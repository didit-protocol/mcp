import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { apiRequest, MCP_RESOURCE_URI, requestContext } from "./config";
import { DiditError, pathSegment } from "./security";

// Download links for the files of an E-signature step: the signer's evidence PDF, the signed PDF of one
// document, and the PNG of a signature or initials field. Same capability-link design as the session
// report (session-pdf-download.ts): an authenticated-encryption token carries the user's credentials,
// the link authenticates itself, the file is fetched again from Didit at download time (so revocation
// and the SHA-256 check both apply) and nothing is cached.

export const SESSION_SIGNATURE_DOWNLOAD_PATH = "/downloads/session-signature";
const TTL_SECONDS = 300;
const PURPOSE = Buffer.from("didit-session-signature-v1");

interface SignatureFile {
  contentType: "application/pdf" | "image/png";
  responseType: "pdf" | "png";
  filename: string;
}

const FILES = {
  evidence: { contentType: "application/pdf", responseType: "pdf", filename: "signature-evidence.pdf" },
  document: { contentType: "application/pdf", responseType: "pdf", filename: "signed-document.pdf" },
  field_image: { contentType: "image/png", responseType: "png", filename: "signature-field.png" },
} as const satisfies Record<string, SignatureFile>;

export type SignatureFileKind = keyof typeof FILES;

export interface SignatureFileRef {
  kind: SignatureFileKind;
  session_id: string;
  node_id: string;
  /** document_id for a signed document, field_id for a field image, optional signature_id for evidence. */
  target_id?: string;
}

function downloadKey(): Buffer {
  const value = process.env.MCP_PDF_DOWNLOAD_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Signature file downloads require MCP_PDF_DOWNLOAD_KEY (32 random bytes in hex) on the MCP HTTP server and every issuing replica.");
  }
  return Buffer.from(value, "hex");
}

function downloadUrl(): URL {
  const url = new URL(SESSION_SIGNATURE_DOWNLOAD_PATH, MCP_RESOURCE_URI);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Signature file downloads require an HTTPS MCP_RESOURCE_URI pointing to the MCP HTTP server.");
  }
  return url;
}

/** Validate every id the way a path segment is validated, and build the Didit route. */
function route(ref: SignatureFileRef): { path: string; params?: Record<string, string> } {
  const base = `/session/${pathSegment(ref.session_id, "session_id")}/signatures/${pathSegment(ref.node_id, "node_id")}`;
  if (!(ref.kind in FILES)) throw new Error("Unknown signature file kind.");
  if (ref.kind === "evidence") {
    return {
      path: `${base}/evidence/`,
      params: ref.target_id ? { signature_id: pathSegment(ref.target_id, "signature_id") } : undefined,
    };
  }
  if (ref.kind === "document") {
    return { path: `${base}/documents/${pathSegment(ref.target_id ?? "", "document_id")}/file/` };
  }
  return { path: `${base}/fields/${pathSegment(ref.target_id ?? "", "field_id")}/image/` };
}

function fetchFile(ref: SignatureFileRef): Promise<Buffer> {
  const { path, params } = route(ref);
  return apiRequest(path, { responseType: FILES[ref.kind].responseType, params });
}

export async function createSignatureDownload(ref: SignatureFileRef): Promise<unknown> {
  route(ref);
  const key = downloadKey();
  const url = downloadUrl();
  const credentials = requestContext.getStore();
  if (!credentials?.accessToken) throw new Error("Signature file downloads require an authenticated Didit user.");
  // Check the file endpoint's own authorization (and the stored file's SHA-256) before issuing any capability.
  await fetchFile(ref);
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(PURPOSE);
  const payload = JSON.stringify({
    ref, expires, audience: url.origin,
    accessToken: credentials.accessToken,
    organizationId: credentials.organizationId,
  });
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  url.searchParams.set("token", Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url"));
  return {
    download_url: url.href,
    content_type: FILES[ref.kind].contentType,
    expires_at: new Date(expires * 1000).toISOString(),
    expires_in: TTL_SECONDS,
  };
}

export const downloadSessionSignatureFile: RequestHandler = async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
  let payload;
  try {
    const token = req.query.token;
    if (typeof token !== "string" || token.length > 16384 || !/^[\w-]+$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", downloadKey(), bytes.subarray(0, 12));
    decipher.setAAD(PURPOSE);
    decipher.setAuthTag(bytes.subarray(12, 28));
    payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(payload.expires) || payload.expires <= now || payload.expires > now + TTL_SECONDS ||
        payload.audience !== downloadUrl().origin || typeof payload.accessToken !== "string" || !payload.accessToken) throw new Error();
    route(payload.ref);
  } catch {
    res.status(403).json({ error: "Invalid or expired signature file link. Generate a new link with the didit_session_get_signature_* tool." });
    return;
  }
  try {
    const ref = payload.ref as SignatureFileRef;
    const file = FILES[ref.kind];
    // Recheck upstream authorization, including revocation, at download time.
    const bytes = await requestContext.run({
      accessToken: payload.accessToken, organizationId: payload.organizationId,
      toolName: "didit_session_get_signature_file",
    }, () => fetchFile(ref));
    res.set({ "Content-Type": file.contentType, "Content-Disposition": `attachment; filename="${file.filename}"` });
    res.send(bytes);
  } catch (error) {
    const status = error instanceof DiditError ? error.shape.status : undefined;
    res.status(status === 401 || status === 403 || status === 404 ? status : 502)
      .json({ error: "Unable to download the signature file. Generate a new link or check session access." });
  }
};

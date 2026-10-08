import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { apiRequest, MCP_RESOURCE_URI, requestContext } from "./config";
import { DiditError, pathSegment } from "./security";

export const SESSION_PDF_DOWNLOAD_PATH = "/downloads/session-report.pdf";
const TTL_SECONDS = 300;
const PURPOSE = Buffer.from("didit-session-pdf-v1");

function downloadKey(): Buffer {
  const value = process.env.MCP_PDF_DOWNLOAD_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Session PDF downloads require MCP_PDF_DOWNLOAD_KEY (32 random bytes in hex) on the MCP HTTP server and every issuing replica.");
  }
  return Buffer.from(value, "hex");
}

function downloadUrl(): URL {
  const url = new URL(SESSION_PDF_DOWNLOAD_PATH, MCP_RESOURCE_URI);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Session PDF downloads require an HTTPS MCP_RESOURCE_URI pointing to the MCP HTTP server.");
  }
  return url;
}

function fetchPdf(sessionId: string): Promise<Buffer> {
  return apiRequest(`/session/${pathSegment(sessionId, "session_id")}/generate-pdf/`, { responseType: "pdf" });
}

/** An authenticated-encryption token: credentials must never be visible in a signed URL.
 * No PDF or credential cache is needed, so links work across replicas sharing the key.
 */
export async function createSessionPdfDownload(sessionId: string): Promise<unknown> {
  pathSegment(sessionId, "session_id");
  const key = downloadKey();
  const url = downloadUrl();
  const credentials = requestContext.getStore();
  if (!credentials?.accessToken) throw new Error("Session PDF downloads require an authenticated Didit user.");
  // Check the PDF endpoint's own authorization before issuing any capability.
  await fetchPdf(sessionId);
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(PURPOSE);
  const payload = JSON.stringify({
    sessionId, expires, audience: url.origin,
    accessToken: credentials.accessToken,
    organizationId: credentials.organizationId,
  });
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  url.searchParams.set("token", Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url"));
  return { download_url: url.href, expires_at: new Date(expires * 1000).toISOString(), expires_in: TTL_SECONDS };
}

export const downloadSessionPdf: RequestHandler = async (req, res) => {
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
    pathSegment(payload.sessionId, "session_id");
  } catch {
    res.status(403).json({ error: "Invalid or expired PDF download link. Generate a new link with didit_session_generate_pdf." });
    return;
  }
  try {
    // Recheck upstream authorization, including revocation, at download time.
    const bytes = await requestContext.run({
      accessToken: payload.accessToken, organizationId: payload.organizationId,
      toolName: "didit_session_generate_pdf",
    }, () => fetchPdf(payload.sessionId));
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=\"session-report.pdf\"" });
    res.send(bytes);
  } catch (error) {
    const status = error instanceof DiditError ? error.shape.status : undefined;
    res.status(status === 401 || status === 403 || status === 404 ? status : 502)
      .json({ error: "Unable to download the original Didit PDF. Generate a new link or check session access." });
  }
};

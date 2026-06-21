// Ported verbatim from the audited mcp-server-v2-public hardening core (config.ts).
// Surface-agnostic security/correctness helpers: structured errors, DRF error parsing,
// sanitization, secret redaction, path-segment + SSRF + file-upload guards.
import { openSync, readSync, closeSync, lstatSync, statSync } from "fs";
import { basename, extname, isAbsolute } from "path";

export interface DiditErrorShape {
  /** Machine-readable code: e.g. bad_request, not_found, unprocessable, payment_required, forbidden, conflict, rate_limited, server_error, missing_scope, missing_auth, unsafe_operation. */
  code: string;
  /** Human-readable message (no internal method/path leaked). */
  message: string;
  /** Actionable remediation hint for the agent. */
  hint?: string;
  /** The offending field, when known. */
  field?: string;
  /** Allowed enum values, when the backend supplied them. */
  allowed?: string[];
  /** HTTP status, when this originated from an HTTP response. */
  status?: number;
}

/**
 * A typed error carrying the structured shape. On an MCP error result the
 * dispatch renders this as a TEXT block only — `Error [code]: message` plus an
 * optional `Hint:`/`Allowed:` line — and OMITS `structuredContent` entirely, so a
 * strict client never validates an error against a tool's success `outputSchema`.
 * The `[code]` tag keeps the text machine-parseable. Never embeds the internal HTTP path.
 */
export class DiditError extends Error {
  readonly shape: DiditErrorShape;
  constructor(shape: DiditErrorShape) {
    super(shape.message);
    this.name = "DiditError";
    this.shape = shape;
  }
}

// ── Path-segment safety (WS-E security) ───────────────────────────────────────
//
// EVERY user-controlled value interpolated into a request path MUST go through
// pathSegment(). `new URL()` normalizes `..`, so a raw value like
// "../billing/balance" would silently target a DIFFERENT endpoint. We reject the
// routing/traversal metacharacters outright AND percent-encode the rest.
export function pathSegment(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must be a string.`,
      field,
      hint: "Provide a single id/value with no path separators.",
    });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must not be empty.`,
      field,
    });
  }
  // Reject routing/path-separator metacharacters BEFORE encoding so the value can
  // never escape its slot. NOTE: we reject only path-ESCAPING traversal — a bare
  // "." or ".." segment (which `new URL()` would resolve as the current/parent
  // dir) — NOT every "..". A dotted run *inside* a segment (e.g. a valid
  // vendor_data like "customer..prod") is safe: `/` is already rejected, and
  // encodeURIComponent leaves the dots literal so it can't be re-read as traversal.
  if (/[\/?#]/.test(trimmed)) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} contains illegal path characters.`,
      field,
      hint: "Path identifiers must not contain '/', '?', or '#'.",
    });
  }
  if (trimmed === "." || trimmed === "..") {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must not be a path-traversal segment.`,
      field,
      hint: "A bare '.' or '..' segment is not a valid identifier.",
    });
  }
  return encodeURIComponent(trimmed);
}

/**
 * Require a value to be a real boolean (true/false) — NOT a truthy string such as
 * "false". Used for safety flags (delete_all, confirm) where a coerced string is a
 * security bug (a truthy "false" would otherwise pass a `truthy` check).
 */
export function assertBoolean(value: unknown, field: string): void {
  if (value !== undefined && value !== null && typeof value !== "boolean") {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must be a boolean (true or false), not a string or number.`,
      field,
      hint: `Pass ${field}:true or ${field}:false — the string "true"/"false" is rejected.`,
    });
  }
}

/** Hard cap on the number of ids accepted in a single batch operation. */
export const MAX_BATCH_IDS = 1000;

// ── Local-file upload safety (WS-E security) ──────────────────────────────────
/** Maximum size (bytes) accepted for a local image/branding upload. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

const RESTRICTED_PATH_PREFIXES = [
  "/etc/", "/proc/", "/sys/", "/dev/", "/root/", "/run/", "/var/run/", "/boot/",
];

/** Allowed upload file extensions (lower-case, with the dot). */
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".pdf",
]);

/**
 * Basenames we refuse to read even if they somehow carried an image extension —
 * secret/credential files + manifests. Defense in depth on top of the
 * magic-bytes allow-list (a `.env` would also fail the sniff). Matched
 * case-insensitively against the FILE NAME (not directory components).
 */
const BLOCKED_UPLOAD_BASENAMES = new Set([
  ".env", ".env.local", ".env.development", ".env.production", ".env.test",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  ".netrc", ".npmrc", ".pgpass", ".git-credentials", ".htpasswd",
  "credentials", "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
]);

/**
 * Sniff the leading bytes of a file and return a known image/document type, or
 * null if the magic bytes don't match an allowed format. Reads only the header so
 * a non-image file is rejected BEFORE the (potentially large) full read.
 */
function sniffFileType(filePath: string): string | null {
  let fd: number | undefined;
  const buf = Buffer.alloc(16);
  try {
    fd = openSync(filePath, "r");
    readSync(fd, buf, 0, 16, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  // PNG  89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "png";
  // JPEG FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  // GIF  "GIF87a" / "GIF89a"
  if (buf.slice(0, 4).toString("latin1") === "GIF8") return "gif";
  // WEBP "RIFF"...."WEBP"
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "webp";
  // BMP  "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  // ICO  00 00 01 00
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "ico";
  // PDF  "%PDF-"
  if (buf.slice(0, 5).toString("latin1") === "%PDF-") return "pdf";
  return null;
}

/**
 * Validate that a path points to a readable, regular, sanely-sized image/document
 * file before we read it for an upload. Requires an ABSOLUTE path; rejects
 * non-strings, directories, symlinks, restricted system paths, dotfiles + known
 * secret/manifest filenames, disallowed extensions, empty + oversized files, and
 * — crucially — any content whose MAGIC BYTES are not a recognised image/PDF
 * (so `.env`, `package.json`, source, archives, executables can never be read).
 * Never echoes the path back (no leak).
 */
export function validateLocalFile(filePath: unknown, field = "image_path"): string {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must be a non-empty file-path string.`,
      field,
      hint: "Provide an absolute path to a readable image (png/jpg/jpeg/webp/gif/bmp/ico) or PDF file.",
    });
  }
  if (!isAbsolute(filePath)) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must be an absolute path.`,
      field,
      hint: "Provide an absolute path (starting with '/'), not a relative one.",
    });
  }
  const lower = filePath.toLowerCase();
  for (const bad of RESTRICTED_PATH_PREFIXES) {
    if (lower === bad.slice(0, -1) || lower.startsWith(bad)) {
      throw new DiditError({
        code: "bad_request",
        message: `${field} points to a restricted system path.`,
        field,
      });
    }
  }
  const name = basename(filePath);
  // Dotfiles (e.g. `.env`, `.npmrc`) are never uploadable images.
  if (name.startsWith(".") && !ALLOWED_UPLOAD_EXTENSIONS.has(extname(name).toLowerCase())) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must not be a dotfile.`,
      field,
    });
  }
  if (BLOCKED_UPLOAD_BASENAMES.has(name.toLowerCase())) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} points to a blocked secret/configuration file.`,
      field,
    });
  }
  const ext = extname(name).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} has an unsupported file extension.`,
      field,
      hint: "Allowed extensions: png, jpg, jpeg, webp, gif, bmp, ico, pdf.",
    });
  }
  let st;
  try {
    // lstat (NOT stat) so a symlink is detected rather than followed.
    st = lstatSync(filePath);
  } catch {
    throw new DiditError({
      code: "bad_request",
      message: `${field}: file not found or not readable.`,
      field,
      hint: "Provide an absolute path to a readable image/PDF file.",
    });
  }
  if (st.isSymbolicLink()) {
    throw new DiditError({ code: "bad_request", message: `${field} must not be a symbolic link.`, field });
  }
  if (!st.isFile()) {
    throw new DiditError({ code: "bad_request", message: `${field} must be a regular file.`, field });
  }
  if (st.size <= 0) {
    throw new DiditError({ code: "bad_request", message: `${field} is empty (0 bytes).`, field });
  }
  if (st.size > MAX_UPLOAD_BYTES) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB upload limit.`,
      field,
    });
  }
  // Content sniff LAST (after the cheap rejects) but BEFORE any full read by the
  // caller: the magic bytes must match a recognised image/PDF format.
  const sniffed = sniffFileType(filePath);
  if (!sniffed) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} is not a recognised image or PDF (content check failed).`,
      field,
      hint: "Upload a real png/jpg/jpeg/webp/gif/bmp/ico image or a PDF.",
    });
  }
  return filePath;
}

// ── Webhook SSRF guard (WS-E security) ────────────────────────────────────────

function ipv4IsInternal(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return true; // malformed → treat as unsafe
  const [a, b] = o;
  if (a === 0 || a === 127) return true; // 0.0.0.0/8, loopback
  if (a === 10) return true; // RFC-1918
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918
  if (a === 192 && b === 168) return true; // RFC-1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isInternalHost(rawHost: string): boolean {
  // Canonicalize: lower-case, strip IPv6 brackets, and drop FQDN trailing dots
  // (e.g. `localhost.` / `evil.com.`) so a trailing-dot variant can't dodge the
  // name checks below.
  let host = rawHost.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  host = host.replace(/\.+$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "ip6-localhost") return true;
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1") return true;
  // IPv6 unique-local (fc00::/7) + link-local (fe80::/10)
  if (/^f[cd][0-9a-f]*:/.test(host) || /^fe[89ab][0-9a-f]*:/.test(host)) return true;
  // IPv4-mapped IPv6, DOTTED tail (::ffff:127.0.0.1) — extract the v4 tail.
  const mappedDotted = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
  if (mappedDotted && ipv4IsInternal(mappedDotted[1])) return true;
  // IPv4-mapped IPv6, HEX tail (::ffff:7f00:1). The WHATWG URL parser canonicalizes
  // `[::ffff:127.0.0.1]` to this hex form, so we MUST decode it back to dotted
  // quad and run it through the same internal-range check.
  const mappedHex = /^(?:0*:)*:?0*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (ipv4IsInternal(dotted)) return true;
  }
  // Best-effort alias guard: reject a hostname that EMBEDS an internal IPv4 literal
  // as a dotted label (e.g. 127.0.0.1.nip.io, 10.0.0.1.sslip.io) — wildcard-DNS
  // services that resolve straight back to the embedded internal address. This is
  // NOT a complete rebinding defense (see the note on assertSafeWebhookUrl): a host
  // can still resolve to an internal IP at request time without revealing it in the
  // name, so the BACKEND must re-validate the resolved IP at delivery time.
  const embedded = /(?:^|\.)((?:\d{1,3}\.){3}\d{1,3})(?:$|\.)/.exec(host);
  if (embedded && ipv4IsInternal(embedded[1])) return true;
  return ipv4IsInternal(host);
}

/**
 * Reject a URL that the BACKEND will fetch or call (webhook destination, KYB
 * webhook_url, session-import source_file_url, URL-form portrait_image…) when it
 * points at an internal / loopback / cloud-metadata / RFC-1918 host. This is the
 * single client-side SSRF guard; returns the URL when it is a public http(s) endpoint.
 *
 * ⚠️ CLIENT-SIDE ONLY — NOT a complete DNS-rebinding / TOCTOU defense. The MCP only
 * FORWARDS the URL; the OUTBOUND fetch happens on the Didit BACKEND. A hostname that
 * passes this check can still resolve to an internal IP at delivery time (rebinding),
 * or redirect (3xx) to an internal target after the fact. The BACKEND MUST therefore
 * re-validate at delivery time: resolve the host and re-check the ACTUAL IP against
 * the same internal ranges, disable/restrict following redirects, and pin/re-validate
 * the post-redirect target. This function rejects literal internal hosts and obviously
 * suspicious embedded-internal-IP aliases (e.g. 127.0.0.1.nip.io) — it cannot see DNS.
 */
export function assertSafeWebhookUrl(rawUrl: unknown, field = "url"): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new DiditError({ code: "bad_request", message: `${field} must be a non-empty URL string.`, field });
  }
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new DiditError({ code: "bad_request", message: `${field} must be a valid absolute URL.`, field });
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must use http or https.`,
      field,
    });
  }
  if (isInternalHost(u.hostname)) {
    throw new DiditError({
      code: "unsafe_operation",
      message: `${field} targets an internal, loopback, or cloud-metadata address.`,
      field,
      hint: "Use a public HTTPS endpoint. Internal hosts (localhost, 127.0.0.0/8, 169.254.169.254, 10/172.16/192.168 RFC-1918) are refused.",
    });
  }
  return rawUrl.trim();
}

// ── Error sanitization (WS-G security) ────────────────────────────────────────
const SENSITIVE_KEY_RE = /(api[_-]?key|secret|token|password|passwd|pwd|authorization|bearer|refresh[_-]?token|client[_-]?secret|signing[_-]?secret)/i;

/** Canonical RFC-4122 UUID (8-4-4-4-12 hex). A legitimate resource id. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Strip secrets / PII / local-environment detail out of a free-text string:
 * URLs + hosts, absolute file paths (INCLUDING spaces, e.g. "Application Support"),
 * emails, known secret-token shapes, JWTs, long opaque mixed blobs, and
 * phone-number-like digit runs. Canonical UUIDs are PRESERVED — they are legit
 * resource ids that the 24+ mixed-token rule and the phone digit-run rule would
 * otherwise mangle — so we stash them behind a sentinel before redacting and
 * restore them at the end.
 */
export function sanitizeText(input: unknown): string {
  let s = typeof input === "string" ? input : String(input ?? "");
  // Redact secret-shaped tokens FIRST — BEFORE UUID preservation — so a secret like
  // "didit-<uuid>" / "sk_live_…" is redacted whole instead of having its UUID tail
  // preserved (which would shrink it below the match threshold and let it slip).
  s = s.replace(/\b(?:didit|sk|pk|rk|whsec|key)[_-][A-Za-z0-9_\-]{6,}/gi, "[redacted-secret]");
  // Stash canonical UUIDs so no downstream rule can touch them, then restore.
  const uuids: string[] = [];
  s = s.replace(UUID_RE, (m) => {
    uuids.push(m);
    return `UUID${uuids.length - 1}`;
  });
  s = s.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
  s = s.replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, "[redacted-path]"); // Windows abs paths
  // Unix abs paths (>=2 segments). A space is allowed INSIDE a segment only when
  // that segment is followed by another '/', so we consume a directory name like
  // "Application Support" in full but never run off the end of the path into prose.
  s = s.replace(
    /(?:\/[A-Za-z0-9._@%+\-]+(?: +[A-Za-z0-9._@%+\-]+)*(?=\/))+\/?[A-Za-z0-9._@%+\-]*/g,
    "[redacted-path]",
  );
  s = s.replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]");
  s = s.replace(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[redacted-token]");
  s = s.replace(/\b[A-Za-z0-9_\-]{24,}\b/g, (m) => (/[A-Za-z]/.test(m) && /\d/.test(m) ? "[redacted-token]" : m));
  s = s.replace(/(?<!\w)\+?\d[\d\s().\-]{6,}\d(?!\w)/g, "[redacted-phone]");
  // Restore the preserved UUIDs.
  s = s.replace(/UUID(\d+)/g, (_m, i) => uuids[Number(i)] ?? "");
  return s;
}

/** Recursively redact sensitive-keyed values and sanitize string leaves. */
export function redactDeep(value: any): any {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Sanitize a structured error shape. `code`, `field`, and `hint` are MCP-authored
 * (trusted) — they legitimately name env vars (e.g. DIDIT_DEFAULT_ORG_ID) and tools,
 * so they are NOT value-sanitized (that would mangle remediation hints). `message`
 * and `allowed[]` can carry BACKEND-origin text (a 422 body's enum list could leak a
 * URL / email / token), so each is run through sanitizeText. Any other nested fields
 * go through redactDeep.
 */
export function sanitizeErrorShape(shape: DiditErrorShape): DiditErrorShape {
  const { code, field, allowed, hint, message, ...rest } = shape as any;
  return {
    ...(redactDeep(rest) as object),
    ...(code !== undefined ? { code } : {}),
    ...(field !== undefined ? { field } : {}),
    ...(allowed !== undefined
      ? { allowed: Array.isArray(allowed) ? allowed.map((a) => sanitizeText(a)) : sanitizeText(allowed) }
      : {}),
    ...(hint !== undefined ? { hint } : {}),
    ...(message !== undefined ? { message: sanitizeText(message) } : {}),
  } as DiditErrorShape;
}

/**
 * Convert ANY thrown value into a safe DiditErrorShape: DiditError shapes are
 * sanitized; transport failures (undici `fetch failed`, ECONNREFUSED, DNS, TLS…)
 * become a clean `network_error`; everything else is sanitized + wrapped.
 */
export function toSafeErrorShape(error: any): DiditErrorShape {
  if (error instanceof DiditError) return sanitizeErrorShape(error.shape);
  const raw = error && error.message ? String(error.message) : String(error);
  const isTransport =
    /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|network|getaddrinfo|\bTLS\b|certificate|self[- ]signed/i.test(raw) ||
    (error && (error.name === "FetchError" || error.code === "ECONNREFUSED" || error.code === "ENOTFOUND"));
  if (isTransport) {
    return {
      code: "network_error",
      message: "Could not reach the Didit API (network/transport error).",
      hint: "Check connectivity and retry. If it persists, the API may be temporarily unavailable.",
    };
  }
  return { code: "error", message: sanitizeText(raw) };
}

/** Map an HTTP status to a stable machine-readable error code. */

export function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 402:
      return "payment_required";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "unprocessable";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "server_error" : "error";
  }
}

/** Per-status remediation hint so the model knows what to do next. */
export function statusToHint(status: number, body: any): string | undefined {
  switch (status) {
    case 402:
      return "Insufficient balance. Use didit_top_up to add credits (minimum $50), then retry.";
    case 404:
      return "The referenced id was not found. List the parent collection first (e.g. didit_list_sessions / didit_list_workflows) to get a valid id.";
    case 422:
      return body && Array.isArray(body.allowed)
        ? "Invalid enum value — choose one of the values in `allowed`."
        : "A field value was rejected. Check the field constraints and retry.";
    case 403:
      return "This action is not permitted with the current credentials (it may require a different role).";
    case 401:
      return "Authentication failed. Check the api key / access token.";
    case 409:
      return "Conflict — the resource is in a state that blocks this action (e.g. transaction monitoring not configured). Configure the prerequisite first.";
    case 429:
      return "Rate limited. Back off and retry after a short delay.";
    case 400:
      // Cheap presence check (no second full DRF traversal — parseErrorBody already extracts the detail).
      return body && (typeof body === "object" || typeof body === "string") ? "Fix the indicated field and retry." : undefined;
    default:
      return undefined;
  }
}

// ── DRF (Django REST Framework) error-body extraction (WS-G explainability) ───
//
// The REAL Didit backend returns validation errors as FIELD-KEYED objects or BARE
// ARRAYS, NOT the {detail:"..."} shape. Without parsing these we would surface the
// opaque "Request failed with status N" and lose the backend's field-level detail.
// Captured real 400 bodies:
//   (a) field-error object   { "list_type": ["..."], "entry_type": ["\"x\" is not a valid choice."] }
//   (b) NESTED field-error    { "features": [["Each workflow feature must be an object."]] }
//                             { "form_elements": [{ "element_type": ["This field is required."] }] }
//   (c) bare array            ["Provide vendor_data_list or set delete_all=true."]
// flattenDrfError() turns any nested array/object value into a readable line;
// extractDrfFieldError() picks the FIRST offending field and assembles the message.

// Bounds so a hostile / huge / cyclic backend error body can't overflow the stack,
// burn CPU, or produce oversized user-facing text (DoS-safe).
const DRF_MAX_DEPTH = 8;
const DRF_MAX_PARTS = 40;
const DRF_MAX_LEAF = 400;
const DRF_MAX_MSG = 2000;

/** Flatten a DRF error value (string | nested arrays | nested {field:...} objects) into one readable
 *  line. Depth/breadth/leaf/total-length bounded, with a cycle guard. */
function flattenDrfError(value: any, depth = 0, seen?: Set<any>): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().slice(0, DRF_MAX_LEAF);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object" || depth >= DRF_MAX_DEPTH) return "";
  const visited = seen || new Set<any>();
  if (visited.has(value)) return ""; // cycle guard
  visited.add(value);
  let parts: string[];
  if (Array.isArray(value)) {
    parts = value.slice(0, DRF_MAX_PARTS).map((v) => flattenDrfError(v, depth + 1, visited)).filter(Boolean);
  } else {
    // Bounded lazy scan — a for…in stops after DRF_MAX_PARTS without allocating the
    // full key array (DoS-safe on a pathologically wide object).
    parts = [];
    let n = 0;
    for (const k in value) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      if (n++ >= DRF_MAX_PARTS) break;
      const inner = flattenDrfError((value as any)[k], depth + 1, visited);
      if (inner) parts.push(`${k}: ${inner}`);
    }
  }
  visited.delete(value);
  return parts.join("; ").slice(0, DRF_MAX_MSG);
}

/** A backend error KEY is rendered as the remediation `field` ONLY when it looks like a real field
 *  path (identifier / dots / brackets, ≤64 chars). Anything else (an email, an absolute path, a
 *  secret) is dropped so a hostile/odd backend body can't leak it via the `Field:` line. */
function safeFieldName(field: any): string | undefined {
  if (typeof field !== "string" || !/^[A-Za-z0-9_.\-[\]]{1,64}$/.test(field)) return undefined;
  // Reject secret-SHAPED keys. The explicit prefix check is order-independent (sanitizeText
  // stashes UUIDs before its secret regex, so "didit_<uuid>" would otherwise slip through);
  // the sanitizeText comparison then catches anything else redactable.
  if (/^(didit|sk|pk|rk|whsec|key)[_-]/i.test(field)) return undefined;
  return sanitizeText(field) === field ? field : undefined;
}

/**
 * Detect + extract a DRF field-error body. Returns { message, field? } — `field`
 * is the FIRST offending key (undefined for a bare array). Returns null when the
 * body is NOT a field-error shape (so the {detail}/{message}/{error} path handles it).
 * The flattened message keeps the original backend text (e.g. `"x" is not a valid choice`).
 */
export function extractDrfFieldError(body: any): { message: string; field?: string } | null {
  // (c) bare array — ["Provide vendor_data_list or set delete_all=true."]
  if (Array.isArray(body)) {
    const message = flattenDrfError(body);
    return message ? { message } : null;
  }
  if (!body || typeof body !== "object") return null;
  // Single BOUNDED lazy pass (≤ DRF_MAX_PARTS keys; no full-width allocation).
  // Treat as a field-error MAP only when at least one value is an array/object — a
  // {detail:"..."} string body is NOT a field map (handled by the standard path).
  let firstFieldKey: string | undefined;
  const parts: string[] = [];
  let scanned = 0;
  for (const k in body) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    if (scanned++ >= DRF_MAX_PARTS) break;
    const v = (body as any)[k];
    if (firstFieldKey === undefined && (Array.isArray(v) || (v !== null && typeof v === "object"))) firstFieldKey = k;
    const inner = flattenDrfError(v);
    if (inner) parts.push(`${k}: ${inner}`);
  }
  if (firstFieldKey === undefined) return null;
  const message = parts.join("; ").slice(0, DRF_MAX_MSG);
  return message ? { message, field: safeFieldName(firstFieldKey) } : null;
}

/**
 * Pull the clearest human message + offending field + allowed-enum list out of ANY
 * backend error body. Priority: the standard {detail}/{message}/{error} STRING
 * shapes first, then DRF field-error objects / nested arrays / bare arrays.
 * The returned `message` is sanitized at RENDER time (sanitizeErrorShape runs
 * sanitizeText over message + allowed); `field` is a backend KEY name and is
 * PRESERVED (never value-sanitized) so the remediation field stays intact.
 * `message` is undefined when nothing usable was found (caller falls back to a status line).
 */
export function parseErrorBody(body: any): { message?: string; field?: string; allowed?: string[] } {
  const isPlainObject = body && typeof body === "object" && !Array.isArray(body);
  const allowed = isPlainObject && Array.isArray(body.allowed) ? body.allowed.map((a: any) => String(a)) : undefined;
  // 1) Standard {detail}/{message}/{error} STRING shapes (highest priority).
  if (isPlainObject) {
    const standard = body.detail ?? body.message ?? body.error;
    if (typeof standard === "string" && standard.trim()) {
      const field =
        (typeof body.field === "string" && body.field) ||
        /^(\w+) is required$/.exec(standard)?.[1] ||
        undefined;
      return { message: standard, field: safeFieldName(field), allowed };
    }
  }
  // 2) DRF field-error object / nested / bare array.
  const drf = extractDrfFieldError(body);
  if (drf) {
    const explicitField = isPlainObject && typeof body.field === "string" && body.field ? body.field : undefined;
    return { message: drf.message, field: safeFieldName(explicitField) || drf.field, allowed };
  }
  return { allowed };
}

/**
 * Mask a secret to a short preview that shows it exists without leaking the value.
 */
export function maskSecret(secret: unknown): string | null {
  if (secret === null || secret === undefined) return null;
  const s = String(secret);
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars, hidden)`;
}

/**
 * Redact known secret-bearing fields on an application object. Replaces the raw
 * value with a masked preview and adds *_set booleans. Returns a shallow copy.
 */
export function redactApplication(app: any): any {
  if (!app || typeof app !== "object") return app;
  const out: any = { ...app };
  if ("api_key" in out) {
    out.api_key_set = out.api_key !== null && out.api_key !== undefined && out.api_key !== "";
    out.api_key_preview = maskSecret(out.api_key);
    delete out.api_key;
  }
  if ("client_secret" in out) {
    out.client_secret_set = !!out.client_secret;
    out.client_secret_preview = maskSecret(out.client_secret);
    delete out.client_secret;
  }
  if ("secret" in out) {
    out.secret_set = !!out.secret;
    out.secret_preview = maskSecret(out.secret);
    delete out.secret;
  }
  return out;
}

/** Redact the signing secret on a webhook destination. */
export function redactWebhookDestination(dest: any): any {
  if (!dest || typeof dest !== "object") return dest;
  const out: any = { ...dest };
  for (const key of ["secret_shared_key", "signing_secret", "secret"]) {
    if (key in out) {
      out.secret_set = out[key] !== null && out[key] !== undefined && out[key] !== "";
      delete out[key];
    }
  }
  return out;
}

/** Redact api_key fields on an API-key object (list_api_keys). */
export function redactApiKey(key: any): any {
  if (!key || typeof key !== "object") return key;
  const out: any = { ...key };
  for (const field of ["api_key", "key", "secret", "token", "value"]) {
    if (field in out) {
      out[`${field}_set`] = out[field] !== null && out[field] !== undefined && out[field] !== "";
      out[`${field}_preview`] = maskSecret(out[field]);
      delete out[field];
    }
  }
  return out;
}

/**
 * Apply redaction across a list-envelope or a bare array/object of the given
 * shape, using the provided per-item redactor.
 */
export function redactCollection(payload: any, redactor: (item: any) => any): any {
  if (Array.isArray(payload)) return payload.map(redactor);
  if (payload && Array.isArray(payload.results)) {
    return { ...payload, results: payload.results.map(redactor) };
  }
  return redactor(payload);
}

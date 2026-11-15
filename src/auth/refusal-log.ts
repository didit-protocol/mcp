/**
 * One line for a request to a hosted MCP endpoint that was refused, or that never got an answer.
 *
 * Which requests: the MCP transport endpoints (`/mcp`, `/mcp/chatgpt`, `/mcp/payments`) — everything a
 * connector sends, including a body the JSON parser rejected before any route ran (400/413/415) and a
 * request that arrived and was then dropped, or hung, without an answer. Not covered: the discovery
 * documents, the PDF and signature download links, and the investigator engine; none of those is part
 * of a connector session.
 *
 * Why: the hosted endpoint refuses a connection with 401 (no credential), 401 (a credential the auth
 * service did not accept), 403 (an API key on a profile endpoint), 405 (a reachability probe with GET),
 * 406 (an Accept header the transport cannot answer) or 500 (the auth service did not answer). Until
 * now every one of those was answered silently, so a report like "the Claude connector says it could
 * not verify the server" left nothing behind on this side: an auth service refusing every credential
 * and Anthropic's egress never arriving produced the same, empty log — and so did a request that
 * arrived and was cut off before the answer, which is what a 502 at the connector usually is. The line
 * says which, and how long the request was open, so the next report is one query instead of a
 * reconstruction (the same reason the console logs refused authorizations).
 *
 * What it never says: the credential. Only which header carried one, and the reason — never a token,
 * an API key or a prefix of either. Deliberately not sampled: the arrival time is the evidence, and a
 * sample would drop exactly the request someone is asking about.
 */
import type { Request, Response } from "express";

/** Which request header carried the caller's credential, as it arrived (before any rewrite). */
export type CredentialHeader = "none" | "authorization" | "x-api-key" | "both";

/** Bounded, server-defined: never derived from a credential or from a free-form upstream message. */
export type RefusalReason =
  | "missing_credential"
  | "credential_refused"
  | "forbidden"
  | "unsupported_method"
  | "not_acceptable"
  | "bad_request"
  | "server_error";

/** Why a request got no answer: the connection ended before the response did. */
export type NoAnswerReason = "client_closed";

interface Caller {
  credential: CredentialHeader;
  client: string;
  forwarded?: string;
}

const callers = new WeakMap<Request, Caller>();

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** `python-httpx/0.27.0` → `python-httpx`: the program, not the build, and never a URL or a token. */
export function clientOf(userAgent: unknown): string {
  const first = text(userAgent).split(/\s+/)[0] ?? "";
  const program = first.split("/")[0].replace(/[^A-Za-z0-9._-]/g, "");

  return (program || "unknown").slice(0, 32);
}

/**
 * The address the balancer accepted the connection from: the LAST `X-Forwarded-For` entry.
 *
 * `mcp.didit.me` sits behind the shared `didit-public` ALB, which appends the address it saw to the
 * end of the header. Every earlier entry is whatever the caller chose to declare, so taking the first
 * one would let anyone claim to be Anthropic's egress. A request that reaches the task without the
 * balancer can still write the whole header: the line says what arrived, not a verified identity.
 */
export function forwardedOf(req: Request): string | undefined {
  const hops = text(req.headers["x-forwarded-for"])
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const seen = hops[hops.length - 1];

  return seen && seen.length <= 45 ? seen : undefined;
}

/** Remember what arrived, before the x-api-key door rewrites it into an Authorization header. */
export function noteRequestCredentials(req: Request): void {
  const authorization = Boolean(req.headers.authorization);
  const apiKey = Boolean(text(req.headers["x-api-key"]).trim());
  const credential: CredentialHeader =
    authorization && apiKey ? "both" : authorization ? "authorization" : apiKey ? "x-api-key" : "none";

  callers.set(req, { credential, client: clientOf(req.headers["user-agent"]), forwarded: forwardedOf(req) });
}

/** The reason a response of this status was a refusal, in the server's own words. */
export function refusalReasonOf(status: number, credential: CredentialHeader): RefusalReason | undefined {
  if (status === 401) return credential === "none" ? "missing_credential" : "credential_refused";
  // Today only the API-key-on-a-profile-endpoint gate answers 403 (http.ts keyOnlyOnFullProfile).
  if (status === 403) return "forbidden";
  if (status === 405) return "unsupported_method";
  // The transport's own Accept check: a client that does not accept both JSON and an event stream.
  if (status === 406) return "not_acceptable";
  if (status === 400 || status === 413 || status === 415) return "bad_request";
  if (status >= 500) return "server_error";

  return undefined;
}

/**
 * Watch one request on a hosted endpoint and log how it ended. Mounted before the body parser, so a
 * body it rejects is logged too; the caller has already noted the credentials (`noteRequestCredentials`).
 *
 * `finish` covers every answered request. `close` without `finish` is the case a 502 leaves behind: the
 * request reached this task and the connection ended before an answer — the client gave up, or the
 * balancer's timeout did — which is otherwise indistinguishable from a request that never arrived.
 */
export function watchHostedRequest(req: Request, res: Response, path: string): void {
  const startedAt = Date.now();
  let logged = false;
  const logStatus = () => {
    if (logged) return;
    logged = true;
    logRefusedHostedRequest(req, path, res.statusCode, Date.now() - startedAt);
  };
  const logNoAnswer = () => {
    if (logged) return;
    logged = true;
    logUnansweredHostedRequest(req, path, res, Date.now() - startedAt);
  };

  res.on("finish", logStatus);
  res.on("close", () => (res.writableFinished ? logStatus() : logNoAnswer()));
}

/**
 * Log one refused hosted request. Silent for anything that was not a refusal: a 404 from an
 * unrelated path and every success stay out of the log.
 */
export function logRefusedHostedRequest(req: Request, path: string, status: number, elapsedMs = 0): void {
  const caller = callers.get(req);

  if (!caller) return;
  const reason = refusalReasonOf(status, caller.credential);
  if (!reason) return;
  emit({
    level: "warn",
    message: "hosted request refused",
    path: path.slice(0, 64),
    method: text(req.method).toUpperCase().slice(0, 8),
    status,
    reason,
    credential: caller.credential,
    client: caller.client,
    ms: elapsedMs,
  }, caller);
}

/** Log a request that reached this task and ended without an answer (close before finish). */
export function logUnansweredHostedRequest(req: Request, path: string, res: Response, elapsedMs: number): void {
  const caller = callers.get(req);

  if (!caller) return;
  const reason: NoAnswerReason = "client_closed";
  emit({
    level: "warn",
    message: "hosted request not answered",
    path: path.slice(0, 64),
    method: text(req.method).toUpperCase().slice(0, 8),
    // 0 when nothing was sent: the caller saw a dropped connection, which is the 502 shape.
    status: res.headersSent ? res.statusCode : 0,
    reason,
    credential: caller.credential,
    client: caller.client,
    ms: elapsedMs,
  }, caller);
}

/** A warn-level line on stderr, which is where this service's log pipeline reads from. */
function emit(fields: Record<string, unknown>, caller: Caller): void {
  console.warn(JSON.stringify({ ...fields, ...(caller.forwarded ? { forwarded: caller.forwarded } : {}) }));
}

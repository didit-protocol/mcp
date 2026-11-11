// OAuth 2.0 Device Authorization Grant (RFC 8628) for the local (stdio) server and the
// `didit-mcp-server login` command: a coding agent on a remote machine or in CI has no local
// browser, so the person approves on any device with a browser and the agent polls for the token.
//
// Pure logic: fetch, clock and sleep are injected so every RFC branch is unit-testable. The
// authorization server is the Didit Business Console (MCP_AUTHORIZATION_SERVER_ORIGIN). A token
// (access or refresh) is never logged, printed or put in an error message.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MCP_AUTHORIZATION_SERVER_ORIGIN } from "./config";

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_LOGIN_SCOPE = "openid profile email didit:management didit:verification didit:staff";
export const DEVICE_LOGIN_CLIENT_NAME = "Didit MCP (terminal)";
/** Refresh when the access token expires within this window. */
export const REFRESH_SKEW_MS = 60_000;
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
const MAX_BACKOFF_S = 60;

export type DeviceLoginErrorCode =
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "login_required"
  | "authorization_failed"
  | "temporarily_unavailable"
  | "slow_down";

/** A failure the person (or agent) can act on. `code` is stable; `message` never carries a token. */
export class DeviceLoginError extends Error {
  readonly code: DeviceLoginErrorCode;
  /** Seconds the server asked us to wait (Retry-After), when it sent one. */
  readonly retryAfterSeconds?: number;
  constructor(code: DeviceLoginErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "DeviceLoginError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface DeviceLoginDeps {
  fetch: typeof fetch;
  /** Epoch milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultDeps: DeviceLoginDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ServerEndpoints {
  device_authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
}

export interface StoredCredentials {
  client_id: string;
  access_token?: string;
  refresh_token?: string;
  /** Epoch milliseconds when access_token stops working. */
  expires_at?: number;
  scope?: string;
  /**
   * Epoch milliseconds of the sign-in itself (not of a refresh). The local server may hold two
   * sign-ins, this one and the account tools' (account-session.ts), and uses the newer.
   */
  signed_in_at?: number;
}

interface CredentialsFile {
  version: 1;
  servers: Record<string, StoredCredentials>;
}

/** A device authorization in flight. Lives in memory only: device_code is never shown to an agent. */
export interface PendingDeviceLogin {
  origin: string;
  endpoints: ServerEndpoints;
  client_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  /** Epoch ms after which the code is dead. */
  expires_at: number;
  /** Current polling interval in seconds (grows on slow_down). */
  interval: number;
  /** Epoch ms of the last token request (or of the authorization), the base for the next wait. */
  last_poll_at: number;
}

export interface DeviceLoginResult {
  scope: string;
  credentialsPath: string;
}

export const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, "");

// ── Credentials store ───────────────────────────────────────────────────────

export function credentialsFilePath(): string {
  return process.env.DIDIT_MCP_CREDENTIALS_FILE || path.join(os.homedir(), ".config", "didit", "mcp-credentials.json");
}

function readFile(file: string): CredentialsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.servers && typeof parsed.servers === "object") {
      return { version: 1, servers: parsed.servers };
    }
  } catch {
    // Missing or unreadable file = nothing stored.
  }
  return { version: 1, servers: {} };
}

// Directory 0700, file 0600, temp file + rename so a crash never leaves a half-written token file.
function writeFileAtomic(file: string, data: CredentialsFile): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp file already gone
    }
    throw err;
  }
}

export function loadCredentials(origin: string, file = credentialsFilePath()): StoredCredentials | undefined {
  return readFile(file).servers[normalizeOrigin(origin)];
}

export function saveCredentials(origin: string, creds: StoredCredentials, file = credentialsFilePath()): void {
  const data = readFile(file);
  data.servers[normalizeOrigin(origin)] = creds;
  writeFileAtomic(file, data);
}

/** Removes this origin only (staging and production coexist); the file goes when it is empty. */
export function deleteCredentials(origin: string, file = credentialsFilePath()): boolean {
  const data = readFile(file);
  const key = normalizeOrigin(origin);
  if (!(key in data.servers)) return false;
  delete data.servers[key];
  if (Object.keys(data.servers).length === 0) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  } else {
    writeFileAtomic(file, data);
  }
  return true;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

const formBody = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function retryAfter(res: Response): number | undefined {
  const raw = res.headers?.get?.("retry-after");
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function postForm(deps: DeviceLoginDeps, url: string, fields: Record<string, string>): Promise<Response> {
  return deps.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: formBody(fields),
  });
}

const safeError = (body: any): string => (typeof body?.error === "string" ? body.error : "unknown_error");

// ── Discovery and registration ──────────────────────────────────────────────

export function fallbackEndpoints(origin: string): ServerEndpoints {
  const o = normalizeOrigin(origin);
  return {
    device_authorization_endpoint: `${o}/api/auth/oauth-device-authorization`,
    token_endpoint: `${o}/api/auth/oauth-token`,
    registration_endpoint: `${o}/api/auth/oauth-register`,
    revocation_endpoint: `${o}/api/auth/oauth-revoke`,
  };
}

/** RFC 8414 discovery; the documented paths are only a fallback for when discovery fails. */
export async function discoverEndpoints(deps: DeviceLoginDeps, origin: string): Promise<ServerEndpoints> {
  const fallback = fallbackEndpoints(origin);
  try {
    const res = await deps.fetch(`${normalizeOrigin(origin)}/.well-known/oauth-authorization-server`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return fallback;
    const meta = await readJson(res);
    const pick = (key: keyof ServerEndpoints): string =>
      typeof meta?.[key] === "string" && meta[key] ? meta[key] : fallback[key];
    return {
      device_authorization_endpoint: pick("device_authorization_endpoint"),
      token_endpoint: pick("token_endpoint"),
      registration_endpoint: pick("registration_endpoint"),
      revocation_endpoint: pick("revocation_endpoint"),
    };
  } catch {
    return fallback;
  }
}

/** RFC 7591 public client for the device grant: no redirect_uris, no secret. */
export async function registerClient(deps: DeviceLoginDeps, endpoints: ServerEndpoints): Promise<string> {
  const res = await deps.fetch(endpoints.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: DEVICE_LOGIN_CLIENT_NAME,
      grant_types: [DEVICE_GRANT_TYPE, "refresh_token"],
      response_types: [],
      token_endpoint_auth_method: "none",
      scope: DEVICE_LOGIN_SCOPE,
    }),
  });
  const body = await readJson(res);
  if (!res.ok || typeof body?.client_id !== "string" || !body.client_id) {
    throw new DeviceLoginError(
      "authorization_failed",
      `Didit refused to register this sign-in client (${res.ok ? "no client_id returned" : safeError(body)}, HTTP ${res.status}).`,
    );
  }
  return body.client_id;
}

export function deviceName(): string {
  const raw = process.env.DIDIT_DEVICE_NAME || os.hostname() || "unknown device";
  return raw.trim().slice(0, 64) || "unknown device";
}

// ── Device authorization ────────────────────────────────────────────────────

async function requestDeviceAuthorization(
  deps: DeviceLoginDeps,
  endpoints: ServerEndpoints,
  clientId: string,
): Promise<{ res: Response; body: any }> {
  const res = await postForm(deps, endpoints.device_authorization_endpoint, {
    client_id: clientId,
    scope: DEVICE_LOGIN_SCOPE,
    device_name: deviceName(),
  });
  return { res, body: await readJson(res) };
}

/**
 * Starts a device login: discovers the server, reuses (or registers) the client, and asks for a
 * device code. A cached client the server no longer knows is registered again once.
 */
export async function startDeviceLogin(
  deps: DeviceLoginDeps = defaultDeps,
  origin: string = MCP_AUTHORIZATION_SERVER_ORIGIN,
  file = credentialsFilePath(),
): Promise<PendingDeviceLogin> {
  const endpoints = await discoverEndpoints(deps, origin);
  const stored = loadCredentials(origin, file);
  let clientId = stored?.client_id;
  let registeredNow = false;
  if (!clientId) {
    clientId = await registerClient(deps, endpoints);
    registeredNow = true;
  }

  let { res, body } = await requestDeviceAuthorization(deps, endpoints, clientId);
  if (!res.ok && !registeredNow && (body?.error === "invalid_client" || body?.error === "unauthorized_client")) {
    clientId = await registerClient(deps, endpoints);
    registeredNow = true;
    ({ res, body } = await requestDeviceAuthorization(deps, endpoints, clientId));
  }
  if (!res.ok) {
    if (res.status === 429 || body?.error === "slow_down") {
      throw new DeviceLoginError("slow_down", "Didit asked to slow down. Wait a moment and try again.", retryAfter(res));
    }
    if (res.status === 503 || body?.error === "temporarily_unavailable") {
      throw new DeviceLoginError("temporarily_unavailable", "Didit sign-in is temporarily unavailable. Try again shortly.", retryAfter(res));
    }
    throw new DeviceLoginError("authorization_failed", `Didit refused the sign-in request (${safeError(body)}, HTTP ${res.status}).`);
  }
  for (const key of ["device_code", "user_code", "verification_uri"] as const) {
    if (typeof body?.[key] !== "string" || !body[key]) {
      throw new DeviceLoginError("authorization_failed", `Didit returned an incomplete sign-in response (missing ${key}).`);
    }
  }

  // Keep the client for the next login even if this one is abandoned.
  if (registeredNow || !stored) saveCredentials(origin, { ...stored, client_id: clientId }, file);

  const now = deps.now();
  const interval = Number(body.interval) > 0 ? Number(body.interval) : DEFAULT_INTERVAL_S;
  const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : 600;
  return {
    origin: normalizeOrigin(origin),
    endpoints,
    client_id: clientId,
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    verification_uri_complete:
      typeof body.verification_uri_complete === "string" && body.verification_uri_complete
        ? body.verification_uri_complete
        : body.verification_uri,
    expires_at: now + expiresIn * 1000,
    interval,
    last_poll_at: now,
  };
}

export type PollOutcome = { status: "pending" } | ({ status: "connected" } & DeviceLoginResult);

/**
 * Polls the token endpoint until the person decides, the code expires, or `deadline` (epoch ms)
 * passes. Never polls faster than the current interval; slow_down adds 5 s for every later poll.
 * Returns pending when the deadline hits first (the caller may call again with the same
 * `pending`, which carries the interval and last poll time).
 */
export async function pollDeviceLogin(
  deps: DeviceLoginDeps,
  pending: PendingDeviceLogin,
  options: { deadline?: number; file?: string } = {},
): Promise<PollOutcome> {
  const file = options.file ?? credentialsFilePath();
  for (;;) {
    const earliest = pending.last_poll_at + pending.interval * 1000;
    // The next allowed poll would land after the code's lifetime (a slow_down near the end can push
    // it there): the code is dead by then, so stop instead of sending a request it cannot answer.
    if (deps.now() >= pending.expires_at || earliest >= pending.expires_at) {
      throw new DeviceLoginError("expired_token", "The sign-in code expired before it was approved. Start the login again.");
    }
    if (options.deadline !== undefined && earliest > options.deadline) return { status: "pending" };
    const wait = earliest - deps.now();
    if (wait > 0) await deps.sleep(wait);

    pending.last_poll_at = deps.now();
    let res: Response | undefined;
    let body: any = {};
    try {
      res = await postForm(deps, pending.endpoints.token_endpoint, {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: pending.device_code,
        client_id: pending.client_id,
      });
      body = await readJson(res);
    } catch {
      // Network blip: back off like a 503 and keep going until the code expires.
      pending.interval = Math.min(pending.interval + SLOW_DOWN_STEP_S, MAX_BACKOFF_S);
      continue;
    }

    if (res.ok && typeof body?.access_token === "string" && typeof body?.refresh_token === "string") {
      const scope = typeof body.scope === "string" ? body.scope : "";
      saveCredentials(
        pending.origin,
        {
          client_id: pending.client_id,
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_at: deps.now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600) * 1000,
          scope,
          signed_in_at: deps.now(),
        },
        file,
      );
      return { status: "connected", scope, credentialsPath: file };
    }

    const error = safeError(body);
    if (error === "authorization_pending") continue;
    if (error === "slow_down" || res.status === 429) {
      pending.interval += SLOW_DOWN_STEP_S;
      continue;
    }
    if (error === "temporarily_unavailable" || res.status === 503) {
      const hinted = retryAfter(res);
      pending.interval = Math.min(Math.max(hinted ?? 0, pending.interval + SLOW_DOWN_STEP_S), MAX_BACKOFF_S);
      continue;
    }
    if (error === "expired_token") {
      throw new DeviceLoginError("expired_token", "The sign-in code expired before it was approved. Start the login again.");
    }
    if (error === "access_denied") {
      throw new DeviceLoginError("access_denied", "The sign-in request was denied on the Didit page. Nothing was connected.");
    }
    throw new DeviceLoginError("authorization_failed", `Sign-in failed (${error}). Start the login again.`);
  }
}

// ── Refresh and revocation ──────────────────────────────────────────────────

const inFlightRefreshes = new Map<string, Promise<StoredCredentials | undefined>>();

async function refreshCredentials(
  deps: DeviceLoginDeps,
  origin: string,
  file: string,
): Promise<StoredCredentials | undefined> {
  // Re-read inside the lock: another process may have rotated the pair while we waited.
  const current = loadCredentials(origin, file);
  if (!current?.refresh_token) return undefined;
  if (current.access_token && (current.expires_at ?? 0) - deps.now() > REFRESH_SKEW_MS) return current;

  const endpoints = await discoverEndpoints(deps, origin);
  let res: Response;
  try {
    res = await postForm(deps, endpoints.token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
      client_id: current.client_id,
    });
  } catch {
    // A network failure says nothing about the grant: keep the credentials (and a token that still
    // works) and try again on the next call.
    throw new DeviceLoginError("temporarily_unavailable", "Could not reach Didit to refresh the sign-in.");
  }
  const body = await readJson(res);
  if (res.ok && typeof body?.access_token === "string") {
    // Refresh tokens rotate: reuse of the old one revokes the grant, so always store the new one.
    const next: StoredCredentials = {
      client_id: current.client_id,
      access_token: body.access_token,
      refresh_token: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : current.refresh_token,
      expires_at: deps.now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600) * 1000,
      scope: typeof body.scope === "string" ? body.scope : current.scope,
      ...(current.signed_in_at !== undefined ? { signed_in_at: current.signed_in_at } : {}),
    };
    saveCredentials(origin, next, file);
    return next;
  }
  const error = safeError(body);
  if (error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client") {
    // Revoked (or the client is gone): drop everything; the next login registers a fresh client.
    deleteCredentials(origin, file);
    throw new DeviceLoginError("login_required", "Your Didit sign-in was revoked or expired. Log in again with `didit-mcp-server login`.");
  }
  throw new DeviceLoginError("temporarily_unavailable", `Could not refresh the Didit sign-in (${error}, HTTP ${res.status}).`);
}

/**
 * The stored device-login access token, refreshed when it expires within 60 s. Concurrent callers
 * share one refresh (a rotating refresh token may be used once). Returns undefined when nothing is
 * stored; throws login_required when the grant was revoked.
 */
export async function getStoredAccessToken(
  deps: DeviceLoginDeps = defaultDeps,
  origin: string = MCP_AUTHORIZATION_SERVER_ORIGIN,
  file = credentialsFilePath(),
): Promise<string | undefined> {
  const stored = loadCredentials(origin, file);
  if (!stored?.refresh_token) return undefined;
  if (stored.access_token && (stored.expires_at ?? 0) - deps.now() > REFRESH_SKEW_MS) return stored.access_token;

  const key = `${file}\n${normalizeOrigin(origin)}`;
  let job = inFlightRefreshes.get(key);
  if (!job) {
    job = refreshCredentials(deps, origin, file).finally(() => inFlightRefreshes.delete(key));
    inFlightRefreshes.set(key, job);
  }
  try {
    return (await job)?.access_token;
  } catch (err) {
    // A transient outage must not drop a token that still works for a few more seconds.
    if (err instanceof DeviceLoginError && err.code === "temporarily_unavailable" && stored.access_token && (stored.expires_at ?? 0) > deps.now()) {
      return stored.access_token;
    }
    throw err;
  }
}

/** RFC 7009 revocation of the refresh token, then the local credentials for this origin go. */
export async function logout(
  deps: DeviceLoginDeps = defaultDeps,
  origin: string = MCP_AUTHORIZATION_SERVER_ORIGIN,
  file = credentialsFilePath(),
): Promise<{ hadCredentials: boolean; revoked: boolean }> {
  const stored = loadCredentials(origin, file);
  if (!stored?.refresh_token) {
    // Drop a client-id-only entry too, nothing else to revoke.
    deleteCredentials(origin, file);
    return { hadCredentials: false, revoked: false };
  }
  let revoked = false;
  try {
    const endpoints = await discoverEndpoints(deps, origin);
    // RFC 7009: the authorization server only accepts revocations from a client it registered.
    const res = await postForm(deps, endpoints.revocation_endpoint, {
      token: stored.refresh_token,
      token_type_hint: "refresh_token",
      client_id: stored.client_id,
    });
    revoked = res.ok;
  } catch {
    // Offline logout still removes the local copy; the server grant can be revoked from the console.
  }
  deleteCredentials(origin, file);
  return { hadCredentials: true, revoked };
}

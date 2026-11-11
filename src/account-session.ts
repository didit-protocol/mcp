/**
 * The sign-in the local (stdio) server keeps after the account tools.
 *
 * didit_account_verify_email, didit_account_login and didit_account_verify_2fa answer with an
 * access token. The server used to hand it to the model and forget it, so the very next tool
 * call was unauthenticated: an agent that had just created an account could not create a
 * workflow without restarting the server with DIDIT_ACCESS_TOKEN set. The server now keeps the
 * sign-in the way it keeps a device-code one (device-login.ts): in the same credentials file,
 * readable by the person only, and refreshed before it expires.
 *
 * - It is stored under the auth service's address; a device-code sign-in is stored under the
 *   console's. Neither overwrites the other, and the local server uses whichever is newer.
 * - The refresh token never leaves this module. The auth service rotates it on every use and
 *   ends the session when an old one is presented again, so a copy in the model's hands would
 *   be a way to sign the server out by accident. The tools' answers no longer carry it.
 * - When the credentials file cannot be written (a read-only home directory in a container),
 *   the sign-in is kept in memory for the life of the process instead.
 *
 * A token (access or refresh) is never logged, printed or put in an error message.
 */
import { DIDIT_AUTH_BASE_URL, MCP_AUTHORIZATION_SERVER_ORIGIN } from "./config";
import {
  DeviceLoginDeps,
  DeviceLoginError,
  REFRESH_SKEW_MS,
  StoredCredentials,
  credentialsFilePath,
  defaultDeps,
  deleteCredentials,
  getStoredAccessToken,
  loadCredentials,
  normalizeOrigin,
  saveCredentials,
} from "./device-login";

/** Where the sign-in is kept: the credentials file, or this process's memory when the file cannot be written. */
export type KeptIn = { where: "file"; path: string } | { where: "memory" };

/** The key of an account-tools sign-in in the credentials file. */
const storeKey = (authBaseUrl: string): string => normalizeOrigin(authBaseUrl);

/**
 * The file is the store. This holds what the file could not be made to say: a sign-in whose
 * write failed, or `null` for a sign-in that ended while the file could not be updated. An entry
 * here is always newer than the file, so it wins: otherwise a file that turned read-only would
 * keep the server acting as the account that was signed in before. Kept per credentials file
 * and auth address, and dropped as soon as the file can be written again.
 */
const unsaved = new Map<string, StoredCredentials | null>();
const unsavedKey = (authBaseUrl: string, file: string): string => `${file}\n${storeKey(authBaseUrl)}`;

/** The claims of a JWT, unverified: only to read which client the token was issued to. */
function claimsOf(token: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));

    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function load(authBaseUrl: string, file: string): StoredCredentials | undefined {
  const key = unsavedKey(authBaseUrl, file);
  if (unsaved.has(key)) return unsaved.get(key) ?? undefined;

  return loadCredentials(storeKey(authBaseUrl), file);
}

function store(authBaseUrl: string, session: StoredCredentials, file: string): KeptIn {
  const key = unsavedKey(authBaseUrl, file);
  try {
    saveCredentials(storeKey(authBaseUrl), session, file);
    unsaved.delete(key);

    return { where: "file", path: file };
  } catch {
    // A home directory that cannot be written must not cost the sign-in.
    unsaved.set(key, session);

    return { where: "memory" };
  }
}

function forget(authBaseUrl: string, file: string): boolean {
  const key = unsavedKey(authBaseUrl, file);
  const had = load(authBaseUrl, file) !== undefined;
  try {
    deleteCredentials(storeKey(authBaseUrl), file);
  } catch {
    // Checked below: what matters is what the file says now, not how the delete failed.
  }
  // A delete can fail without throwing (the last entry is removed by unlinking the file, and
  // that error is swallowed), so read the file back. If it still holds the sign-in, remember
  // here that it is over.
  let stillInFile = true;
  try {
    stillInFile = loadCredentials(storeKey(authBaseUrl), file) !== undefined;
  } catch {
    // Unreadable: nothing can be loaded from it either, but stay on the safe side.
  }
  if (stillInFile) unsaved.set(key, null);
  else unsaved.delete(key);

  return had;
}

/**
 * Keep the sign-in an account tool just returned. `tokens` is the auth service's answer
 * (`access_token`, `refresh_token`, `expires_in`); anything without an access token (a second
 * factor step, an SSO notice) keeps nothing and returns undefined.
 */
export function keepAccountSession(
  tokens: unknown,
  deps: DeviceLoginDeps = defaultDeps,
  authBaseUrl: string = DIDIT_AUTH_BASE_URL,
  file = credentialsFilePath(),
): KeptIn | undefined {
  const answer = (tokens && typeof tokens === "object" ? tokens : {}) as Record<string, unknown>;
  if (typeof answer.access_token !== "string" || !answer.access_token) return undefined;
  const claims = claimsOf(answer.access_token);
  const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.aud === "string" ? claims.aud : "";
  const lifetime = Number(answer.expires_in) > 0 ? Number(answer.expires_in) : 3600;

  return store(
    authBaseUrl,
    {
      client_id: clientId,
      access_token: answer.access_token,
      ...(typeof answer.refresh_token === "string" && answer.refresh_token ? { refresh_token: answer.refresh_token } : {}),
      expires_at: deps.now() + lifetime * 1000,
      signed_in_at: deps.now(),
    },
    file,
  );
}

/** Remove the kept account-tools sign-in from this machine. Returns whether there was one. */
export function forgetAccountSession(authBaseUrl: string = DIDIT_AUTH_BASE_URL, file = credentialsFilePath()): boolean {
  return forget(authBaseUrl, file);
}

const inFlightRefreshes = new Map<string, Promise<StoredCredentials>>();

const SIGN_IN_AGAIN =
  "Your Didit sign-in expired or was ended. Sign in again with didit_account_login (or run `didit-mcp-server login`).";

async function refresh(deps: DeviceLoginDeps, authBaseUrl: string, file: string): Promise<StoredCredentials> {
  // Re-read: another process sharing the file may have rotated the pair while this one waited.
  const current = load(authBaseUrl, file);
  if (!current?.access_token) throw new DeviceLoginError("login_required", SIGN_IN_AGAIN);
  if ((current.expires_at ?? 0) - deps.now() > REFRESH_SKEW_MS) return current;
  if (!current.refresh_token || !current.client_id) {
    forget(authBaseUrl, file);
    throw new DeviceLoginError("login_required", SIGN_IN_AGAIN);
  }

  let res: Response;
  try {
    // service-didit-auth `/token/`: a JSON body, and the client the token was issued to.
    res = await deps.fetch(`${normalizeOrigin(authBaseUrl)}/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: current.refresh_token, client_id: current.client_id }),
    });
  } catch {
    // A network failure says nothing about the session: keep it and try again on the next call.
    throw new DeviceLoginError("temporarily_unavailable", "Could not reach Didit to refresh the sign-in.");
  }
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    // A body that is not JSON is handled by the status below.
  }
  if (res.ok && typeof body?.access_token === "string" && body.access_token) {
    const next: StoredCredentials = {
      client_id: current.client_id,
      access_token: body.access_token,
      // The auth service rotates the refresh token on every use: always keep the new one.
      refresh_token: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : current.refresh_token,
      expires_at: deps.now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600) * 1000,
      signed_in_at: current.signed_in_at,
    };
    store(authBaseUrl, next, file);

    return next;
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    // The session is over (expired, ended from the console, or its refresh token was used elsewhere).
    forget(authBaseUrl, file);
    throw new DeviceLoginError("login_required", SIGN_IN_AGAIN);
  }
  throw new DeviceLoginError("temporarily_unavailable", `Could not refresh the Didit sign-in (HTTP ${res.status}).`);
}

/**
 * The kept account-tools access token, refreshed when it expires within 60 s. Concurrent callers
 * share one refresh (a refresh token works once). Returns undefined when nothing is kept; throws
 * login_required when the session is over.
 */
export async function accountSessionToken(
  deps: DeviceLoginDeps = defaultDeps,
  authBaseUrl: string = DIDIT_AUTH_BASE_URL,
  file = credentialsFilePath(),
): Promise<string | undefined> {
  const kept = load(authBaseUrl, file);
  if (!kept?.access_token) return undefined;
  if ((kept.expires_at ?? 0) - deps.now() > REFRESH_SKEW_MS) return kept.access_token;

  const key = `${file}\n${storeKey(authBaseUrl)}`;
  let job = inFlightRefreshes.get(key);
  if (!job) {
    job = refresh(deps, authBaseUrl, file).finally(() => inFlightRefreshes.delete(key));
    inFlightRefreshes.set(key, job);
  }
  try {
    return (await job).access_token;
  } catch (error) {
    // A transient outage must not drop a token that still works for a few more seconds.
    if (error instanceof DeviceLoginError && error.code === "temporarily_unavailable" && (kept.expires_at ?? 0) > deps.now()) {
      return kept.access_token;
    }
    throw error;
  }
}

/**
 * The access token of the local server's sign-in: the device-code one or the account-tools one,
 * whichever the person did last. Returns undefined when neither exists.
 */
export async function localSignInToken(
  deps: DeviceLoginDeps = defaultDeps,
  consoleOrigin: string = MCP_AUTHORIZATION_SERVER_ORIGIN,
  authBaseUrl: string = DIDIT_AUTH_BASE_URL,
  file = credentialsFilePath(),
): Promise<string | undefined> {
  const device = loadCredentials(consoleOrigin, file);
  const account = load(authBaseUrl, file);
  const deviceToken = () => getStoredAccessToken(deps, consoleOrigin, file);
  const accountToken = () => accountSessionToken(deps, authBaseUrl, file);
  // A device-code entry without a refresh token is only a remembered client, not a sign-in.
  if (!device?.refresh_token) return accountToken();
  if (!account?.access_token) return deviceToken();

  const accountIsNewer = (account.signed_in_at ?? 0) >= (device.signed_in_at ?? 0);
  const [newer, older] = accountIsNewer ? [accountToken, deviceToken] : [deviceToken, accountToken];
  try {
    return await newer();
  } catch (error) {
    // The newer sign-in is over (and was removed by its own refresh): the older one still stands.
    if (!(error instanceof DeviceLoginError) || error.code !== "login_required") throw error;
    const fallback = await older();
    if (fallback === undefined) throw error;

    return fallback;
  }
}

/**
 * What an account tool answers once the server kept its sign-in: the same answer without the
 * refresh token, and a line saying the next tools are authenticated. Answers that carry no
 * access token (a second factor step, an SSO notice) pass through unchanged.
 */
export function signedInAnswer(answer: unknown, kept: KeptIn | undefined): unknown {
  if (!kept || !answer || typeof answer !== "object") return answer;
  const { refresh_token: _refreshToken, ...rest } = answer as Record<string, unknown>;

  return {
    ...rest,
    signed_in: true,
    next_step:
      (kept.where === "file"
        ? `Signed in. The local server keeps this sign-in in ${kept.path} (readable by you only) and refreshes it, `
        : "Signed in. The credentials file could not be written, so the local server keeps this sign-in in memory until it stops, ") +
      "so the tools that follow are authenticated: do not pass access_token to them. Call didit_context_get for the " +
      "organization and its applications (each application's mode is live or sandbox).",
  };
}

/**
 * What the server does with an account tool's answer: on the local server, keep the sign-in so
 * the next tool is authenticated and take the refresh token out of what the model sees.
 *
 * A hosted server keeps nothing, ever: its process and its credentials file are shared by every
 * caller, so one caller's refresh token must never land there. A hosted server already refuses
 * the account tools before they run (index.ts); this is the same rule stated where the token is
 * stored, so it holds whatever happens to that refusal.
 */
export function keepSignIn(
  answer: unknown,
  options: { hosted: boolean },
  deps: DeviceLoginDeps = defaultDeps,
  authBaseUrl: string = DIDIT_AUTH_BASE_URL,
  file = credentialsFilePath(),
): unknown {
  if (options.hosted) return answer;

  return signedInAnswer(answer, keepAccountSession(answer, deps, authBaseUrl, file));
}

import { DIDIT_AUTH_BASE_URL, apiRequest, getAuthHeaders } from "../config";
import {
  DeviceLoginError,
  PendingDeviceLogin,
  defaultDeps,
  pollDeviceLogin,
  startDeviceLogin,
} from "../device-login";
import { redactApplication, redactCollection, pathSegment, DiditError } from "../security";
import { wholeEnvelope } from "../paging";

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function register(email: string, password: string): Promise<any> {
  return apiRequest("/programmatic/register/", {
    method: "POST",
    baseUrl: DIDIT_AUTH_BASE_URL,
    headers: JSON_HEADERS,
    json: { email, password },
  });
}

export async function verifyEmail(email: string, code: string): Promise<any> {
  try {
    const res = await apiRequest("/programmatic/verify-email/", {
      method: "POST",
      baseUrl: DIDIT_AUTH_BASE_URL,
      headers: JSON_HEADERS,
      json: { email, code },
    });
    // An account that already has a second factor gets the login's step up instead of tokens (auth #982).
    return res?.["2fa_required"] ? twoFactorStepUp(res) : res;
  } catch (error) {
    const sso = ssoRequiredResult(error);
    if (sso) return sso;
    throw error;
  }
}

// auth #986: a member of an organization that enforces SSO gets 403 `sso_required` from the password login
// and from verify-email. No token, API key or application is issued programmatically, so this is a result
// the agent hands to the person, not a failure to retry.
function ssoRequiredResult(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof DiditError) || error.shape.status !== 403 || error.shape.backend_code !== "sso_required") {
    return undefined;
  }
  const organization = error.shape.sso_organization;
  return {
    sso_required: true,
    ...(organization?.name ? { organization_name: organization.name } : {}),
    ...(organization?.slug ? { organization_slug: organization.slug } : {}),
    next_step:
      `This account${organization?.name ? ` belongs to the organization '${organization.name}', which` : "'s organization"} ` +
      "enforces SSO, so no access token or API key is issued here and retrying will not help. Ask the person to sign in " +
      "to the Didit console (https://business.didit.me) through their organization's SSO in a browser. " +
      "To use the API afterwards, they create an API key in the console, or approve a code with didit_account_device_login_start.",
  };
}

export async function login(email: string, password: string): Promise<any> {
  // Redact any echoed api_key/client_secret; keep access_token/refresh_token (the caller needs them).
  let res: any;
  try {
    res = redactApplication(
      await apiRequest("/programmatic/login/", {
        method: "POST",
        baseUrl: DIDIT_AUTH_BASE_URL,
        headers: JSON_HEADERS,
        json: { email, password },
      }),
    );
  } catch (error) {
    const sso = ssoRequiredResult(error);
    if (sso) return sso;
    throw error;
  }
  return res?.["2fa_required"] ? twoFactorStepUp(res) : res;
}

// once an account has a second factor enrolled, the password alone no longer
// returns tokens - the backend answers with a 5-minute temp_token for /2fa/verify/ instead.
// That step only accepts an authenticator (TOTP) or backup code; a passkey needs a browser.
function twoFactorStepUp(res: any): any {
  const base = { "2fa_required": true, has_authenticator: !!res.has_authenticator, has_passkeys: !!res.has_passkeys };
  if (!res.has_authenticator) {
    return {
      ...base,
      next_step:
        "This account signs in with a passkey, which a password login cannot use. Call didit_account_device_login_start " +
        "(or run `didit-mcp-server login` in a terminal) to approve a code on any device with a browser, connect the " +
        "hosted Didit MCP connector, or add an authenticator app to the account and log in again.",
    };
  }
  return {
    ...base,
    temp_token: res.temp_token,
    expires_in: 300,
    next_step:
      "Ask the user for the current 6-digit code from their authenticator app (or an unused backup code) and call " +
      "didit_account_verify_2fa with this temp_token within 5 minutes.",
  };
}

export async function verify2fa(tempToken: string, code: string): Promise<any> {
  return redactApplication(
    await apiRequest("/2fa/verify/", {
      method: "POST",
      baseUrl: DIDIT_AUTH_BASE_URL,
      headers: JSON_HEADERS,
      json: { temp_token: tempToken, otp_token: code },
    }),
  );
}

export async function resendOtp(email: string): Promise<any> {
  return apiRequest("/programmatic/resend-otp/", {
    method: "POST",
    baseUrl: DIDIT_AUTH_BASE_URL,
    headers: JSON_HEADERS,
    json: { email },
  });
}

// Discovery tools work in BOTH modes: hosted/OAuth (accessToken omitted → headers default to
// the request-context user Bearer) and stdio (explicit accessToken from didit_login).
// Both lists are paged by the API (50 a page) and both are read whole: they are what every
// scope is resolved from, so an organization or an application on a second page would not
// exist for the caller (paging.ts).
export async function listOrganizations(accessToken?: string): Promise<any> {
  return wholeEnvelope((page) =>
    apiRequest("/organizations/me/", {
      baseUrl: DIDIT_AUTH_BASE_URL,
      headers: accessToken ? getAuthHeaders(accessToken) : undefined,
      params: page,
    }),
  );
}

export async function listApplications(orgId: string, accessToken?: string): Promise<any> {
  const path = `/organizations/me/${pathSegment(orgId, "organization_id")}/applications/`;
  const res = await wholeEnvelope((page) =>
    apiRequest(path, {
      baseUrl: DIDIT_AUTH_BASE_URL,
      headers: accessToken ? getAuthHeaders(accessToken) : undefined,
      params: page,
    }),
  );
  return redactCollection(res, redactApplication);
}

export async function getApplication(orgId: string, appId: string, accessToken?: string): Promise<any> {
  const res = await apiRequest(
    `/organizations/me/${pathSegment(orgId, "organization_id")}/applications/${pathSegment(appId, "application_id")}/`,
    { baseUrl: DIDIT_AUTH_BASE_URL, headers: accessToken ? getAuthHeaders(accessToken) : undefined },
  );
  return redactApplication(res);
}

/**
 * The ONLY path that returns a live, UN-redacted api_key. Requires confirm:true AND an
 * explicit organization_id + application_id (no env-default fallback). The raw key must
 * not be logged or persisted.
 */
export async function revealApplicationApiKey(
  orgId: unknown,
  appId: unknown,
  confirm: unknown,
  accessToken?: string,
): Promise<any> {
  if (typeof orgId !== "string" || !orgId.trim() || typeof appId !== "string" || !appId.trim()) {
    throw new DiditError({
      code: "missing_scope",
      message: "organization_id and application_id must both be provided explicitly to reveal a raw api_key.",
      hint: "Raw-secret tools never fall back to env/context defaults — pass both ids.",
    });
  }
  if (confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: "Revealing a live api_key exposes a secret. Re-call with confirm:true to proceed.",
      field: "confirm",
      hint: "Only reveal the key when a human explicitly needs it to integrate. Do not log or persist it.",
    });
  }
  return apiRequest(
    `/organizations/me/${pathSegment(orgId, "organization_id")}/applications/${pathSegment(appId, "application_id")}/`,
    { baseUrl: DIDIT_AUTH_BASE_URL, headers: accessToken ? getAuthHeaders(accessToken) : undefined },
  );
}

// ── Device-code sign-in (RFC 8628), stdio only ──────────────────────────────
// The pending device_code stays in this module's memory: the agent only ever sees the user_code
// and the URLs, never the secret that redeems the grant.
let pendingDeviceLogin: PendingDeviceLogin | undefined;
const POLL_WINDOW_MS = 45_000;

const deviceLoginFailure = (err: unknown): never => {
  if (err instanceof DeviceLoginError) {
    throw new DiditError({
      code: err.code === "access_denied" ? "forbidden" : err.code === "temporarily_unavailable" || err.code === "slow_down" ? "rate_limited" : "bad_request",
      message: err.message,
      hint:
        err.code === "access_denied"
          ? "The person denied the request. Do not retry unless they ask you to."
          : "Call didit_account_device_login_start to begin a new sign-in.",
    });
  }
  throw err;
};

export async function deviceLoginStart(): Promise<any> {
  try {
    pendingDeviceLogin = await startDeviceLogin(defaultDeps);
  } catch (err) {
    return deviceLoginFailure(err);
  }
  const p = pendingDeviceLogin;
  return {
    verification_uri: p.verification_uri,
    verification_uri_complete: p.verification_uri_complete,
    user_code: p.user_code,
    expires_in: Math.max(0, Math.round((p.expires_at - defaultDeps.now()) / 1000)),
    next_step:
      "Show the person the verification_uri and the user_code (or the verification_uri_complete link) and ask them to " +
      "open it on any device with a browser and approve ONLY if the code on that page matches this user_code. " +
      "Then call didit_account_device_login_poll.",
  };
}

export async function deviceLoginPoll(): Promise<any> {
  const pending = pendingDeviceLogin;
  if (!pending) {
    throw new DiditError({
      code: "bad_request",
      message: "No device sign-in is pending.",
      hint: "Call didit_account_device_login_start first.",
    });
  }
  try {
    const outcome = await pollDeviceLogin(defaultDeps, pending, { deadline: defaultDeps.now() + POLL_WINDOW_MS });
    if (outcome.status === "pending") {
      return { status: "pending", next_step: "The person has not approved yet. Call didit_account_device_login_poll again." };
    }
    pendingDeviceLogin = undefined;
    return { status: "connected", scope: outcome.scope };
  } catch (err) {
    // Denied, expired and failed requests are final; a transient outage keeps the pending code.
    if (!(err instanceof DeviceLoginError) || err.code !== "temporarily_unavailable") pendingDeviceLogin = undefined;
    return deviceLoginFailure(err);
  }
}

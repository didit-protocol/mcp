import { DIDIT_AUTH_BASE_URL, apiRequest, requestContext, resolveApplicationId, resolveOrganizationId } from "./config";
import { DiditError, pathSegment } from "./security";

// The application API key behind the standalone phone OTP endpoints.
//
// `POST /phone/send/` and `POST /phone/check/` are public product APIs, not console
// endpoints. Their only permission class is `IsValidClient` (service-didit-verification
// `core/permissions.py:183`), which accepts an introspected credential carrying NO
// `identifier`: an application `x-api-key`. A user Bearer always carries one
// (service-didit-auth `authorizations/processors/tokens.py:265`), so it is refused there.
//
// The other standalone tools reach their APIs through the console's user-Bearer proxy
// (`/organization/{org}/application/{app}/apis/<check>/`, gated on `create:sessions`),
// but that proxy registers only aml, id-verification, poa, kyb/*, phone-risk,
// email-risk, ip-risk and fraud-check (`applications/urls.py:1486-1573`): there is no
// `…/apis/phone/send/` or `…/apis/phone/check/`, and both answer 404 on staging and
// production. The application API key is therefore the only credential that works.
//
// The MCP reads it the two supported ways the auth service hands it to a user:
//   1. The console's application read, `GET /organizations/{org}/applications/{app}`
//      (`organizations/views/application.py:86`): `read:applications` to read it at all,
//      and `client_secret` is blanked unless the role holds `create:sessions`
//      (`organizations/serializers/applications.py:100`), the same permission every other
//      standalone tool needs. It only takes console-client tokens, which MCP sign-ins are.
//   2. When that read is refused outright (a local `didit_account_login` token is minted for
//      the user's own application, not the console), the membership read
//      `GET /organizations/me/{org}/applications/{app}/` returns it as `api_key`
//      (`organizations/views/me.py:68`) to organization owners and admins only (`me.py:286`).
//      That read checks the grant's organizations but not its scopes, so a sign-in refused
//      for its scopes never falls back to it: the key stays behind the user's consent.
// Both blank a live application's key for a console browser session while staging's
// LIVE_PRIMARY_SECRET_REVEAL_ONLY is on (`organizations/services/secret_step_up.py:204`);
// MCP tokens are not console sessions and keep it.
//
// The key is a live secret. It is never cached in module state, never returned to a
// caller, never logged (audit-log.ts records argument keys and a digest only) and never
// interpolated into an error message.

// The auth service's refusal when an MCP sign-in's consented scopes do not cover the request
// (service-didit-auth `core/permissions.py:312`). The application read needs the
// `applications` resource, which only didit:management grants (`authorizations/config/mcp_scopes.py:50`).
const MCP_SCOPE_REFUSAL = /token's scope does not permit this action/;

/** Request headers for a public product API that authenticates with the application API key. */
export async function applicationApiKeyHeaders(): Promise<Record<string, string>> {
  return { "Content-Type": "application/json", "x-api-key": await applicationApiKey() };
}

/** The resolved application's API key, read fresh on every call. */
export async function applicationApiKey(): Promise<string> {
  // An API key connection already holds its application's key (api-key-connection.ts).
  const own = requestContext.getStore()?.apiKey;
  if (own) return own;

  const org = pathSegment(resolveOrganizationId(), "organization_id");
  const app = pathSegment(resolveApplicationId(), "application_id");

  let key: unknown;
  try {
    // The console detail route is declared WITHOUT a trailing slash (APPEND_SLASH only adds one).
    const application = await apiRequest(`/organizations/${org}/applications/${app}`, {
      baseUrl: DIDIT_AUTH_BASE_URL,
    });
    key = application?.client_secret;
  } catch (error) {
    if (!isForbidden(error)) throw error;
    if (MCP_SCOPE_REFUSAL.test(error.shape.message)) {
      throw new DiditError({
        ...error.shape,
        code: "missing_scope",
        hint:
          "These tools send the code with the application's API key, and reading it needs the " +
          "didit:management scope, which this sign-in was not granted. Sign in to the Didit MCP " +
          "connector again with didit:management as well as didit:verification.",
      });
    }
    key = await ownerOrAdminApplicationKey(`/organizations/me/${org}/applications/${app}/`);
  }

  if (typeof key !== "string" || !key.trim()) {
    throw new DiditError({
      code: "missing_scope",
      message: "Didit returned no API key for this application to your sign-in.",
      hint:
        "These tools send the code with the application's API key, which Didit only shows to a role " +
        "holding create:sessions (Owner, Admin and Developer have it). A console browser session cannot " +
        "read a live application's key where the console hides it: sign in through the Didit MCP " +
        "connector instead.",
    });
  }

  return key;
}

async function ownerOrAdminApplicationKey(path: string): Promise<unknown> {
  try {
    const application = await apiRequest(path, { baseUrl: DIDIT_AUTH_BASE_URL });

    return application?.api_key;
  } catch (error) {
    // Say which roles can read the key instead of the generic "may require a different role".
    if (isForbidden(error)) {
      throw new DiditError({
        ...error.shape,
        hint:
          "These tools send the code with the application's API key, and this sign-in cannot read it. " +
          "Through the Didit MCP connector it needs a role with create:sessions (Owner, Admin or " +
          "Developer); with a local didit_account_login token, an organization owner or admin.",
      });
    }
    throw error;
  }
}

function isForbidden(error: unknown): error is DiditError {
  return error instanceof DiditError && error.shape.status === 403;
}

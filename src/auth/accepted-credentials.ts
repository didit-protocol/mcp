// Which credentials the HOSTED Didit MCP accepts, and what it says to one it does not.
//
// a token from `POST /programmatic/login` loaded the tool list and then every
// application-scoped call answered `not_found` or `forbidden` with no reason, so the caller
// concluded their account was empty. It is not a credential this server documents:
// `/programmatic/login` mints a token for one of the account's own APPLICATIONS
// (service-didit-auth `programmatic_auth.py`: the first application of the caller's first
// organization that has one, `aud` = that application's client id, `claims` = the application's
// user-data permissions), which is a verification-runtime user token, not a console member
// session and not a "Log in with Didit" grant. service-didit-auth says the same in its own words: it calls
// this "a member token issued to another client (the local MCP server's programmatic login)"
// (`service-didit-verification` billing/services/agent_spending.py).
//
// So the server refuses it at the FIRST request, tool list included, with one error that names
// both supported ways in. It never answers a token it does not accept with `not_found`.
//
// The two credentials it accepts:
//   - a "Log in with Didit" grant: the auth service marks it `token_use: "mcp"` (OAuth code,
//     device code, refresh - `authorizations/processors/tokens.py`);
//   - a first-party console session: the token `business.didit.me` itself is signed in with,
//     `aud` = the console's client id (`APP_CONSOLE_CLIENT_ID` / `STAFF_CONSOLE_CLIENT_ID` in
//     service-didit-auth). The console's own copilot (didit-ai-assistant) relays exactly this
//     token to this server with the person's question, so a deployment that serves it must
//     name those client ids in MCP_CONSOLE_CLIENT_IDS - see deploy/prod.tfvars and stg.tfvars.
// An application API key is the third, handled in api-key-connection.ts before this point.

import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { MCP_CONSOLE_CLIENT_IDS } from "../config";

/** Where the reader finds both supported ways in, and the credentials each one needs. */
export const MCP_AUTH_DOCS_URL = "https://docs.didit.me/integration/mcp/authentication";

/** The auth service's marker for a "Log in with Didit" grant (service-didit-auth TokenUseChoices.MCP). */
const MCP_GRANT_TOKEN_USE = "mcp";

/** The client ids (token `aud`) of the first-party console sessions this deployment serves. */
export function consoleClientIds(): Set<string> {
  return new Set(
    MCP_CONSOLE_CLIENT_IDS.split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export interface IntrospectedCredential {
  /** RFC 7662 `token_use`; only a "Log in with Didit" grant carries it. */
  token_use?: unknown;
  /** The client the token was issued to: the console for a console session, an application for `/programmatic/login`. */
  client_id?: unknown;
  /** The token's `aud`, used when the answer carries no `client_id`. */
  aud?: unknown;
}

/**
 * Whether this token is one of the two the hosted server accepts.
 *
 * Deliberately a whitelist: a token the auth service calls active but that is not a grant for
 * this server and not a console session is a token minted for something else (an application's
 * verification runtime, a delegated support token), and every application-scoped call would then
 * fail at the backend with `not_found`/`forbidden` - the failure this decision replaces.
 */
export function isAcceptedToken(credential: IntrospectedCredential, consoleClients = consoleClientIds()): boolean {
  if (credential.token_use === MCP_GRANT_TOKEN_USE) return true;

  const clientId = typeof credential.client_id === "string" ? credential.client_id : "";
  const audience = typeof credential.aud === "string" ? credential.aud : "";
  const issuedTo = new Set([clientId, audience].filter(Boolean));

  return [...issuedTo].some((client) => consoleClients.has(client));
}

/**
 * The one error a token this server does not accept gets: at the first request, tool list
 * included, naming both supported ways to connect and linking the docs page.
 *
 * `InvalidTokenError` is what the bearer middleware answers with a 401 whose
 * `error_description` carries this text and whose `error_uri` is the docs page, so a person
 * reads the reason in the client instead of diagnosing "my account looks empty".
 */
export function unsupportedCredentialError(): InvalidTokenError {
  return new InvalidTokenError(
    "This is a Didit token issued to an application or another client (the token POST /programmatic/login " +
      "returns is one), not a Didit MCP sign-in, so the hosted Didit MCP cannot act for it. Connect by " +
      "signing in with Didit (OAuth) in your MCP client, or with an application API key in the x-api-key " +
      `header. See ${MCP_AUTH_DOCS_URL}`,
    MCP_AUTH_DOCS_URL,
  );
}

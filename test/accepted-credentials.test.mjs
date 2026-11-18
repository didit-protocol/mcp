import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * which credentials the HOSTED Didit MCP accepts.
 *
 * A token from `POST /programmatic/login` loaded the tool list and then every application-scoped
 * call answered `not_found` or `forbidden` with no reason. That token is not a Didit MCP credential:
 * service-didit-auth mints it for one of the account's own APPLICATIONS (`programmatic_auth.py`,
 * `aud` = that application's client id, `claims` = the application's user-data permissions), and
 * service-didit-verification names it "a member token issued to another client" when it refuses it
 * as a console session. The two accepted credentials are a "Log in with Didit" grant (`token_use:
 * "mcp"`) and a first-party console session (the token the console's own copilot relays).
 */

process.env.MCP_CONSOLE_CLIENT_IDS = "console-client,staff-console-client";
const { isAcceptedToken, unsupportedCredentialError, MCP_AUTH_DOCS_URL } = await import(
  "../dist/auth/accepted-credentials.js"
);

/** What service-didit-auth answers for a `POST /programmatic/login` token. */
const applicationToken = {
  active: true,
  sub: "5bfe5319-625d-487c-a9c3-8f3cf50750b8",
  identifier: "new-customer@example.test",
  client_id: "client-of-the-application",
  aud: "client-of-the-application",
  claims: ["read:picture", "read:email", "read:names"],
  exp: Math.floor(Date.now() / 1000) + 3600,
};

/** What it answers for a "Log in with Didit" grant: the consented scopes and org permissions. */
const grant = {
  ...applicationToken,
  token_use: "mcp",
  scope: "didit:management didit:verification",
  claims: [],
  org_permissions: ["read:sessions", "write:sessions"],
};

/** What it answers for the console session the console's copilot relays: the console's client id. */
const consoleSession = { ...applicationToken, client_id: "console-client", aud: "console-client", claims: [] };

test("a grant and a first-party console session are accepted", () => {
  assert.equal(isAcceptedToken(grant), true);
  assert.equal(isAcceptedToken(consoleSession), true);
  assert.equal(isAcceptedToken({ ...consoleSession, client_id: "staff-console-client" }), true);
  // An older answer may carry only `aud`, and only as a list.
  assert.equal(isAcceptedToken({ token_use: "mcp" }), true);
  assert.equal(isAcceptedToken({ aud: "console-client" }), true);
});

test("a token minted for an application (POST /programmatic/login) is not", () => {
  assert.equal(isAcceptedToken(applicationToken), false);
  // The application's client id is not a first-party console client, even when the deployment
  // serves console sessions.
  assert.equal(isAcceptedToken({ ...applicationToken, client_id: "application-client" }), false);
  // Nothing to classify: refused rather than trusted.
  assert.equal(isAcceptedToken({ active: true }), false);
});

test("the refusal names both supported ways in and links the docs page", () => {
  const error = unsupportedCredentialError();

  // Its own type, so the refusal line names this cause rather than an expired token;
  // still an InvalidTokenError, so the bearer middleware answers it the same way (401 below).
  assert.equal(error.constructor.name, "UnsupportedCredentialError");
  assert.match(error.message, /programmatic\/login/);
  assert.match(error.message, /sign(ing)? in with Didit \(OAuth\)/);
  assert.match(error.message, /application API key in the x-api-key header/);
  assert.ok(error.message.includes(MCP_AUTH_DOCS_URL), "the error links the docs page");
  assert.equal(error.errorUri, MCP_AUTH_DOCS_URL);
  assert.equal(error.errorCode, "invalid_token");
});

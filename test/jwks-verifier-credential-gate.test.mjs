import http from "node:http";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair, jwtVerify } from "jose";

/**
 * the JWKS verifier (`MCP_TOKEN_VERIFY_MODE=jwks`, src/auth/verifier.ts) makes the same
 * credential decision as the introspection verifier, and answers a token it does not accept with
 * the same refusal. Without this the two verifiers can drift: the introspection path is the one the
 * hosted deployment runs today, but a self-hosted one that switches to jwks would then serve again
 * the token the hosted server refuses.
 *
 * Everything is signed here against a JWKS this test serves on 127.0.0.1; nothing leaves the machine.
 */

const ISSUER = "https://business.didit.me";
const RESOURCE = "https://mcp.didit.me/mcp";
const CONSOLE_CLIENT = "console-client";

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" };

const jwks = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((resolve) => jwks.listen(0, "127.0.0.1", resolve));
after(() => jwks.close());

// Config is read when the verifier module loads, so the JWKS URL must be known first.
process.env.DIDIT_JWKS_URL = `http://127.0.0.1:${jwks.address().port}/jwks.json`;
process.env.MCP_RESOURCE_URI = RESOURCE;
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = ISSUER;
process.env.MCP_OAUTH_CLIENT_ID = "";
process.env.MCP_CONSOLE_CLIENT_IDS = CONSOLE_CLIENT;

const { DiditTokenVerifier } = await import("../dist/auth/verifier.js");
const { MCP_AUTH_DOCS_URL } = await import("../dist/auth/accepted-credentials.js");

const verifier = new DiditTokenVerifier();

/** A correctly signed, correctly addressed token: only its claims decide how it is classified. */
function sign(claims) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject(claims.sub ?? "5bfe5319-625d-487c-a9c3-8f3cf50750b8")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

test("a signed token minted for an application is refused with the same error as the introspection path", async () => {
  const token = await sign({ client_id: "client-of-the-application", claims: ["read:picture", "read:email"] });

  // The signature, issuer and audience are all good: only the credential decision can refuse it.
  const { payload } = await jwtVerify(token, publicKey, { issuer: ISSUER, audience: RESOURCE });
  assert.equal(payload.token_use, undefined);

  await assert.rejects(verifier.verifyAccessToken(token), (err) => {
    assert.equal(err.constructor.name, "InvalidTokenError");
    assert.equal(err.errorCode, "invalid_token");
    assert.match(err.message, /programmatic\/login/);
    assert.match(err.message, /signing in with Didit \(OAuth\)/);
    assert.match(err.message, /application API key in the x-api-key header/);
    assert.equal(err.errorUri, MCP_AUTH_DOCS_URL);
    return true;
  });
});

test("a signed 'Log in with Didit' grant is served", async () => {
  const token = await sign({ token_use: "mcp", client_id: "the-mcp-oauth-client", scope: "didit:management" });

  const info = await verifier.verifyAccessToken(token);
  assert.equal(info.clientId, "the-mcp-oauth-client");
  assert.deepEqual(info.scopes, ["didit:management"]);
  assert.equal(info.resource.href, RESOURCE);
});

test("a signed first-party console session is served", async () => {
  const token = await sign({ client_id: CONSOLE_CLIENT, claims: [] });

  const info = await verifier.verifyAccessToken(token);
  assert.equal(info.clientId, CONSOLE_CLIENT);
});

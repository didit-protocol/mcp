import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * An auth service that does not answer is not an invalid token: a local first-try run of the
 * staging demo prompt (2026-11-04) got "Introspection request failed: TimeoutError" as a 401, and
 * the assistant told the user their session had expired in the middle of a workflow build.
 */

process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/introspect/";
const { IntrospectionTokenVerifier } = await import("../dist/auth/introspection-verifier.js");

const active = { active: true, sub: "u-1", organization_id: "org-1", org_permissions: ["read:workflows"] };
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function auth(answers) {
  let calls = 0;
  globalThis.fetch = async () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return () => calls;
}

test("a timeout is retried once and the token verifies on the second answer", async () => {
  const calls = auth([new DOMException("The operation was aborted due to timeout", "TimeoutError"), json(active)]);

  const info = await new IntrospectionTokenVerifier().verifyAccessToken("tok");

  assert.equal(info.extra.sub, "u-1");
  assert.equal(calls(), 2);
});

test("an auth service that keeps failing is a server error, never an invalid token", async () => {
  const calls = auth([json({}, 503), new Error("ECONNRESET")]);

  await assert.rejects(new IntrospectionTokenVerifier().verifyAccessToken("tok"), (error) => {
    assert.equal(error.constructor.name, "ServerError");
    assert.match(error.message, /Token introspection unavailable/);
    return true;
  });
  assert.equal(calls(), 2);
});

test("an inactive token and a 4xx stay an invalid token, without a retry", async () => {
  const inactive = auth([json({ active: false })]);
  await assert.rejects(new IntrospectionTokenVerifier().verifyAccessToken("tok"), (error) => {
    assert.equal(error.constructor.name, "InvalidTokenError");
    return true;
  });
  assert.equal(inactive(), 1);

  const refused = auth([json({ detail: "bad client" }, 401)]);
  await assert.rejects(new IntrospectionTokenVerifier().verifyAccessToken("tok"), (error) => {
    assert.equal(error.constructor.name, "InvalidTokenError");
    return true;
  });
  assert.equal(refused(), 1);
});

test("a throttled auth service (429) is retried and then a server error, not an expired token", async () => {
  const calls = auth([json({ detail: "slow down" }, 429), json({ detail: "slow down" }, 429)]);

  await assert.rejects(new IntrospectionTokenVerifier().verifyAccessToken("tok"), (error) => {
    assert.equal(error.constructor.name, "ServerError");
    return true;
  });
  assert.equal(calls(), 2);
});

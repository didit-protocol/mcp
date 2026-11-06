import test from "node:test";
import assert from "node:assert/strict";
import { CachingTokenVerifier } from "../dist/auth/cached-verifier.js";

/** An inner verifier that counts its calls and answers what each test says. */
function innerVerifier(answer) {
  const calls = { count: 0 };
  return {
    calls,
    async verifyAccessToken(token) {
      calls.count += 1;
      return answer(token, calls.count);
    },
  };
}

const accepted = (token) => ({
  token,
  clientId: "console",
  scopes: ["read:sessions"],
  extra: { sub: "user-1", organization_id: "org-1" },
});

test("an accepted token is introspected once per TTL, not once per request", async () => {
  let now = 1_000_000;
  const inner = innerVerifier(accepted);
  const verifier = new CachingTokenVerifier(inner, 60_000, 100, () => now);

  // initialize, notifications/initialized, tools/list: one introspection.
  for (let i = 0; i < 3; i++) {
    assert.equal((await verifier.verifyAccessToken("tok")).extra.sub, "user-1");
  }
  assert.equal(inner.calls.count, 1);

  now += 60_000;
  await verifier.verifyAccessToken("tok");
  assert.equal(inner.calls.count, 2, "past the TTL the token is checked again");
});

test("a rejected or unverifiable token is never remembered", async () => {
  const inner = innerVerifier((_token, n) => {
    throw new Error(n === 1 ? "Token is inactive or unknown" : "Token introspection unavailable");
  });
  const verifier = new CachingTokenVerifier(inner, 60_000);

  await assert.rejects(verifier.verifyAccessToken("tok"), /inactive/);
  await assert.rejects(verifier.verifyAccessToken("tok"), /unavailable/);
  assert.equal(inner.calls.count, 2);
});

test("an entry never outlives the token's own expiry", async () => {
  let now = 1_000_000;
  const inner = innerVerifier((token) => ({ ...accepted(token), expiresAt: (now + 10_000) / 1000 }));
  const verifier = new CachingTokenVerifier(inner, 60_000, 100, () => now);

  await verifier.verifyAccessToken("tok");
  now += 9_000;
  await verifier.verifyAccessToken("tok");
  assert.equal(inner.calls.count, 1);
  now += 1_000;
  await verifier.verifyAccessToken("tok");
  assert.equal(inner.calls.count, 2, "at the token's expiry the cache asks again");
});

test("distinct tokens never share an entry", async () => {
  const inner = innerVerifier((token) => ({ ...accepted(token), extra: { sub: token } }));
  const verifier = new CachingTokenVerifier(inner, 60_000);

  assert.equal((await verifier.verifyAccessToken("tok-a")).extra.sub, "tok-a");
  assert.equal((await verifier.verifyAccessToken("tok-b")).extra.sub, "tok-b");
  assert.equal((await verifier.verifyAccessToken("tok-a")).extra.sub, "tok-a");
  assert.equal(inner.calls.count, 2);
});

test("concurrent requests for one token share a single introspection", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const inner = innerVerifier(async (token) => {
    await gate;
    return accepted(token);
  });
  const verifier = new CachingTokenVerifier(inner, 60_000);

  const pending = [1, 2, 3].map(() => verifier.verifyAccessToken("tok"));
  release();
  const results = await Promise.all(pending);
  assert.equal(inner.calls.count, 1);
  assert.ok(results.every((info) => info.extra.sub === "user-1"));
});

test("each request gets its own AuthInfo, so an edit cannot leak into the next one", async () => {
  const verifier = new CachingTokenVerifier(innerVerifier(accepted), 60_000);

  const first = await verifier.verifyAccessToken("tok");
  first.scopes.push("write:everything");
  first.extra.sub = "someone-else";
  const second = await verifier.verifyAccessToken("tok");
  assert.deepEqual(second.scopes, ["read:sessions"]);
  assert.equal(second.extra.sub, "user-1");
});

test("the map is bounded: the oldest token leaves first", async () => {
  const inner = innerVerifier(accepted);
  const verifier = new CachingTokenVerifier(inner, 60_000, 2);

  await verifier.verifyAccessToken("tok-1");
  await verifier.verifyAccessToken("tok-2");
  await verifier.verifyAccessToken("tok-3"); // evicts tok-1
  await verifier.verifyAccessToken("tok-2");
  assert.equal(inner.calls.count, 3);
  await verifier.verifyAccessToken("tok-1");
  assert.equal(inner.calls.count, 4);
});

test("a TTL of 0 introspects every request", async () => {
  const inner = innerVerifier(accepted);
  const verifier = new CachingTokenVerifier(inner, 0);

  await verifier.verifyAccessToken("tok");
  await verifier.verifyAccessToken("tok");
  assert.equal(inner.calls.count, 2);
});

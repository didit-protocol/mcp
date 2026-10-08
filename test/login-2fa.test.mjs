import { test } from "node:test";
import assert from "node:assert/strict";
import { login, verify2fa } from "../dist/tools/auth.js";

// programmatic/login/ no longer returns tokens for an account with a second
// factor enrolled; it answers 2fa_required + a 5-minute temp_token for /2fa/verify/.
// didit_account_login must hand the agent a usable next step instead of a dead end.

const AUTH = "https://apx.didit.me/auth/v2";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const stubFetch = (routes) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[String(url).split("?")[0]];
    if (!handler) return json({ detail: "Not found." }, 404);
    return typeof handler === "function" ? handler() : json(handler);
  };
  return calls;
};

test("login without 2FA still returns the tokens", async () => {
  stubFetch({ [`${AUTH}/programmatic/login/`]: { access_token: "a", refresh_token: "r" } });

  const res = await login("owner@example.com", "pw");

  assert.deepEqual(res, { access_token: "a", refresh_token: "r" });
});

test("login for an authenticator user returns the temp_token and points at didit_account_verify_2fa", async () => {
  stubFetch({
    [`${AUTH}/programmatic/login/`]: {
      "2fa_required": true,
      temp_token: "tmp",
      has_authenticator: true,
      has_passkeys: false,
    },
  });

  const res = await login("owner@example.com", "pw");

  assert.equal(res["2fa_required"], true);
  assert.equal(res.temp_token, "tmp");
  assert.equal(res.expires_in, 300);
  assert.equal(res.access_token, undefined);
  assert.match(res.next_step, /didit_account_verify_2fa/);
});

test("login for a passkey-only user explains the browser route and drops the unusable temp_token", async () => {
  stubFetch({
    [`${AUTH}/programmatic/login/`]: {
      "2fa_required": true,
      temp_token: "tmp",
      has_authenticator: false,
      has_passkeys: true,
    },
  });

  const res = await login("owner@example.com", "pw");

  assert.equal(res["2fa_required"], true);
  assert.equal(res.temp_token, undefined);
  assert.equal(res.has_passkeys, true);
  assert.match(res.next_step, /passkey/);
  assert.doesNotMatch(res.next_step, /didit_account_verify_2fa/);
});

test("verify2fa posts temp_token + otp_token to /2fa/verify/ and returns the tokens", async () => {
  const calls = stubFetch({ [`${AUTH}/2fa/verify/`]: { access_token: "a2", refresh_token: "r2" } });

  const res = await verify2fa("tmp", "123456");

  assert.deepEqual(res, { access_token: "a2", refresh_token: "r2" });
  assert.equal(calls[0].url, `${AUTH}/2fa/verify/`);
  assert.deepEqual(calls[0].body, { temp_token: "tmp", otp_token: "123456" });
});

test("verify2fa surfaces a wrong code as an error", async () => {
  stubFetch({ [`${AUTH}/2fa/verify/`]: () => json(["Invalid OTP token."], 400) });

  await assert.rejects(() => verify2fa("tmp", "000000"));
});

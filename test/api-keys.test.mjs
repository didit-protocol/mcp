import { test } from "node:test";
import assert from "node:assert/strict";
import { listApiKeys } from "../dist/tools/members.js";
import { requestContext } from "../dist/config.js";

const API = "https://apx.didit.me/auth/v2";

const inContext = (fn) => requestContext.run({ accessToken: "tok" }, fn);

// API keys live under their application: /organizations/{org}/api-keys/ is no route at all, so
// a call without application_id came back as a bare 404 the agent could not act on (7 of 37
// production calls, Nov 2026). It must say what is missing instead of calling that path.

test("listApiKeys: without application_id it asks for it and calls nothing", async () => {
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url));

    return new Response("{}", { status: 404 });
  };
  const error = await inContext(() => listApiKeys("org-1")).then(
    () => null,
    (caught) => caught,
  );

  assert.deepEqual(calls, []);
  assert.equal(error?.shape?.code, "bad_request");
  assert.equal(error?.shape?.field, "application_id");
  assert.match(error?.shape?.hint ?? "", /didit_context_get/);
});

test("listApiKeys: with application_id it reads that application's keys", async () => {
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url).split("?")[0]);

    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await inContext(() => listApiKeys("org-1", "app-1"));

  assert.deepEqual(calls, [`${API}/organizations/org-1/applications/app-1/api-keys/`]);
});

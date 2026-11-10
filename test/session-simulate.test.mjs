import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { simulateSandboxSession } from "../dist/tools/sessions.js";

// An agent tests an integration end to end in the sandbox without a person going through the
// flow: the sandbox simulate route finishes the session with the outcome it picks (staging, 9 Nov 2026).

const API = "https://verification.didit.me/v3";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const inContext = (fn) => requestContext.run({ accessToken: "tok", organizationId: "org-1" }, fn);
const SESSION = "019efeb8-dbe6-4129-99ed-7a1a579611bd";

test("finishes a sandbox session through the simulate route with only the fields given", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return json({ session_id: SESSION, previous_status: "Not Started", status: "Approved" });
  };
  const res = await inContext(() => simulateSandboxSession(SESSION, { new_status: "Approved", ignored: 1 }));

  assert.deepEqual(seen, [{ url: `${API}/session/${SESSION}/simulate/`, method: "POST", body: { new_status: "Approved" } }]);
  assert.equal(res.status, "Approved");
});

test("refuses an empty or unknown outcome before any request", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return json({});
  };
  for (const data of [{}, { new_status: "Resubmitted" }]) {
    const err = await inContext(() => simulateSandboxSession(SESSION, data)).then(
      () => null,
      (e) => e,
    );
    assert.ok(err);
  }
  assert.equal(called, false);
});

test("a live session (404) says only sandbox sessions can be simulated", async () => {
  globalThis.fetch = async () => json({ detail: "Not found." }, 404);
  const err = await inContext(() => simulateSandboxSession(SESSION, { scenario: "approve" })).then(
    () => null,
    (e) => e,
  );
  assert.match(err.shape.hint, /SANDBOX application/);
});

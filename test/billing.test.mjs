import { test } from "node:test";
import assert from "node:assert/strict";
import { getBalance } from "../dist/tools/billing.js";
import { requestContext } from "../dist/config.js";

const API = "https://verification.didit.me/v3";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const stubFetch = (routes) => {
  globalThis.fetch = async (url) => {
    const handler = routes[String(url).split("?")[0]];
    if (!handler) return json({ detail: "Not found." }, 404);
    return typeof handler === "function" ? handler() : json(handler);
  };
};

const inContext = (ctx, fn) => requestContext.run(ctx, fn);

// Regression for didit_org_get_balance's schema declared no parameters, so a
// multi-org token (no per-request default organization) could never satisfy
// resolveOrganizationId and always dead-ended on "organization_id is required" with no way
// to recover. getBalance must now accept an explicit organizationId and thread it through
// to the org-scoped billing endpoint.

test("getBalance: explicit organization_id resolves for a multi-org caller with no default org", async () => {
  stubFetch({
    [`${API}/organization/org-multi/top-up/`]: { balance: 4200, auto_refill_enabled: false },
  });
  // No organizationId on the context — mirrors a multi-org token where the per-request
  // context cannot pick a single default org.
  const balance = await inContext({ accessToken: "tok-multi" }, () => getBalance("org-multi"));

  assert.equal(balance.balance, 4200);
});

test("getBalance: omitting organization_id still resolves from the per-request token context", async () => {
  stubFetch({
    [`${API}/organization/org-single/top-up/`]: { balance: 100, auto_refill_enabled: true },
  });
  const balance = await inContext({ accessToken: "tok-single", organizationId: "org-single" }, () => getBalance());

  assert.equal(balance.balance, 100);
});

test("getBalance: no explicit id and no context org still throws the actionable resolver error", async () => {
  const err = await inContext({ accessToken: "tok-none" }, () => getBalance()).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "expected getBalance to throw when no organization can be resolved");
  assert.match(err.message, /organization_id is required/);
  assert.match(err.message, /didit_context_get/);
});

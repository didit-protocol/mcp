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

// The self-serve top-up ceiling is $20,000 (sdv #2841). A larger amount is refused before any
// request is made, and the tool schema advertises the same ceiling.
import { topUp, TOP_UP_MAXIMUM } from "../dist/tools/billing.js";

test("topUp: $20,000 is the ceiling, enforced before any checkout is created", async () => {
  assert.equal(TOP_UP_MAXIMUM, 20_000);
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return json({ checkout_url: "https://checkout.example/x" });
  };
  const err = await inContext({ accessToken: "tok", organizationId: "org-1" }, () => topUp(20_001, true)).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "expected a refusal above the ceiling");
  assert.match(err.message, /maximum of \$20000/);
  assert.equal(called, false);
});

test("topUp: exactly $20,000 reaches the API", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).searchParams.get("amount_in_dollars"), "20000");
    return json({ checkout_session_url: "https://checkout.example/x" });
  };
  const res = await inContext({ accessToken: "tok", organizationId: "org-1" }, () => topUp(20_000, true));
  assert.equal(res.requires_human_approval, true);
});

// The organization's /top-up/ route answers GET and PUT only, so the POST this tool sent was a
// 405 on every call (reproduced on staging, 9 Nov 2026). Checkout is the console's GET route.
test("topUp: creates the Checkout page through the console's checkout-session route", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/billing/top-up-requests/")) return json({ detail: "down" }, 500);
    seen.push({ url: String(url), method: init.method, body: init.body });
    return json({ checkout_session_id: "cs_test_1", checkout_session_url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  };
  const res = await inContext({ accessToken: "tok" }, () => topUp(150, true, "org-9"));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].body, undefined);
  assert.equal(seen[0].url, `${API}/organization/org-9/checkout-session/?amount_in_dollars=150`);
  assert.equal(res.checkout_session_url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(res.next_steps.console_top_up_url, "https://business.didit.me/console/org-9/settings/billing?top_up_amount=150");
});

test("getBalance with links: hands the person the console pages, never a charge", async () => {
  stubFetch({ [`${API}/organization/org-links/top-up/`]: { balance: "0.00", auto_refill_enabled: false } });
  const balance = await inContext({ accessToken: "tok" }, () => getBalance("org-links", { links: true }));

  assert.equal(balance.next_steps.top_up_url, "https://business.didit.me/console/org-links/settings/billing?top_up_amount=100");
  assert.equal(balance.next_steps.automatic_top_up_url, "https://business.didit.me/console/org-links/settings/billing/payment-methods");
  assert.equal(balance.next_steps.plans_url, "https://business.didit.me/console/org-links/settings/billing/plans");
  // Without the option (the ChatGPT catalog) the answer is the balance alone.
  const plain = await inContext({ accessToken: "tok" }, () => getBalance("org-links"));
  assert.equal(plain.next_steps, undefined);
});

import { quotePlan, updateBillingDetails, listPaymentMethods } from "../dist/tools/billing.js";

test("quotePlan: asks for the quote and names the page where the person confirms", async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return json({ plan: "growth", amount_due: "99.00", credit_added: "115.00" });
  };
  const quote = await inContext({ accessToken: "tok", organizationId: "org-q" }, () => quotePlan("growth", "yearly"));

  assert.equal(seen[0], `${API}/organization/org-q/billing/plans/quote/?plan=growth&billing_interval=yearly`);
  assert.equal(quote.amount_due, "99.00");
  assert.equal(quote.next_steps.plans_url, "https://business.didit.me/console/org-q/settings/billing/plans?billing=yearly");
});

test("quotePlan: an unknown plan or interval is refused before any request", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return json({});
  };
  for (const [plan, interval] of [["enterprise", undefined], ["Growth", undefined], ["scale", "weekly"]]) {
    const err = await inContext({ accessToken: "tok", organizationId: "org-q" }, () => quotePlan(plan, interval)).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, `${plan}/${interval} must be refused`);
  }
  assert.equal(called, false);
});

test("listPaymentMethods: returns the saved cards with the page to add one", async () => {
  stubFetch({ [`${API}/organization/org-c/billing/payment-methods/`]: { results: [] } });
  const methods = await inContext({ accessToken: "tok" }, () => listPaymentMethods("org-c"));
  assert.deepEqual(methods.results, []);
  assert.match(methods.next_steps.add_card_url, /\/console\/org-c\/settings\/billing\/payment-methods$/);
});

test("updateBillingDetails: a partial change keeps every other saved field (the PUT replaces all)", async () => {
  const saved = {
    legal_name: "Acme Ltd",
    tax_id_type: "eu_vat",
    tax_id: "ESB12345678",
    address: { line1: "Calle 1", line2: "", city: "Madrid", state: "", postal_code: "28001", country: "ES" },
    billing_emails: ["billing@acme.example"],
    po_number: "PO-1",
  };
  let put;
  globalThis.fetch = async (url, init) => {
    if (init.method === "PUT") {
      put = JSON.parse(init.body);
      return json(put);
    }
    return json(saved);
  };
  await inContext({ accessToken: "tok", organizationId: "org-d" }, () =>
    updateBillingDetails({ legal_name: "Acme Holdings Ltd", address: { city: "Barcelona", postal_code: "08001" } }),
  );

  assert.deepEqual(put, {
    ...saved,
    legal_name: "Acme Holdings Ltd",
    address: { ...saved.address, city: "Barcelona", postal_code: "08001" },
  });
});

test("updateBillingDetails: unknown fields and empty changes are refused before any request", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return json({});
  };
  for (const changes of [{ card_number: "4242" }, {}]) {
    const err = await inContext({ accessToken: "tok", organizationId: "org-d" }, () => updateBillingDetails(changes)).then(
      () => null,
      (e) => e,
    );
    assert.ok(err);
  }
  assert.equal(called, false);
});

test("updateBillingDetails: an authenticator step-up points the person at the console", async () => {
  globalThis.fetch = async (url, init) =>
    init.method === "PUT"
      ? json({ detail: "Enter the code from your authenticator app to confirm this change.", code: "otp_required" }, 400)
      : json({ address: {} });
  const err = await inContext({ accessToken: "tok", organizationId: "org-s" }, () =>
    updateBillingDetails({ po_number: "PO-9" }),
  ).then(
    () => null,
    (e) => e,
  );
  assert.ok(err);
  assert.match(err.shape.hint, /business\.didit\.me\/console\/org-s\/settings\/billing/);
});

// Production threads bbceb192 / 95aae947 (Nov 2026): the $10 monthly credit is conditional
// (decided per organization at creation), but /top-up/ says nothing about it, so the agent
// promised credit to organizations that never get it and could not tell "never eligible"
// from "used up". /credits/ holds that decision and this month's lot.

test("getBalance: an organization that never gets the monthly credit says why", async () => {
  stubFetch({
    [`${API}/organization/org-personal/top-up/`]: { balance: "0.00" },
    [`${API}/organization/org-personal/credits/`]: {
      balance: "0.00",
      free_credit: { eligibility: "personal_email", receives: false, this_month: null },
    },
  });
  const balance = await inContext({ accessToken: "tok" }, () => getBalance("org-personal"));

  assert.equal(balance.balance, "0.00");
  assert.deepEqual(balance.free_credit, { eligibility: "personal_email", receives: false, this_month: null });
});

test("getBalance: an eligible organization shows this month's credit once used up", async () => {
  const thisMonth = { granted_amount: "10.00", remaining_amount: "0.00", used_up_at: "2026-11-04T10:00:00Z" };

  stubFetch({
    [`${API}/organization/org-spent/top-up/`]: { balance: "0.20" },
    [`${API}/organization/org-spent/credits/`]: {
      free_credit: { eligibility: "eligible", receives: true, this_month: thisMonth },
    },
  });
  const balance = await inContext({ accessToken: "tok" }, () => getBalance("org-spent"));

  assert.equal(balance.free_credit.receives, true);
  assert.deepEqual(balance.free_credit.this_month, thisMonth);
});

test("getBalance: a failing /credits/ never costs the balance answer", async () => {
  stubFetch({
    [`${API}/organization/org-soft/top-up/`]: { balance: "12.00" },
    [`${API}/organization/org-soft/credits/`]: () => json({ detail: "Forbidden." }, 403),
  });
  const balance = await inContext({ accessToken: "tok" }, () => getBalance("org-soft"));

  assert.equal(balance.balance, "12.00");
  assert.equal(balance.free_credit, undefined);
});

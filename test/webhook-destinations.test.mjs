import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { DiditError } from "../dist/security.js";
import { WEBHOOK_TOOLS } from "../dist/tools/webhooks.js";

// The webhook destination tools against the console routes of the verification API
// (applications/urls.py webhook/destinations/…): what each call sends, and what it refuses to send.

delete process.env.DIDIT_ACCESS_TOKEN;

const APP_BASE = "https://verification.didit.me/v3/organization/org-1/application/app-1";
const DESTINATION = "5e55aaaa-2222-4333-8444-555555555555";
const DELIVERY = "6f66bbbb-3333-4444-8555-666666666666";
const BASE = `${APP_BASE}/webhook/destinations/${DESTINATION}`;
const TOOLS = new Map(WEBHOOK_TOOLS.map((tool) => [tool.def.name, tool]));

function recordFetch(t, reply = () => ({})) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const parsed = new URL(String(url));
    const sent = { method: init.method ?? "GET", path: `${parsed.origin}${parsed.pathname}`, query: Object.fromEntries(parsed.searchParams), body: init.body && JSON.parse(init.body) };
    calls.push(sent);
    const answer = reply(sent);
    return answer instanceof Response ? answer : Response.json(answer);
  });
  return calls;
}

const call = async (name, args) =>
  requestContext.run({ accessToken: "token-1", organizationId: "org-1", applicationId: "app-1" }, () => TOOLS.get(name).run(args));

test("a destination names the events it receives: none named would receive none", async (t) => {
  const calls = recordFetch(t);
  const { def } = TOOLS.get("didit_webhook_create");
  const events = def.inputSchema.properties.subscribed_events;
  assert.ok(def.inputSchema.required.includes("subscribed_events"));
  assert.equal(events.items.enum.length, 51);
  assert.ok(["status.updated", "transaction.created", "investigator.report.ready", "bank.link.completed", "auth.login"].every((event) => events.items.enum.includes(event)));
  assert.doesNotMatch(JSON.stringify(def), /receive all/i);
  // The list is stated once: update points at it.
  const update = TOOLS.get("didit_webhook_update").def.inputSchema.properties.subscribed_events;
  assert.equal(update.items.enum, undefined);
  assert.match(update.description, /didit_webhook_create/);

  for (const subscribed_events of [undefined, []]) {
    await assert.rejects(call("didit_webhook_create", { label: "Prod", url: "https://example.com/hook", subscribed_events }), (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.field, "subscribed_events");
      assert.ok(error.shape.allowed.includes("status.updated"));
      return true;
    });
  }
  assert.equal(calls.length, 0);

  const body = { label: "Prod", url: "https://example.com/hook", subscribed_events: ["status.updated"] };
  await call("didit_webhook_create", body);
  assert.deepEqual(calls, [{ method: "POST", path: `${APP_BASE}/webhook/destinations/`, query: {}, body }]);
});

test("the deliveries of a destination are listed with their filters, and read one by one", async (t) => {
  const calls = recordFetch(t, ({ path }) => (path.endsWith("/analytics/") ? { summary: { failed_deliveries: 1 }, points: [] } : { count: 0, results: [] }));

  await call("didit_webhook_delivery_list", { destination_uuid: DESTINATION, outcome: "retryable", date_from: "2026-11-01", date_to: "2026-11-20", limit: 5, offset: 10 });
  assert.deepEqual(calls.splice(0), [
    { method: "GET", path: `${BASE}/deliveries/`, query: { outcome: "retryable", date_from: "2026-11-01", date_to: "2026-11-20", limit: "5", offset: "10" }, body: undefined },
  ]);

  const withAnalytics = await call("didit_webhook_delivery_list", { destination_uuid: DESTINATION, date_from: "2026-11-01", include: ["analytics"] });
  assert.deepEqual(calls.splice(0).map(({ path, query }) => [path, query]), [
    [`${BASE}/deliveries/`, { date_from: "2026-11-01" }],
    [`${BASE}/analytics/`, { date_from: "2026-11-01" }],
  ]);
  assert.deepEqual(withAnalytics.analytics, { summary: { failed_deliveries: 1 }, points: [] });

  await call("didit_webhook_delivery_list", { destination_uuid: DESTINATION, delivery_uuid: DELIVERY });
  assert.deepEqual(calls, [{ method: "GET", path: `${BASE}/deliveries/${DELIVERY}/`, query: {}, body: undefined }]);
  assert.deepEqual(TOOLS.get("didit_webhook_delivery_list").permission, ["read:webhooks", "list:webhooks"]);
});

test("a delivery is sent again to the destination's current URL; a refusal is the API's own", async (t) => {
  const calls = recordFetch(t, () => ({ uuid: "new-delivery", response_status: 200 }));
  const tool = TOOLS.get("didit_webhook_delivery_resend");
  assert.deepEqual([tool.access, tool.openWorld, tool.permission], ["write", true, "write:webhooks"]);

  const resent = await call("didit_webhook_delivery_resend", { destination_uuid: DESTINATION, delivery_uuid: DELIVERY });
  assert.equal(resent.response_status, 200);
  assert.deepEqual(calls, [{ method: "POST", path: `${BASE}/deliveries/${DELIVERY}/resend/`, query: {}, body: undefined }]);

  t.mock.method(globalThis, "fetch", async () => Response.json({ detail: "You do not have permission to perform this action." }, { status: 403 }));
  await assert.rejects(call("didit_webhook_delivery_resend", { destination_uuid: DESTINATION, delivery_uuid: DELIVERY }), (error) => error.shape.status === 403);
  await assert.rejects(call("didit_webhook_delivery_resend", { destination_uuid: "../lists", delivery_uuid: DELIVERY }), (error) => error.shape.field === "destination_uuid");
});

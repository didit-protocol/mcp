import { test } from "node:test";
import assert from "node:assert/strict";
import { listNetworks, getNetwork, getNetworkMembership } from "../dist/tools/networks.js";
import { requestContext } from "../dist/config.js";

const API = "https://verification.didit.me/v3";
const APP_BASE = `${API}/organization/org-1/application/app-1`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function captureRoutes(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const path = String(url).split("?")[0];
    const body = routes[path];
    if (body === undefined) return json({ detail: "Not found." }, 404);
    return json(body);
  };
  return calls;
}

const inApp = (fn) =>
  requestContext.run({ accessToken: "token-1", organizationId: "org-1", applicationId: "app-1" }, fn);

test("network list uses the app-scoped console endpoint and passes filters", async () => {
  const calls = captureRoutes({
    [`${APP_BASE}/networks/`]: { count: 1, results: [{ uuid: "net-1" }], kpis: {} },
  });

  const res = await inApp(() => listNetworks({ status: "active", signal_type: "device", limit: 10 }));

  assert.equal(res.count, 1);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(`${url.origin}${url.pathname}`, `${APP_BASE}/networks/`);
  assert.equal(url.searchParams.get("status"), "active");
  assert.equal(url.searchParams.get("signal_type"), "device");
  assert.equal(url.searchParams.get("limit"), "10");
});

test("network get defaults to members and signals only", async () => {
  const calls = captureRoutes({
    [`${APP_BASE}/networks/net-1/`]: { uuid: "net-1", risk: { score: 91 } },
    [`${APP_BASE}/networks/net-1/members/`]: { results: [{ subject: { kind: "user" } }] },
    [`${APP_BASE}/networks/net-1/signals/`]: { results: [{ signal_type: "device" }] },
  });

  const res = await inApp(() => getNetwork({ network_id: "net-1" }));

  assert.equal(res.uuid, "net-1");
  assert.deepEqual(Object.keys(res.included), ["members", "signals"]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => !url.includes("cross-org-insights")));
});

test("network get can include graph options and map without exposing cross-org insights", async () => {
  const calls = captureRoutes({
    [`${APP_BASE}/networks/net-1/`]: { uuid: "net-1" },
    [`${APP_BASE}/networks/net-1/graph/`]: { nodes: [], edges: [] },
    [`${APP_BASE}/networks/net-1/map/`]: { points: [] },
  });

  const res = await inApp(() =>
    getNetwork({
      network_id: "net-1",
      include: ["graph", "map"],
      depth: "2",
      focus_kind: "user",
      focus_id: "user-1",
    }),
  );

  assert.deepEqual(Object.keys(res.included), ["graph", "map"]);
  const graphUrl = new URL(calls.find((url) => url.includes("/graph/")));
  assert.equal(graphUrl.searchParams.get("depth"), "2");
  assert.equal(graphUrl.searchParams.get("focus_kind"), "user");
  assert.equal(graphUrl.searchParams.get("focus_id"), "user-1");
  assert.ok(calls.every((url) => !url.includes("cross-org-insights")));
});

test("membership lookup maps subject kinds to the merged console routes", async () => {
  const cases = [
    ["session", `${APP_BASE}/sessions/sub-1/networks/`],
    ["business_session", `${APP_BASE}/business-sessions/sub-1/networks/`],
    ["vendor_user", `${APP_BASE}/users/sub-1/networks/`],
    ["vendor_business", `${APP_BASE}/businesses/sub-1/networks/`],
    ["transaction", `${APP_BASE}/transactions/sub-1/networks/`],
  ];

  for (const [subjectKind, path] of cases) {
    const calls = captureRoutes({ [path]: { results: [] } });
    await inApp(() => getNetworkMembership({ subject_kind: subjectKind, subject_id: "sub-1" }));
    assert.equal(calls[0], path);
  }
});

test("network ids are path-segment guarded", async () => {
  const err = await inApp(() => getNetwork({ network_id: "../billing" })).then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "expected unsafe id to throw");
  assert.equal(err.shape?.code, "bad_request");
  assert.equal(err.shape?.field, "network_id");
});

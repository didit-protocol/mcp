import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { TOOL_PERMISSIONS, decidePermission } from "../dist/permissions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * didit_session_get_location_evidence reads the session page's Location section
 * (GET /geolocation/sessions/{id}/evidence/). The decision payload keeps only the
 * accepted attempt of a Location node, so without this tool an agent cannot say
 * which attempt was outside an area or which earlier checks of the same person
 * made LOCATION_CONSECUTIVE_MISMATCHES fire.
 */
const API = "https://verification.didit.me/v3";
const AUTH_INFO = { token: "tok", clientId: "client", scopes: [], extra: { sub: "u1", organization_id: "org-1" } };
const SESSION = "6f0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const EVIDENCE_PATH = `/geolocation/sessions/${SESSION}/evidence/`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AUTH = "https://apx.didit.me/auth/v2";
const AUTH_ROUTES = {
  [`${AUTH}/organizations/me/`]: [{ uuid: "org-1", name: "Acme" }],
  [`${AUTH}/organizations/me/org-1/applications/`]: [{ uuid: "app-1", name: "Acme", mode: "live" }],
};

/** Stub every call: the auth lookups first, then `respond()` for each verification-API
 * call. Only the API calls are recorded. */
function stubFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).split("?")[0];
    if (path in AUTH_ROUTES) return json(AUTH_ROUTES[path]);
    calls.push(`${init.method ?? "GET"} ${path.replace(API, "")}`);
    return respond();
  };
  return calls;
}

async function withClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo: AUTH_INFO });
  const client = new Client({ name: "session-location-evidence-test", version: "0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const callEvidence = (session_id) =>
  withClient((client) => client.callTool({ name: "didit_session_get_location_evidence", arguments: { session_id } }));

/** One Location node in the shape the backend's build_session_evidence returns
 * (service-didit-verification geolocation/services/evidence.py; synthetic values). */
const node = () => ({
  node_id: "location-1",
  config: {
    position_source: "device_and_ip",
    preset: "licensing",
    refusal_path: "retry_then_handoff",
    max_attempts: 3,
    max_accuracy_radius_m: 100,
    low_accuracy_behavior: "ask_again",
    geofencing_enabled: true,
    areas: [{ id: "spain", type: "allowed", kind: "country", country: "ESP" }],
    geofencing_by_country: null,
    ip_distance_km: 500,
    document_distance_km: null,
    document_distance_basis: "document",
    travel_tolerance: { enabled: true, usual_area_km: 100, max_days: 14 },
    consecutive_mismatch_count: 2,
    actions: { geolocation_vpn_action: "DECLINE", geolocation_consecutive_mismatch_action: "REVIEW" },
  },
  result: {
    node_id: "location-1",
    status: "In Review",
    outcome: "outside_geofence",
    inside_areas: [],
    blocked_areas: [],
    warnings: [{ risk: "LOCATION_CONSECUTIVE_MISMATCHES" }],
  },
  attempts: [
    { uuid: "a1", attempt: 1, outcome: "low_accuracy", geofence_result: "undetermined", retired: true },
    { uuid: "a2", attempt: 2, outcome: "outside_geofence", geofence_result: "outside", retired: false },
  ],
  reference_points: {
    device: { latitude: 1.5, longitude: 2.5, uncertainty_km: 0.02 },
    ip: { latitude: 1.6, longitude: 2.4, uncertainty_km: 50 },
    address: null,
    area_reading: null,
  },
  distances: { device_to_ip_km: 0, device_to_address_km: null, ip_to_address_km: null },
  areas: { inside: [], blocked: [], undetermined: [], nearest_allowed_km: 812.4, allowed_result: "outside" },
  anonymizers: { vpn: false, proxy: false, tor: false, spoofing: false, emulator: null },
  is_mismatch: true,
  history: [{ uuid: "h1", session_id: "0a0b0c0d-0000-4000-8000-000000000001", is_mismatch: true, travel_excused: false }],
  map: { pins: [{ id: "device", kind: "device", lat: 1.5, lon: 2.5, label: "Device" }], areas: [{ id: "spain" }], lines: [] },
  map_url: `/v3/geolocation/sessions/${SESSION}/checks/a2/map/`,
});

test("advertised as a read-only tool that needs read:sessions", async () => {
  const tool = await withClient(async (client) =>
    (await client.listTools()).tools.find((t) => t.name === "didit_session_get_location_evidence"),
  );
  assert.ok(tool, "the tool is listed");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(tool.inputSchema.required, ["session_id"]);

  assert.equal(TOOL_PERMISSIONS.didit_session_get_location_evidence, "read:sessions");
  const decide = (scopes) =>
    decidePermission({ tool: "didit_session_get_location_evidence", scopes, mode: "enforce", tokenOrg: "org-1", targetOrg: "org-1" });
  assert.equal(decide(["read:sessions"]), "allow");
  assert.equal(decide(["list:sessions"]), "deny");
});

test("reads the evidence once and drops each node's map props and map URL", async () => {
  const calls = stubFetch(() => json({ session_id: SESSION, nodes: [node()] }));
  const res = await callEvidence(SESSION);
  const body = JSON.parse(res.content[0].text);

  assert.equal(res.isError, undefined);
  assert.deepEqual(calls, [`GET ${EVIDENCE_PATH}`]);
  assert.equal(body.session_id, SESSION);
  assert.equal(body.nodes.length, 1);
  const { map, map_url, ...expected } = node();
  assert.deepEqual(body.nodes[0], expected);
  assert.ok(!("map" in body.nodes[0]) && !("map_url" in body.nodes[0]));
  // The two things only this endpoint carries: retired attempts and the person's earlier checks.
  assert.deepEqual(body.nodes[0].attempts.map((a) => a.retired), [true, false]);
  assert.equal(body.nodes[0].history.length, 1);
});

test("every node loses its map props, including one with nothing to draw (map_url null)", async () => {
  // A refusal on a node with no IP or address point places no pin: the backend sends
  // `map_url: null` rather than a link to a 404.
  const refused = {
    ...node(),
    node_id: "location-2",
    attempts: [{ uuid: "b1", attempt: 1, outcome: "denied", geofence_result: null, retired: false }],
    reference_points: { device: null, ip: null, address: null, area_reading: null },
    map: { pins: [], areas: [], lines: [] },
    map_url: null,
  };
  stubFetch(() => json({ session_id: SESSION, nodes: [node(), refused] }));
  const body = JSON.parse((await callEvidence(SESSION)).content[0].text);

  assert.deepEqual(body.nodes.map((n) => n.node_id), ["location-1", "location-2"]);
  for (const evidenceNode of body.nodes) {
    assert.ok(!("map" in evidenceNode) && !("map_url" in evidenceNode), `${evidenceNode.node_id} kept map props`);
  }
  const { map, map_url, ...expected } = refused;
  assert.deepEqual(body.nodes[1], expected);
});

test("a session with no Location step comes back as an empty node list", async () => {
  stubFetch(() => json({ session_id: SESSION, nodes: [] }));
  const body = JSON.parse((await callEvidence(SESSION)).content[0].text);
  assert.deepEqual(body, { session_id: SESSION, nodes: [] });
});

test("a session_id that is not one path segment is refused before any API call", async () => {
  const calls = stubFetch(() => json({ session_id: SESSION, nodes: [] }));
  const res = await callEvidence(`${SESSION}/../../users`);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /session_id/);
  assert.deepEqual(calls, []);
});

test("the backend's flag-off 404 reaches the agent as the feature being unavailable", async () => {
  stubFetch(() => json({ detail: "Precise Location is not available." }, 404));
  const res = await callEvidence(SESSION);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Precise Location is not available\./);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The standalone verification tools against the routes and serializers of the verification service
// (apis/urls.py, apis/urls_v3.py, applications/views/proxy.py): the exact method, path, headers and
// body each call sends. The email and phone codes go to the public API with the application's API
// key; everything else goes through the console proxy with the person's Bearer.

for (const name of ["DIDIT_ACCESS_TOKEN", "MCP_PERMISSION_MODE", "DIDIT_TOOLSETS", "MCP_DEFAULT_ORG", "MCP_DEFAULT_APP"]) delete process.env[name];

const API = "https://verification.didit.me/v3";
const AUTH = "https://apx.didit.me/auth/v2";
const ORG = "0d6b5c1e-2f3a-4b7c-8d9e-1a2b3c4d5e6f";
const APP = "a1b2c3d4-0000-4000-8000-000000000002";
const SCOPE = { organization_id: ORG, application_id: APP };
const CONSOLE = `/organization/${ORG}/application/${APP}`;
const API_KEY = "recorded-application-api-key";
const PERSON = {
  token: "standalone.person.token",
  clientId: "standalone-test",
  scopes: ["didit:verification", "didit:management", "create:sessions"],
  extra: { sub: "user-1", organization_id: ORG },
};
// A 1x1 PNG: what the upload guard accepts.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const bodyOf = (body) =>
  typeof body === "string" ? JSON.parse(body) : body instanceof FormData ? Object.fromEntries(body.entries()) : undefined;

/** Runs `fn` with a fake auth service and verification API; `sent` holds the verification calls. */
async function withApi(reply, fn) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === `${AUTH}/organizations/${ORG}/applications/${APP}`) return json({ uuid: APP, client_secret: API_KEY });
    if (!target.startsWith(API)) return json([]);
    const call = { method: init.method ?? "GET", path: target.slice(API.length), headers: init.headers ?? {}, body: bodyOf(init.body) };
    sent.push(call);

    return reply(call);
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted: true });
  await server.connect(serverTransport);
  const onmessage = serverTransport.onmessage?.bind(serverTransport);
  serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo: PERSON });
  const client = new Client({ name: "standalone-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn({
      sent,
      client,
      call: (name, args) => client.callTool({ name, arguments: { ...SCOPE, ...args } }),
    });
  } finally {
    globalThis.fetch = original;
    await client.close();
    await server.close();
  }
}

const ok = () => json({ request_id: "r-1" });
const textOf = (result) => result.content.map((block) => block.text).join("\n");

/** One call, its only request without headers. */
async function requestOf(name, args) {
  return withApi(ok, async ({ sent, call }) => {
    const result = await call(name, args);
    assert.equal(result.isError, undefined, `${name}: ${textOf(result)}`);
    assert.equal(sent.length, 1, `${name} sends one request`);
    const { headers: _headers, ...request } = sent[0];

    return request;
  });
}

test("the email code goes to the public API with the application key, never to the console proxy", async () => {
  await withApi(ok, async ({ sent, call }) => {
    const options = { code_size: 8, alphanumeric_code: true, locale: "es" };
    await call("didit_verify_email_send", { email: "ana@acme.test", options, signals: { ip: "192.0.2.1" }, vendor_data: "u-1", metadata: { plan: "pro" } });
    await call("didit_verify_email_check", { email: "ana@acme.test", code: "123456", actions: { breached_email_action: "DECLINE" }, enable_social: true });

    assert.deepEqual(sent.map(({ method, path, body }) => ({ method, path, body })), [
      { method: "POST", path: "/email/send/", body: { email: "ana@acme.test", options, signals: { ip: "192.0.2.1" }, vendor_data: "u-1", metadata: { plan: "pro" } } },
      { method: "POST", path: "/email/check/", body: { email: "ana@acme.test", code: "123456", breached_email_action: "DECLINE", enable_social: true } },
    ]);
    for (const { headers } of sent) {
      assert.equal(headers["x-api-key"], API_KEY);
      assert.equal(headers.Authorization, undefined);
    }
  });
});

test("an email send the API refuses is an error that never echoes the key", async () => {
  await withApi(() => json({ error: "You don't have enough credits to perform this request." }, 403), async ({ call }) => {
    const result = await call("didit_verify_email_send", { email: "ana@acme.test" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /enough credits/);
    assert.ok(!textOf(result).includes(API_KEY));
  });
});

test("the phone code takes the v3 options and never a code, an override or a limit of the caller", async () => {
  const options = { preferred_channel: "sms", locale: "es-ES" };
  const sentBody = { phone_number: "+34600000012", options, allowed_channels: ["sms"], on_conflict: "reject", code_length: 8, vendor_data: "u-1" };
  assert.deepEqual(
    await requestOf("didit_verify_phone_send", { ...sentBody, code: "K7P2QX", fraud_override: "v1.1.x", trusted_user: true, rate_limits: { user_id: "u" } }),
    { method: "POST", path: "/phone/send/", body: sentBody },
  );
  assert.deepEqual(
    await requestOf("didit_verify_phone_check", { verification_id: "pv-1", code: "123456", factor_id: "fa-1", actions: { voip_number_action: "DECLINE" }, enable_enrichment: true }),
    { method: "POST", path: "/phone/check/", body: { verification_id: "pv-1", code: "123456", voip_number_action: "DECLINE", enable_enrichment: true } },
  );
});

test("the action and threshold settings reach each check flat, and metadata as JSON text in a form", async () => {
  const image = { image_base64: PNG };
  const form = async (name, args) => {
    const { method, path, body } = await requestOf(name, args);
    const fields = Object.fromEntries(Object.entries(body).filter(([, value]) => typeof value === "string"));

    return { method, path: path.replace(CONSOLE, ""), fields };
  };
  const common = { metadata: { plan: "pro" }, save_api_request: false };
  const sentCommon = { metadata: '{"plan":"pro"}', save_api_request: "false" };

  assert.deepEqual(await form("didit_verify_id", { front_image_base64: PNG, actions: { invalid_mrz_action: "NO_ACTION" }, ...common }), {
    method: "POST", path: "/apis/id-verification/", fields: { invalid_mrz_action: "NO_ACTION", ...sentCommon },
  });
  assert.deepEqual(
    await form("didit_verify_poa", { document_image_base64: PNG, actions: { poa_name_mismatch_action: "NO_ACTION" }, poa_languages_allowed: "en,es", ...common }),
    { method: "POST", path: "/apis/poa/", fields: { poa_name_mismatch_action: "NO_ACTION", poa_languages_allowed: "en,es", ...sentCommon } },
  );
  assert.deepEqual(await form("didit_verify_passive_liveness", { ...image, face_liveness_score_decline_threshold: 50, rotate_image: true }), {
    method: "POST", path: "/apis/passive-liveness/", fields: { face_liveness_score_decline_threshold: "50", rotate_image: "true" },
  });
  assert.deepEqual(await form("didit_verify_face_match", { image_1_base64: PNG, image_2_base64: PNG, face_match_score_decline_threshold: 60 }), {
    method: "POST", path: "/apis/face-match/", fields: { face_match_score_decline_threshold: "60" },
  });
  assert.deepEqual(await form("didit_verify_face_search", { ...image, search_type: "blocklisted_or_approved" }), {
    method: "POST", path: "/apis/face-search/", fields: { search_type: "blocklisted_or_approved" },
  });
  assert.deepEqual(await form("didit_verify_age", { ...image, age_estimation_decline_threshold: 21 }), {
    method: "POST", path: "/apis/age-estimation/", fields: { age_estimation_decline_threshold: "21" },
  });
});

test("AML and database validation send their settings as JSON", async () => {
  const aml = { full_name: "Ana Pons", aml_match_score_threshold: 90, aml_name_weight: 70, aml_dob_weight: 20, aml_country_weight: 10, sandbox_scenario: "decline_aml_hit", save_api_request: false };
  assert.deepEqual(await requestOf("didit_verify_aml", aml), { method: "POST", path: `${CONSOLE}/apis/aml/`, body: aml });
  assert.deepEqual(
    await requestOf("didit_verify_database", { issuing_state: "IND", consent: true, identification_number: "123", extra_fields: { pan: "ABCDE1234F", issuing_state: "USA" } }),
    { method: "POST", path: `${CONSOLE}/apis/database-validation/`, body: { issuing_state: "IND", consent: true, identification_number: "123", pan: "ABCDE1234F" } },
  );
});

test("a registry record is pulled at the tier asked for, each on its own route", async () => {
  for (const [args, route] of [[{}, "select"], [{ tier: "basic" }, "select"], [{ tier: "shareholders" }, "shareholders"], [{ tier: "ubo" }, "ubo"]]) {
    assert.deepEqual(await requestOf("didit_verify_kyb_select", { kyb_response_id: "k-1", ...args }), {
      method: "POST", path: `${CONSOLE}/apis/kyb/${route}/`, body: { kyb_response_id: "k-1" },
    });
  }
  assert.deepEqual(await requestOf("didit_verify_kyb_search", { country_code: "GB", name: "Acme", search_type: "contains", tier: "ubo" }), {
    method: "POST", path: `${CONSOLE}/apis/kyb/search/`, body: { country_code: "GB", name: "Acme", search_type: "contains", tier: "ubo" },
  });
  await withApi(ok, async ({ sent, call, client }) => {
    const refused = await call("didit_verify_kyb_select", { kyb_response_id: "k-1", tier: "../aml" });
    assert.equal(refused.isError, true);
    assert.deepEqual(sent, []);
    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === "didit_verify_kyb_search").inputSchema.properties;
    assert.deepEqual(search.search_type.enum, ["contains"], "the only strategy the registry provider honours");
  });
});

test("a document is sent with its type and the fields as one JSON text", async () => {
  await withApi(ok, async ({ sent, call }) => {
    const fields = [{ key: "invoice_total", type: "number", required: true }];
    const result = await call("didit_verify_document_ai", {
      document_base64: PNG,
      fields,
      expected_company_name: "Acme",
      actions: { document_ai_name_mismatch_action: "REVIEW" },
      metadata: { plan: "pro" },
    });
    assert.equal(result.isError, undefined, textOf(result));
    const [{ method, path, body }] = sent;
    const { document, ...rest } = body;
    assert.deepEqual([method, path], ["POST", `${CONSOLE}/apis/document-ai/`]);
    assert.equal(document.type, "image/png");
    assert.deepEqual(rest, {
      fields: JSON.stringify(fields),
      expected_company_name: "Acme",
      document_ai_name_mismatch_action: "REVIEW",
      metadata: '{"plan":"pro"}',
    });

    const missing = await call("didit_verify_document_ai", { fields });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /document/);
    assert.equal(sent.length, 1);
  });
});

test("an address is validated through the console proxy, and the API's refusal is relayed", async () => {
  const address = { address: "Paseo de la Castellana 259, 28046 Madrid", country: "ES" };
  assert.deepEqual(await requestOf("didit_verify_address", address), { method: "POST", path: `${CONSOLE}/apis/address-validation/`, body: address });
  await withApi(() => json({ code: "insufficient_credits", detail: "Not enough credits." }, 403), async ({ call }) => {
    const result = await call("didit_verify_address", address);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Not enough credits/);
  });
});

test("a risk check goes to the route of its kind, with the names that route uses", async () => {
  assert.deepEqual(await requestOf("didit_verify_risk", { kind: "phone", value: "+34600000012", country: "ES", enable_social: true }), {
    method: "POST", path: `${CONSOLE}/apis/phone-risk/`, body: { phone_number: "+34600000012", country_code: "ES", enable_social: true },
  });
  assert.deepEqual(await requestOf("didit_verify_risk", { kind: "email", value: "ana@acme.test", signals: { ip: "192.0.2.1" } }), {
    method: "POST", path: `${CONSOLE}/apis/email-risk/`, body: { email: "ana@acme.test", signals: { ip: "192.0.2.1" } },
  });
  assert.deepEqual(await requestOf("didit_verify_risk", { kind: "ip", value: "192.0.2.1", country: "ES", user_agent: "UA" }), {
    method: "POST", path: `${CONSOLE}/apis/ip-risk/`, body: { ip_address: "192.0.2.1", claimed_country: "ES", user_agent: "UA" },
  });
  await withApi(ok, async ({ sent, call }) => {
    for (const args of [{ kind: "ip", value: "192.0.2.1", enable_social: true }, { kind: "phone", value: "+34600000012", user_agent: "UA" }, { kind: "../aml", value: "x" }]) {
      assert.equal((await call("didit_verify_risk", args)).isError, true);
    }
    assert.deepEqual(sent, []);
  });
});

test("a fraud check only plans unless it is told to run and the person agreed", async () => {
  const identifiers = [{ type: "email", value: "ana@acme.test" }];
  const body = { subject: { identifiers } };
  assert.deepEqual(await requestOf("didit_verify_fraud_check", { identifiers }), { method: "POST", path: `${CONSOLE}/apis/fraud-check/plan/`, body });
  assert.deepEqual(await requestOf("didit_verify_fraud_check", { identifiers, client_reference: "ref-1", plan_only: false, confirm: true }), {
    method: "POST", path: `${CONSOLE}/apis/fraud-check/`, body: { client_reference: "ref-1", ...body },
  });
  await withApi(ok, async ({ sent, call, client }) => {
    const refused = await call("didit_verify_fraud_check", { identifiers, plan_only: false });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /confirm/);
    assert.deepEqual(sent, []);
    const { tools } = await client.listTools();
    const { confirm } = tools.find((tool) => tool.name === "didit_verify_fraud_check").inputSchema.properties;
    assert.match(confirm.description, /explicit user confirmation of this exact action/);
  });
});

test("a number is validated with the application key", async () => {
  await withApi(() => json({ valid: true, charged: false }), async ({ sent, call }) => {
    const result = await call("didit_phone_validate", { phone_number: "600000012", country: "ES" });
    assert.equal(result.isError, undefined, textOf(result));
    const [{ method, path, headers, body }] = sent;
    assert.deepEqual({ method, path, body }, { method: "POST", path: "/phone/validate/", body: { phone_number: "600000012", country: "ES" } });
    assert.equal(headers["x-api-key"], API_KEY);
    assert.equal(headers.Authorization, undefined);
  });
  await withApi(() => json({ code: "invalid_phone_number", detail: "That is not a phone number." }, 400), async ({ call }) => {
    const result = await call("didit_phone_validate", { phone_number: "1" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not a phone number/);
  });
});

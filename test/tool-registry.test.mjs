import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// A registered tool (src/tools/registry.ts) declares in one object what it is, what a call does,
// what the caller's role needs and what runs it. These tests hold the server to what each one
// declares, so the next area that moves here cannot drift from it either:
//
//   - it is listed once, by every server that lists its area, with the annotations it declares;
//   - its permission is the one the permission pre-check uses;
//   - no name-keyed table of index.ts still classifies it (one fact, one place);
//   - a call reaches its handler, and the handler makes the request the tool stands for.

for (const name of ["DIDIT_ACCESS_TOKEN", "DIDIT_IS_STAFF", "MCP_DEFAULT_TOOLSETS", "MCP_PERMISSION_MODE", "DIDIT_DOCS_MCP_URL", "DIDIT_TOOLSETS", "DIDIT_READ_ONLY", "MCP_DEFAULT_ORG", "MCP_DEFAULT_APP"]) {
  delete process.env[name];
}

const { createServer, NAME_KEYED_TABLES } = await import("../dist/index.js");
const { REGISTERED_TOOL_LIST, REGISTERED_TOOLS } = await import("../dist/tools/registered.js");
const { byName } = await import("../dist/tools/registry.js");
const { TOOL_PERMISSIONS } = await import("../dist/permissions.js");

const API = "https://verification.didit.me/v3";
const ORG = "0d6b5c1e-2f3a-4b7c-8d9e-1a2b3c4d5e6f";
const APP = "a1b2c3d4-0000-4000-8000-000000000002";
const DESTINATION = "5e55aaaa-2222-4333-8444-555555555555";
const PERSON = { token: "person.access.token", clientId: "registry-test", scopes: [], extra: { organization_id: ORG } };

async function withClient(options, authInfo, run) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  }
  const client = new Client({ name: "registry-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// The areas moved so far. An area joins this list in the change that moves it.
const AREAS = {
  webhooks: ["didit_webhook_list", "didit_webhook_create", "didit_webhook_get", "didit_webhook_update", "didit_webhook_delete"],
  branding: ["didit_branding_get", "didit_branding_update"],
  questionnaires: [
    "didit_questionnaire_list", "didit_questionnaire_create", "didit_questionnaire_append_choices",
    "didit_questionnaire_get", "didit_questionnaire_update", "didit_questionnaire_delete",
  ],
  lists: [
    "didit_lists_list", "didit_lists_create", "didit_lists_get", "didit_lists_update", "didit_lists_delete",
    "didit_lists_entries_list", "didit_lists_entry_create", "didit_lists_entry_upload_face", "didit_lists_entry_delete",
  ],
  cases: ["didit_case_list", "didit_case_get", "didit_case_create", "didit_case_statistics", "didit_case_manage"],
  transactionRules: [
    "didit_transaction_rule_list", "didit_transaction_rule_get", "didit_transaction_rule_create",
    "didit_transaction_rule_update", "didit_transaction_rule_delete", "didit_transaction_rule_backtest",
    "didit_transaction_rule_library_list", "didit_transaction_rule_install", "didit_transaction_rule_uninstall",
  ],
  search: ["didit_session_search", "didit_transaction_search", "didit_case_search", "didit_vendor_user_search", "didit_vendor_business_search"],
  transactions: ["didit_transaction_list", "didit_transaction_create", "didit_transaction_get", "didit_transaction_screen_wallet"],
  vendorUsers: [
    "didit_vendor_user_list", "didit_vendor_user_create", "didit_vendor_user_get",
    "didit_vendor_user_update", "didit_vendor_user_update_status", "didit_vendor_user_delete",
  ],
  vendorBusinesses: [
    "didit_vendor_business_list", "didit_vendor_business_create", "didit_vendor_business_get",
    "didit_vendor_business_update", "didit_vendor_business_update_status", "didit_vendor_business_delete",
  ],
  reports: ["didit_report_list", "didit_report_get", "didit_report_get_download_url", "didit_report_export"],
  auditAndAlerts: ["didit_audit_log_list", "didit_alert_list", "didit_alert_configure"],
  orgMembers: [
    "didit_org_list_members", "didit_org_invite_member", "didit_org_update_member", "didit_org_remove_member",
    "didit_org_list_roles", "didit_org_create_api_key", "didit_org_list_api_keys",
  ],
  blocklist: ["didit_blocklist_get", "didit_blocklist_add", "didit_blocklist_remove", "didit_allowlist_add"],
  billing: [
    "didit_billing_get_plan", "didit_billing_quote_plan", "didit_billing_list_payment_methods",
    "didit_billing_list_receipts", "didit_billing_get_details", "didit_billing_update_details",
  ],
  sessions: [
    "didit_session_create", "didit_session_list", "didit_session_get_decision", "didit_session_get_location_evidence",
    "didit_session_simulate", "didit_session_update_status", "didit_session_update_data", "didit_session_update_poa_data",
    "didit_session_delete", "didit_session_batch_delete", "didit_session_generate_pdf", "didit_session_get_signature_evidence",
    "didit_session_get_signed_document", "didit_session_get_signature_field_image", "didit_session_validate_signatures",
    "didit_session_list_reviews", "didit_session_add_review", "didit_session_share", "didit_session_explain_decision",
    "didit_session_webhooks", "didit_session_webhook_resend", "didit_session_import_shared",
  ],
  sessionImports: [
    "didit_session_create_import", "didit_session_list_import_providers", "didit_session_check_import_provider",
    "didit_session_manage_import", "didit_session_get_import_template", "didit_session_get_import", "didit_session_get_import_errors",
  ],
  standaloneDocuments: ["didit_verify_id", "didit_verify_poa", "didit_verify_account_check", "didit_verify_database"],
  standaloneKyb: ["didit_verify_kyb_search", "didit_verify_kyb_select"],
  standaloneBiometrics: ["didit_verify_passive_liveness", "didit_verify_face_match", "didit_verify_face_search", "didit_verify_age"],
  standaloneAml: ["didit_verify_aml"],
  standaloneContact: ["didit_verify_email_send", "didit_verify_email_check", "didit_verify_phone_send", "didit_verify_phone_check"],
  workflows: [
    "didit_workflow_list", "didit_workflow_create", "didit_workflow_get", "didit_workflow_update", "didit_workflow_delete",
    "didit_workflow_search", "didit_workflow_get_graph", "didit_workflow_get_field_definitions",
    "didit_workflow_get_feature_config_schema", "didit_workflow_get_id_verification_methods_catalog",
    "didit_workflow_get_kyb_registry_catalog", "didit_workflow_get_branch_fields", "didit_workflow_validate_graph",
    "didit_workflow_edit_graph", "didit_workflow_set_graph", "didit_workflow_create_draft", "didit_workflow_publish",
  ],
};

test("the registry holds the tools of every moved area, each once", () => {
  const names = REGISTERED_TOOL_LIST.map((tool) => tool.def.name);
  assert.deepEqual([...names].sort(), Object.values(AREAS).flat().sort());
  assert.equal(REGISTERED_TOOLS.size, names.length);
  assert.throws(() => byName([REGISTERED_TOOL_LIST[0], REGISTERED_TOOL_LIST[0]]), /registered twice/);
});

test("every registered tool is listed once, with the annotations it declares", async () => {
  for (const [label, options, authInfo] of [["local", {}, undefined], ["hosted", { hosted: true }, PERSON]]) {
    const { tools } = await withClient(options, authInfo, (client) => client.listTools());
    for (const registered of REGISTERED_TOOL_LIST) {
      const listed = tools.filter((tool) => tool.name === registered.def.name);
      assert.equal(listed.length, 1, `${label}: ${registered.def.name} is listed once`);
      const { annotations } = listed[0];
      assert.equal(annotations.readOnlyHint, registered.access === "read", `${label}: ${registered.def.name} readOnlyHint`);
      assert.equal(annotations.destructiveHint, registered.access === "destructive", `${label}: ${registered.def.name} destructiveHint`);
      assert.equal(annotations.openWorldHint, registered.openWorld === true, `${label}: ${registered.def.name} openWorldHint`);
      assert.equal(listed[0].description, registered.def.description);
    }
  }
});

test("a registered tool's permission is the one the permission pre-check uses", () => {
  for (const registered of REGISTERED_TOOL_LIST) {
    assert.ok(registered.def.name in TOOL_PERMISSIONS, `${registered.def.name} has a permission entry`);
    assert.equal(TOOL_PERMISSIONS[registered.def.name], registered.permission, registered.def.name);
  }
});

test("no name-keyed table still classifies a registered tool", () => {
  for (const [table, names] of Object.entries(NAME_KEYED_TABLES)) {
    for (const name of names) assert.equal(REGISTERED_TOOLS.has(name), false, `${name} is registered and still in ${table}`);
  }
});

test("a call reaches the tool's handler, which makes the request the tool stands for", async () => {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : undefined;
    requests.push({ method: (init?.method ?? "GET").toUpperCase(), path: new URL(String(url)).pathname, body });
    const status = (init?.method ?? "GET").toUpperCase() === "DELETE" ? 204 : 200;
    return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify({ uuid: DESTINATION, results: [] }), { status, headers: { "Content-Type": "application/json" } });
  };
  const scope = { organization_id: ORG, application_id: APP };
  const base = `/v3/organization/${ORG}/application/${APP}/webhook/destinations/`;
  try {
    await withClient({ hosted: true }, PERSON, async (client) => {
      const call = async (name, args) => {
        requests.length = 0;
        const result = await client.callTool({ name, arguments: { ...scope, ...args } });
        assert.equal(result.isError, undefined, `${name}: ${result.content?.[0]?.text}`);
        return requests.filter((request) => request.path.startsWith("/v3/"));
      };
      assert.deepEqual(await call("didit_webhook_list", {}), [{ method: "GET", path: base, body: undefined }]);
      assert.deepEqual(await call("didit_webhook_create", { label: "Prod", url: "https://hooks.example.com/didit" }), [
        { method: "POST", path: base, body: { label: "Prod", url: "https://hooks.example.com/didit" } },
      ]);
      assert.deepEqual(await call("didit_webhook_get", { destination_uuid: DESTINATION }), [{ method: "GET", path: `${base}${DESTINATION}/`, body: undefined }]);
      assert.deepEqual(await call("didit_webhook_update", { destination_uuid: DESTINATION, enabled: false }), [
        { method: "PATCH", path: `${base}${DESTINATION}/`, body: { enabled: false } },
      ]);
      assert.deepEqual(await call("didit_webhook_delete", { destination_uuid: DESTINATION }), [{ method: "DELETE", path: `${base}${DESTINATION}/`, body: undefined }]);

      const branding = `/v3/organization/${ORG}/application/${APP}/white-label-customization/`;
      assert.deepEqual(await call("didit_branding_get", {}), [{ method: "GET", path: branding, body: undefined }]);
      assert.deepEqual(await call("didit_branding_update", { sms_sender_name: "Acme Bank" }), [
        { method: "PATCH", path: branding, body: { sms_sender_name: "Acme Bank" } },
      ]);

      const questionnaires = `/v3/organization/${ORG}/application/${APP}/questionnaires/`;
      const QUESTIONNAIRE = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
      assert.deepEqual(await call("didit_questionnaire_list", {}), [{ method: "GET", path: questionnaires, body: undefined }]);
      assert.deepEqual(await call("didit_questionnaire_get", { questionnaire_id: QUESTIONNAIRE }), [{ method: "GET", path: `${questionnaires}${QUESTIONNAIRE}/`, body: undefined }]);
      assert.deepEqual(await call("didit_questionnaire_delete", { questionnaire_id: QUESTIONNAIRE, confirm: true }), [
        { method: "DELETE", path: `${questionnaires}${QUESTIONNAIRE}/`, body: undefined },
      ]);

      const LIST = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
      const ENTRY = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
      const list = `/v3/organization/${ORG}/application/${APP}/lists/${LIST}/`;
      assert.deepEqual(await call("didit_lists_get", { list_uuid: LIST }), [{ method: "GET", path: list, body: undefined }]);
      assert.deepEqual(await call("didit_lists_update", { list_uuid: LIST, name: "VIP" }), [{ method: "PATCH", path: list, body: { name: "VIP" } }]);
      assert.deepEqual(await call("didit_lists_entries_list", { list_uuid: LIST }), [{ method: "GET", path: `${list}entries/`, body: undefined }]);
      assert.deepEqual(await call("didit_lists_entry_create", { list_uuid: LIST, value: "+34600000000" }), [
        { method: "POST", path: `${list}entries/`, body: { value: "+34600000000" } },
      ]);
      assert.deepEqual(await call("didit_lists_entry_delete", { list_uuid: LIST, entry_uuid: ENTRY, confirm: true }), [
        { method: "DELETE", path: `${list}entries/${ENTRY}/`, body: undefined },
      ]);

      const CASE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
      const cases = `/v3/organization/${ORG}/application/${APP}/cases/`;
      assert.deepEqual(await call("didit_case_list", {}), [{ method: "GET", path: cases, body: undefined }]);
      assert.deepEqual(await call("didit_case_get", { case_id: CASE }), [{ method: "GET", path: `${cases}${CASE}/`, body: undefined }]);
      assert.deepEqual(await call("didit_case_statistics", {}), [{ method: "GET", path: `${cases}statistics/`, body: undefined }]);

      const RULE = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
      const rules = `/v3/organization/${ORG}/application/${APP}/transactions/rules/`;
      assert.deepEqual(await call("didit_transaction_rule_list", {}), [{ method: "GET", path: rules, body: undefined }]);
      assert.deepEqual(await call("didit_transaction_rule_get", { rule_uuid: RULE }), [{ method: "GET", path: `${rules}${RULE}/`, body: undefined }]);
      assert.deepEqual(await call("didit_transaction_rule_delete", { rule_uuid: RULE, confirm: true }), [{ method: "DELETE", path: `${rules}${RULE}/`, body: undefined }]);
    });
  } finally {
    globalThis.fetch = original;
  }
});

// A registered list of one application can declare what runs when the caller named none and has
// several: the same list across all of them. That must still win over the tool's own handler.
for (const [tool, resource] of [["didit_case_list", "/cases/"], ["didit_transaction_list", "/transactions/"], ["didit_vendor_user_list", "/vendor-users/"], ["didit_vendor_business_list", "/vendor-businesses/"], ["didit_workflow_list", "/verification-settings/"], ["didit_session_list", "/sessions/"]])
test(`${tool} spans applications when the caller named none of several`, async () => {
  const AUTH = "https://apx.didit.me/auth/v2";
  const OTHER_APP = "a1b2c3d4-0000-4000-8000-000000000003";
  const paths = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (`https://apx.didit.me${path}` === `${AUTH}/organizations/me/`) return json([{ uuid: ORG, name: "Acme" }]);
    if (`https://apx.didit.me${path}` === `${AUTH}/organizations/me/${ORG}/applications/`) {
      return json([{ uuid: APP, name: "Acme live", mode: "live" }, { uuid: OTHER_APP, name: "Acme sandbox", mode: "sandbox" }]);
    }
    return json({ count: 0, next: null, previous: null, results: [] });
  };
  try {
    const person = { ...PERSON, token: `spanning.${tool}.token` };
    await withClient({ hosted: true }, person, async (client) => {
      const result = await client.callTool({ name: tool, arguments: {} });
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
    });
    const reads = paths.filter((path) => path.endsWith(resource));
    assert.ok(reads.length > 0, "the list was read");
    assert.ok(!reads.every((path) => path === `/v3/organization/${ORG}/application/${APP}${resource}`), `not only the first application: ${reads.join(", ")}`);
  } finally {
    globalThis.fetch = original;
  }
});

// A search across applications takes the routing ids the caller sent to narrow it: the dispatcher
// removes them from every other tool's arguments, and passes them on to a tool that says so.
test("a search narrowed to one application reads only that application", async () => {
  const AUTH = "https://apx.didit.me/auth/v2";
  const OTHER_APP = "a1b2c3d4-0000-4000-8000-000000000003";
  const paths = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (`https://apx.didit.me${path}` === `${AUTH}/organizations/me/`) return json([{ uuid: ORG, name: "Acme" }]);
    if (`https://apx.didit.me${path}` === `${AUTH}/organizations/me/${ORG}/applications/`) {
      return json([{ uuid: APP, name: "Acme live", mode: "live" }, { uuid: OTHER_APP, name: "Acme sandbox", mode: "sandbox" }]);
    }
    return json({ count: 0, next: null, previous: null, results: [] });
  };
  try {
    const person = { ...PERSON, token: "narrowing.person.token" };
    await withClient({ hosted: true }, person, async (client) => {
      const result = await client.callTool({ name: "didit_case_search", arguments: { organization_id: ORG, application_id: OTHER_APP } });
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
      assert.equal(result.structuredContent.scanned_apps, 1, "one application was searched");
      assert.equal(result.structuredContent.aggregated, false);
    });
    // Only the named application's cases: not the organization-wide read a search without ids makes.
    assert.deepEqual(paths.filter((path) => path.includes("/cases/")), [`/v3/organization/${ORG}/application/${OTHER_APP}/cases/`]);
  } finally {
    globalThis.fetch = original;
  }
});

// The member tools build the auth service path from the organization the caller sent. The ids route
// the call there, and never reach the query string or the body.
test("a member call goes to the organization the caller named, with no routing id in its query or body", async () => {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    requests.push({ method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, query: [...u.searchParams.keys()].sort(), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ count: 0, results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await withClient({ hosted: true }, { ...PERSON, token: "members.person.token" }, async (client) => {
      await client.callTool({ name: "didit_org_list_members", arguments: { organization_id: ORG, application_id: APP, page: 2 } });
      await client.callTool({ name: "didit_org_list_roles", arguments: { organization_id: ORG } });
    });
  } finally {
    globalThis.fetch = original;
  }
  const authCalls = requests.filter((request) => request.path.includes(`/organizations/${ORG}/`));
  assert.ok(authCalls.length >= 2, `both calls reached the named organization: ${requests.map((r) => r.path).join(", ")}`);
  for (const request of authCalls) {
    assert.ok(!request.query.includes("organization_id") && !request.query.includes("application_id"), `no routing id in the query of ${request.path}`);
    assert.ok(!request.body || (!("organization_id" in request.body) && !("application_id" in request.body)), `no routing id in the body of ${request.path}`);
  }
});

// The workflow list annotates its own rows with age assurance, on both of its paths: one
// application named, or every application when the caller named none of several.
for (const scoped of [true, false]) {
  test(`didit_workflow_list annotates age assurance ${scoped ? "for the application named" : "across every application"}`, async () => {
    const AUTH = "https://apx.didit.me/auth/v2";
    const OTHER_APP = "a1b2c3d4-0000-4000-8000-000000000003";
    const WORKFLOW = "77777777-2222-4333-8444-555555555555";
    const paths = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (`https://apx.didit.me${path}` === `${AUTH}/organizations/me/`) return json([{ uuid: ORG, name: "Acme" }]);
      if (`https://apx.didit.me${path}` === `${AUTH}/organizations/me/${ORG}/applications/`) {
        return json([{ uuid: APP, name: "Acme live", mode: "live" }, { uuid: OTHER_APP, name: "Acme sandbox", mode: "sandbox" }]);
      }
      if (path.endsWith("/workflow-graph/")) return json({ graph: { start_node: "n1", nodes: { n1: { type: "status", status: "Approved" } } } });
      if (path.endsWith(`/application/${APP}/verification-settings/`)) {
        return json({ count: 1, next: null, previous: null, results: [{ uuid: WORKFLOW, workflow_label: "KYC" }] });
      }
      return json({ count: 0, next: null, previous: null, results: [] });
    };
    try {
      const person = { ...PERSON, token: `age.${scoped}.token` };
      await withClient({ hosted: true }, person, async (client) => {
        const scope = scoped ? { organization_id: ORG, application_id: APP } : {};
        for (const flag of [false, true]) {
          paths.length = 0;
          const result = await client.callTool({ name: "didit_workflow_list", arguments: { ...scope, include_age_assurance: flag } });
          assert.equal(result.isError, undefined, result.content?.[0]?.text);
          const graphReads = paths.filter((path) => path.endsWith(`/verification-settings/${WORKFLOW}/workflow-graph/`));
          assert.equal(graphReads.length, flag ? 1 : 0, `include_age_assurance ${flag}: graph reads ${graphReads.length}`);
          if (flag) assert.match(JSON.stringify(result.structuredContent ?? result.content), /does_age_assurance/);
        }
      });
    } finally {
      globalThis.fetch = original;
    }
  });
}

// A scope-agnostic tool (the KYB registry catalog is a public price list) resolves no default
// scope: the dispatcher does not read the caller's organizations and applications for it.
test("a scope-agnostic registered tool resolves no default organization or application", async () => {
  const paths = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    paths.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ ES: { country: "ES", tiers: {} } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await withClient({ hosted: true }, { ...PERSON, token: "kyb.catalog.token" }, async (client) => {
      const result = await client.callTool({ name: "didit_workflow_get_kyb_registry_catalog", arguments: {} });
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(paths.filter((path) => path.includes("/organizations/me")), [], `no scope lookups: ${paths.join(", ")}`);
  assert.ok(paths.some((path) => path.endsWith("/organization/kyb-registry-pricing/")), "the catalog was read");
});

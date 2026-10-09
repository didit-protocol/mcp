import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { requestContext, orgAppPath, orgPath } from "../dist/config.js";
import { pathSegment, DiditError } from "../dist/security.js";
import { scope, inScope, interceptFetch, testRoutingHandlers } from "./helpers/path-routing.mjs";
import * as lists from "../dist/tools/lists.js";
import * as members from "../dist/tools/members.js";
import * as questionnaires from "../dist/tools/questionnaires.js";
import * as reports from "../dist/tools/reports.js";
import * as transactions from "../dist/tools/transactions.js";
import * as observability from "../dist/tools/observability.js";
import * as settings from "../dist/tools/settings.js";
import * as users from "../dist/tools/users.js";
import * as businesses from "../dist/tools/businesses.js";
import { getWorkflowGraph, publishWorkflow } from "../dist/tools/workflow-graph.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64");

testRoutingHandlers([
  ["list detail", (id) => lists.getListDetail(id)],
  ["list update", (id) => lists.updateList(id, { name: "test" })],
  ["list delete", (id) => lists.deleteList(id)],
  ["list entries", (id) => lists.listEntries(id)],
  ["list entry create", (id) => lists.createEntry(id, {})],
  ["list entry delete/list", (id) => lists.deleteEntry(id, "entry")],
  ["list entry delete/entry", (id) => lists.deleteEntry("list", id)],
  ["face entry upload", (id) => lists.uploadFaceEntry(id, { image_base64: png })],
  ["member update", (id) => members.updateMember(id, { role: "reader" })],
  ["member removal", (id) => members.removeMember(id)],
  ["member organization", (id) => members.listMembers(id), true],
  ["API-key organization", (id) => members.listApiKeys(id, "app"), true],
  ["questionnaire read", (id) => questionnaires.getQuestionnaire(id)],
  ["questionnaire update", (id) => questionnaires.updateQuestionnaire(id, { title: "test" })],
  ["questionnaire delete", (id) => questionnaires.deleteQuestionnaire(id)],
  ["report read", (id) => reports.getReport(id)],
  ["report download", (id) => reports.getReportDownloadUrl(id)],
  ["report export kind", (id) => reports.exportReport(id)],
  ["transaction read", (id) => transactions.getTransaction(id)],
  ["alert configuration", (id) => observability.configureAlert(id, {})],
  ["workflow read", (id) => settings.getWorkflow(id)],
  ["workflow update", (id) => settings.updateWorkflow(id, { status: "draft" })],
  ["workflow delete", (id) => settings.deleteWorkflow(id)],
]);

test("scope builders guard explicit and contextual IDs without changing precedence", () => {
  for (const id of ["..", "../other", "x?y", "x#y", "x/y"]) {
    assert.throws(() => inScope(() => orgAppPath("/lists/", { organizationId: id })), DiditError);
    assert.throws(() => inScope(() => orgAppPath("/lists/", { applicationId: id })), DiditError);
    assert.throws(() => orgPath("/top-up/", { organizationId: id }), DiditError);
    assert.throws(() => requestContext.run({ ...scope, organizationId: id }, () => orgPath("/top-up/")), DiditError);
    assert.throws(() => requestContext.run({ ...scope, applicationId: id }, () => orgAppPath("/lists/")), DiditError);
  }
  assert.equal(inScope(() => orgAppPath("/lists/", { organizationId: "explicit-org", applicationId: "explicit-app" })),
    "/organization/explicit-org/application/explicit-app/lists/");
});

test("encoded-looking values, backslashes and controls stay inside one URL segment", () => {
  for (const id of ["%2e%2e", "%2E.", "%2f", "%5c", "%252e%252e", "..\\other", ".\t.", ".\n.", "customer..prod", "客户", "a%20b"]) {
    const encoded = pathSegment(id, "id");
    const url = new URL(`https://synthetic.invalid/parent/${encoded}/child/`);
    assert.equal(url.pathname, `/parent/${encodeURIComponent(id)}/child/`, id);
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
  }
});

test("ordinary routes preserve methods, bodies, member slash behavior and encoded IDs", async (t) => {
  const calls = interceptFetch(t);
  await inScope(() => lists.updateList("customer..prod", { name: "updated" }));
  await inScope(() => members.updateMember("member-1", { role: "reader", accessible_applications: ["app-1"] }));
  await inScope(() => members.removeMember("member-1"));
  await inScope(() => reports.getReport("report %2e 客户"));
  assert.equal(calls[0].url.pathname, "/v3/organization/synthetic-org/application/synthetic-app/lists/customer..prod/");
  assert.equal(calls[0].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].body), { name: "updated" });
  assert.equal(calls[1].url.pathname, "/auth/v2/organizations/synthetic-org/members/member-1");
  assert.deepEqual(JSON.parse(calls[1].body), { role: "reader", accessible_applications: ["app-1"] });
  assert.equal(calls[2].method, "DELETE");
  assert.equal(calls[2].url.pathname, calls[1].url.pathname);
  assert.equal(calls[3].url.pathname, `/v3/organization/synthetic-org/application/synthetic-app/reports/${encodeURIComponent("report %2e 客户")}/`);
});

test("opaque vendor identifiers preserve their exact value and reject empty/dot segments", async (t) => {
  const calls = interceptFetch(t);
  const routes = [
    [users.getUser, "vendor-users", ""],
    [(id) => users.updateUser(id, { name: "test" }), "vendor-users", "update/"],
    [businesses.getBusiness, "vendor-businesses", ""],
    [(id) => businesses.updateBusiness(id, { name: "test" }), "vendor-businesses", "update/"],
  ];
  for (const [run, resource, suffix] of routes) {
    for (const id of ["", ".", ".."]) await assert.rejects(inScope(() => run(id)), DiditError);
    for (const id of [" customer ", " .. ", "a/b", "a\\b", "a?b#c", "%2e%2e", "a%20b", "客户", ".\t."]) {
      await inScope(() => run(id));
      assert.equal(calls.at(-1).url.pathname,
        `/v3/organization/synthetic-org/application/synthetic-app/${resource}/${encodeURIComponent(id)}/${suffix}`);
    }
  }
});

test("returned workflow IDs cannot redirect graph reads or draft publication", async (t) => {
  const calls = [];
  const workflowScope = { organization_id: scope.organizationId, application_id: scope.applicationId };
  const prefix = "/v3/organization/synthetic-org/application/synthetic-app/verification-settings/";
  let returnUnsafeVersion = true;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init.method ?? "GET" });
    if (path === `${prefix}known-version/`) {
      return Response.json({ uuid: returnUnsafeVersion ? "../unexpected-resource" : "known-version", status: "published", has_draft: true });
    }
    if (path === `${prefix}known-version/create-draft/`) return Response.json({ uuid: "../unexpected-resource", status: "draft" });
    assert.fail(`Unexpected request: ${path}`);
  });
  await assert.rejects(inScope(() => getWorkflowGraph("known-version", workflowScope)), DiditError);
  assert.deepEqual(calls, [{ path: `${prefix}known-version/`, method: "GET" }]);
  calls.length = 0;
  returnUnsafeVersion = false;
  await assert.rejects(inScope(() => publishWorkflow("known-version", workflowScope)), DiditError);
  assert.deepEqual(calls, [
    { path: `${prefix}known-version/`, method: "GET" },
    { path: `${prefix}known-version/create-draft/`, method: "POST" },
  ]);
});

test("MCP dispatch rejects unsafe IDs and keeps session deletion confirmation enforced", async (t) => {
  const calls = interceptFetch(t);
  const client = new Client({ name: "offline-routing-test", version: "1" });
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const [name, args] of [
      ["didit_lists_delete", { list_uuid: "../unexpected-resource" }],
      ["didit_org_remove_member", { member_id: "../unexpected-resource" }],
      ["didit_questionnaire_delete", { questionnaire_id: "../unexpected-resource" }],
      ["didit_session_delete", { session_id: "synthetic-session" }],
    ]) {
      const result = await client.callTool({ name, arguments: { organization_id: scope.organizationId, application_id: scope.applicationId, ...args } });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /bad_request|unsafe_operation/, name);
    }
    assert.equal(calls.length, 0);
    const catalog = await client.listTools();
    assert.equal(catalog.tools.find((tool) => tool.name === "didit_session_update_status").annotations.destructiveHint, true);
  } finally {
    await client.close();
    await server.close();
  }
});

// a raw id in one tool's arguments must not steer the generated HTTP request to a
// DIFFERENT backend endpoint. The external reporter reproduced it through the real stdio
// entrypoint against a mock backend: `didit_lists_delete {list_uuid: "../../../../../session/abc/delete"}`
// issued the DELETE that `didit_session_delete` makes, without that tool's confirm gate, and
// `didit_org_remove_member {member_id: "../../applications/APP1/api-keys/KEY"}` reached the
// api-key path. This keeps that reproduction as a regression test: it fails on any URL builder
// that interpolates a raw id, and passes only while every id goes through pathSegment().
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function recordingBackend() {
  const requests = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests })));
}

async function connectStdio(backendUrl) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, "dist", "index.js")],
    cwd: repoRoot,
    env: {
      ...getDefaultEnvironment(),
      DIDIT_API_BASE_URL: `${backendUrl}/v3`,
      DIDIT_AUTH_BASE_URL: `${backendUrl}/auth/v2`,
      DIDIT_ACCESS_TOKEN: "synthetic-caller-token",
      MCP_DEFAULT_ORG: "synthetic-org",
      MCP_DEFAULT_APP: "synthetic-app",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "path-segment-routing-stdio", version: "1" });
  await client.connect(transport);
  return client;
}

test("stdio: a traversed id is refused instead of reaching another tool's endpoint", { timeout: 30_000 }, async (t) => {
  const { server, requests } = await recordingBackend();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = await connectStdio(`http://127.0.0.1:${server.address().port}`);
  t.after(() => client.close());

  for (const [name, args] of [
    ["didit_lists_delete", { list_uuid: "../../../../../session/abc/delete" }],
    ["didit_org_remove_member", { member_id: "../../applications/APP1/api-keys/KEY" }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} must reject the traversed id`);
    assert.match(result.content[0].text, /bad_request/, name);
  }
  // The endpoint those payloads target keeps its own confirm gate.
  const unconfirmed = await client.callTool({ name: "didit_session_delete", arguments: { session_id: "abc" } });
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.content[0].text, /unsafe_operation/);
  assert.deepEqual(requests, [], "a traversed id must not let a request leave the server");

  const catalog = await client.listTools();
  const updateStatus = catalog.tools.find((tool) => tool.name === "didit_session_update_status");
  assert.equal(updateStatus.annotations.destructiveHint, true, "approve/decline is destructive by behaviour");
});

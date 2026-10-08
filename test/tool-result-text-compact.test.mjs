// The model-facing `content` text of a tool result is COMPACT JSON.
//
// A client whose tool carries an outputSchema (didit-ai-assistant through
// @mastra/mcp) hands the `content` text to the model and keeps
// `structuredContent` for code. The 2-space pretty print tripled every result
// on its way to the model: seven didit_workflow_get reads reached it as ~147k
// chars each instead of ~50k and burst a 1.05M-token window (Sentry
// DIDIT-AI-ASSISTANT-2K, 429 turns 11-15 Sep 2026). Same data, compact form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("a tool result's text content is compact JSON equal to its structuredContent", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "compact-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const res = await client.callTool({ name: "didit_workflow_get_feature_config_schema", arguments: {} });
  const text = res.content[0].text;

  assert.equal(text, JSON.stringify(res.structuredContent), "text is the compact form of the data");
  assert.doesNotMatch(text, /\n {2}"/, "no 2-space pretty print");
  assert.deepEqual(JSON.parse(text), res.structuredContent);
});

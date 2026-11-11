// What the server tells a model about itself: instructions on connect, prompts to start from,
// and the documentation search that keeps "how does Didit work" out of the model's memory.
//
// Clients truncate instructions (some after 512 characters, most after a few thousand) and not
// every client passes them on, so these tests hold the text to what survives: a first paragraph
// that stands on its own, a short total, and nothing that only makes sense if the rest arrived.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { createServer } from "../dist/index.js";
import { handleModernRpc } from "../dist/mcp-modern.js";
import { CORE_TOOLSET, parseSelection } from "../dist/toolsets.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

delete process.env.DIDIT_ACCESS_TOKEN;
delete process.env.DIDIT_IS_STAFF;
delete process.env.DIDIT_DOCS_MCP_URL;
delete process.env.MCP_PERMISSION_MODE;
delete process.env.MCP_DEFAULT_TOOLSETS;

const HOSTED_AUTH = { token: "user-token", clientId: "test-client", scopes: [], extra: {} };
const select = (toolsets, readOnly = false) => parseSelection(toolsets, readOnly, CORE_TOOLSET);
const realFetch = globalThis.fetch;

async function withClient(options, fn, authInfo) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (authInfo) {
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, sendOptions) => send(message, { ...(sendOptions ?? {}), authInfo });
  }
  const server = createServer(options);
  await server.connect(serverTransport);
  const client = new Client({ name: "guidance-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const hosted = (selection, fn) => withClient({ hosted: true, selection }, fn, HOSTED_AUTH);

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

test("the first paragraph stands on its own and says where to start", async () => {
  await hosted(select("core"), async (client) => {
    const instructions = client.getInstructions();
    const [first] = instructions.split("\n\n");
    assert.ok(first.length <= 512, `the first paragraph is ${first.length} characters; some clients keep only 512`);
    assert.match(first, /identity verification/);
    assert.match(first, /didit_context_get/);
    assert.ok(instructions.length <= 2000, `${instructions.length} characters of instructions (budget: 2,000)`);
  });
});

test("the instructions say what this connection loaded and how to reach the rest", async () => {
  await hosted(select("core,cases"), async (client) => {
    const instructions = client.getInstructions();
    assert.match(instructions, /loads these toolsets: core,cases\./);
    assert.match(instructions, /More tools exist in: .*sessions.*workflows/);
    assert.doesNotMatch(instructions, /More tools exist in: [^.]*\bcases\b/, "a loaded toolset is not advertised as missing");
    assert.match(instructions, /didit_tool_search/);
    assert.match(instructions, /\?toolsets=/, "a hosted server names the URL parameter");
    assert.match(instructions, /never ask the person for a password/);
  });
  await hosted(select("all"), async (client) => {
    const instructions = client.getInstructions();
    assert.match(instructions, /loads every toolset/);
    assert.doesNotMatch(instructions, /didit_tool_search/, "with everything loaded there is nothing to search for");
  });
});

test("a read-only connection is told so, and is never pointed at the write proxy", async () => {
  await hosted(select("core", true), async (client) => {
    const instructions = client.getInstructions();
    assert.match(instructions, /read-only/);
    assert.match(instructions, /didit_tool_call_read/);
    assert.doesNotMatch(instructions, /didit_tool_call_write/);
  });
});

test("an unknown toolset is named back with the valid ids, so the mistake can be fixed", async () => {
  await hosted(select("core,transactoins"), async (client) => {
    const instructions = client.getInstructions();
    assert.match(instructions, /Unknown toolsets were ignored: transactoins\./);
    assert.match(instructions, /Valid ids: core, .*transactions.*, all\./);
  });
});

test("a local server names its own switches, and offers sign-in instead of forbidding credentials", async () => {
  await withClient({ selection: select("core") }, async (client) => {
    const instructions = client.getInstructions();
    assert.match(instructions, /DIDIT_TOOLSETS|--toolsets/);
    assert.doesNotMatch(instructions, /\?toolsets=/);
    assert.doesNotMatch(instructions, /never ask the person for a password/, "the local sign-in tools take credentials by design");
  });
});

test("the instructions never promise a tool the connection cannot use", async () => {
  await hosted(select("core"), async (client) => {
    const listed = new Set((await client.listTools()).tools.map((tool) => tool.name));
    const named = client.getInstructions().match(/didit_[a-z0-9_]+/g) ?? [];
    assert.deepEqual([...new Set(named)].filter((name) => !listed.has(name)), []);
  });
});

test("server/discover carries the same instructions as initialize, for the same selection", async () => {
  const selection = select("core,cases", true);
  const discover = await handleModernRpc({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }, undefined, { selection });
  await hosted(selection, async (client) => {
    assert.equal(discover.result.instructions, client.getInstructions());
    assert.deepEqual(discover.result.capabilities, client.getServerCapabilities());
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

test("prompts are listed with a title, a description and typed arguments", async () => {
  await hosted(select("core"), async (client) => {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(
      prompts.map((prompt) => prompt.name),
      ["integrate_didit", "review_queue", "explain_session", "build_workflow", "verification_report"],
    );
    for (const prompt of prompts) {
      assert.match(prompt.name, /^[a-z_]+$/);
      assert.ok(prompt.title && prompt.description.endsWith("."), prompt.name);
      for (const argument of prompt.arguments ?? []) {
        assert.equal(typeof argument.required, "boolean", `${prompt.name}.${argument.name}`);
        assert.ok(argument.description.length > 5);
      }
    }
    assert.equal(prompts.find((prompt) => prompt.name === "explain_session").arguments[0].required, true);
  });
});

test("a prompt names each tool the way the connection reaches it: directly when listed, through a discovery tool when not", async () => {
  const names = async (client) => new Set((await client.listTools()).tools.map((tool) => tool.name));
  const everything = await hosted(select("all"), names);
  for (const selection of [select("all"), select("core"), select("cases")]) {
    await hosted(selection, async (client) => {
      const listed = await names(client);
      for (const { name } of (await client.listPrompts()).prompts) {
        const { messages } = await client.getPrompt({ name, arguments: {} });
        assert.equal(messages.length, 1);
        assert.equal(messages[0].role, "user");
        const text = messages[0].content.text;
        // "didit_tool_call_write (name: didit_workflow_create)" reaches a tool that is not listed.
        const proxied = [...text.matchAll(/\(name: (didit_[a-z0-9_]+)\)/g)].map((match) => match[1]);
        const direct = text.replace(/\(name: didit_[a-z0-9_]+\)/g, "").match(/didit_[a-z0-9_]+/g) ?? [];
        assert.deepEqual([...new Set(direct)].filter((tool) => !listed.has(tool)), [], `${name} names a tool this connection does not list`);
        assert.deepEqual(proxied.filter((tool) => listed.has(tool) || !everything.has(tool)), [], `${name} proxies a listed or unknown tool`);
      }
    });
  }
  const integrate = (selection) =>
    hosted(selection, async (client) => (await client.getPrompt({ name: "integrate_didit", arguments: {} })).messages[0].content.text);
  assert.match(await integrate(select("all")), /create a simple one with didit_workflow_create\./);
  assert.doesNotMatch(await integrate(select("all")), /didit_tool_/, "with everything listed no discovery tool is mentioned");
  assert.match(await integrate(select("core")), /create a simple one with didit_tool_call_write \(name: didit_workflow_create\)\./);
});

test("prompt arguments are filled in, trimmed and capped; an unknown prompt is an invalid-params error", async () => {
  await hosted(select("core"), async (client) => {
    const explained = await client.getPrompt({ name: "explain_session", arguments: { session_id: "  abc-123  " } });
    assert.match(explained.messages[0].content.text, /session abc-123 ended/);
    const long = await client.getPrompt({ name: "integrate_didit", arguments: { stack: "x".repeat(5000) } });
    assert.ok(long.messages[0].content.text.length < 2500, "an argument is capped, never pasted whole");
    await assert.rejects(client.getPrompt({ name: "nope", arguments: {} }), (error) => error.code === -32602);
  });
});

// ---------------------------------------------------------------------------
// Documentation search
// ---------------------------------------------------------------------------

/** A stand-in for the public documentation search server: answers one tools/call as an event stream. */
function docsServerReply(blocks) {
  const result = { jsonrpc: "2.0", id: 1, result: { content: blocks.map((text) => ({ type: "text", text })) } };

  return new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("docs search returns titled, linked sections and never sends the caller's token to the documentation server", async (t) => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });

    return docsServerReply([
      "Title: Signature verification\nLink: https://docs.didit.me/integration/webhooks#signature-verification\nPage: integration/webhooks\nContent: Every webhook is signed with HMAC-SHA256.",
      `Title: Long page\nLink: https://docs.didit.me/long\nPage: long\nContent: ${"word ".repeat(1000)}`,
      "Title: Third\nLink: https://docs.didit.me/third\nPage: third\nContent: third section",
    ]);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await hosted(select("core"), async (client) => {
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "didit_docs_search");
    assert.equal(tool.annotations.readOnlyHint, true);
    const { structuredContent, isError } = await client.callTool({
      name: "didit_docs_search",
      arguments: { query: " webhook signature ", limit: 2, language: "es" },
    });
    assert.notEqual(isError, true);
    assert.equal(structuredContent.query, "webhook signature");
    assert.equal(structuredContent.results.length, 2, "limit is honoured");
    assert.deepEqual(structuredContent.results[0], {
      title: "Signature verification",
      url: "https://docs.didit.me/integration/webhooks#signature-verification",
      content: "Every webhook is signed with HMAC-SHA256.",
    });
    assert.ok(structuredContent.results[1].content.length <= 1510, "a long section is cut; the link carries the rest");
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://docs.didit.me/mcp");
  assert.deepEqual(seen[0].body.params, { name: "search_didit_docs", arguments: { query: "webhook signature", language: "es" } });
  assert.doesNotMatch(JSON.stringify(seen[0].headers), /user-token|authorization/i, "the Didit token stays with Didit");
});

test("docs search fails soft: an outage is a clear, recoverable error, never a hang or a stack trace", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  await hosted(select("core"), async (client) => {
    for (const failure of [
      async () => new Response("<html>gateway</html>", { status: 502 }),
      async () => new Response("not json", { status: 200 }),
      async () => {
        throw new Error("ECONNRESET");
      },
    ]) {
      globalThis.fetch = failure;
      const result = await client.callTool({ name: "didit_docs_search", arguments: { query: "webhooks" } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /docs_unavailable/);
      assert.match(result.content[0].text, /docs\.didit\.me/);
      assert.doesNotMatch(result.content[0].text, /ECONNRESET|gateway|at .*\.js/);
    }
    const missing = await client.callTool({ name: "didit_docs_search", arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /query is required/);
  });
});

test("an empty DIDIT_DOCS_MCP_URL switches the documentation tool off everywhere it is mentioned", async (t) => {
  process.env.DIDIT_DOCS_MCP_URL = "";
  t.after(() => {
    delete process.env.DIDIT_DOCS_MCP_URL;
  });
  await hosted(select("core"), async (client) => {
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!listed.includes("didit_docs_search"));
    assert.doesNotMatch(client.getInstructions(), /didit_docs_search/);
    const prompt = (await client.getPrompt({ name: "integrate_didit", arguments: {} })).messages[0].content.text;
    assert.doesNotMatch(prompt, /didit_docs_search/);
    assert.match(prompt, /in the documentation at https:\/\/docs\.didit\.me/);
  });
});

// ---------------------------------------------------------------------------
// Over HTTP: the selection travels in the URL or in headers
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

function post(server, path, body, headers = {}) {
  const { port } = server.address();
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** The JSON-RPC result of a response that may be plain JSON or a one-message event stream. */
function rpcResult(raw) {
  const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());

  return JSON.parse(data.length ? data[data.length - 1] : raw).result;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
};

test("HTTP: a bare URL lists everything; the URL query and the headers select toolsets; the deployment sets the default", async (t) => {
  const previous = { ...process.env };
  process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
  process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
  // Protocol negotiation without a Bearer (config.ts): enough to read what each URL selects.
  process.env.MCP_PUBLIC_DISCOVERY = "true";
  delete process.env.MCP_DEFAULT_TOOLSETS;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        issuer: "https://business.didit.me",
        authorization_endpoint: "https://business.didit.me/authorize",
        token_endpoint: "https://business.didit.me/api/auth/oauth-token",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { createHttpApp } = require("../dist/http.js");
  const server = (await createHttpApp()).listen(0);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    globalThis.fetch = realFetch;
    return new Promise((resolve) => server.close(resolve));
  });

  const instructionsOf = async (path, headers) => {
    const res = await post(server, path, INITIALIZE, headers);
    assert.equal(res.status, 200, `${path}: ${res.raw.slice(0, 200)}`);

    return rpcResult(res.raw).instructions;
  };

  assert.match(await instructionsOf("/mcp"), /loads every toolset/, "no selection: everything, as before toolsets existed");
  assert.match(await instructionsOf("/mcp?toolsets=core"), /loads these toolsets: core\./);
  assert.match(await instructionsOf("/mcp?toolsets=core,cases"), /loads these toolsets: core,cases\./);
  assert.match(await instructionsOf("/mcp?toolsets=all"), /loads every toolset/);
  assert.match(await instructionsOf("/mcp?read_only=true"), /It is read-only/);
  assert.match(await instructionsOf("/mcp", { "X-MCP-Toolsets": "sessions", "X-MCP-Readonly": "true" }), /loads these toolsets: sessions\. It is read-only/);
  assert.match(await instructionsOf("/mcp?toolsets=nope"), /Unknown toolsets were ignored: nope\./);

  // A browser client may send the two headers: the preflight allows them.
  const preflight = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/mcp", method: "OPTIONS" }, resolve);
    req.on("error", reject);
    req.end();
  });
  assert.match(preflight.headers["access-control-allow-headers"], /x-mcp-toolsets, x-mcp-readonly/);

  // The health endpoint says what this build supports, readable from a browser on another origin:
  // the console offers a read-only connection only where the server will enforce it.
  const health = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, path: "/healthz", method: "GET", headers: { Origin: "https://business.didit.me" } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ headers: res.headers, body: JSON.parse(raw) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(health.body.status, "ok");
  assert.deepEqual(health.body.features, ["toolsets", "read_only", "tool_discovery", "prompts", "api_key"]);
  assert.equal(health.headers["access-control-allow-origin"], "https://business.didit.me");

  // The deployment's default is read per request: no rebuild, no restart of this app.
  process.env.MCP_DEFAULT_TOOLSETS = "core";
  assert.match(await instructionsOf("/mcp"), /loads these toolsets: core\./);
  assert.match(await instructionsOf("/mcp?toolsets=all"), /loads every toolset/, "an explicit request still wins");
});

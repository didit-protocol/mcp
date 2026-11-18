import { createRequire } from "node:module";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

// a paying customer could not add the hosted MCP as a claude.ai connector and the
// failure left nothing behind on this side — an auth service refusing every credential and a
// connection that never arrived produced the same, empty log, and so did a request that arrived and
// was cut off before the answer (the 502 shape). Every request to a hosted MCP endpoint that is
// refused, or that ends without an answer, now leaves one bounded line saying which it was
// (src/auth/refusal-log.ts), and never the credential.

process.env.MCP_RESOURCE_URI = "https://mcp.didit.me/mcp";
process.env.MCP_AUTHORIZATION_SERVER_ORIGIN = "https://business.didit.me";
process.env.DIDIT_OIDC_DISCOVERY_URL = "https://business.didit.me/.well-known/oauth-authorization-server";
process.env.MCP_OAUTH_INTROSPECT_URL = "https://auth.example.test/introspect/";
delete process.env.MCP_PUBLIC_DISCOVERY;
delete process.env.MCP_DEFAULT_ORG;

const require = createRequire(import.meta.url);
const { createHttpApp } = require("../dist/http.js");
const { profileServesWidgets } = require("../dist/chatgpt-app.js");
const { countableLine, refusalReasonOf } = require("../dist/auth/refusal-log.js");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** What the auth service answers; each test sets it. */
let introspection = () => json({ active: false });

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target === process.env.DIDIT_OIDC_DISCOVERY_URL) {
    return json({
      issuer: "https://business.didit.me",
      authorization_endpoint: "https://business.didit.me/authorize",
      token_endpoint: "https://business.didit.me/api/auth/oauth-token",
      registration_endpoint: "https://business.didit.me/api/auth/oauth-register",
    });
  }
  if (target === process.env.MCP_OAUTH_INTROSPECT_URL) return introspection();

  return json({});
};

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } },
};

/** One request; `raw` sends exactly those bytes, otherwise `body` is JSON-encoded. */
function request(server, { method = "POST", path = "/mcp", body, raw, headers = {} } = {}) {
  const { port } = server.address();
  const payload = raw === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : raw;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let rawAnswer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (rawAnswer += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: rawAnswer }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * The refusal lines one call produced, parsed. The stub keeps every line this module writes and
 * forwards anything else to the real console, so an application error during a test is still seen.
 */
async function refusalsOf(run) {
  const lines = [];
  const original = console.warn;
  console.warn = (line) => {
    const text = String(line);
    if (text.includes("hosted request")) lines.push(text);
    else original(line);
  };
  try {
    const answer = await run();
    // The `finish`/`close` listeners run when the response ends; one macrotask later is enough.
    await new Promise((resolve) => setTimeout(resolve, 30));

    return { answer, lines: lines.map((line) => JSON.parse(line)) };
  } finally {
    console.warn = original;
  }
}

async function withApp(fn) {
  const server = (await createHttpApp()).listen(0);
  try {
    return await fn(server);
  } finally {
    server.close();
  }
}

test("an unauthenticated call names the missing credential and the client that made it", async () => {
  introspection = () => json({ active: false });
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() =>
      request(server, { body: INITIALIZE, headers: { "User-Agent": "python-httpx/0.27.0", "X-Forwarded-For": "160.79.104.10, 10.0.0.7" } }),
    );

    assert.equal(answer.status, 401);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    const [line] = lines;
    assert.equal(line.message, "hosted request refused: missing_credential status=401 credential=none");
    assert.equal(line.level, "warn");
    assert.equal(line.path, "/mcp");
    assert.equal(line.method, "POST");
    assert.equal(line.status, 401);
    assert.equal(line.reason, "missing_credential");
    assert.equal(line.credential, "none");
    // Which program called, and the address the balancer saw last: the two facts a "did Anthropic
    // reach us" question needs. The first hop is whatever the caller declared.
    assert.equal(line.client, "python-httpx");
    assert.equal(line.forwarded, "10.0.0.7");
    assert.equal(typeof line.ms, "number");
  });
});

test("a caller that writes its own first hop is not recorded as that address", async () => {
  introspection = () => json({ active: false });
  await withApp(async (server) => {
    const { lines } = await refusalsOf(() =>
      request(server, { body: INITIALIZE, headers: { "X-Forwarded-For": "160.79.104.10, 203.0.113.9" } }),
    );

    assert.equal(lines.length, 1, JSON.stringify(lines));
    // 203.0.113.9 is what the balancer appended; 160.79.104.10 was typed by the caller.
    assert.equal(lines[0].forwarded, "203.0.113.9");
  });
});

test("a Bearer the auth service refuses is logged as refused, and the token never is", async () => {
  const token = "person.secret.access.token";
  introspection = () => json({ active: false });
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() =>
      request(server, { body: INITIALIZE, headers: { Authorization: `Bearer ${token}`, "User-Agent": "Claude-User/1.0" } }),
    );

    assert.equal(answer.status, 401);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].reason, "credential_refused");
    assert.equal(lines[0].credential, "authorization");
    assert.equal(lines[0].client, "Claude-User");
    assert.equal(lines[0].token, undefined);
    assert.ok(!JSON.stringify(lines).includes(token), "the credential must never reach the log");
  });
});

test("an x-api-key connection is logged as such, and the key never is", async () => {
  const key = "sk_live_9f2c8a7b6d5e4f3a2b1c0d9e8f7a6b5c";
  introspection = () => json({ active: false });
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() => request(server, { body: INITIALIZE, headers: { "x-api-key": key } }));

    assert.equal(answer.status, 401);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].credential, "x-api-key");
    assert.equal(lines[0].reason, "credential_refused");
    assert.ok(!JSON.stringify(lines).includes(key), "the key must never reach the log");
  });
});

test("an auth service that does not answer is not reported as a bad credential", async () => {
  introspection = () => json({ error: "unavailable" }, 503);
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() =>
      request(server, { body: INITIALIZE, headers: { Authorization: "Bearer person.access.token" } }),
    );

    // The verifier distinguishes "the service did not answer" (500, retryable) from "the token is
    // refused" (401, sign in again) — so the log must too.
    assert.equal(answer.status, 500);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].reason, "server_error");
    assert.equal(lines[0].credential, "authorization");
  });
});

test("a reachability probe with GET is logged with its method", async () => {
  introspection = () => json({ active: false });
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() => request(server, { method: "GET" }));

    assert.equal(answer.status, 405);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].method, "GET");
    assert.equal(lines[0].reason, "unsupported_method");
  });
});

test("an Accept header the transport cannot answer is logged as such", async () => {
  introspection = () =>
    json({
      active: true,
      token_use: "mcp",
      sub: "u-1",
      organization_id: "org-1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() =>
      // Only a client that accepts neither media type is refused (accept.ts): one that names JSON is
      // answered in JSON now, so the unanswerable case is a probe that asks for a page.
      request(server, { body: INITIALIZE, headers: { Authorization: "Bearer person.access.token", Accept: "text/html" } }),
    );

    assert.equal(answer.status, 406, answer.raw.slice(0, 200));
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].reason, "not_acceptable");
    assert.equal(lines[0].status, 406);
  });
});

test("a body the JSON parser rejects is logged, even though no route ever ran", async () => {
  introspection = () => json({ active: false });
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() =>
      request(server, { raw: '{"jsonrpc": "2.0",', headers: { "User-Agent": "Claude-User/1.0" } }),
    );

    assert.equal(answer.status, 400);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].reason, "bad_request");
    assert.equal(lines[0].status, 400);
    assert.equal(lines[0].client, "Claude-User");
  });
});

test("a body over the size limit and a charset the parser cannot read are logged too", async () => {
  introspection = () => json({ active: false });
  process.env.MCP_JSON_BODY_LIMIT = "1kb";
  try {
    await withApp(async (server) => {
      const oversized = await refusalsOf(() => request(server, { raw: JSON.stringify({ pad: "x".repeat(4096) }) }));
      assert.equal(oversized.answer.status, 413);
      assert.equal(oversized.lines.length, 1, JSON.stringify(oversized.lines));
      assert.equal(oversized.lines[0].reason, "bad_request");

      const charset = await refusalsOf(() =>
        request(server, { raw: JSON.stringify(INITIALIZE), headers: { "Content-Type": "application/json; charset=iso-8859-1" } }),
      );
      assert.equal(charset.answer.status, 415);
      assert.equal(charset.lines.length, 1, JSON.stringify(charset.lines));
      assert.equal(charset.lines[0].reason, "bad_request");
    });
  } finally {
    delete process.env.MCP_JSON_BODY_LIMIT;
  }
});

test("a request cut off before its answer is logged, with how long it stayed open", async () => {
  // The auth service never answers, so the request sits open; the caller then drops it, which is
  // what a connector sees as a 502 and what "finish" alone would leave invisible.
  introspection = () => new Promise(() => {});
  await withApp(async (server) => {
    const { lines } = await refusalsOf(async () => {
      const { port } = server.address();
      const payload = JSON.stringify(INITIALIZE);
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer person.access.token",
          "X-Forwarded-For": "160.79.104.10, 10.0.0.7",
        },
      });
      req.on("error", () => {});
      req.write(payload);
      req.end();
      await new Promise((resolve) => setTimeout(resolve, 80));
      req.destroy();

      return {};
    });

    assert.equal(lines.length, 1, JSON.stringify(lines));
    const [line] = lines;
    assert.equal(line.message, "hosted request not answered: client_closed status=0 credential=authorization");
    assert.equal(line.reason, "client_closed");
    assert.equal(line.status, 0, "nothing was sent, so there is no status to report");
    assert.equal(line.path, "/mcp");
    assert.equal(line.forwarded, "10.0.0.7");
    assert.ok(line.ms >= 60, `the line says how long the request was open (${line.ms}ms)`);
  });
});

test("a request that works leaves no refusal line, and neither does an unrelated path", async () => {
  introspection = () => json({ active: true, sub: "u-1", organization_id: "org-1", token_use: "mcp", exp: Math.floor(Date.now() / 1000) + 3600 });
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() =>
      request(server, { body: INITIALIZE, headers: { Authorization: "Bearer person.access.token" } }),
    );

    assert.equal(answer.status, 200, answer.raw.slice(0, 200));
    assert.deepEqual(lines, []);

    const unrelated = await refusalsOf(() => request(server, { method: "GET", path: "/not-a-route" }));

    assert.equal(unrelated.answer.status, 404);
    assert.deepEqual(unrelated.lines, []);
  });
});

test("a profile endpoint logs its own refusal once, not once per endpoint", async (t) => {
  if (!profileServesWidgets("chatgpt")) {
    t.skip("the open-source build serves /mcp only");

    return;
  }
  introspection = () => json({ active: false });
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() => request(server, { body: INITIALIZE, path: "/mcp/chatgpt" }));

    assert.equal(answer.status, 401);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].path, "/mcp/chatgpt");
    assert.equal(lines[0].reason, "missing_credential");
  });
});

/**
 * what the log store keeps, and therefore what a person can count.
 *
 * The sidecar stores a JSON line's `message` as the line body and, of the line's other top-level
 * keys, only the ones the logging contract reserves (didit-infra/infra-brain
 * `contracts/logging-contract.md` v2 §5 - the list below) plus the ones the pipeline adds itself.
 * Every other key is dropped before the line reaches the store. A refusal that says which it was in
 * a field therefore arrives as the bare text `hosted request refused`: about 1,500 of those in 53
 * minutes of production, indistinguishable from each other, and a filter for `401` inside them
 * matches none. These tests read the line the way the store does — the body alone — so a change that
 * keeps the reason in a field fails here even though the field is right in the emitted JSON.
 */
const CONTRACT_RESERVED_FIELDS = [
  // correlation (§7)
  "trace_id",
  "span_id",
  "amzn_trace_id",
  // HTTP
  "method",
  "path",
  "status_code",
  "duration_ms",
  "remote_addr",
  "request",
  // tasks
  "task_id",
  "task_name",
  "event",
  "data",
  // code
  "name",
  "module",
  "funcName",
  "lineno",
  // diagnostics
  "error",
  // business
  "conversation_id",
  "request_id",
  // versioning
  "log_schema",
];
/** What the pipeline itself puts on a line; it keeps its own keys as well as the reserved ones. */
const PIPELINE_ADDED_FIELDS = ["levelname", "app_version"];

/** One line as the store has it: the body a text filter searches, and the metadata beside it. */
function stored(line) {
  const metadata = {};
  for (const [key, value] of Object.entries(line)) {
    if (key === "message") continue;
    if (CONTRACT_RESERVED_FIELDS.includes(key) || PIPELINE_ADDED_FIELDS.includes(key)) metadata[key] = value;
  }

  return { body: line.message ?? "", metadata };
}

/** How many stored bodies a plain text filter matches: the count the issue asks a person to make. */
const countIn = (bodies, filter) => bodies.filter((body) => body.includes(filter)).length;

test("a stored refusal says its reason and status in the text, in one fixed shape", async () => {
  const lines = [];
  const run = async (options) => {
    const answer = await refusalsOf(() => request(options.server, options.request));

    return answer.lines.map(stored);
  };
  introspection = () => json({ active: false });
  await withApp(async (server) => {
    // No credential at all, a Bearer the auth service refuses, a reachability probe, a body the
    // parser rejected: four different refusals, four different answers to "why".
    lines.push(...(await run({ server, request: { body: INITIALIZE } })));
    lines.push(...(await run({ server, request: { body: INITIALIZE, headers: { Authorization: "Bearer person.access.token" } } })));
    lines.push(...(await run({ server, request: { method: "GET" } })));
    lines.push(...(await run({ server, request: { raw: '{"jsonrpc": "2.0",' } })));

    const bodies = lines.map((line) => line.body);

    assert.deepEqual(bodies, [
      "hosted request refused: missing_credential status=401 credential=none",
      "hosted request refused: credential_refused status=401 credential=authorization",
      "hosted request refused: unsupported_method status=405 credential=none",
      "hosted request refused: bad_request status=400 credential=none",
    ]);
    // Countable the way the issue counted in production: the status is in the text the store keeps,
    // so a filter for `401` matches the two 401s and nothing else.
    assert.equal(countIn(bodies, "status=401"), 2);
    assert.equal(countIn(bodies, "status=405"), 1);
    assert.equal(countIn(bodies, "credential=authorization"), 1);
    assert.equal(countIn(bodies, "hosted request refused: "), 4);
  });
});

test("a token the auth service calls active but this server does not accept has its own reason", async () => {
  // The token `POST /programmatic/login` returns: active, issued to one of the account's own
  // applications. It is answered 401 like an expired token, so the two can only be told apart by a
  // reason of their own — with v5.1.71's new refusal, a total was all the store could give.
  introspection = () =>
    json({
      active: true,
      client_id: "client-of-the-application",
      sub: "5bfe5319-625d-487c-a9c3-8f3cf50750b8",
      claims: ["read:picture"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  await withApp(async (server) => {
    const { answer, lines } = await refusalsOf(() =>
      request(server, { body: INITIALIZE, headers: { Authorization: "Bearer application.token.value" } }),
    );

    assert.equal(answer.status, 401, answer.raw.slice(0, 200));
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(stored(lines[0]).body, "hosted request refused: unsupported_credential status=401 credential=authorization");
    // Never the credential, and never a path with ids in it.
    assert.ok(!JSON.stringify(lines).includes("application.token.value"), "the token must never reach the log");
  });
});

test("a request the store sees cut off says so, and how long it was open", async () => {
  introspection = () => new Promise(() => {});
  await withApp(async (server) => {
    const { lines } = await refusalsOf(async () => {
      const { port } = server.address();
      const payload = JSON.stringify(INITIALIZE);
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer person.access.token",
        },
      });
      req.on("error", () => {});
      req.write(payload);
      req.end();
      await new Promise((resolve) => setTimeout(resolve, 80));
      req.destroy();

      return {};
    });

    assert.equal(lines.length, 1, JSON.stringify(lines));
    const [line] = lines.map(stored);

    // Nothing was answered, so there is no HTTP status to report: `status=0` is the dropped
    // connection, which is the 502 shape a connector leaves behind.
    assert.equal(line.body, "hosted request not answered: client_closed status=0 credential=authorization");
  });
});

test("every reason has its exact text, pinned so a new one cannot slip in unread", () => {
  // The closed list of reasons and the status and credential kind that produce each one. The README
  // table ("Log lines you can count") says what each counts; this test says what each reads as.
  const reasons = [
    [401, "none", "missing_credential"],
    [401, "authorization", "credential_refused"],
    [401, "x-api-key", "credential_refused"],
    [401, "both", "credential_refused"],
    [403, "x-api-key", "forbidden"],
    [405, "none", "unsupported_method"],
    [406, "authorization", "not_acceptable"],
    [400, "none", "bad_request"],
    [413, "none", "bad_request"],
    [415, "none", "bad_request"],
    [500, "authorization", "server_error"],
    [503, "none", "server_error"],
  ];
  const pinned = {
    missing_credential: "hosted request refused: missing_credential status=401 credential=none",
    credential_refused: "hosted request refused: credential_refused status=401 credential=authorization",
    forbidden: "hosted request refused: forbidden status=403 credential=x-api-key",
    unsupported_method: "hosted request refused: unsupported_method status=405 credential=none",
    not_acceptable: "hosted request refused: not_acceptable status=406 credential=authorization",
    bad_request: "hosted request refused: bad_request status=400 credential=none",
    server_error: "hosted request refused: server_error status=500 credential=authorization",
  };

  for (const [status, credential, reason] of reasons) {
    assert.equal(refusalReasonOf(status, credential), reason, `${status} with ${credential}`);
  }
  for (const [reason, text] of Object.entries(pinned)) {
    const [status, credential] = reasons.find((entry) => entry[2] === reason).slice(0, 2);

    assert.equal(countableLine("hosted request refused", reason, status, credential), text);
  }
  // The one reason only the verification path can produce (accepted-credentials.ts), and the
  // not-answered line, in the same fixed shape.
  assert.equal(
    countableLine("hosted request refused", "unsupported_credential", 401, "authorization"),
    "hosted request refused: unsupported_credential status=401 credential=authorization",
  );
  assert.equal(
    countableLine("hosted request not answered", "client_closed", 0, "none"),
    "hosted request not answered: client_closed status=0 credential=none",
  );
  // Nothing a status cannot place is invented: a 404 from an unrelated path is not a refusal.
  assert.equal(refusalReasonOf(404, "none"), undefined);
  assert.equal(refusalReasonOf(200, "authorization"), undefined);
});

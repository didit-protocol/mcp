import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

/**
 * End to end against a real Wakeshift core: the HTTP server (OAuth introspection, the
 * stateless /mcp transport, both protocol eras, the backend routes) against a mock Didit,
 * woken through Claude Code's Monitor command and Codex's connector stream.
 *
 * Skipped unless WAKESHIFT_E2E_HARNESS names a JSON file { "core": "...", "key": "wst_..." }:
 * a core you run, and an app key from it.
 */

const harnessFile = process.env.WAKESHIFT_E2E_HARNESS;
const skip = !harnessFile && "set WAKESHIFT_E2E_HARNESS to run against a Wakeshift core";

const ORG = "org-1";
const APP = "app-1";
// Bearer tokens the mock introspection knows, by user. eve belongs to another organization.
// Shaped like JWTs (three dot-separated parts): anything else is read as an API key (api-key-connection.ts).
const TOKENS = { "tok.bob.sig": "bob", "tok.ada.sig": "ada", "tok.eve.sig": "eve" };
// An application API key (api-key-connection.ts) of app-1, for a headless agent: no person.
const API_KEY = "sk_test_" + randomBytes(18).toString("base64url").replace(/[^A-Za-z0-9]/g, "x");
const KEY_ID = randomUUID();

// ── Helpers ─────────────────────────────────────────────────────────────

class Inbox {
  frames = [];
  waiters = [];
  push(f) {
    this.frames.push(f);
    this.waiters.splice(0).forEach((w) => w());
  }
  async next(ms = 8000) {
    const deadline = Date.now() + ms;
    while (this.frames.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("nothing arrived");
      await new Promise((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => (clearTimeout(t), resolve()));
      });
    }
    return this.frames.shift();
  }
  async expectNothing(ms = 1500) {
    await assert.rejects(this.next(ms), /nothing arrived/);
  }
}

/**
 * Runs the command Claude Code's Monitor is given, in sh, as Monitor runs it: one JSON line per
 * event. `monitor` is monitorOf's answer: the command, and the HOME holding its link file.
 */
function readLines(monitor, signal) {
  const inbox = new Inbox();
  const sh = spawn("sh", ["-c", monitor.cmd], { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, HOME: monitor.home } });
  signal.addEventListener("abort", () => rmSync(monitor.home, { recursive: true, force: true }));
  signal.addEventListener("abort", () => {
    try {
      process.kill(-sh.pid, "SIGKILL");
    } catch {}
  });
  let buf = "";
  sh.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const l = JSON.parse(line);
      if (l.type === "event") inbox.push(l);
    }
  });
  return inbox;
}

/** The connector version this test says it is (WAKESHIFT_E2E_CONNECTOR_VERSION overrides). */
const CONNECTOR_VERSION = process.env.WAKESHIFT_E2E_CONNECTOR_VERSION || "2026.11.11.1053";

/** Does what Wakeshift's connector for Codex does with a beacon: redeem it and hold the stream. */
async function connectCodex(beacon, thread) {
  const claims = JSON.parse(Buffer.from(beacon.split(".")[1], "base64url").toString());
  assert.equal(claims.thread, thread);
  const resp = await fetch(claims.redeem, {
    method: "POST",
    // As the connector does: its version, so Wakeshift serves it (it refuses ones below its minimum).
    headers: { "Content-Type": "application/json", "X-Wakeshift-Connector": `wakeshift/${CONNECTOR_VERSION} codex` },
    body: JSON.stringify({ ticket: claims.ticket, thread }),
  });
  const redeemed = await resp.json();
  assert.equal(resp.status, 200, JSON.stringify(redeemed));
  const inbox = new Inbox();
  // The connector's version on the stream too, and an Origin that matches it, as the connector sends.
  const sock = new WebSocket(redeemed.url, {
    headers: { "X-Wakeshift-Connector": `wakeshift/${CONNECTOR_VERSION} codex`, Origin: new URL(redeemed.url.replace(/^ws/, "http")).origin },
  });
  await new Promise((resolve, reject) => {
    sock.onopen = () => resolve();
    sock.onerror = () => reject(new Error("websocket"));
  });
  sock.onmessage = (m) => {
    const f = JSON.parse(String(m.data));
    if (f.type !== "event") return;
    sock.send(JSON.stringify({ type: "ack", delivery_id: f.delivery_id }));
    inbox.push({ subject: f.event.subject, data: f.event.data });
  };
  return { inbox, close: () => sock.close() };
}

const text = (r) => r.content.map((c) => c.text ?? "").join("\n");
/** A result for an assertion's message: its stream links and session keys left out. */
const shown = (r) => text(r).replace(/link=[A-Za-z0-9._~%-]+/g, "link=<redacted>").replace(/wsc_[a-z2-7]+/g, "wsc_<redacted>");
/**
 * Does what Claude Code does with a subscribing result: writes the conversation's link file
 * (in a HOME of its own, the folder 0700 and the file 0600, as the result says) and returns
 * the Monitor command to run with that HOME. Never prints the result: it holds the link.
 */
const monitorOf = (r) => {
  const t = text(r);
  const file = t.match(/write it with your file-writing tool[^]*?\.wakeshift\/links\/([0-9a-f]+)/)?.[1]
    ?? t.match(/~\/\.wakeshift\/links\/([0-9a-f]+)/)?.[1];
  const link = t.match(/this one line: (https?:\/\/\S+\/v1\/stream\/wait\?link=[A-Za-z0-9._~%-]+)/)?.[1];
  const cmd = t.match(/start the Monitor tool now \(timeout_ms \d+\) with this command: (f=\$HOME\/\.wakeshift\/links\/[0-9a-f]+; .*?; done; fi) \./)?.[1];
  assert.ok(file && link && cmd, "the result has no link file and Monitor command");
  const home = mkdtempSync(join(tmpdir(), "didit-e2e-home-"));
  const dir = join(home, ".wakeshift", "links");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".wakeshift"), 0o700);
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, file), link + "\n", { mode: 0o600 });
  return { cmd, home };
};
const sessionKeyOf = (r) => text(r).match(/session_key="(wsc_[a-z2-7]+)"/)?.[1];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

// ── The test ────────────────────────────────────────────────────────────

test("Claude Code and Codex are woken by the Didit backend's signed events", { skip, timeout: 120_000 }, async (t) => {
  const { core, key } = JSON.parse(readFileSync(harnessFile, "utf8"));
  const secret = "whsec_" + randomBytes(32).toString("base64");

  // The mock Didit: introspection, org discovery and the API the tools call.
  const sessions = new Map(); // session_id -> owner user
  let mcpUrl = "";
  let fastImport = null; // the body the mock backend reports while creating an import
  const didit = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const body = req.method === "POST" ? await readJson(req) : {};
    // The MCP server forwards a key connection's key as x-api-key, never as a Bearer.
    assert.ok(!(req.headers.authorization ?? "").includes(API_KEY), "an API key never goes out as a Bearer");
    const user = TOKENS[(req.headers.authorization ?? "").replace("Bearer ", "")] ?? (req.headers["x-api-key"] === API_KEY ? "ci" : undefined);
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/auth/v2/introspect/") {
      if (body.api_key !== undefined) {
        if (body.api_key !== API_KEY) return json(200, { active: false });
        return json(200, {
          active: true, sub: APP, organization_id: ORG, organization_name: "Acme", application_name: "Acme", application_mode: "sandbox",
          api_key: { uuid: KEY_ID, label: "CI", prefix: API_KEY.slice(0, 12), primary: false, scopes: null, allowed_ips: [], expires_at: null },
        });
      }
      const sub = TOKENS[body.token];
      if (!sub) return json(200, { active: false });
      return json(200, { active: true, sub, organization_id: sub === "eve" ? "org-2" : ORG, exp: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (path === "/auth/v2/organizations/me/") return json(200, [{ uuid: user === "eve" ? "org-2" : ORG, name: "Acme" }]);
    if (path.endsWith("/applications/")) return json(200, [{ uuid: user === "eve" ? "app-2" : APP, name: "Acme", mode: "live" }]);
    if (req.method === "POST" && path === "/v3/session/") {
      const id = randomUUID();
      sessions.set(id, user);
      return json(201, { session_id: id, url: `https://verify.didit.me/session/${id}`, session_token: "st" });
    }
    const decision = path.match(/^\/v3\/session\/([^/]+)\/decision\/$/);
    if (decision) {
      if (sessions.get(decision[1]) !== user) return json(404, { detail: "Not found." });
      return json(200, { session_id: decision[1], status: "Not Started", id_verification: { first_name: "Ada" } });
    }
    const hooks = path.match(/^\/v3\/session\/([^/]+)\/webhooks\/$/);
    if (hooks) return sessions.get(hooks[1]) === user ? json(200, []) : json(404, { detail: "Not found." });
    if (path === `/v3/organization/${ORG}/application/${APP}/sessions/` && user !== "eve") return json(200, { count: 2, results: [{}] });
    if (req.method === "POST" && path === "/v3/session/imports/") {
      const id = randomUUID();
      // A fast dry run: the backend reports it finished before the create even answers.
      fastImport = { import_id: id, status: "READY", import_type: "user_verification", total_rows: 3, processed_rows: 3, created_count: 0, updated_count: 0, skipped_count: 0, failed_count: 0, finished_at: new Date().toISOString() };
      assert.equal((await backend("session-import-finished", fastImport)).status, 204);
      return json(201, { uuid: id, status: "PENDING" });
    }
    if (req.method === "POST" && path === `/v3/organization/${ORG}/application/${APP}/transactions/`) {
      return json(201, { uuid: randomUUID(), transaction_id: body.transaction_id, status: "IN_REVIEW" });
    }
    return json(404, { detail: "Not found." });
  });
  const diditUrl = await listen(didit);
  t.after(() => didit.close());

  // The MCP server, configured as in production but pointed at the mock and the local core.
  Object.assign(process.env, {
    DIDIT_API_BASE_URL: `${diditUrl}/v3`,
    DIDIT_AUTH_BASE_URL: `${diditUrl}/auth/v2`,
    MCP_OAUTH_INTROSPECT_URL: `${diditUrl}/auth/v2/introspect/`,
    DIDIT_OIDC_DISCOVERY_URL: `${diditUrl}/no-discovery`,
    MCP_OAUTH_CLIENT_ID: "mcp",
    MCP_OAUTH_CLIENT_SECRET: "mcp-secret",
    WAKESHIFT_KEY: key,
    WAKESHIFT_CORE: core,
    DIDIT_EVENTS_SECRET: secret,
  });
  delete process.env.DIDIT_ACCESS_TOKEN;
  const require = createRequire(import.meta.url);
  const { createHttpApp } = require("../dist/http.js");
  const { sign, signingKey } = require("../dist/backend-events.js");
  const signing = signingKey(secret);
  const app = await createHttpApp();
  const mcp = http.createServer(app);
  mcpUrl = await listen(mcp);
  t.after(() => mcp.close());

  /** One signed backend notification, as docs/backend-events.md describes. */
  async function backend(route, body, { badSignature = false } = {}) {
    const raw = JSON.stringify(body);
    const id = "msg_" + randomUUID();
    const ts = Math.floor(Date.now() / 1000);
    const signature = badSignature ? sign(randomBytes(32), id, ts, raw) : sign(signing, id, ts, raw);
    const res = await fetch(`${mcpUrl}/internal/events/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signature },
      body: raw,
    });
    return { status: res.status, body: await res.text() };
  }

  /** A legacy-era (initialize, then calls) client, stateless: each POST is its own server. */
  let rpcId = 0;
  async function legacyCall(token, userAgent, name, args, meta, { query = "", apiKey } = {}) {
    const res = await fetch(`${mcpUrl}/mcp${query}`, {
      method: "POST",
      headers: {
        ...(apiKey ? { "x-api-key": apiKey } : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": userAgent,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }),
    });
    const raw = await res.text();
    const line = raw.startsWith("{") ? raw : raw.split("\n").find((l) => l.startsWith("data: ")).slice(6);
    const out = JSON.parse(line);
    assert.ok(out.result, raw);
    return out.result;
  }

  /** A 2026-07-28 client: no initialize, the version, method and name on every request. */
  async function modernCall(token, client, name, args) {
    const res = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": client },
        },
      }),
    });
    const out = await res.json();
    assert.ok(out.result, JSON.stringify(out));
    return out.result;
  }

  const stop = new AbortController();
  const closers = [];
  t.after(() => {
    stop.abort();
    closers.forEach((c) => c());
  });
  const CLAUDE_UA = "claude-code/2.1.0 (external, cli)";

  // ── Claude Code (2026-07-28): didit_session_create wakes on the session's status ──
  const created = await modernCall("tok.bob.sig", { name: "claude-code", version: "2.1.0" }, "didit_session_create", { workflow_id: "wf-1" });
  assert.equal(created.isError, undefined, shown(created));
  const session = created.structuredContent.session_id;
  const bobKey = sessionKeyOf(created);
  assert.ok(bobKey, shown(created));
  const bob = readLines(monitorOf(created), stop.signal);
  // Let the Monitor connect before the first event.
  await new Promise((r) => setTimeout(r, 1500));

  const statusBody = (status, event_id = randomUUID()) => ({ event_id, session_id: session, application_id: APP, status, updated_at: new Date().toISOString() });
  // In Review isn't a decision: the session's watcher isn't woken (the review queue's are).
  assert.equal((await backend("session-status-updated", statusBody("In Review"))).status, 204);
  await bob.expectNothing();
  const approved = statusBody("Approved");
  assert.equal((await backend("session-status-updated", approved)).status, 204);
  let line = await bob.next();
  assert.match(line.subject, new RegExp(`session ${session} is now Approved`));
  // Monitor's line: the event's topic, its subject, and a preview of the minimal payload.
  assert.ok(line.topic.startsWith("ev/session.status.updated/"), line.topic);
  assert.match(line.data_preview, /"status": "Approved"/);
  assert.doesNotMatch(JSON.stringify(line), /first_name|vendor_data|id_verification/);

  // A retry of the same notification (same event_id, new delivery headers) wakes nobody again.
  assert.equal((await backend("session-status-updated", approved)).status, 204);
  await bob.expectNothing();

  // A forged notification is refused and wakes nobody.
  assert.equal((await backend("session-status-updated", statusBody("Declined"), { badSignature: true })).status, 401);
  await bob.expectNothing();

  // ── Claude Code (legacy era): webhook deliveries, then a transaction, same conversation ──
  const watched = await legacyCall("tok.bob.sig", CLAUDE_UA, "didit_session_webhooks", { session_id: session, session_key: bobKey });
  assert.equal(watched.isError, undefined, shown(watched));
  assert.equal((await backend("session-webhook-delivery", {
    delivery_id: randomUUID(), session_id: session, webhook_type: "status.updated", destination_host: "api.acme.com", response_status: 401, attempted_at: new Date().toISOString(),
  })).status, 204);
  line = await bob.next();
  assert.match(line.subject, /status\.updated .* to api\.acme\.com: HTTP 401/);

  // Each run its own ID: a transaction's watch also replays the last ten minutes of its occurrences.
  const order = "Order-" + randomBytes(4).toString("hex");
  const txn = await legacyCall("tok.bob.sig", CLAUDE_UA, "didit_transaction_create", {
    transaction_id: order, transaction_category: "finance", transaction_details: { amount: 10 }, subject: { vendor_data: "u1" }, session_key: bobKey,
  });
  assert.equal(txn.isError, undefined, shown(txn));
  assert.equal((await backend("transaction-status-updated", {
    event_id: randomUUID(), transaction_id: randomUUID(), txn_id: order, application_id: APP, status: "APPROVED", updated_at: new Date().toISOString(),
  })).status, 204);
  line = await bob.next();
  assert.equal(line.subject, `Didit transaction ${order} is now APPROVED. Read it with didit_transaction_get.`);

  // ── Access refusal: eve can't watch bob's session, and nothing reaches her ──
  const refused = await legacyCall("tok.eve.sig", CLAUDE_UA, "didit_session_watch", { session_id: session });
  assert.equal(refused.isError, true);
  assert.equal(sessionKeyOf(refused), undefined, "a refused call carries no Wakeshift block");

  // ── Codex: the review queue, and a fast import caught by replay ──
  const thread = randomUUID();
  const codexMeta = { "x-codex-turn-metadata": { thread_id: thread } };
  const reviews = await legacyCall("tok.ada.sig", "codex_exec/0.50.0", "didit_session_watch_reviews", {}, codexMeta);
  assert.equal(reviews.isError, undefined, shown(reviews));
  assert.equal(reviews.structuredContent.in_review_now, 2);
  const beacon = reviews._meta?.["wakeshift/connector"];
  assert.equal(typeof beacon, "string", JSON.stringify(reviews._meta));
  const codex = await connectCodex(beacon, thread);
  closers.push(codex.close);
  // The watch also delivers what went to review just before it (bob's session, above), so nothing
  // reported between its read and its subscribe is missed.
  assert.match((await codex.inbox.next()).subject, new RegExp(`session ${session} is In Review`));

  assert.equal((await backend("session-status-updated", statusBody("In Review"))).status, 204);
  const review = await codex.inbox.next();
  assert.match(review.subject, new RegExp(`session ${session} is In Review`));
  assert.deepEqual(review.data, { session_id: session, application_id: APP, updated_at: review.data.updated_at });
  // bob watches that session too, but In Review isn't its decision: he isn't woken.
  await bob.expectNothing();

  const imported = await legacyCall("tok.ada.sig", "codex_exec/0.50.0", "didit_session_create_import", { source_file_url: "https://files.example.com/a.csv", dry_run: true }, codexMeta);
  assert.equal(imported.isError, undefined, shown(imported));
  const done = await codex.inbox.next();
  assert.match(done.subject, /finished its dry run/);
  assert.equal(done.data.import_id, fastImport.import_id);
  assert.equal(done.data.total_rows, 3);

  // ── ?toolsets=core: the watch tools are one search away, and run through the discovery proxies ──
  const listCore = await fetch(`${mcpUrl}/mcp?toolsets=core`, {
    method: "POST",
    headers: { Authorization: "Bearer tok.bob.sig", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "User-Agent": CLAUDE_UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }),
  });
  const coreRaw = await listCore.text();
  const coreTools = JSON.parse(coreRaw.startsWith("{") ? coreRaw : coreRaw.split("\n").find((l) => l.startsWith("data: ")).slice(6)).result.tools;
  const coreNames = coreTools.map((tool) => tool.name);
  assert.ok(!coreNames.includes("didit_session_watch") && !coreNames.includes("didit_transaction_create"));
  assert.ok(coreTools.find((tool) => tool.name === "didit_tool_call_write").inputSchema.properties.session_key);
  const search = await legacyCall("tok.bob.sig", CLAUDE_UA, "didit_tool_search", { query: "watch the review queue" }, undefined, { query: "?toolsets=core" });
  assert.equal(search.structuredContent.matches[0].name, "didit_session_watch_reviews");
  const coreOrder = "Order-" + randomBytes(4).toString("hex");
  const viaProxy = await legacyCall("tok.bob.sig", CLAUDE_UA, "didit_tool_call_write", {
    name: "didit_transaction_create",
    arguments: { transaction_id: coreOrder, transaction_category: "finance", transaction_details: { amount: 10 }, subject: { vendor_data: "u1" } },
    session_key: bobKey,
  }, undefined, { query: "?toolsets=core" });
  assert.equal(viaProxy.isError, undefined, shown(viaProxy));
  assert.equal((await backend("transaction-status-updated", {
    event_id: randomUUID(), transaction_id: randomUUID(), txn_id: coreOrder, application_id: APP, status: "DECLINED", updated_at: new Date().toISOString(),
  })).status, 204);
  assert.equal((await bob.next()).subject, `Didit transaction ${coreOrder} is now DECLINED. Read it with didit_transaction_get.`);

  // ── An API key connection (a headless agent in Claude Code): its own subscriber, its own key ──
  const keyCreated = await legacyCall(undefined, CLAUDE_UA, "didit_session_create", { workflow_id: "wf-1" }, undefined, { apiKey: API_KEY });
  assert.equal(keyCreated.isError, undefined, shown(keyCreated));
  const keySession = keyCreated.structuredContent.session_id;
  assert.equal(sessions.get(keySession), "ci");
  assert.doesNotMatch(text(keyCreated), new RegExp(API_KEY));
  const ci = readLines(monitorOf(keyCreated), stop.signal);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await backend("session-status-updated", { event_id: randomUUID(), session_id: keySession, application_id: APP, status: "Approved", updated_at: new Date().toISOString() })).status, 204);
  assert.match((await ci.next()).subject, new RegExp(`session ${keySession} is now Approved`));
  // bob's session is not the key's to watch: the key's own read is refused, and nothing is subscribed.
  const keyRefused = await legacyCall(undefined, CLAUDE_UA, "didit_session_watch", { session_id: session }, undefined, { apiKey: API_KEY });
  assert.equal(keyRefused.isError, true);
  await bob.expectNothing(500);

  // A status nobody needs to hear about wakes nobody.
  assert.equal((await backend("session-status-updated", statusBody("In Progress"))).status, 204);
  await bob.expectNothing();
  await codex.inbox.expectNothing();
  await ci.expectNothing();
});

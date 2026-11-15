import { createRequire } from "node:module";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";

// The hosted server sits behind a load balancer that keeps its connections to a task open and closes
// an idle one after 60 seconds. Node closes an idle connection after 5 seconds. With the shorter
// timeout on the server's side, the balancer sent requests down connections the server was closing
// and answered the client `502 Bad Gateway`: 42 times on 12 and 13 Nov 2026, each with a target time
// of a few milliseconds and no status from the task. To a connector that is a server it cannot reach.
//
// The server must be the side that waits longer.

const require = createRequire(import.meta.url);
const {
  BALANCER_IDLE_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  holdIdleConnections,
  keepAliveTimeoutMs,
} = require("../dist/connection-timeouts.js");

const NODE_DEFAULT_KEEP_ALIVE_MS = 5_000;
const NODE_TIMER_MAX_MS = 2 ** 31 - 1;

test("an idle connection is kept longer than the load balancer keeps it", () => {
  const server = holdIdleConnections(http.createServer());

  assert.equal(new http.Server().keepAliveTimeout, NODE_DEFAULT_KEEP_ALIVE_MS, "what Node does when nothing is set");
  assert.equal(BALANCER_IDLE_TIMEOUT_MS, 60_000);
  assert.ok(server.keepAliveTimeout > BALANCER_IDLE_TIMEOUT_MS, `keep-alive ${server.keepAliveTimeout} ms`);
  assert.equal(server.keepAliveTimeout, DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
  // The headers timeout is never what ends a connection that is only idle.
  assert.ok(server.headersTimeout > server.keepAliveTimeout, `headers ${server.headersTimeout} ms`);
});

test("the timeout follows the balancer's setting, and a value that is not a duration is ignored", () => {
  assert.equal(keepAliveTimeoutMs({}), DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
  assert.equal(keepAliveTimeoutMs({ MCP_KEEP_ALIVE_TIMEOUT_MS: "125000" }), 125_000);
  assert.equal(keepAliveTimeoutMs({ MCP_KEEP_ALIVE_TIMEOUT_MS: " 125000 " }), 125_000);
  for (const value of ["", "0", "-1", "65s", "6.5e4", "abc"]) {
    assert.equal(keepAliveTimeoutMs({ MCP_KEEP_ALIVE_TIMEOUT_MS: value }), DEFAULT_KEEP_ALIVE_TIMEOUT_MS, JSON.stringify(value));
  }
  // A Node timer holds at most 2^31 - 1 milliseconds. Given more, Node does not use the value (older
  // releases run the timer after 1 millisecond, closing every idle connection at once), so such a
  // setting is ignored here. The headers timeout sits 1 second above the keep-alive timeout.
  const longest = NODE_TIMER_MAX_MS - 1_000;
  assert.equal(keepAliveTimeoutMs({ MCP_KEEP_ALIVE_TIMEOUT_MS: String(longest) }), longest);
  for (const value of [String(longest + 1), String(NODE_TIMER_MAX_MS), String(NODE_TIMER_MAX_MS + 1), "99999999999999999999"]) {
    assert.equal(keepAliveTimeoutMs({ MCP_KEEP_ALIVE_TIMEOUT_MS: value }), DEFAULT_KEEP_ALIVE_TIMEOUT_MS, value);
  }
  assert.equal(holdIdleConnections(http.createServer(), longest).headersTimeout, NODE_TIMER_MAX_MS);

  const server = holdIdleConnections(http.createServer(), 125_000);
  assert.equal(server.keepAliveTimeout, 125_000);
  assert.equal(server.headersTimeout, 126_000);
});

/** One request on the agent's connection; resolves with the status and whether the socket was reused. */
function get(port, agent) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, reused: req.reusedSocket }));
    });
    req.on("error", reject);
  });
}

test("a connection that was idle for longer than Node's default is still answered", async () => {
  // What the balancer does: hold one connection, leave it idle, send the next request down it.
  const listen = (server) => new Promise((resolve) => server.listen(0, () => resolve(server)));
  const answer = (_req, res) => res.end("ok");
  const held = await listen(holdIdleConnections(http.createServer(answer)));
  const unset = await listen(http.createServer(answer));
  // Newer Node versions wait a little past the keep-alive timeout before closing (keepAliveTimeoutBuffer).
  const idleMs = NODE_DEFAULT_KEEP_ALIVE_MS + (unset.keepAliveTimeoutBuffer ?? 0) + 700;
  const agents = [new http.Agent({ keepAlive: true, maxSockets: 1 }), new http.Agent({ keepAlive: true, maxSockets: 1 })];

  try {
    assert.equal((await get(held.address().port, agents[0])).reused, false);
    assert.equal((await get(unset.address().port, agents[1])).reused, false);
    await new Promise((resolve) => setTimeout(resolve, idleMs));

    const afterIdle = await get(held.address().port, agents[0]);
    assert.equal(afterIdle.status, 200);
    assert.equal(afterIdle.reused, true, "the same connection carried the second request");

    // The control: with nothing set, the server closed the connection, so there was none to reuse.
    // A balancer that had not noticed yet is the one that answers 502.
    const control = await get(unset.address().port, agents[1]).catch((error) => ({ error: error.code }));
    assert.notEqual(control.reused, true, "Node's default had closed the idle connection");
  } finally {
    for (const agent of agents) agent.destroy();
    held.close();
    unset.close();
  }
});

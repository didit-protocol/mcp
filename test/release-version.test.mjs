// The server says which release it is.
//
// package.json says 5.1.1 on every release (a release is a git tag, and nothing writes it back),
// so production on v5.1.54 answered "version":"5.1.1" on /healthz and in the MCP handshake.
// The image is tagged with the release, and a container can read its own image name from the
// ECS task metadata endpoint: that is where the version now comes from.

import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json");
const config = require("../dist/config.js");
const { LATE_RELEASE_LOOKUP, resolveReleaseVersion, versionFromImage } = require("../dist/release-version.js");
const { createHttpApp } = require("../dist/http.js");
const { createServer } = require("../dist/index.js");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ECS = "http://169.254.170.2/v4/abc";

test("an image tag names the release: a git tag, or the build stamp of a branch deploy", () => {
  assert.equal(versionFromImage("291958376923.dkr.ecr.eu-west-1.amazonaws.com/didit-protocol/mcp-server:v5.1.54"), "5.1.54");
  assert.equal(versionFromImage("registry.example/mcp-server:5.2.0"), "5.2.0");
  assert.equal(versionFromImage("registry.example/mcp-server:2026.11.11.225733"), "2026.11.11.225733");
  // A registry with a port has a colon of its own.
  assert.equal(versionFromImage("localhost:5000/mcp-server:v5.1.54"), "5.1.54");
  // What names no version: a digest, a word, no tag, something that is not a string.
  for (const image of ["repo/mcp-server@sha256:" + "a".repeat(64), "repo/mcp-server:latest", "repo/mcp-server:development", "localhost:5000/mcp-server", "repo/mcp-server", "", null, undefined, 54]) {
    assert.equal(versionFromImage(image), undefined, String(image));
  }
});

test("the release is read from the task metadata, and a stated version wins", async () => {
  const asked = [];
  const metadata = (image) => async (url) => {
    asked.push(String(url));
    return json({ Image: image, Name: "application" });
  };
  assert.equal(await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, metadata("x/mcp-server:v5.1.54")), "5.1.54");
  assert.deepEqual(asked, [ECS]);
  // A host that is not ECS says what it deployed, and then nothing is fetched.
  asked.length = 0;
  assert.equal(await resolveReleaseVersion({ MCP_SERVER_VERSION: " v6.0.0 ", ECS_CONTAINER_METADATA_URI_V4: ECS }, metadata("x/mcp-server:v5.1.54")), "6.0.0");
  assert.deepEqual(asked, []);
});

test("a server that cannot name its release still starts, on the package version", async () => {
  const nothing = async () => { throw new Error("must not be fetched"); };
  assert.equal(await resolveReleaseVersion({}, nothing), undefined, "not on ECS");
  const now = { sleep: async () => {} };
  assert.equal(await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, async () => { throw new Error("unreachable"); }, now), undefined);
  assert.equal(await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, async () => json({}, 500), now), undefined);
  assert.equal(await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, async () => new Response("not json"), now), undefined);
  assert.equal(await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, async () => json({ Image: "x/mcp-server:latest" }), now), undefined);
  assert.match(config.SERVER_VERSION, /^\d+\.\d+\.\d+/, "the package version is what is left");
});

// Production, 12 November 2026: the tasks the deploy started answered 5.1.57, the ones autoscaling
// started later answered 5.1.1. One read at start is not enough, so a read that fails is tried again.
test("a read that fails is tried again, waiting longer each time, until the image names the release", async () => {
  const waits = [];
  let reads = 0;
  const flaky = async () => {
    reads += 1;
    if (reads === 1) throw new Error("connect ECONNREFUSED 169.254.170.2:80");
    if (reads === 2) return json({}, 503);
    if (reads === 3) return json({ Name: "application" });
    return json({ Image: "x/mcp-server:v5.1.57" });
  };
  const version = await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, flaky, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(version, "5.1.57");
  assert.equal(reads, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test("a lookup that gives up says why, once, and waits no more after its last read", async () => {
  const waits = [];
  const reasons = [];
  const version = await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, async () => { throw new Error("timeout"); }, {
    attempts: 3, sleep: async (ms) => { waits.push(ms); }, onGiveUp: (reason) => reasons.push(reason),
  });
  assert.equal(version, undefined);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /could not be read \(timeout\), 3 reads/);
});

// Production, 13 November 2026: the deployment record says v5.1.58 was live and deployed successfully,
// and every /healthz sample answered "5.1.1" - the package placeholder - while the customer's own
// browser read "5.1.58" from the same host. A task the autoscaler starts under load takes longer than
// the 15 seconds of waiting the first fix allowed, and then answered a version it was not for days.
test("a task that starts before its metadata answers names its release minutes later", async () => {
  const waits = [];
  let reads = 0;
  const late = async () => {
    reads += 1;
    if (reads <= 20) throw new Error("connect ECONNREFUSED 169.254.170.2:80");
    return json({ Image: "x/mcp-server:v5.1.58" });
  };
  const version = await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, late, {
    ...LATE_RELEASE_LOOKUP,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(version, "5.1.58", "the task names the release it was deployed as");
  assert.equal(reads, 21);
  // Doubling, then no further than the cap: no wait grows into hours.
  assert.deepEqual(waits.slice(0, 5), [1000, 2000, 4000, 8000, 15000]);
  assert.ok(waits.every((ms) => ms <= LATE_RELEASE_LOOKUP.maxDelayMs), "no wait grows into hours");
});

test("a late lookup reads for minutes, then stops and says why", async () => {
  const reasons = [];
  const waits = [];
  const version = await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, async () => { throw new Error("timeout"); }, {
    ...LATE_RELEASE_LOOKUP,
    sleep: async (ms) => { waits.push(ms); },
    onGiveUp: (reason) => reasons.push(reason),
  });
  assert.equal(version, undefined);
  assert.deepEqual(reasons, ["the task metadata could not be read (timeout), 40 reads"]);
  // Covering a task that starts before the metadata endpoint answers, and bounded all the same.
  assert.equal(waits.length, LATE_RELEASE_LOOKUP.attempts - 1);
  const total = waits.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total > 5 * 60 * 1000, `minutes of reads, not seconds (${total}ms)`);
  assert.ok(total < 15 * 60 * 1000, `and it stops (${total}ms)`);
});

test("an image whose tag names no release is an answer: it is not read again", async () => {
  let reads = 0;
  const reasons = [];
  const version = await resolveReleaseVersion({ ECS_CONTAINER_METADATA_URI_V4: ECS }, async () => { reads += 1; return json({ Image: "x/mcp-server:latest" }); }, {
    sleep: async () => { throw new Error("must not wait"); }, onGiveUp: (reason) => reasons.push(reason),
  });
  assert.equal(version, undefined);
  assert.equal(reads, 1);
  assert.deepEqual(reasons, ["the image tag names no release (mcp-server:latest)"]);
});

test("once named, the release is what /healthz and the MCP handshake state", async () => {
  const before = config.SERVER_VERSION;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => json({ issuer: "https://business.didit.me", authorization_endpoint: "https://business.didit.me/authorize", token_endpoint: "https://business.didit.me/api/auth/oauth-token" });
  config.setServerVersion("5.9.9");
  const server = (await createHttpApp()).listen(0);
  try {
    const health = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: server.address().port, path: "/healthz" }, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve(JSON.parse(raw)));
      }).on("error", reject);
    });
    assert.equal(health.version, "5.9.9");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = createServer({ hosted: true });
    await mcp.connect(serverTransport);
    const client = new Client({ name: "release-version-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    assert.equal(client.getServerVersion().version, "5.9.9");
    await client.close();
    await mcp.close();
  } finally {
    server.close();
    config.setServerVersion(before);
    globalThis.fetch = realFetch;
  }
});

/** A port nothing is listening on, so the spawned server can bind it. */
async function freePort() {
  const server = net.createServer().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  return port;
}

/** `GET /healthz` on the spawned server, or undefined until it answers. */
function healthz(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 1000 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(undefined);
        }
      });
    });
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

// The schedule above only helps if `main()` actually uses it: it reads once before listening and then
// runs the late lookup in the background. This starts the real entry point against a metadata endpoint
// that answers later than the fifteen seconds #274 allowed (its five reads stop at 15s), and checks
// that /healthz answers immediately with the placeholder and then names the release when it arrives.
// The placeholder is package.json's version - 5.1.1 here, and the release version in the public
// mirror, which stamps package.json before it syncs - so it is read from the file, not typed in.
test("the server names its release on /healthz once its task metadata answers, however late", { timeout: 90_000 }, async (t) => {
  // Two reads at 0s, then 1s, 3s, 7s, 15s and 30s: the six #274 allowed all fail, the seventh succeeds.
  const LATE_ANSWER = 6;
  let reads = 0;
  const metadata = http.createServer((_req, res) => {
    reads += 1;
    if (reads <= LATE_ANSWER) {
      res.statusCode = 503;
      res.end("not yet");

      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ Image: "291958376923.dkr.ecr.eu-west-1.amazonaws.com/didit-protocol/mcp-server:v5.1.58" }));
  });
  metadata.listen(0);
  await new Promise((resolve) => metadata.once("listening", resolve));
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/http.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      MCP_PORT: String(port),
      ECS_CONTAINER_METADATA_URI_V4: `http://127.0.0.1:${metadata.address().port}`,
      // The authorization-server document is not what this test is about; make it fail immediately.
      DIDIT_OIDC_DISCOVERY_URL: "http://127.0.0.1:1/.well-known/oauth-authorization-server",
      MCP_RESOURCE_URI: "https://mcp.didit.me/mcp",
      MCP_AUTHORIZATION_SERVER_ORIGIN: "https://business.didit.me",
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    child.kill();
    metadata.close();
  });

  // The first read already failed before the server started listening: the health check answers the
  // placeholder straight away, which is the point of the background read.
  let first;
  for (let attempt = 0; attempt < 100 && !first; attempt++) {
    first = await healthz(port);
    if (!first) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(first?.status, "ok", `the server answered /healthz (stderr: ${stderr.slice(-300)})`);
  assert.equal(first.version, PACKAGE_VERSION, `the health check answers the package version while the metadata is still failing (${first.version})`);

  let named;
  for (let attempt = 0; attempt < 450 && named?.version !== "5.1.58"; attempt++) {
    named = await healthz(port);
    if (named?.version !== "5.1.58") await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(named?.version, "5.1.58", `the background read names the release (stderr: ${stderr.slice(-300)})`);
  assert.ok(reads > LATE_ANSWER, `the metadata was read again past the old limit (${reads} reads)`);
});

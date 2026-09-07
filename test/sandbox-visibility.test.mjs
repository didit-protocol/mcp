import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getContext } from "../dist/tools/context.js";
import { requestContext } from "../dist/config.js";

/**
 * Whether a caller can tell a LIVE application from a SANDBOX one.
 *
 * It could not: the word "sandbox" appeared nowhere in this server, and
 * didit_context_get — the tool whose own description says to call it first to
 * discover ids — returned an id and a name per application and nothing else.
 * The only signal left was the name, so an application called
 * "Acme Ltd (Sandbox)" read as sandbox and a live one read as sandbox too if
 * someone had named it that way.
 *
 * Reported 2026-08-25: a customer was told "since you are in the sandbox" while
 * the session dialog was open on her live application, and was billed for every
 * test run. The auth API has always returned `mode` on an application; it was
 * dropped in this server's own org/app map.
 */

const AUTH = "https://apx.didit.me/auth/v2";

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

test("didit_context_get reports each application's mode, not just its name", async () => {
  globalThis.fetch = async (url) => {
    const path = String(url).split("?")[0];

    if (path === `${AUTH}/organizations/me/`) return json([{ uuid: "org-1", name: "Taylor" }]);
    if (path === `${AUTH}/organizations/me/org-1/applications/`) {
      return json([
        // The trap: a LIVE application whose name says otherwise.
        { uuid: "app-live", name: "Taylor (Sandbox)", mode: "live" },
        { uuid: "app-sbx", name: "My Application", mode: "sandbox" },
      ]);
    }

    return json({ detail: "Not found." });
  };
  const ctx = await requestContext.run({ accessToken: "tok-mode" }, () => getContext());
  const apps = ctx.organizations[0].applications;

  assert.deepEqual(
    apps.map((app) => [app.application_id, app.mode]),
    [
      ["app-live", "live"],
      ["app-sbx", "sandbox"],
    ],
  );
  assert.match(ctx.hint, /never guess the environment from application_name/i);
});

test("didit_session_create advertises sandbox_scenario so a test run can be unbilled", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const create = tools.find((tool) => tool.name === "didit_session_create");

  await client.close();
  assert.ok(create, "didit_session_create is advertised");
  assert.ok(
    "sandbox_scenario" in create.inputSchema.properties,
    "the parameter the backend accepts must be reachable — the copilot described it and could not use it",
  );
});

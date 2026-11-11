#!/usr/bin/env node
// Export the tool catalog as data: what the hosted server lists to a signed-in person, and
// what only a local (stdio) server adds.
//
//   npm run catalog:export                 # print the JSON
//   npm run catalog:export -- <file>       # write it to <file>
//
// Why: the public documentation states how many tools there are and describes each one in a
// table. Both were written by hand and drifted (the docs said 177 tools while the server
// listed 202, and eight tools had no row). The documentation repository keeps a copy of this
// file and checks its pages against it, so a tool that is added, renamed or retyped here shows
// up there as a failing check instead of as a wrong page.
//
// The answer comes from the server's own tools/list, never from reading the source: it is
// exactly what a client receives. Run it on a build of the commit that is deployed.

import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";
import { SERVER_VERSION } from "../dist/config.js";

/** tools/list as one kind of caller sees it. */
async function listTools(options, authInfo) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (message, extra) => onmessage?.(message, { ...extra, authInfo });
  }
  const client = new Client({ name: "export-tool-catalog", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

/** read, write or destructive, from the annotations a client groups tools by. */
function typeOf(tool) {
  if (tool.annotations?.readOnlyHint) return "read";
  return tool.annotations?.destructiveHint ? "destructive" : "write";
}

function describe(tool) {
  return {
    name: tool.name,
    type: typeOf(tool),
    group: tool._meta?.["anthropic/toolGroup"] ?? null,
    // The permission the caller's organization role must hold; null when the endpoint has no per-role check.
    permission: TOOL_PERMISSIONS[tool.name] ?? null,
    required: [...(tool.inputSchema?.required ?? [])].sort(),
  };
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The catalog of this build. `hosted` is what `https://mcp.didit.me/mcp` lists to a signed-in
 * person who is not Didit staff; `local_only` is what a local server lists on top of it.
 */
export async function exportToolCatalog() {
  // A signed-in person on the hosted server: a remote Bearer, no staff flag.
  const person = { token: "catalog.export.token", clientId: "export-tool-catalog", scopes: [], extra: {} };
  const staffEnv = process.env.DIDIT_IS_STAFF;
  delete process.env.DIDIT_IS_STAFF;
  try {
    const hosted = (await listTools({ hosted: true }, person)).map(describe).sort(byName);
    const hostedNames = new Set(hosted.map((tool) => tool.name));
    const localOnly = (await listTools({})).filter((tool) => !hostedNames.has(tool.name)).map(describe).sort(byName);
    const count = (type) => hosted.filter((tool) => tool.type === type).length;

    return {
      server_version: SERVER_VERSION,
      hosted: {
        total: hosted.length,
        read: count("read"),
        write: count("write"),
        destructive: count("destructive"),
        tools: hosted,
      },
      local_only: { total: localOnly.length, tools: localOnly },
    };
  } finally {
    if (staffEnv !== undefined) process.env.DIDIT_IS_STAFF = staffEnv;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = `${JSON.stringify(await exportToolCatalog(), null, 2)}\n`;
  const target = process.argv[2];
  if (target) {
    writeFileSync(target, text);
    console.error(`Wrote ${target}`);
  } else {
    process.stdout.write(text);
  }
}

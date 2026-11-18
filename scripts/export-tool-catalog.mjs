#!/usr/bin/env node
// Export the tool catalog as data: what the hosted server lists to a signed-in person, and
// what only a local (stdio) server adds.
//
//   npm run catalog:export                         # print the JSON
//   npm run catalog:export -- <file>               # write it to <file>
//   npm run catalog:export -- --markdown <file>    # write the tool reference (docs/TOOLS.md) to <file>
//
// Why: the public documentation states how many tools there are and describes each one in a
// table. Both were written by hand and drifted (the docs said 177 tools while the server
// listed 202, and eight tools had no row). The documentation repository keeps a copy of this
// file and checks its pages against it, so a tool that is added, renamed or retyped here shows
// up there as a failing check instead of as a wrong page.
//
// The answer comes from the server's own tools/list, never from reading the source: it is
// exactly what a client receives. Run it on a build of the commit that is deployed.
//
// `hosted` and `local_only` are the keys the documentation repository reads: keep them as they
// are. `profiles` adds what one connection of a signed-in person lists for a selection of the
// catalog (toolsets.ts): `all`, `core`, and `all_read_only` (everything, read-only), each with
// the property names of every tool and the instructions the server sends with it.
//
// scripts/sync-public.sh runs `--markdown` on the public build to write the mirror's
// docs/TOOLS.md, so its counts are the public server's own.

import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";
import { SERVER_VERSION } from "../dist/config.js";
import { parseSelection } from "../dist/toolsets.js";
import { isDiscoveryToolName } from "../dist/tools/discovery.js";

/** tools/list, and the server instructions, as one kind of caller sees them. */
async function listToolsAndInstructions(options, authInfo) {
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
    return { tools: (await client.listTools()).tools, instructions: client.getInstructions() ?? null };
  } finally {
    await client.close();
    await server.close();
  }
}

async function listTools(options, authInfo) {
  return (await listToolsAndInstructions(options, authInfo)).tools;
}

/** The permission a role must hold: one string, or the whole set the endpoint accepts any one of. */
function permissionOf(entry) {
  if (Array.isArray(entry)) return entry.length > 0 ? [...entry] : null;

  return entry;
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
    // The permission the caller's organization role must hold; null when the endpoint has no per-role
    // check. An endpoint that accepts any one of several is published as the WHOLE set, because a role
    // holding any one of them may run the tool: `create:sessions` or `write:sessions` on the session
    // views, and `read:sessions` or `list:sessions` on a read the backend accepts either way. A single
    // permission stays a string, so only the rows that really accept more than one change shape.
    permission: permissionOf(TOOL_PERMISSIONS[tool.name] ?? null),
    required: [...(tool.inputSchema?.required ?? [])].sort(),
  };
}

/** describe(), plus what a profile adds: the input property names and whether a call needs `confirm`. */
function describeWithSchema(tool) {
  const properties = Object.keys(tool.inputSchema?.properties ?? {}).sort();
  return { ...describe(tool), properties, confirm: properties.includes("confirm") };
}

/** What a signed-in person's connection lists for each selection of the catalog (toolsets.ts). */
const PROFILES = {
  all: { toolsets: "all", readOnly: false },
  core: { toolsets: "core", readOnly: false },
  all_read_only: { toolsets: "all", readOnly: true },
};

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
    const profiles = {};
    for (const [name, { toolsets, readOnly }] of Object.entries(PROFILES)) {
      const selection = parseSelection(toolsets, readOnly);
      const listed = await listToolsAndInstructions({ hosted: true, selection }, person);
      const tools = listed.tools.map(describeWithSchema).sort(byName);
      profiles[name] = {
        toolsets,
        read_only: readOnly,
        total: tools.length,
        // The discovery tools a short catalog adds, so the rest stays one search away.
        discovery: tools.filter((tool) => isDiscoveryToolName(tool.name)).map((tool) => tool.name),
        instructions: listed.instructions,
        tools,
      };
    }

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
      profiles,
    };
  } finally {
    if (staffEnv !== undefined) process.env.DIDIT_IS_STAFF = staffEnv;
  }
}

const MARKERS = { read: "read", write: "write", destructive: "destructive" };

/** docs/TOOLS.md: the hosted catalog grouped by the tool's group, with its type and totals. */
export function toolCatalogMarkdown(catalog) {
  const { hosted, local_only: localOnly, profiles } = catalog;
  const groups = new Map();
  for (const tool of hosted.tools) {
    const group = tool.group ?? "Other";
    groups.set(group, [...(groups.get(group) ?? []), tool]);
  }
  const row = (tool) => `| \`${tool.name}\` | ${MARKERS[tool.type]} | ${tool.required.length ? tool.required.map((r) => `\`${r}\``).join(", ") : ""} |`;
  const table = (tools) => ["| Tool | Type | Required arguments |", "| --- | --- | --- |", ...tools.map(row)];
  const lines = [
    "# Tools",
    "",
    `Generated by \`scripts/export-tool-catalog.mjs\` from the server's own tools/list (version ${catalog.server_version}). Do not edit by hand.`,
    "",
    `The hosted server (\`https://mcp.didit.me/mcp\`) lists **${hosted.total} tools** to a signed-in person: ` +
      `${hosted.read} read, ${hosted.write} write and ${hosted.destructive} destructive. ` +
      `A local (stdio) server lists ${localOnly.total} more, shown at the end.`,
    "",
    "- **read**: reads data and changes nothing. A client may run it without asking.",
    "- **write**: creates or changes data.",
    "- **destructive**: deletes data or cannot be undone. A client asks before it runs.",
    "",
    "Which tools you see also depends on your organization role: a tool your role can never run is not listed.",
    "",
  ];
  if (profiles) {
    const core = profiles.core;
    lines.push(
      "## Toolsets",
      "",
      "A connection can load part of the catalog with `?toolsets=` (hosted) or `--toolsets` (stdio), and only the read tools with `read_only=true` or `--read-only`.",
      "",
      "| Selection | Tools listed |",
      "| --- | --- |",
      `| \`all\` (the default) | ${profiles.all.total} |`,
      `| \`core\` | ${core.total}, of which ${core.discovery.length} are discovery tools |`,
      `| \`all\`, read-only | ${profiles.all_read_only.total} |`,
      "",
    );
    if (core.discovery.length) {
      lines.push(
        "When a connection does not list every tool, the discovery tools keep the rest one step away:",
        "",
        ...core.discovery.map((name) => `- \`${name}\``),
        "",
      );
    }
  }
  for (const group of [...groups.keys()].sort()) {
    const tools = groups.get(group);
    lines.push(`## ${group} (${tools.length})`, "", ...table(tools), "");
  }
  if (localOnly.total) {
    lines.push(
      `## Local server only (${localOnly.total})`,
      "",
      "These are listed by a local (stdio) server and never by the hosted one.",
      "",
      ...table(localOnly.tools),
      "",
    );
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const markdown = args[0] === "--markdown";
  const catalog = await exportToolCatalog();
  const text = markdown ? toolCatalogMarkdown(catalog) : `${JSON.stringify(catalog, null, 2)}\n`;
  const target = markdown ? args[1] : args[0];
  if (markdown && !target) {
    console.error("usage: export-tool-catalog.mjs --markdown <file>");
    process.exit(1);
  }
  if (target) {
    writeFileSync(target, text);
    console.error(`Wrote ${target}`);
  } else {
    process.stdout.write(text);
  }
}

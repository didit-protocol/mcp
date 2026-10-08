// Public build: the internal-only tool families (compliance interview/profile, travel rule,
// marketplace, networks, the transaction SDK token) are not part of the open-source distribution,
// so this module is intentionally empty. It exposes the same surface index.ts and permissions.ts
// expect (so they compile unchanged) with no tool definitions, no dispatch and no permissions.

type ToolDef = { name: string; description: string; inputSchema: any };

export type InternalToolSection = "network" | "transaction_sdk_token" | "travel_rule" | "marketplace" | "compliance";

export function internalToolDefs(_section: InternalToolSection): ToolDef[] {
  return [];
}

export function isInternalToolName(_name: string): boolean {
  return false;
}

export const INTERNAL_GROUP_PREFIXES: [string, string][] = [];

export const INTERNAL_DESTRUCTIVE_TOOLS: string[] = [];
export const INTERNAL_OPEN_WORLD_TOOLS: string[] = [];
export const INTERNAL_READ_TOOLS: string[] = [];

export const REGULATION_GRAPH_HINT = "";

export const INTERNAL_TOOL_PERMISSIONS: Record<string, string | null> = {};

export async function dispatchInternalTool(name: string, _args: Record<string, any> | undefined): Promise<any> {
  throw new Error(`Unknown tool: ${name}`);
}

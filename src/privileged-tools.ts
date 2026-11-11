// Public build: a small set of internal-only operational tools is not part of the open-source
// distribution, so this module is intentionally empty. It exposes the same surface the server
// expects (so index.ts compiles unchanged) with no tool definitions and no dispatch.

type ToolDef = { name: string; description: string; inputSchema: any };

export const PRIVILEGED_TOOLSET: { id: string; description: string; groups: [string, string][] } | null = null;

export function isPrivilegedToolName(_name: string): boolean {
  return false;
}

export const PRIVILEGED_READ_TOOLS: string[] = [];

export function isPrivilegedCaller(_authInfo: any, _opts?: { hosted?: boolean }): boolean {
  return false;
}

export const PRIVILEGED_TOOL_DEFS: ToolDef[] = [];

export async function dispatchPrivilegedTool(name: string, _args: any): Promise<any> {
  throw new Error(`Unknown tool: ${name}`);
}

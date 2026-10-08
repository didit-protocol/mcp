import type { Express } from "express";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

// Public build: the ChatGPT app surface (reduced catalog profile, MCP Apps widgets, the extra
// protected-resource endpoint and the OpenAI Apps domain challenge) is not part of the
// open-source distribution, so this module is intentionally inert. It exposes the same surface
// index.ts, http.ts and mcp-modern.ts expect (so they compile unchanged): one `full` catalog,
// no widgets, no extra endpoint.

export type CatalogProfile = "full" | "chatgpt";

export interface CatalogTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

export function applyCatalogProfile(tools: readonly CatalogTool[], _profile: CatalogProfile): CatalogTool[] {
  return [...tools];
}

export function applyCatalogResult(_profile: CatalogProfile, _name: string, result: unknown): unknown {
  return result;
}

export function catalogProfileRefusal(
  _profile: CatalogProfile,
  _name: string,
  _args: Record<string, unknown> | undefined,
): string | undefined {
  return undefined;
}

/** No entry tool in the public build (never matches a tool name). */
export const CONSOLE_OPEN_TOOL = "";

export function consoleOpenResult(_args: Record<string, unknown>): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
}

export function profileServesWidgets(_profile: CatalogProfile): boolean {
  return false;
}

export function listWidgetResources(): Record<string, unknown>[] {
  return [];
}

export function readWidgetResource(uri: string): { contents: Record<string, unknown>[] } {
  throw new Error(`Unknown resource: ${uri}`);
}

export function widgetToolMeta(_profile: CatalogProfile, _name: string): Record<string, unknown> {
  return {};
}

export function widgetTools(_profile: CatalogProfile): Record<string, unknown>[] {
  return [];
}

export function stdioCatalogProfile(): CatalogProfile {
  return "full";
}

export function mountDomainChallenge(_app: Express): void {}

export interface ProfileEndpoint {
  path: string;
  profile: CatalogProfile;
  resourceUrl: URL;
}

export function mountProfileEndpoint(
  _app: Express,
  _options: { oauthMetadata: OAuthMetadata; resourceServerUrl: URL; scopesSupported: string[] },
): ProfileEndpoint | undefined {
  return undefined;
}

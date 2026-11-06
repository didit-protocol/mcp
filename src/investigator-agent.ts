import type { Express } from "express";

// Public build: the Investigator's remote engine endpoint (/mcp/investigator-agent) serves Didit's own
// didit-ai-investigator service only, so it is not part of the open-source distribution and this module is inert.
// It exposes the surface http.ts expects (so it compiles unchanged) and mounts nothing.

export const INVESTIGATOR_AGENT_MCP_PATH = "";

export function mountInvestigatorAgentEndpoint(_app: Express): void {}

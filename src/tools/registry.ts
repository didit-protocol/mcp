// One object per tool: what it is, what a call does, what the caller's role needs, and what runs it.
//
// Before this, a tool lived in five places of the server: its definition in the list in index.ts,
// its read / write / destructive class in name-keyed sets there (or in the verbs of its name), its
// open-world flag in another set, the permission its role needs in permissions.ts, and its handler
// in the dispatch switch. A test holds every name-keyed table to the tool list (NAME_KEYED_TABLES),
// so a rename that misses one table fails; but nothing tied the five facts of one tool together.
//
// A tool area moves here one at a time (webhooks first), in place of its entries in those tables.
// What a moved tool shows to a client does not change: the same definition object, at the same
// place in the list, with the same annotations and permission (test/tool-registry.test.mjs).

/** A tool as it is listed: name, description and input schema. A type, not an interface, so it fits the catalog's index-signature type. */
export type ToolDef = {
  name: string;
  description: string;
  inputSchema: any;
};

/**
 * What a call does. `read` changes nothing. `write` changes data. `destructive` is a change a client
 * asks the person about before running it: a delete, an overwrite, a decision.
 */
export type ToolAccess = "read" | "write" | "destructive";

export interface RegisteredTool {
  def: ToolDef;
  access: ToolAccess;
  /** Reaches outside the Didit workspace: sends mail, registers an endpoint Didit delivers to, shares data. */
  openWorld?: boolean;
  /**
   * The role permission the backend checks for it (permissions.ts): one string, or the set the
   * endpoint accepts any one of (a DRF view's `accepted_org_permissions`). Null when
   * it has no per-role check.
   */
  permission: string | readonly string[] | null;
  /** Runs a call. The routing ids and blank optional arguments are already removed (index.ts). */
  run(args: Record<string, any>): Promise<unknown>;
  /**
   * For a list of one application: what runs instead when the caller named no application and has
   * more than one, the same list across every application they can open (index.ts,
   * aggregateFallbackFor). It gets the routing ids the caller did send, to narrow the span.
   */
  spanAllApplications?(args: Record<string, any>): Promise<unknown>;
  /**
   * The handler reads organization_id / application_id itself, to narrow a search across
   * applications to one organization or one application: the dispatcher passes on the ones the
   * caller sent (it removes them from every other tool's arguments).
   */
  routingIds?: true;
  /** Acts on no organization or application: the dispatcher resolves no default scope for it (index.ts). */
  scopeAgnostic?: true;
}

/** The annotations a client reads (MCP ToolAnnotations), from what the tool declares. */
export function registeredAnnotations(tool: RegisteredTool, title: string) {
  return {
    title,
    readOnlyHint: tool.access === "read",
    openWorldHint: tool.openWorld === true,
    destructiveHint: tool.access === "destructive",
  };
}

/** The permission entries of a set of tools, in the shape of permissions.ts's table. */
export function permissionsOf(tools: readonly RegisteredTool[]): Record<string, string | readonly string[] | null> {
  return Object.fromEntries(tools.map((tool) => [tool.def.name, tool.permission]));
}

/** A name lookup over a set of tools; a name registered twice is a programming error. */
export function byName(tools: readonly RegisteredTool[]): ReadonlyMap<string, RegisteredTool> {
  const map = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    if (map.has(tool.def.name)) throw new Error(`Tool ${tool.def.name} is registered twice.`);
    map.set(tool.def.name, tool);
  }
  return map;
}

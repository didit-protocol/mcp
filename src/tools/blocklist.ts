import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { PAGE_PROPS, pageParams } from "../paging";
import { ORG_APP_PROPS } from "../orgapp";
import { DiditError } from "../security";

// Blocklist / allowlist — org/app-scoped console resources.

/**
 * A blocklist or allowlist entry is an item a session holds, chosen with a flag per item. A call
 * that names the session and no item changes nothing, so it is refused here with the flags to
 * choose from, before anything is sent.
 */
function requireOneFlag(data: Record<string, unknown>, flags: readonly string[], action: string): void {
  if (flags.some((flag) => data?.[flag] === true)) return;
  throw new DiditError({
    code: "bad_request",
    message: `Say what to ${action}: set ${flags.length === 1 ? flags[0] : `at least one of ${flags.join(", ")}`} to true.`,
    field: flags[0],
    hint: "Each flag names an item of the session (its face, document, phone number or email address).",
  });
}

const BLOCK_FLAGS = ["blocklist_face", "blocklist_document", "blocklist_phone", "blocklist_email"] as const;
const UNBLOCK_FLAGS = ["unblock_face", "unblock_document", "unblock_phone", "unblock_email"] as const;

export async function getBlocklist(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/blocklist/"), { params });
}

export async function addToBlocklist(data: Record<string, any>): Promise<any> {
  requireOneFlag(data, BLOCK_FLAGS, "block");
  return apiRequest(orgAppPath("/blocklist/add/"), { method: "POST", json: data });
}

export async function removeFromBlocklist(data: Record<string, any>): Promise<any> {
  requireOneFlag(data, UNBLOCK_FLAGS, "unblock");
  return apiRequest(orgAppPath("/blocklist/remove/"), { method: "POST", json: data });
}

export async function addToAllowlist(data: Record<string, any>): Promise<any> {
  requireOneFlag(data, ["allowlist_phone"], "allowlist");
  return apiRequest(orgAppPath("/allowlist/add/"), { method: "POST", json: data });
}

// ── The blocklist and allowlist tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const BLOCKLIST_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_blocklist_get",
      description:
        "List the application's blocklist, newest first: the faces, identity documents, phone numbers and email " +
        "addresses that are blocked, each with the `session_id` it was blocked from (what didit_blocklist_remove " +
        "takes). One page: 50 entries unless `limit` says otherwise, with `count` as the total and `offset` to read " +
        "the ones after.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          item_type: { type: "string", enum: ["face", "document", "phone", "email"], description: "Only entries of this kind." },
          ...PAGE_PROPS,
        },
      },
    },
    access: "read",
    permission: ["read:blocklist", "list:blocklist"], // GET …/blocklist/ → blocklist.py:178
    run: (args) => getBlocklist({ ...args, ...pageParams(args) }),
  },
  {
    def: {
      name: "didit_blocklist_add",
      description:
        "Block what a verification session holds, so that later sessions of this application with the same item are " +
        "caught by the blocklist check: its face, its identity document, its phone number or its email address. " +
        "Name the session and set at least one of the four flags to true. A flag works only when the session has " +
        "that item. Undo with didit_blocklist_remove.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string", description: "The session whose item is blocked." },
          blocklist_face: { type: "boolean", description: "Block the session's face." },
          blocklist_document: { type: "boolean", description: "Block the session's identity document." },
          blocklist_phone: { type: "boolean", description: "Block the session's phone number." },
          blocklist_email: { type: "boolean", description: "Block the session's email address." },
        },
        required: ["session_id"],
      },
    },
    access: "write",
    permission: "write:blocklist", // POST …/blocklist/add/ → blocklist.py:47
    run: (args) => addToBlocklist(args),
  },
  {
    def: {
      name: "didit_blocklist_remove",
      description:
        "Lift a block. Name the session the item was blocked from (the `session_id` of the entry in " +
        "didit_blocklist_get) and set at least one of the four flags to true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string", description: "The session the item was blocked from." },
          unblock_face: { type: "boolean", description: "Lift the block on the session's face." },
          unblock_document: { type: "boolean", description: "Lift the block on the session's identity document." },
          unblock_phone: { type: "boolean", description: "Lift the block on the session's phone number." },
          unblock_email: { type: "boolean", description: "Lift the block on the session's email address." },
        },
        required: ["session_id"],
      },
    },
    access: "destructive",
    permission: "write:blocklist", // POST …/blocklist/remove/ → blocklist.py:76
    run: (args) => removeFromBlocklist(args),
  },
  {
    def: {
      name: "didit_allowlist_add",
      description:
        "Mark the phone number of a verification session as trusted in this application, so that phone verification " +
        "does not turn it away as high risk. A phone number is the only thing that can be allowlisted, and a " +
        "blocked number stays blocked. Name the session and set allowlist_phone to true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string", description: "The session whose phone number is trusted." },
          allowlist_phone: { type: "boolean", description: "Must be true: the phone number is what gets allowlisted." },
        },
        required: ["session_id", "allowlist_phone"],
      },
    },
    access: "write",
    permission: "write:blocklist", // POST …/allowlist/add/ → allowlist.py:33
    run: (args) => addToAllowlist(args),
  },
];

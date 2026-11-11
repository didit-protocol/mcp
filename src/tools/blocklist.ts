import { apiRequest, orgAppPath } from "../config";
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

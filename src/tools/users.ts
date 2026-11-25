import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { searchVendorUsers } from "./search";
import { ENTITY_STATUSES, VENDOR_FILTER_PROPS } from "./shared-schema";
import { ORG_APP_PROPS } from "../orgapp";
import { assertBoolean, DiditError, MAX_BATCH_IDS, pathSegment } from "../security";

// Vendor users — the console resource is `vendor-users`, org/app-scoped. Every tool names a person
// by vendor_data; the bulk status route takes internal ids only, so one person's status is set
// through the profile update, which takes the status and its reason.

export async function listUsers(params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath("/vendor-users/"), { params });
}

export async function getUser(vendorData: string): Promise<any> {
  return apiRequest(orgAppPath(`/vendor-users/${pathSegment(vendorData, "vendor_data", { opaque: true })}/`));
}

export async function createUser({ confirm, ...data }: Record<string, any>): Promise<any> {
  assertBoolean(data.send_verification_link, "send_verification_link");
  assertBoolean(confirm, "confirm");
  if (data.send_verification_link === true && confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: "send_verification_link emails this person a verification link.",
      field: "confirm",
      hint: "Re-call with confirm:true once the user has explicitly confirmed the email, or leave send_verification_link out.",
    });
  }

  return apiRequest(orgAppPath("/vendor-users/"), { method: "POST", json: data });
}

export async function updateUser(vendorData: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/vendor-users/${pathSegment(vendorData, "vendor_data", { opaque: true })}/update/`), { method: "PATCH", json: data });
}

export async function lookupUsers({ identifiers, limit, offset }: Record<string, any>): Promise<any> {
  const lookup = await apiRequest(orgAppPath("/vendor-users/lookup/"), { method: "POST", json: { identifiers } });

  return { ...(await listUsers({ lookup: lookup.lookup_id, limit, offset })), ...lookup };
}

export async function deleteUsers(vendorDataList?: string[], deleteAll?: unknown, confirm?: unknown): Promise<any> {
  assertBoolean(deleteAll, "delete_all");
  assertBoolean(confirm, "confirm");
  const wildcard = deleteAll === true;
  if (wildcard) {
    if (confirm !== true)
      throw new DiditError({ code: "unsafe_operation", message: "delete_all permanently removes EVERY vendor user.", field: "confirm", hint: "Re-call with confirm:true, or pass an explicit vendor_data_list." });
  } else if (!Array.isArray(vendorDataList) || vendorDataList.length === 0) {
    throw new DiditError({ code: "bad_request", message: "Provide a non-empty vendor_data_list, or set delete_all with confirm:true.", field: "vendor_data_list" });
  } else if (vendorDataList.length > MAX_BATCH_IDS) {
    throw new DiditError({ code: "bad_request", message: `Too many ids (max ${MAX_BATCH_IDS}).`, field: "vendor_data_list" });
  }
  return apiRequest(orgAppPath("/vendor-users/delete/"), {
    method: "DELETE",
    json: { vendor_data_list: vendorDataList, delete_all: wildcard },
  });
}

// ── The vendor user tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const VENDOR_USER_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_vendor_user_list",
      description: "List verified users (grouped by vendor_data) for ONE app; with multiple apps (or no scope) it auto-spans all your apps. For a cross-app customer lookup prefer didit_vendor_user_search. Supports limit/offset pagination.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          ...VENDOR_FILTER_PROPS,
          country: { type: "string", description: "ISO 3166-1 alpha-3, comma-separated" },
          search: { type: "string", description: "vendor_data, name or email" },
          limit: { type: "string" },
          offset: { type: "string" },
        },
      },
    },
    access: "read",
    permission: ["list:users", "read:users"], // GET …/vendor-users/ → vendor_user.py:283
    run: (args) => listUsers(args),
    spanAllApplications: (args) => searchVendorUsers(args),
  },
  {
    def: {
      name: "didit_vendor_user_create",
      description: "Create a user record manually (e.g. to pre-register a vendor_data identity or attach allowlisted emails/phones).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "REQUIRED. Your unique identifier for the user" },
          full_name: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          email: { type: "string" },
          phone_number: { type: "string" },
          country: { type: "string", description: "ISO 3166 code" },
          send_verification_link: { type: "boolean", description: "Email them a link to a verification (needs email, workflow_id and confirm:true; also create:sessions)" },
          workflow_id: { type: "string" },
          language: { type: "string", description: "Of the email" },
          confirm: { type: "boolean", description: "REQUIRED true with send_verification_link. Only set after explicit user confirmation of this exact action." },
          display_name: { type: "string" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD" },
          status: { type: "string", enum: ENTITY_STATUSES },
          metadata: { type: "object" },
          approved_emails: { type: "array", items: { type: "string" } },
          approved_phones: { type: "array", items: { type: "string" } },
          issuing_states: { type: "array", items: { type: "string" } },
        },
        required: ["vendor_data"],
      },
    },
    access: "write",
    openWorld: true,
    permission: "create:users", // POST …/vendor-users/ → vendor_user.py:330
    run: (args) => createUser(args),
  },
  {
    def: {
      name: "didit_vendor_user_get",
      description: "Get details of a specific user by their vendor_data identifier.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "The vendor_data value that identifies the user" },
        },
        required: ["vendor_data"],
      },
    },
    access: "read",
    permission: ["read:users", "list:users"], // GET …/vendor-users/{vendor_data}/ → vendor_user.py:763
    run: (args) => getUser(args.vendor_data),
  },
  {
    def: {
      name: "didit_vendor_user_update",
      description: "Update a user's profile fields. Only send the fields you want to change. To change ONLY the monitoring status, prefer didit_vendor_user_update_status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "The vendor_data value that identifies the user" },
          full_name: { type: "string" },
          display_name: { type: "string" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD" },
          status: { type: "string", enum: ENTITY_STATUSES, description: "Monitoring status" },
          reason: { type: "string", description: "Why the status changes" },
          metadata: { type: "object" },
          approved_emails: { type: "array", items: { type: "string" } },
          approved_phones: { type: "array", items: { type: "string" } },
          issuing_states: { type: "array", items: { type: "string" } },
        },
        required: ["vendor_data"],
      },
    },
    access: "write",
    permission: "write:users", // PATCH …/vendor-users/{vendor_data}/update/ → vendor_user.py:1098
    run: ({ vendor_data, ...data }) => updateUser(vendor_data, data),
  },
  {
    def: {
      name: "didit_vendor_user_update_status",
      description: "Set a user's monitoring status (ACTIVE, FLAGGED, or BLOCKED).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "The vendor_data value that identifies the user" },
          status: { type: "string", enum: ENTITY_STATUSES, description: "New status" },
          reason: { type: "string" },
        },
        required: ["vendor_data", "status"],
      },
    },
    access: "write",
    permission: "write:users", // PATCH …/vendor-users/{vendor_data}/update/ → vendor_user.py:1098
    run: ({ vendor_data, status, reason }) => updateUser(vendor_data, { status, reason }),
  },
  {
    def: {
      name: "didit_vendor_user_lookup",
      description: "Find a list of users at once, in the order given: the matching users, and not_found with the identifiers nobody has.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          identifiers: { type: "array", items: { type: "string" }, description: "vendor_data, Didit user ids and verified emails, mixed" },
          limit: { type: "string" },
          offset: { type: "string" },
        },
        required: ["identifiers"],
      },
    },
    access: "read",
    permission: ["list:users", "read:users"], // POST …/vendor-users/lookup/ → user_lookup.py:56, then GET …/vendor-users/
    run: (args) => lookupUsers(args),
  },
  {
    def: {
      name: "didit_vendor_user_delete",
      description: "Batch delete users by vendor_data list, or delete all users. Deletion is permanent. If the API answers 409 (in_filed_report: a selected person is in a finalized regulatory report; subject_deletion_in_progress: another request is still deleting one of them), nothing is deleted: repeat the request once that deletion has finished.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data_list: {
            type: "array",
            items: { type: "string" },
            description: "Array of vendor_data values to delete",
          },
          delete_all: { type: "boolean", description: "Set true to delete ALL users" },
          confirm: {
            type: "boolean",
            description:
              "REQUIRED when delete_all is true - permanently removes EVERY vendor user. Only set after explicit user confirmation of this exact action.",
          },
        },
      },
    },
    access: "destructive",
    permission: "delete:users", // DELETE …/vendor-users/delete/ → vendor_user.py:1139
    run: (args) => deleteUsers(args.vendor_data_list, args.delete_all, args.confirm),
  },
];

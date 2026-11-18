import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { searchVendorBusinesses } from "./search";
import { ENTITY_STATUSES } from "./shared-schema";
import { ORG_APP_PROPS } from "../orgapp";
import { assertBoolean, DiditError, MAX_BATCH_IDS, pathSegment } from "../security";

// Vendor businesses — the console resource is `vendor-businesses`, org/app-scoped (these are
// vendor business ENTITIES, not KYB sessions — KYB sessions are the separate `businesses`/
// `business-sessions` console resource). List/create/get(by vendor_data)/bulk-delete map
// cleanly; update by vendor_data is best-effort (console keys updates by internal id).

export async function listBusinesses(params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath("/vendor-businesses/"), { params });
}

export async function createBusiness(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/vendor-businesses/"), { method: "POST", json: data });
}

export async function getBusiness(vendorData: string): Promise<any> {
  return apiRequest(orgAppPath(`/vendor-businesses/${pathSegment(vendorData, "vendor_data", { opaque: true })}/`));
}

export async function updateBusiness(vendorData: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/vendor-businesses/${pathSegment(vendorData, "vendor_data", { opaque: true })}/update/`), { method: "PATCH", json: data });
}

export async function updateBusinessStatus(vendorData: string, status: string): Promise<any> {
  return apiRequest(orgAppPath("/vendor-businesses/bulk-status/"), {
    method: "POST",
    json: { vendor_data_list: [vendorData], status },
  });
}

export async function deleteBusinesses(
  vendorDataList?: string[],
  diditInternalIdList?: string[],
  deleteAll?: unknown,
  confirm?: unknown,
): Promise<any> {
  assertBoolean(deleteAll, "delete_all");
  assertBoolean(confirm, "confirm");
  const wildcard = deleteAll === true;
  const ids = [...(vendorDataList || []), ...(diditInternalIdList || [])];
  if (wildcard) {
    if (confirm !== true)
      throw new DiditError({ code: "unsafe_operation", message: "delete_all permanently removes EVERY vendor business.", field: "confirm", hint: "Re-call with confirm:true, or pass an explicit id list." });
  } else if (ids.length === 0) {
    throw new DiditError({ code: "bad_request", message: "Provide a non-empty vendor_data_list or didit_internal_id_list, or set delete_all with confirm:true.", field: "vendor_data_list" });
  } else if (ids.length > MAX_BATCH_IDS) {
    throw new DiditError({ code: "bad_request", message: `Too many ids (max ${MAX_BATCH_IDS}).`, field: "vendor_data_list" });
  }
  return apiRequest(orgAppPath("/vendor-businesses/delete/"), {
    method: "DELETE",
    json: {
      vendor_data_list: vendorDataList,
      didit_internal_id_list: diditInternalIdList,
      delete_all: wildcard,
    },
  });
}

// ── The vendor business tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const VENDOR_BUSINESS_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_vendor_business_list",
      description: "List verified businesses (KYB, grouped by vendor_data) for ONE app; with multiple apps (or no scope) it auto-spans all your apps. For a cross-app lookup prefer didit_vendor_business_search. Supports limit/offset pagination.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          limit: { type: "string" },
          offset: { type: "string" },
        },
      },
    },
    access: "read",
    permission: ["list:businesses", "read:businesses"], // GET …/vendor-businesses/ → vendor_business.py:150
    run: (args) => listBusinesses(args),
    spanAllApplications: (args) => searchVendorBusinesses(args),
  },
  {
    def: {
      name: "didit_vendor_business_create",
      description: "Create a business record manually (KYB).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "Your unique identifier for the business" },
          display_name: { type: "string" },
          legal_name: { type: "string" },
          registration_number: { type: "string" },
          country_code: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
          status: { type: "string", enum: ENTITY_STATUSES },
          metadata: { type: "object" },
        },
      },
    },
    access: "write",
    permission: "create:businesses", // POST …/vendor-businesses/ → vendor_business.py:154
    run: (args) => createBusiness(args),
  },
  {
    def: {
      name: "didit_vendor_business_get",
      description: "Get details of a specific business by its vendor_data identifier.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "The vendor_data value that identifies the business" },
        },
        required: ["vendor_data"],
      },
    },
    access: "read",
    permission: ["read:businesses", "list:businesses"], // GET …/vendor-businesses/{vendor_data}/ → vendor_business.py:197
    run: (args) => getBusiness(args.vendor_data),
  },
  {
    def: {
      name: "didit_vendor_business_update",
      description: "Update a business's profile fields. Only send the fields you want to change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string" },
          display_name: { type: "string" },
          legal_name: { type: "string" },
          registration_number: { type: "string" },
          country_code: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
          status: { type: "string", enum: ENTITY_STATUSES },
          metadata: { type: "object" },
        },
        required: ["vendor_data"],
      },
    },
    access: "write",
    permission: null, // PATCH …/vendor-businesses/{vendor_data}/update/ — route does not exist as coded (only by-id/)
    run: ({ vendor_data, ...data }) => updateBusiness(vendor_data, data),
  },
  {
    def: {
      name: "didit_vendor_business_update_status",
      description: "Set a business's monitoring status (ACTIVE, FLAGGED, or BLOCKED).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string" },
          status: { type: "string", enum: ENTITY_STATUSES, description: "New status" },
        },
        required: ["vendor_data", "status"],
      },
    },
    access: "write",
    permission: "write:businesses", // POST …/vendor-businesses/bulk-status/ → vendor_business.py:965
    run: (args) => updateBusinessStatus(args.vendor_data, args.status),
  },
  {
    def: {
      name: "didit_vendor_business_delete",
      description: "Batch delete businesses by vendor_data list and/or didit_internal_id list, or delete all businesses. Deletion is permanent. If the API answers 409 (in_filed_report or subject_deletion_in_progress), nothing is deleted: repeat the request once the other deletion has finished.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data_list: { type: "array", items: { type: "string" } },
          didit_internal_id_list: { type: "array", items: { type: "string" } },
          delete_all: { type: "boolean", description: "Set true to delete ALL businesses" },
          confirm: {
            type: "boolean",
            description:
              "REQUIRED when delete_all is true - permanently removes EVERY vendor business. Only set after explicit user confirmation of this exact action.",
          },
        },
      },
    },
    access: "destructive",
    permission: "delete:businesses", // DELETE …/vendor-businesses/delete/ → vendor_business.py:935
    run: (args) => deleteBusinesses(args.vendor_data_list, args.didit_internal_id_list, args.delete_all, args.confirm),
  },
];

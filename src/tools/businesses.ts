import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { searchVendorBusinesses } from "./search";
import { ENTITY_STATUSES, VENDOR_FILTER_PROPS } from "./shared-schema";
import { mapWithConcurrency, ORG_APP_PROPS } from "../orgapp";
import { assertBoolean, DiditError, pathSegment } from "../security";

// Vendor businesses — the console resource is `vendor-businesses`, org/app-scoped (these are
// vendor business ENTITIES, not KYB sessions — KYB sessions are the separate `businesses`/
// `business-sessions` console resource). List, create and get take vendor_data; the update and the
// batch delete take internal ids only, which are read from the business first.

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
  const id = await internalId(vendorData);

  return apiRequest(orgAppPath(`/vendor-businesses/by-id/${pathSegment(id, "didit_internal_id")}/update/`), { method: "PATCH", json: data });
}

const internalId = async (vendorData: string): Promise<string> => (await getBusiness(vendorData)).didit_internal_id;

/** Each business named by vendor_data is read before it is deleted, so a call takes as many as it can read. */
const MAX_DELETE_IDS = 200;
const ID_READS = 8;

export async function deleteBusinesses(
  vendorDataList?: string[],
  diditInternalIdList?: string[],
  deleteAll?: unknown,
  confirm?: unknown,
): Promise<any> {
  assertBoolean(deleteAll, "delete_all");
  assertBoolean(confirm, "confirm");
  const wildcard = deleteAll === true;
  const notAList = Object.entries({ vendor_data_list: vendorDataList, didit_internal_id_list: diditInternalIdList }).find(
    ([, list]) => list !== undefined && !(Array.isArray(list) && list.every((id) => typeof id === "string" && id.trim() !== "")),
  );
  if (notAList) throw new DiditError({ code: "bad_request", message: `${notAList[0]} must be a list of ids.`, field: notAList[0] });
  const ids = [...(vendorDataList ?? []), ...(diditInternalIdList ?? [])];
  if (!wildcard && ids.length === 0) {
    throw new DiditError({ code: "bad_request", message: "Provide a non-empty vendor_data_list or didit_internal_id_list, or set delete_all with confirm:true.", field: "vendor_data_list" });
  }
  if (!wildcard && ids.length > MAX_DELETE_IDS) {
    throw new DiditError({ code: "bad_request", message: `Too many ids (max ${MAX_DELETE_IDS}).`, field: "vendor_data_list" });
  }
  if (confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: wildcard ? "delete_all permanently removes EVERY vendor business." : "This permanently removes the vendor businesses listed.",
      field: "confirm",
      hint: "Re-call with confirm:true once the user has explicitly confirmed this exact deletion.",
    });
  }
  // The route ignores vendor_data: every business is found first, and one that is not deletes none.
  const found = wildcard ? [] : await mapWithConcurrency(vendorDataList ?? [], ID_READS, internalId);

  return apiRequest(orgAppPath("/vendor-businesses/delete/"), {
    method: "DELETE",
    json: wildcard ? { delete_all: true } : { didit_internal_id_list: [...(diditInternalIdList ?? []), ...found], delete_all: false },
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
          ...VENDOR_FILTER_PROPS,
          country: { type: "string", description: "ISO 3166-1 alpha-2, comma-separated" },
          search: { type: "string", description: "vendor_data, name or registration number" },
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
          reason: { type: "string", description: "Why the status changes" },
          metadata: { type: "object" },
        },
        required: ["vendor_data"],
      },
    },
    access: "write",
    permission: "write:businesses", // PATCH …/vendor-businesses/by-id/{id}/update/ → vendor_business.py; the id is read with read:businesses
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
          reason: { type: "string" },
        },
        required: ["vendor_data", "status"],
      },
    },
    access: "write",
    permission: "write:businesses", // PATCH …/vendor-businesses/by-id/{id}/update/ → vendor_business.py
    run: ({ vendor_data, status, reason }) => updateBusiness(vendor_data, { status, reason }),
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
              "REQUIRED. Must be true - permanently removes the businesses listed, or EVERY one with delete_all. Only set after explicit user confirmation of this exact action.",
          },
        },
        required: ["confirm"],
      },
    },
    access: "destructive",
    permission: "delete:businesses", // DELETE …/vendor-businesses/delete/ → vendor_business.py:935
    run: (args) => deleteBusinesses(args.vendor_data_list, args.didit_internal_id_list, args.delete_all, args.confirm),
  },
];

import { apiRequest, orgAppPath } from "../config";
import { assertBoolean, DiditError, MAX_BATCH_IDS } from "../security";

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
  return apiRequest(orgAppPath(`/vendor-businesses/${encodeURIComponent(vendorData)}/`));
}

export async function updateBusiness(vendorData: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/vendor-businesses/${encodeURIComponent(vendorData)}/update/`), { method: "PATCH", json: data });
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

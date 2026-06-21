import { apiRequest, orgAppPath } from "../config";
import { assertBoolean, DiditError, MAX_BATCH_IDS } from "../security";

// Vendor users — the console resource is `vendor-users`, org/app-scoped. List/get(by
// vendor_data, legacy path)/bulk-delete map cleanly. The console keys updates by internal
// id (not vendor_data), so update/update-status are routed to the vendor_data path
// best-effort and may 404/405 where the console only exposes the by-id update.

export async function listUsers(params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath("/vendor-users/"), { params });
}

export async function getUser(vendorData: string): Promise<any> {
  return apiRequest(orgAppPath(`/vendor-users/${encodeURIComponent(vendorData)}/`));
}

export async function createUser(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/vendor-users/"), { method: "POST", json: data });
}

export async function updateUser(vendorData: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/vendor-users/${encodeURIComponent(vendorData)}/update/`), { method: "PATCH", json: data });
}

export async function updateUserStatus(vendorData: string, status: string): Promise<any> {
  return apiRequest(orgAppPath("/vendor-users/bulk-status/"), {
    method: "POST",
    json: { vendor_data_list: [vendorData], status },
  });
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

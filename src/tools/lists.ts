import { apiRequest, orgAppPath } from "../config";
import { requireFileSource, resolveFileSource } from "../security";

// Lists are org/app-scoped console resources; org/app resolve from the tool args via the
// request context (see orgAppPath). Sub-paths match the console inventory 1:1.

export async function listLists(params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath("/lists/"), { params });
}

export async function createList(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/lists/"), { method: "POST", json: data });
}

export async function getListDetail(listUuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${listUuid}/`));
}

export async function updateList(listUuid: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${listUuid}/`), { method: "PATCH", json: data });
}

export async function deleteList(listUuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${listUuid}/`), { method: "DELETE" });
}

export async function listEntries(listUuid: string, params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${listUuid}/entries/`), { params });
}

export async function createEntry(listUuid: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${listUuid}/entries/`), { method: "POST", json: data });
}

export async function deleteEntry(listUuid: string, entryUuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${listUuid}/entries/${entryUuid}/`), { method: "DELETE" });
}

export async function uploadFaceEntry(listUuid: string, data: Record<string, any>): Promise<any> {
  // The face-upload endpoint expects a base64-encoded `image` field in a JSON body.
  // The image arrives as a local path (stdio/local runs) or inline base64 (hosted runs).
  const { image_path, image_base64, ...rest } = data;
  const source = requireFileSource({ path: image_path, base64: image_base64 }, "image");
  const { buffer } = resolveFileSource(source, "image", { required: true })!;
  return apiRequest(orgAppPath(`/lists/${listUuid}/entries/face-upload/`), {
    method: "POST",
    json: { image: buffer.toString("base64"), ...rest },
  });
}

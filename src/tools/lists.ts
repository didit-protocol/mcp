import { readFileSync } from "fs";
import { apiRequest, orgAppPath } from "../config";

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
  const { image_path, ...rest } = data;
  if (!image_path) {
    throw new Error("uploadFaceEntry requires image_path (a local face image file).");
  }
  const image = readFileSync(image_path).toString("base64");
  return apiRequest(orgAppPath(`/lists/${listUuid}/entries/face-upload/`), {
    method: "POST",
    json: { image, ...rest },
  });
}

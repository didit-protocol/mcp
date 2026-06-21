import { apiRequest, orgAppPath } from "../config";

// Blocklist / allowlist — org/app-scoped console resources.

export async function getBlocklist(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/blocklist/"), { params });
}

export async function addToBlocklist(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/blocklist/add/"), { method: "POST", json: data });
}

export async function removeFromBlocklist(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/blocklist/remove/"), { method: "POST", json: data });
}

export async function addToAllowlist(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/allowlist/add/"), { method: "POST", json: data });
}

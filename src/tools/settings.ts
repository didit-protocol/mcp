import { apiRequest, orgAppPath } from "../config";

// Workflows are the console's "verification-settings" resource, scoped per org+app.
// org/application are resolved from the tool arguments (organization_id/application_id)
// via the request context — see orgAppPath / the CallTool dispatch in index.ts.

export async function listWorkflows(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/verification-settings/"), { params });
}

export async function getWorkflow(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/verification-settings/${uuid}/`));
}

export async function createWorkflow(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/verification-settings/"), { method: "POST", json: data });
}

export async function updateWorkflow(uuid: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/verification-settings/${uuid}/`), { method: "PATCH", json: data });
}

export async function deleteWorkflow(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/verification-settings/${uuid}/`), { method: "DELETE" });
}

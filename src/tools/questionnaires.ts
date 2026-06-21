import { apiRequest, orgAppPath } from "../config";

// Questionnaires — org/app-scoped console resource. Reads (list/get) map 1:1. The console
// edits questionnaires via versioned drafts (create-draft); the create/update/delete tools
// target the same org/app resource and may surface a 405 if the console only supports the
// draft flow for that operation.

export async function listQuestionnaires(): Promise<any> {
  return apiRequest(orgAppPath("/questionnaires/"));
}

export async function createQuestionnaire(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/questionnaires/"), { method: "POST", json: data });
}

export async function getQuestionnaire(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/questionnaires/${uuid}/`));
}

export async function updateQuestionnaire(uuid: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/questionnaires/${uuid}/`), { method: "PATCH", json: data });
}

export async function deleteQuestionnaire(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/questionnaires/${uuid}/`), { method: "DELETE" });
}

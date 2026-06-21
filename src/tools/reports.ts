import { apiRequest, orgAppPath } from "../config";

// Async export reports — org/app-scoped console resource.

export async function listReports(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/reports/"), { params });
}

export async function getReport(reportId: string): Promise<any> {
  return apiRequest(orgAppPath(`/reports/${reportId}/`));
}

export async function getReportDownloadUrl(reportId: string): Promise<any> {
  return apiRequest(orgAppPath(`/reports/${reportId}/download-url/`));
}

// kind ∈ sessions | transactions | businesses | vendor-users | vendor-businesses
export async function exportReport(kind: string, data: Record<string, any> = {}): Promise<any> {
  return apiRequest(orgAppPath(`/reports/${kind}/`), { method: "POST", json: data });
}

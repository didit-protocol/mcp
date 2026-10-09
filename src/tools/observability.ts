import { apiRequest, orgAppPath } from "../config";
import { pathSegment } from "../security";

// Audit logs + alerts — org/app-scoped console resources.

export async function listAuditLogs(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/audit-logs/"), { params });
}

export async function listAlerts(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/alerts/"), { params });
}

export async function configureAlert(alertType: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/alerts/${pathSegment(alertType, "alert_type")}/`), { method: "PATCH", json: data });
}

import { apiRequest, orgAppPath, resolveOrganizationId } from "../config";
import { pathSegment } from "../security";

// Audit logs (organization-scoped) + alerts (org/app-scoped console resources).

/**
 * The organization's audit log: `/audit/{org}/audit-logs/` on the verification API
 * (service-didit-verification audit/urls.py), outside `/organization/`, so neither orgPath
 * nor orgAppPath builds it. Every other argument is a list filter: an explicit
 * `application_id` narrows the log to that application instead of routing the request.
 */
export async function listAuditLogs(params: Record<string, any> = {}): Promise<any> {
  const { organization_id: organizationId, ...filters } = params;
  const org = pathSegment(resolveOrganizationId(organizationId), "organization_id");

  return apiRequest(`/audit/${org}/audit-logs/`, { params: filters });
}

export async function listAlerts(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/alerts/"), { params });
}

export async function configureAlert(alertType: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/alerts/${pathSegment(alertType, "alert_type")}/`), { method: "PATCH", json: data });
}

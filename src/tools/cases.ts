import { apiRequest, orgAppPath } from "../config";
import { pathSegment, DiditError } from "../security";

// Case management — org/app-scoped console resource. Read/create are dedicated tools;
// the many per-case actions (assign/resolve/reopen/escalate/comment) fold into one
// action-dispatch tool to keep the surface small.

const cid = (id: string) => pathSegment(id, "case_id");

export async function listCases(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/cases/"), { params });
}

export async function getCase(caseId: string): Promise<any> {
  return apiRequest(orgAppPath(`/cases/${cid(caseId)}/`));
}

export async function createCase(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/cases/"), { method: "POST", json: data });
}

export async function caseStatistics(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/cases/statistics/"), { params });
}

const KNOWN_CASE_ACTIONS = ["assign", "resolve", "reopen", "escalate", "comment", "update", "sar", "file_sar"];
const SAR_STATUS = "SAR_FILED";

// action ∈ assign | resolve | reopen | escalate | comment | update | sar
export async function manageCase(
  caseId: string,
  action: string,
  data: Record<string, any> = {},
  confirm?: unknown,
): Promise<any> {
  if (typeof action !== "string" || !KNOWN_CASE_ACTIONS.includes(action)) {
    throw new DiditError({
      code: "bad_request",
      message: "Unknown case action.",
      field: "action",
      hint: `action must be one of: ${KNOWN_CASE_ACTIONS.join(", ")}.`,
      allowed: KNOWN_CASE_ACTIONS,
    });
  }
  // Filing a SAR is a high-impact regulatory action — gate the explicit action AND the
  // status-smuggling path (resolving with status:SAR_FILED) behind confirm:true.
  const callerStatus = typeof data.status === "string" ? data.status.trim().toUpperCase() : undefined;
  const filesSar = action === "sar" || action === "file_sar" || callerStatus === SAR_STATUS;
  if (filesSar && confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: "Filing a SAR (Suspicious Activity Report) is a high-impact regulatory action.",
      field: "confirm",
      hint: "Re-call with confirm:true once a human has authorized filing — applies to action 'sar'/'file_sar' AND any resolve with status:'SAR_FILED'.",
    });
  }
  if (action === "update") {
    return apiRequest(orgAppPath(`/cases/${cid(caseId)}/`), { method: "PATCH", json: data });
  }
  if (action === "comment") {
    return apiRequest(orgAppPath(`/cases/${cid(caseId)}/comments/`), { method: "POST", json: data });
  }
  if (action === "sar" || action === "file_sar") {
    const { status: _s, ...rest } = data;
    return apiRequest(orgAppPath(`/cases/${cid(caseId)}/resolve/`), { method: "POST", json: { ...rest, status: SAR_STATUS } });
  }
  return apiRequest(orgAppPath(`/cases/${cid(caseId)}/${pathSegment(action, "action")}/`), { method: "POST", json: data });
}

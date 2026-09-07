import { apiRequest, orgAppPath } from "../config";
import { DiditError, pathSegment } from "../security";

const DETAIL_INCLUDES = new Set(["graph", "members", "signals", "timeline", "map"]);
const SUBJECT_PATHS: Record<string, string> = {
  session: "sessions",
  business_session: "business-sessions",
  vendor_user: "users",
  vendor_business: "businesses",
  transaction: "transactions",
};

const LIST_PARAM_KEYS = [
  "status",
  "signal_type",
  "pattern_type",
  "risk_band",
  "min_size",
  "max_size",
  "date_from",
  "date_to",
  "q",
  "ordering",
  "limit",
  "offset",
];

function pickParams(args: Record<string, any>, keys: string[]): Record<string, any> {
  const params: Record<string, any> = {};
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") params[key] = value;
  }
  return params;
}

function includeList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return ["members", "signals"];
  if (!Array.isArray(raw)) {
    throw new DiditError({
      code: "bad_request",
      message: "include must be an array.",
      field: "include",
      hint: "Pass include as an array of graph, members, signals, timeline, map.",
    });
  }
  const includes = raw.map((v) => String(v));
  const invalid = includes.filter((v) => !DETAIL_INCLUDES.has(v));
  if (invalid.length) {
    throw new DiditError({
      code: "bad_request",
      message: "include contains unsupported network detail sections.",
      field: "include",
      allowed: [...DETAIL_INCLUDES],
    });
  }
  return [...new Set(includes)];
}

export async function listNetworks(args: Record<string, any> = {}): Promise<any> {
  return apiRequest(orgAppPath("/networks/", {
    organizationId: args.organization_id,
    applicationId: args.application_id,
  }), {
    params: pickParams(args, LIST_PARAM_KEYS),
  });
}

export async function getNetwork(args: Record<string, any>): Promise<any> {
  const networkUuid = pathSegment(args.network_id, "network_id");
  const scope = { organizationId: args.organization_id, applicationId: args.application_id };
  const base = `/networks/${networkUuid}`;
  const detail = await apiRequest(orgAppPath(`${base}/`, scope));
  const included = includeList(args.include);
  const sections: Record<string, any> = {};

  for (const section of included) {
    const params =
      section === "graph"
        ? pickParams(args, ["depth", "focus_kind", "focus_id"])
        : undefined;
    sections[section] = await apiRequest(orgAppPath(`${base}/${section}/`, scope), { params });
  }

  return included.length ? { ...detail, included: sections } : detail;
}

export async function getNetworkMembership(args: Record<string, any>): Promise<any> {
  const subjectKind = String(args.subject_kind ?? "");
  const resource = SUBJECT_PATHS[subjectKind];
  if (!resource) {
    throw new DiditError({
      code: "bad_request",
      message: "subject_kind is not supported.",
      field: "subject_kind",
      allowed: Object.keys(SUBJECT_PATHS),
    });
  }
  const subjectId = pathSegment(args.subject_id, "subject_id");
  return apiRequest(orgAppPath(`/${resource}/${subjectId}/networks/`, {
    organizationId: args.organization_id,
    applicationId: args.application_id,
  }));
}

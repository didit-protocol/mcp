import { apiRequest, orgAppPath } from "../config";
import { ORG_APP_PROPS } from "../orgapp";
import { DiditError, assertBoolean, narrowingFilters, pathSegment } from "../security";
import type { RegisteredTool } from "./registry";

// AML ongoing monitoring of the people and companies an application verified (aml_monitoring.py).

const TARGET_PATHS: Readonly<Record<string, string>> = {
  vendor_users: "/vendor-users/toggle-ongoing-monitoring/",
  vendor_businesses: "/vendor-businesses/toggle-ongoing-monitoring/",
};

function targetPath(target: unknown): string {
  const path = TARGET_PATHS[String(target)];
  if (path) return path;
  throw new DiditError({ code: "bad_request", message: "target is not supported.", field: "target", allowed: Object.keys(TARGET_PATHS) });
}

const FILTERS = ["status", "risk", "country", "date_from", "date_to"];
const LIST_FILTERS = ["status", "risk"];

/** The records of a toggle: the ones named, or every one (that the filters match). Never both: the API would take all. */
function selection({ didit_internal_ids: ids, update_all: all, filters }: Record<string, any>): Record<string, any> {
  assertBoolean(all, "update_all");
  if ((all === true) === (ids !== undefined) || (all !== true && filters !== undefined)) {
    throw new DiditError({ code: "bad_request", message: "Pass didit_internal_ids, or update_all:true with or without filters.", field: "didit_internal_ids" });
  }
  if (all !== true) return { didit_internal_id_list: ids };
  const given = filters === undefined ? [] : Object.entries(narrowingFilters(filters, FILTERS));

  return {
    update_all: true,
    ...Object.fromEntries(given.map(([key, value]) => [`filter_${key}`, LIST_FILTERS.includes(key) ? [value].flat().flatMap((item) => item.split(",")) : String(value)])),
  };
}

/** The API runs a toggle that does not say `estimate_only`; here it is the estimate unless asked otherwise. */
export async function updateMonitoring(args: Record<string, any>): Promise<any> {
  const { target, is_enabled, estimate_only = true, confirm } = args;
  const path = targetPath(target);
  assertBoolean(estimate_only, "estimate_only");
  if (estimate_only === false && confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: "Turning ongoing monitoring on is billed for every record it covers.",
      field: "confirm",
      hint: "Read the estimate first (estimate_only, the default), show it to the user, then re-call with estimate_only:false and confirm:true.",
    });
  }

  return apiRequest(orgAppPath(path), {
    method: "PATCH",
    json: { ...selection(args), is_enabled, estimate_only },
  });
}

export async function getMonitoringJob(args: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(targetPath(args.target) + `${pathSegment(args.job_id, "job_id")}/`));
}

const TARGET_PROP = { type: "string", enum: Object.keys(TARGET_PATHS) };

export const MONITORING_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_monitoring_update",
      description:
        "Turn AML ongoing monitoring on or off for people or companies. By default it only estimates (who it would cover and the cost). The real run (estimate_only:false) is billed and returns a job.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          target: TARGET_PROP,
          is_enabled: { type: "boolean" },
          didit_internal_ids: { type: "array", items: { type: "string" }, description: "The records, by didit_internal_id" },
          update_all: { type: "boolean", description: "Every record instead, or those `filters` selects" },
          filters: { type: "object", description: "Narrows update_all: status, risk (texts or lists), country, date_from, date_to" },
          estimate_only: { type: "boolean", description: "Default true" },
          confirm: { type: "boolean", description: "REQUIRED to run it: it is billed. Only set after explicit user confirmation of this exact action." },
        },
        required: ["target", "is_enabled"],
      },
    },
    access: "destructive",
    permission: "write:sessions", // PATCH …/vendor-users|vendor-businesses/toggle-ongoing-monitoring/ → aml_monitoring.py:131
    run: (args) => updateMonitoring(args),
  },
  {
    def: {
      name: "didit_monitoring_get",
      description: "Get the progress and outcomes of a job didit_monitoring_update started.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, target: TARGET_PROP, job_id: { type: "string" } },
        required: ["target", "job_id"],
      },
    },
    access: "read",
    permission: ["read:sessions", "list:sessions"], // GET …/toggle-ongoing-monitoring/{job}/ → aml_monitoring.py:239
    run: (args) => getMonitoringJob(args),
  },
];

import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { PAGE_PROPS, pageParams } from "../paging";
import { assertBoolean, DiditError, pathSegment } from "../security";

// Regulatory reports (SAR, STR, goAML...): drafts only. Finalizing or deleting one is done by a
// person in the console, so no tool here does either. A plan without Cases answers 403.

const STATUSES = ["DRAFT", "VALIDATED", "FINALIZED"];
const REPORT_TYPES = ["SAR", "STR", "CTR", "TTR", "UTR", "IFT", "CBR", "TFR", "FFR", "PNMR"];
const REPORT_FIELDS = [
  "rentity_id", "rentity_branch", "submission_code", "entity_reference", "fiu_ref_number", "currency_code_local", "submission_date",
  "reporting_person", "location", "reason", "action", "activity", "report_indicators", "included_fields",
];

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function assertOneOf(value: unknown, allowed: string[], field: string): void {
  if (value === undefined || allowed.includes(String(value))) return;
  throw new DiditError({ code: "bad_request", message: `${field} must be one of ${allowed.join(", ")}.`, field, allowed });
}

/** The list drops every filter when one is invalid, so a wrong value is refused here. */
export async function listRegulatoryReports(args: Record<string, any>): Promise<any> {
  const { status, report_type, case_id } = args;
  assertOneOf(status, STATUSES, "status");
  assertOneOf(report_type, REPORT_TYPES, "report_type");
  if (case_id !== undefined && !UUID.test(String(case_id))) {
    throw new DiditError({ code: "bad_request", message: "case_id must be the case's uuid.", field: "case_id" });
  }

  return apiRequest(orgAppPath("/regulatory-reports/"), { params: { status, report_type, case: case_id, ...pageParams(args) } });
}

export async function getRegulatoryReport(reportId: string, file?: string): Promise<any> {
  const path = `/regulatory-reports/${pathSegment(reportId, "report_id")}/`;
  const report = await apiRequest(orgAppPath(path));

  return file ? { ...report, ...(await apiRequest(orgAppPath(`${path}download-url/`), { params: { file } })) } : report;
}

/** The body of a draft: its own arguments and `fields`, which the API reads side by side. */
function reportBody(args: Record<string, any>, own: string[]): Record<string, any> {
  const fields = args.fields ?? {};
  const unknown = Object.keys(fields).filter((key) => !REPORT_FIELDS.includes(key));
  if (unknown.length) {
    throw new DiditError({ code: "bad_request", message: `fields does not take ${unknown.join(", ")}.`, field: "fields", allowed: REPORT_FIELDS });
  }
  const given = own.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]);

  return { ...Object.fromEntries(given), ...fields };
}

export async function createRegulatoryReport(args: Record<string, any>): Promise<any> {
  const json = reportBody(args, ["report_type", "jurisdiction", "template", "transactions", "narrative"]);

  return apiRequest(orgAppPath(`/cases/${pathSegment(args.case_id, "case_id")}/regulatory-reports/`), { method: "POST", json });
}

export async function updateRegulatoryReport(args: Record<string, any>): Promise<any> {
  assertBoolean(args.validate, "validate");
  const path = `/regulatory-reports/${pathSegment(args.report_id, "report_id")}/`;
  const json = reportBody(args, ["jurisdiction", "transactions", "narrative"]);
  const edits = Object.keys(json).length > 0;
  if (!edits && args.validate !== true) {
    throw new DiditError({ code: "bad_request", message: "Pass what to change, validate:true, or both.", field: "fields" });
  }
  const report = edits ? await apiRequest(orgAppPath(path), { method: "PATCH", json }) : {};

  return args.validate ? { ...report, validation: await apiRequest(orgAppPath(`${path}validate/`), { method: "POST", json: {} }) } : report;
}

const DRAFT_PROPS = {
  jurisdiction: { type: "string", description: "ISO 3166-1 alpha-2" },
  transactions: { type: "array", items: { type: "string" }, description: "Transaction uuids" },
  narrative: { type: "object", description: "Text by section: who, what, when, where, why, how" },
  fields: { type: "object", description: `Other report fields: ${REPORT_FIELDS.join(", ")}` },
} as const;

// ── The regulatory report tools (tools/registry.ts) ──────────────────────────────────
export const REGULATORY_REPORT_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_regulatory_report_list",
      description: "List the regulatory reports (SAR, STR, goAML...) of the application.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          status: { type: "string", enum: STATUSES },
          report_type: { type: "string", enum: REPORT_TYPES },
          case_id: { type: "string" },
          ...PAGE_PROPS,
        },
      },
    },
    access: "read",
    permission: ["read:cases", "list:cases"], // GET …/regulatory-reports/ → regulatory_reports.py:247
    run: (args) => listRegulatoryReports(args),
  },
  {
    def: {
      name: "didit_regulatory_report_get",
      description: "Get a regulatory report; with `file`, also download_url of its file (a finalized report only).",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, report_id: { type: "string" }, file: { type: "string", enum: ["pdf", "xml"] } },
        required: ["report_id"],
      },
    },
    access: "read",
    permission: ["read:cases", "list:cases"], // GET …/regulatory-reports/{id}/(download-url/) → regulatory_reports.py:289,369
    run: (args) => getRegulatoryReport(args.report_id, args.file),
  },
  {
    def: {
      name: "didit_regulatory_report_create",
      description: "Create a DRAFT regulatory report on a case. Nothing is filed: a person finalizes it in the console.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          case_id: { type: "string" },
          report_type: { type: "string", enum: REPORT_TYPES },
          template: { type: "string", description: "Template uuid (didit_case_catalog_list report_templates)" },
          ...DRAFT_PROPS,
        },
        required: ["case_id"],
      },
    },
    access: "write",
    permission: "write:cases", // POST …/cases/{id}/regulatory-reports/ → regulatory_reports.py:230
    run: (args) => createRegulatoryReport(args),
  },
  {
    def: {
      name: "didit_regulatory_report_update",
      description: "Edit a draft regulatory report (a finalized one answers 409), check it with validate:true, or both.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, report_id: { type: "string" }, ...DRAFT_PROPS, fields: { type: "object", description: "As in didit_regulatory_report_create" }, validate: { type: "boolean", description: "Return the validation errors" } },
        required: ["report_id"],
      },
    },
    access: "write",
    permission: "write:cases", // PATCH …/regulatory-reports/{id}/, POST …/validate/ → regulatory_reports.py:296,342
    run: (args) => updateRegulatoryReport(args),
  },
];

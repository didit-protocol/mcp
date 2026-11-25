import { apiRequest } from "../config";
import type { RegisteredTool } from "./registry";
import { assertBoolean, DiditError, pathSegment } from "../security";

// A reviewer's actions inside one business verification: its key people (parties) and the company
// data read from the registry.

const sid = (id: string) => pathSegment(id, "session_id");

const PARTY_ACTIONS = ["skip", "unskip", "regenerate"];
const COMPANY_FIELDS = [
  "company_name", "registration_number", "country_code", "region", "incorporation_date", "registration_date", "dissolution_date",
  "tax_number", "vat_number", "legal_address", "company_type", "registry_status", "verification_status", "alternative_names",
  "nature_of_business", "registered_capital", "registered_capital_amount", "registered_capital_currency", "website", "email", "phone",
  "legal_entity_identifier", "location_of_registration", "control_scheme",
];

const badRequest = (field: string, message: string, allowed?: string[]): DiditError =>
  new DiditError({ code: "bad_request", message, field, ...(allowed ? { allowed } : {}) });

async function updateParty({ session_id, party_id, action, confirm }: Record<string, any>): Promise<any> {
  if (!PARTY_ACTIONS.includes(action)) throw badRequest("action", `action must be one of ${PARTY_ACTIONS.join(", ")}.`, PARTY_ACTIONS);
  assertBoolean(confirm, "confirm");
  if (confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: action === "regenerate" ? "Regenerating emails this person a new verification link." : "Exempting a key person, or not, decides what the business verification needs.",
      field: "confirm",
      hint: "Show the person the exact action, and re-call with confirm:true only once they have explicitly approved it.",
    });
  }
  const path = `/session/${sid(session_id)}/kyb/parties/${pathSegment(party_id, "party_id")}/`;

  return action === "regenerate"
    ? apiRequest(`${path}regenerate/`, { method: "POST", json: {} })
    : apiRequest(path, { method: "PATCH", json: { is_skipped: action === "skip" } });
}

/** The API ignores a field it does not know and answers an empty change with the company as it is. */
async function updateCompany({ session_id, company_id, company_data = {} }: Record<string, any>): Promise<any> {
  const unknown = Object.keys(company_data).filter((key) => !COMPANY_FIELDS.includes(key));
  if (unknown.length || Object.keys(company_data).length === 0) {
    throw badRequest("company_data", `company_data takes one or more of ${COMPANY_FIELDS.join(", ")}.`, COMPANY_FIELDS);
  }

  return apiRequest(`/session/${sid(session_id)}/kyb/${pathSegment(company_id, "company_id")}/update-data/`, { method: "PATCH", json: company_data });
}

export async function updateKybParty(args: Record<string, any>): Promise<any> {
  if ((args.party_id === undefined) === (args.company_id === undefined)) {
    throw badRequest("party_id", "Pass party_id with action, or company_id with company_data.");
  }

  return args.party_id === undefined ? updateCompany(args) : updateParty(args);
}

// ── The business verification tools (tools/registry.ts) ──────────────────────────────────
export const KYB_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_kyb_party_update",
      description:
        "Act on a business verification. A key person (party_id, from the decision): skip (exempt from verification), unskip, or regenerate " +
        "(a new verification, emailed to them, when theirs was deleted or expired unstarted). Or correct its company (company_id) with company_data.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "The business verification" },
          party_id: { type: "string" },
          action: { type: "string", enum: PARTY_ACTIONS },
          company_id: { type: "string" },
          company_data: { type: "object", description: `Only what changes: ${COMPANY_FIELDS.join(", ")}` },
          confirm: { type: "boolean", description: "REQUIRED true with party_id. Only set after explicit user confirmation of this exact action." },
        },
        required: ["session_id"],
      },
    },
    // Regenerating emails a person; exempting one can settle the verification.
    access: "destructive",
    openWorld: true,
    permission: "write:businesses", // PATCH …/kyb/parties/{id}/, POST …/regenerate/, PATCH …/kyb/{company}/update-data/ → kyb/views/kyb.py
    run: (args) => updateKybParty(args),
  },
];

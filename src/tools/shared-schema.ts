import { renderToolSchemaReference } from "../feature-config-schema";

// Schema pieces several tool areas use in their definitions. A piece only one area uses lives
// with that area (tools/registry.ts); one that index.ts and an area share lives here, so neither
// imports the other.

export const SESSION_STATUSES =
  "Not Started, In Progress, In Review, Approved, Declined, Expired, Abandoned, Kyc Expired, Resubmitted, Awaiting User";

// Relative time-window shortcut for analytics + search tools — saves the model computing
// ISO dates. `last_n_days: 15` ⇒ date_from = today−15, date_to = today (explicit dates win).
export const LAST_N_DAYS_PROP = {
  last_n_days: {
    type: "number",
    description: "Relative window: include only the last N days (sets date_from/date_to). Alternative to passing date_from/date_to.",
  },
} as const;

/**
 * The `search` argument of the session search tool (the list tool carries its first half). A person names a session by the
 * number the console shows (S-2946), so the exact way to find one by number is stated on the
 * argument itself: a model reads it whenever the tool is offered, and only then. A bare number is
 * a prefix search that also matches document, personal and phone numbers and vendor_data, which
 * is how a request for one session returns others.
 */
export const SESSION_SEARCH_DESCRIPTION =
  "Free-text search (name, email, vendor_data, document or phone number). S-<number> finds a user verification by number exactly, B-<number> with session_kind business a business one; numbers are per application. A bare number is a prefix search.";

/** The status a user or business record of the application can have (its own statuses, not a session's). */
export const ENTITY_STATUSES = ["ACTIVE", "FLAGGED", "BLOCKED"];

/** The document type codes a session or a standalone check accepts. */
export const DOCUMENT_TYPES = ["P", "DL", "ID", "RP", "SSC", "HIC", "WP", "TC", "VISA", "PSC", "BC", "OTHER"];

// Graph (node/branching) workflows — the real structure the console uses (the flat `features`
// list above can't express branches, conditions, or Document AI). Enums mirror the backend
// (workflow_graph_choices.py). A graph is { start_node, nodes: { id: node } }.
const WORKFLOW_NODE_TYPES = ["feature", "action", "branch", "status", "webhook"];
const WORKFLOW_OPERATORS = [
  "equals", "not_equals", "greater_than", "greater_than_or_equals", "less_than",
  "less_than_or_equals", "contains", "not_contains", "in", "not_in", "is_empty",
  "is_not_empty", "regex", "fuzzy_match",
];
const WORKFLOW_SESSION_STATUSES = ["Approved", "Declined", "In Review", "Determine"];
// index.ts compares a listed `graph` property with this very object, to carry the manual once per
// list (the saving tool keeps it): every tool shares this one.
export const WORKFLOW_GRAPH_SCHEMA = {
  type: "object" as const,
  description:
    // Graph STRUCTURE - node shapes, branch semantics, ordering. This is MCP and
    // backend behaviour, not the feature-config contract, so it stays prose.
    "Node/branching workflow graph: { start_node, nodes }. `start_node` is the id of the entry " +
    "node (must be a feature node). `nodes` maps nodeId → node. Node shapes: " +
    "feature = {node_type:'feature', feature:<UPPERCASE, e.g. OCR|DOCUMENT_AI>, config?:{}, next?:<id>, branches?:[]}; " +
    "branch = {node_type:'branch', branches:[{id, logic:'and'|'or', rules:[{field, operator, value, score?}], goto:<id>}], next?:<id fallback>}; " +
    "status (TERMINAL) = {node_type:'status', session_status:'Approved'|'Declined'|'In Review'|'Determine'}. " +
    "Branches are evaluated in order, first match wins; an empty rules:[] is the else/catch-all (kept last). " +
    "Operators include `fuzzy_match` (string fields only, needs a `score` 0-100). Reference a feature's outcome " +
    "with e.g. kyc.status / document_ai.status / bank.status, and an extracted value with kyc.extra_fields.profession. " +
    "Each rule's `node_id` (the feature node that produces its field) is auto-filled for you — only set it " +
    "(or use the `field@node_id` form) to disambiguate when the graph has several nodes of the same feature. " +
    // Allow-list NORMALIZATION is something this server does on the way out, so it
    // is not in the backend contract and has to be stated here.
    "Allow-list shorthands the MCP normalizes for you before saving: documents_allowed / poa_documents_allowed " +
    "accept a doc-type array ([\"PASSPORT\"] = passport-only, any country), doc NAMES " +
    "(PASSPORT/ID/DRIVER_LICENSE/RESIDENCE_PERMIT) as well as codes (P/ID/DL/RP), scalar flags, and an \"ALL\" " +
    "country key — every form becomes the canonical {ISO3:{CODE:{enabled:1}}}. poa_languages_allowed accepts a " +
    "language array ([\"es\"]) or a map ({\"es\":1}). Omit an allow-list to accept everything. " +
    // The KYC/KYB rule is a graph-level constraint, not a per-key one.
    "KYC vs KYB: a graph is EITHER a person (KYC) workflow OR a business (KYB) workflow — never both, and the choice follows WHO is verified (a company → KYB, a person → KYC). A graph using any KYB feature (KYB_REGISTRY/KYB_DOCUMENTS/KYB_KEY_PEOPLE) may only also use DOCUMENT_AI, AML, QUESTIONNAIRE, PHONE_VERIFICATION, EMAIL_VERIFICATION, IP_ANALYSIS, BANK_VERIFICATION; it must NOT include person/KYC-only features (OCR, LIVENESS, FACE_MATCH, NFC, PROOF_OF_ADDRESS, DATABASE_VALIDATION, AGE_ESTIMATION). Company paperwork (incorporation, ownership, source of funds, business address) belongs in KYB_DOCUMENTS or DOCUMENT_AI on the KYB graph — never rebuild it as a KYC workflow. To verify the people behind a company (UBOs, officers, shareholders), build a SEPARATE KYC workflow and reference it from the KYB_KEY_PEOPLE node config (kyb_ubo_verification_workflow / kyb_officer_verification_workflow / kyb_shareholder_verification_workflow). Mixing the two is rejected by validation. " +
    "Validate with didit_workflow_validate_graph before didit_workflow_set_graph. Get valid fields/operators from didit_workflow_get_field_definitions.\n\n" +
    // Everything a feature node's `config` accepts, generated from the backend
    // serializers. Never hand-written: that is how DATABASE_VALIDATION came to be
    // documented nowhere while DOCUMENT_AI had four paragraphs.
    renderToolSchemaReference(),
  properties: {
    start_node: { type: "string", description: "Entry node id (a feature node)." },
    nodes: { type: "object", description: "Map of nodeId → node object (see the node shapes above)." },
  },
  required: ["start_node", "nodes"],
} as const;

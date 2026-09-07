#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as auth from "./tools/auth";
import * as sessions from "./tools/sessions";
import * as settings from "./tools/settings";
import * as billing from "./tools/billing";
import * as users from "./tools/users";
import * as businesses from "./tools/businesses";
import * as transactions from "./tools/transactions";
import * as travelRule from "./tools/travelRule";
import * as marketplace from "./tools/marketplace";
import * as customization from "./tools/customization";
import * as webhooks from "./tools/webhooks";
import * as questionnaires from "./tools/questionnaires";
import * as lists from "./tools/lists";
import * as standalone from "./tools/standalone";
import {
  PRIVILEGED_TOOL_DEFS,
  PRIVILEGED_GROUP_PREFIX,
  isPrivilegedToolName,
  isPrivilegedCaller,
  dispatchPrivilegedTool,
} from "./privileged-tools";
import * as blocklist from "./tools/blocklist";
import * as cases from "./tools/cases";
import * as reports from "./tools/reports";
import * as observability from "./tools/observability";
import * as members from "./tools/members";
import * as context from "./tools/context";
import * as search from "./tools/search";
import * as workflowGraph from "./tools/workflow-graph";
import {
  FEATURE_CONFIG_CHECKSUM,
  WORKFLOW_FEATURES,
  configKeys,
  renderFeatureDetail,
  renderFeatureItemReference,
  renderToolSchemaReference,
  FEATURE_CONFIG_SCHEMA,
} from "./feature-config-schema";
import * as analytics from "./tools/analytics";
import * as compliance from "./tools/compliance";
import * as networks from "./tools/networks";
import { requestContext, stripRoutingIds, SERVER_VERSION, permissionMode, MCP_TOOL_PROFILE } from "./config";
import { applyCatalogProfile, catalogProfileRefusal, resolveCatalogProfile, type CatalogProfile } from "./catalog-profiles";
import { getOrgAppMap } from "./orgapp";
import { toSafeErrorShape, DiditError } from "./security";
import { auditToolCall } from "./audit-log";
import { decidePermission, missingPermissionError } from "./permissions";

const SESSION_STATUSES =
  "Not Started, In Progress, In Review, Approved, Declined, Expired, Abandoned, Kyc Expired, Resubmitted, Awaiting User";

const LANGUAGE_CODES = [
  "en", "ar", "bg", "bn", "bs", "ca", "cnr", "cs", "da", "de", "el", "es", "et",
  "fa", "fi", "fr", "he", "hi", "hr", "hu", "hy", "id", "it", "ja", "ka", "kk",
  "ko", "ky", "lt", "lv", "mk", "mn", "ms", "nl", "no", "pl", "pt-BR", "pt",
  "ro", "ru", "sk", "sl", "so", "sq", "sr", "sv", "th", "tr", "uk", "uz",
  "vi", "zh-CN", "zh-TW", "zh",
];

const DOCUMENT_TYPES = ["P", "DL", "ID", "RP", "SSC", "HIC", "WP", "TC", "VISA", "PSC", "BC", "OTHER"];
const ENTITY_STATUSES = ["ACTIVE", "FLAGGED", "BLOCKED"];
const LIST_ENTRY_TYPES = [
  "face", "document", "phone", "email", "ip_address", "device_fingerprint",
  "wallet_address", "bank_account", "user", "business", "country", "key",
];
const NETWORK_STATUSES = ["active", "in_review", "resolved", "dismissed"];
const NETWORK_SIGNAL_TYPES = ["ip_address", "device", "face", "document_number", "phone", "email", "address"];
const NETWORK_PATTERN_TYPES = [
  "exact_same_device",
  "similar_device",
  "same_ip_address",
  "same_address",
  "similar_selfie_backgrounds",
  "similar_poa_documents",
  "same_document_number",
  "same_phone_number",
  "same_email",
];
const NETWORK_RISK_BANDS = ["low", "medium", "high"];
const NETWORK_DETAIL_INCLUDES = ["graph", "members", "signals", "timeline", "map"];
const NETWORK_SUBJECT_KINDS = ["session", "business_session", "vendor_user", "vendor_business", "transaction"];

// Real backend FormElementType (questionnaires/config/choices.py) — uppercase.
const FORM_ELEMENT_TYPES = [
  "SHORT_TEXT", "LONG_TEXT", "PARAGRAPH", "DROPDOWN", "SINGLE_CHOICE", "MULTIPLE_CHOICE",
  "NUMBER", "IMAGE", "FILE_UPLOAD", "TIME", "EMAIL", "ADDRESS", "PHONE", "COUNTRY",
  "DATE_PICKER", "CONSENT", "SECTION_HEADER", "SEPARATOR", "HEADING", "REPEATABLE_GROUP",
];
const QUESTIONNAIRE_LANG_PROPS = {
  languages: {
    type: "array",
    items: { type: "string" },
    description: "Locales the questionnaire is offered in. Defaults to [\"en\"]; \"en\" must always be included.",
  },
  default_language: { type: "string", description: "Locale shown by default (must be in `languages`). Defaults to the first language." },
  status: { type: "string", enum: ["draft", "published"], description: "Omit to publish immediately; 'draft' saves without publishing." },
} as const;

const FORM_ELEMENTS_PROP = {
  form_elements: {
    type: "array",
    description:
      "REQUIRED. Array of form-element objects, in the order the user answers them. Each: { element_type (uppercase, one of the allowed types), title (a plain string, or an object of locale→string e.g. {\"en\":\"Your name\"}), is_required (bool), placeholder (hint text), and for choice types a `choices` array }. A per-question hint goes in `placeholder`: `description` is only accepted on HEADING, SECTION_HEADER and PARAGRAPH elements.",
    items: {
      type: "object",
      properties: {
        element_type: { type: "string", enum: FORM_ELEMENT_TYPES, description: "Element type (UPPERCASE)" },
        title: { type: "object", description: "Locale → label, e.g. {\"en\":\"Question text\"}" },
        is_required: { type: "boolean" },
        choices: { type: "array", items: { type: "object" }, description: "Options for DROPDOWN/SINGLE_CHOICE/MULTIPLE_CHOICE. Each: { value, label?, requires_text_input? }" },
      },
      required: ["element_type"],
    },
  },
} as const;

const WORKFLOW_FEATURE_ITEM = {
  type: "object" as const,
  properties: {
    feature: { type: "string", enum: WORKFLOW_FEATURES, description: "Feature to run (uppercase)" },
    config: {
      type: "object",
      description:
        renderFeatureItemReference() +
        "\n\nThe MCP normalizes the allow-lists for you before it saves: documents_allowed / " +
        "poa_documents_allowed accept a plain doc-type array ([\"PASSPORT\"] = passport-only, any " +
        "country), doc NAMES (PASSPORT/ID/DRIVER_LICENSE/RESIDENCE_PERMIT) as well as codes " +
        "(P/ID/DL/RP), scalar flags, and an \"ALL\" country key - all of it becomes the canonical " +
        "{ISO3:{CODE:{enabled:1}}}. poa_languages_allowed likewise accepts a language array " +
        "([\"es\"]) or a map ({\"es\":1}). Omit an allow-list to accept everything.",
    },
    label: { type: "string", description: "Optional internal node label" },
  },
  required: ["feature"],
};

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
const WORKFLOW_GRAPH_SCHEMA = {
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
    "with e.g. kyc.status / document_ai.status, and an extracted value with kyc.extra_fields.profession. " +
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
    "KYC vs KYB: a graph is EITHER a person (KYC) workflow OR a business (KYB) workflow — never both, and the choice follows WHO is verified (a company → KYB, a person → KYC). A graph using any KYB feature (KYB_REGISTRY/KYB_DOCUMENTS/KYB_KEY_PEOPLE) may only also use DOCUMENT_AI, AML, QUESTIONNAIRE, PHONE_VERIFICATION, EMAIL_VERIFICATION, IP_ANALYSIS; it must NOT include person/KYC-only features (OCR, LIVENESS, FACE_MATCH, NFC, PROOF_OF_ADDRESS, DATABASE_VALIDATION, AGE_ESTIMATION). Company paperwork (incorporation, ownership, source of funds, business address) belongs in KYB_DOCUMENTS or DOCUMENT_AI on the KYB graph — never rebuild it as a KYC workflow. To verify the people behind a company (UBOs, officers, shareholders), build a SEPARATE KYC workflow and reference it from the KYB_KEY_PEOPLE node config (kyb_ubo_verification_workflow / kyb_officer_verification_workflow / kyb_shareholder_verification_workflow). Mixing the two is rejected by validation. " +
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

// Transaction-monitoring (KYT) rule schemas. These mirror the engine-facing
// fields in service-didit-verification's TransactionRule serializers. The MCP
// deliberately requires an explicit aggregation window even though the backend
// defaults an omitted window to 1d: a silent one-day default is unsafe when an
// agent is authoring a velocity rule for another period.
const RULE_CONDITION_OPERATORS = [
  "eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "not_contains",
  "contains_any", "regex", "fuzzy_match", "exists", "is_not_empty", "is_not_null",
  "not_exists", "is_empty", "is_null",
];
const RULE_CONDITION_ITEM = {
  type: "object" as const,
  properties: {
    field: {
      type: "string",
      description:
        "Field path from the transaction field catalog, e.g. amount, currency, direction, action_type, score, " +
        "transaction_type, subject_country, counterparty_country, subject_vendor_data, subject_device_fingerprint, " +
        "subject_payment_method_type, travel_rule_status, travel_rule_required, tags, " +
        "subject_days_since_previous_transaction, or custom_values.<key> (a key submitted as custom_properties). " +
        "Country codes, travel_rule_status, and payment_method_type are normalized before comparison.",
    },
    operator: {
      type: "string",
      enum: RULE_CONDITION_OPERATORS,
      description:
        "in/not_in accept a scalar or list; a scalar is treated as a one-item membership set. " +
        "contains/not_contains are case-insensitive substring matches. contains_any requires a list of strings. " +
        "regex safely matches value (the pattern) against the field. fuzzy_match requires score (0-100). " +
        "gt/gte/lt/lte are false when either side is null or not comparable. exists/is_not_empty/is_not_null " +
        "are presence aliases; not_exists/is_empty/is_null are their negation and ignore value.",
    },
    value: {
      description:
        "Comparison value; its shape depends on operator and value_type. Omit for presence operators.",
    },
    value_type: {
      type: "string",
      enum: ["list", "field", "relative_date"],
      description:
        "list: value is a List UUID and its entries become the comparison set. field: value is another field path. " +
        "relative_date: value is resolved as a relative date expression. Omit for a literal value.",
    },
    score: {
      type: "number",
      minimum: 0,
      maximum: 100,
      description: "Required match threshold when operator is fuzzy_match.",
    },
    group_index: {
      type: "integer",
      description:
        "Setting group_index on any condition switches the entire condition list to grouped evaluation.",
    },
    group_logic: {
      type: "string",
      enum: ["AND", "OR"],
      description: "Combines conditions within a group. Default AND.",
    },
    groups_logic: {
      type: "string",
      enum: ["AND", "OR"],
      description:
        "Combines group outcomes; only the first condition's value is used. Default OR. Grouped evaluation " +
        "overrides evaluation_mode.",
    },
  },
  required: ["field", "operator"],
};
const RULE_AGGREGATION_ITEM = {
  type: "object" as const,
  description:
    "One historical velocity check. Every aggregation entry on a rule must match (AND), regardless of " +
    "evaluation_mode. The window is required by the MCP so it cannot silently fall back to the backend's 1d default.",
  properties: {
    metric: {
      type: "string",
      enum: ["count", "sum", "max", "min", "avg", "distinct_count", "unique_count"],
      description: "unique_count is an alias of distinct_count.",
    },
    field: {
      type: "string",
      description: "Numeric or identity field to aggregate. Defaults to amount; ignored for count.",
    },
    operator: {
      type: "string",
      enum: ["eq", "ne", "gt", "gte", "lt", "lte"],
      description: "Comparison of the computed metric against value.",
    },
    value: { type: "number", description: "Threshold the computed metric is compared against." },
    window: {
      type: "string",
      pattern: "^\\d+[mhd]$",
      description:
        "REQUIRED. Velocity window: '<N>m' (minutes, not months), '<N>h' (hours), or '<N>d' (days).",
    },
    filters: {
      type: "object",
      description:
        "Restricts the same-app historical transactions counted inside the window. A value of '__current__' " +
        "resolves to that field's value on the transaction being evaluated, e.g. " +
        "{subject_vendor_data:'__current__'} counts the same subject only. An array means membership.",
    },
  },
  required: ["metric", "operator", "value", "window"],
};
const RULE_SCOPE_SCHEMA = {
  type: "object" as const,
  description:
    "Restricts which transactions are considered. Empty or omitted lists mean no restriction. Transaction type " +
    "aliases such as travelRule are normalized by the engine.",
  properties: {
    transaction_types: {
      type: "array",
      items: { type: "string" },
      description:
        "Examples: finance, kyc, travel_rule, user_event, audit_trail_event, gambling_bet, " +
        "gambling_limit_change, gambling_bonus_change.",
    },
    directions: { type: "array", items: { type: "string", enum: ["INBOUND", "OUTBOUND"] } },
    action_types: {
      type: "array",
      items: { type: "string" },
      description: "Application-specific action types, e.g. withdrawal or deposit.",
    },
  },
};
const RULE_ACTION_ITEM = {
  type: "object" as const,
  description:
    "One action. All actions on a match run together; TEST-mode rules record the match but skip every action. " +
    "Shapes: add_score {type,value:<integer>}; change_status {type,value:'IN_REVIEW'|'DECLINED'|" +
    "'AWAITING_USER'|'APPROVED',workflow_id?}, where AWAITING_USER requires workflow_id; add_tags " +
    "{type,tag_uuid? or tag_name?,tag_color?}; add_note {type,note}; add_to_list {type,list_id}; open_case " +
    "{type,blueprint?,grouping?,attach_matched_transaction?}. Only the first open_case action is applied.",
  properties: {
    type: {
      type: "string",
      enum: ["add_score", "change_status", "add_tags", "add_note", "add_to_list", "open_case"],
    },
    value: { description: "add_score delta, or change_status target (alias: status)." },
    workflow_id: {
      type: "string",
      description: "change_status only; required when value is AWAITING_USER.",
    },
    tag_uuid: { type: "string", description: "add_tags only." },
    tag_name: { type: "string", description: "add_tags only; the backend uppercases it." },
    tag_color: { type: "string", description: "add_tags only, e.g. #FF0000." },
    note: { type: "string", description: "add_note only (alias: value)." },
    list_id: { type: "string", description: "add_to_list only; UUID of the target List." },
    blueprint: { type: "string", description: "open_case only; case blueprint UUID." },
    grouping: {
      type: "string",
      enum: ["by_applicant", "by_rule_and_applicant"],
      description: "open_case only.",
    },
    attach_matched_transaction: { type: "boolean", description: "open_case only." },
  },
  required: ["type"],
};
const RULE_CONDITIONS_PROP = {
  conditions: {
    type: "array",
    items: RULE_CONDITION_ITEM,
    description: "Conditions persisted on the rule, combined by evaluation_mode unless grouped.",
  },
} as const;
const RULE_AGGREGATION_PROP = {
  aggregation: {
    type: "array",
    items: RULE_AGGREGATION_ITEM,
    description:
      "Velocity checks persisted on the rule. Include them on create/update; putting them only in backtest does not save them.",
  },
} as const;
const RULE_ACTIONS_PROP = {
  actions: {
    type: "array",
    items: RULE_ACTION_ITEM,
    description:
      "Actions persisted on the rule. Include every action the user requested on create/update; backtest never saves actions.",
  },
} as const;
const RULE_EVALUATION_MODE_PROP = {
  evaluation_mode: {
    type: "string",
    enum: ["ALL", "ANY"],
    description:
      "How flat conditions combine when no condition has group_index. Default ALL. This is not TEST/ACTIVE mode.",
  },
} as const;
const RULE_SCOPE_PROP = { scope: RULE_SCOPE_SCHEMA } as const;

// Org/app selectors shared by the console (management) tools, which target
// /organization/{org}/application/{app}/... endpoints. Spread into each such tool's
// `properties`. Resolved (arg → token context → env default) by orgAppPath in config.ts;
// discover ids via didit_org_list / didit_org_list_applications.
const ORG_APP_PROPS = {
  organization_id: {
    type: "string",
    description: "Organization UUID (from didit_org_list). Optional if your token has a single/default org.",
  },
  application_id: {
    type: "string",
    description: "Application UUID (from didit_context_get). Optional when you own exactly one application - it is resolved automatically, even if you belong to several organizations.",
  },
} as const;

// Relative time-window shortcut for analytics + search tools — saves the model computing
// ISO dates. `last_n_days: 15` ⇒ date_from = today−15, date_to = today (explicit dates win).
const LAST_N_DAYS_PROP = {
  last_n_days: {
    type: "number",
    description: "Relative window: include only the last N days (sets date_from/date_to). Alternative to passing date_from/date_to.",
  },
} as const;

// Tool names are domain-first (`didit_<domain>_<action>`) so that Claude's flat
// "Other tools" connector list sorts every domain's tools into one contiguous block
// (there is no public API for named sub-groups within a single connector — the
// alphabetical name sort is the only lever). The group label below is derived from the
// name prefix and emitted per tool as _meta["anthropic/toolGroup"] (app-facing metadata
// the model never sees) — harmless today, future-proof if the UI ever renders it.
const TOOL_GROUP_BY_PREFIX: [string, string][] = [
  ...(PRIVILEGED_GROUP_PREFIX ? [PRIVILEGED_GROUP_PREFIX] : []),
  ["account_", "Account Setup"],
  ["context_", "Account & Org"],
  ["org_", "Account & Org"],
  ["session_", "Sessions"],
  ["workflow_", "Workflows & Questionnaires"],
  ["questionnaire_", "Workflows & Questionnaires"],
  ["lists_", "Lists & Blocklist"],
  ["blocklist_", "Lists & Blocklist"],
  ["allowlist_", "Lists & Blocklist"],
  ["vendor_", "Vendor Users & Businesses"],
  ["transaction_", "Transactions (AML)"],
  ["travel_rule_", "Travel Rule"],
  ["marketplace_", "Marketplace"],
  ["case_", "Cases"],
  ["webhook_", "Webhooks & Alerts"],
  ["alert_", "Webhooks & Alerts"],
  ["report_", "Reports & Audit"],
  ["audit_", "Reports & Audit"],
  ["analytics", "Reports & Audit"],
  ["network_", "Networks"],
  ["compliance_", "Compliance"],
  ["branding_", "Branding"],
  ["verify_", "Verification APIs"],
];
function toolGroupOf(name: string): string {
  const rest = name.replace(/^didit_/, "");
  for (const [prefix, group] of TOOL_GROUP_BY_PREFIX) {
    if (rest.startsWith(prefix)) return group;
  }
  return "Other";
}

// Tools that don't operate on an org/app scope — never auto-resolve a default for them.
const SCOPE_AGNOSTIC_TOOLS = new Set([
  "didit_account_register",
  "didit_account_verify_email",
  "didit_account_resend_otp",
  "didit_account_login",
  "didit_org_list",
  "didit_context_get",
  // Public pricing catalog: no org/app scope to resolve.
  "didit_workflow_get_kyb_registry_catalog",
]);

// Account bootstrap tools accept passwords/OTP codes and are only for unauthenticated
// stdio setup. Hosted (remote) servers exclude them for EVERY caller - a remote connector
// authenticates with OAuth, so account credentials must never travel through the
// conversation (Anthropic MCP directory requirement, 2026-07).
const ACCOUNT_BOOTSTRAP_TOOLS = new Set([
  "didit_account_register",
  "didit_account_verify_email",
  "didit_account_resend_otp",
  "didit_account_login",
]);

// These tools remain available in local/stdio contexts, but should not be part
// of the authenticated ChatGPT app catalog because public app review disallows
// digital-credit checkout flows and live credential/secret exposure.
const HOSTED_APP_EXCLUDED_TOOLS = new Set([
  ...ACCOUNT_BOOTSTRAP_TOOLS,
  "didit_org_reveal_application_api_key",
  "didit_org_top_up",
]);

// When a tool needs an org/app and the caller passed none (and the token carries none),
// auto-resolve the single org / single app so single-tenant users never have to pass or
// discover ids. Mutates the live request-context store (same object the resolvers read).
// Multi-org/app users fall through to the normal resolver error (which points to didit_context).
async function ensureScopeDefaults(name: string): Promise<void> {
  if (SCOPE_AGNOSTIC_TOOLS.has(name) || isPrivilegedToolName(name)) return;
  const store = requestContext.getStore();
  if (!store?.accessToken) return; // no Bearer (env-default scope) — resolver will surface the error
  if (store.organizationId && store.applicationId) return;
  try {
    const map = await getOrgAppMap();
    if (!store.organizationId && map.length === 1) store.organizationId = map[0].orgId;
    if (!store.applicationId) {
      // Candidates = the applications of the org already pinned in context, or - when no org
      // is pinned - every application the caller owns. ONE candidate is unambiguous even when
      // it is spread over several organizations: an org that holds no application cannot make
      // the choice ambiguous, and didit_context_get already advertises exactly that app as
      // `default_application_id`. Requiring a single ORG here (the pre-DID-2113 rule) is what
      // made didit_lists_list / didit_webhook_list answer "application_id is required" to a
      // caller whose context call had just named the default application.
      const scoped = store.organizationId
        ? map.filter((o) => o.orgId === store.organizationId)
        : map;
      // An org whose applications failed to list is UNKNOWN, not empty - it could hold the
      // second candidate, so never call the count unambiguous while one is blind.
      const blind = scoped.some((o) => o.appsError);
      const candidates = scoped.flatMap((o) => o.apps.map((a) => ({ orgId: o.orgId, appId: a.appId })));
      if (!blind && candidates.length === 1) {
        store.applicationId = candidates[0].appId;
        // The console path needs BOTH ids, and they must be the same pair: adopt the org that
        // actually owns the resolved app rather than leaving the org for the resolver to fail on.
        store.organizationId = candidates[0].orgId;
      }
    }
  } catch {
    /* discovery failed — let the normal resolver surface the actionable error */
  }
}

// Per-app list tools that have a cross-org/app aggregate sibling. A multi-tenant caller who
// invokes one of these without a resolvable scope would otherwise hit "organization_id is
// required". Instead we transparently span every app (identical to the matching *_search tool:
// newest-first, each row attributed to its org/app), so a general "list my sessions" by a
// multi-app user succeeds on the FIRST call rather than erroring then recovering.
const AGGREGATE_FALLBACK: Record<string, (a: Record<string, any>) => Promise<any>> = {
  didit_session_list: search.searchSessions,
  didit_transaction_list: search.searchTransactions,
  didit_case_list: search.searchCases,
  didit_vendor_user_list: search.searchVendorUsers,
  didit_vendor_business_list: search.searchVendorBusinesses,
  didit_workflow_list: search.searchWorkflows,
};

// The aggregate to run in place of a per-app list when scope is unresolved; undefined when the
// caller is fully scoped (org+app present) and the real single-app list should run.
function aggregateFallbackFor(name: string): ((a: Record<string, any>) => Promise<any>) | undefined {
  const fn = AGGREGATE_FALLBACK[name];
  if (!fn) return undefined;
  const store = requestContext.getStore();
  if (store?.organizationId && store?.applicationId) return undefined;
  return fn;
}

// MCP tool annotations. Claude's connector "Tool permissions" UI groups tools into
// "Read-only" / "Write" / "Destructive" categories from readOnlyHint + destructiveHint —
// WITHOUT them every tool collapses into one undifferentiated "Other tools" bucket (which
// is exactly what GitHub/Linear/Sentry avoid by annotating their tools). Derived from the
// domain-first name (whole-token match, so the "lists"/"blocklist" domains don't read as
// the "list" verb) — maintenance-free as tools are added.
const READ_VERB_TOKENS = new Set([
  "list", "get", "search", "statistics", "analytics", "export", "pdf", "validate", "backtest",
]);
const DESTRUCTIVE_VERB_TOKENS = new Set(["delete", "remove", "uninstall"]);
function toolTitle(name: string): string {
  return name
    .replace(/^didit_/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
// Tools that are destructive/high-impact by SEMANTICS, not by a delete/remove verb in the
// name: revealing a live secret, moving money, and case management (SAR/dispose).
const EXPLICIT_DESTRUCTIVE_TOOLS = new Set([
  "didit_org_reveal_application_api_key",
  "didit_org_top_up",
  "didit_case_manage",
]);

// Tools that can reach outside the current Didit workspace/account boundary by
// sending email/SMS, creating third-party checkout, registering webhook delivery
// endpoints, or sharing verification data with a partner.
const EXPLICIT_OPEN_WORLD_TOOLS = new Set([
  "didit_account_register",
  "didit_account_resend_otp",
  "didit_org_invite_member",
  "didit_org_top_up",
  "didit_session_share",
  "didit_session_update_status",
  "didit_travel_rule_transfer_action",
  "didit_verify_email_send",
  "didit_verify_phone_send",
  "didit_webhook_create",
  "didit_webhook_update",
]);

// These tools have names that include read-like tokens, but their handlers
// create server-side artifacts/jobs rather than strictly retrieving data.
const EXPLICIT_WRITE_TOOLS = new Set([
  "didit_report_export",
  "didit_session_generate_pdf",
]);

// The inverse: tools whose names carry no read-like token but whose handlers never
// change server state (requirements/workflow-check are deterministic reads over the
// stored profile + knowledge base; interview/next is pure computation; generate_workflow
// computes and returns a graph WITHOUT persisting anything — the backend view only
// requires read:workflows, and applying the graph goes through the didit_workflow_* writes).
const EXPLICIT_READ_TOOLS = new Set([
  "didit_compliance_requirements",
  "didit_compliance_check_workflow",
  "didit_compliance_interview_next",
  "didit_compliance_generate_workflow",
  // build_graph computes a graph from a plain feature spec, persisting nothing.
  "didit_workflow_build_graph",
]);

function annotationsFor(name: string): {
  title: string;
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint: boolean;
} {
  const tokens = name.replace(/^didit_/, "").split("_");
  const title = toolTitle(name);
  const openWorldHint = EXPLICIT_OPEN_WORLD_TOOLS.has(name);
  if (EXPLICIT_DESTRUCTIVE_TOOLS.has(name) || tokens.some((t) => DESTRUCTIVE_VERB_TOKENS.has(t))) {
    return { title, readOnlyHint: false, openWorldHint, destructiveHint: true };
  }
  if (EXPLICIT_WRITE_TOOLS.has(name)) {
    return { title, readOnlyHint: false, openWorldHint, destructiveHint: false };
  }
  if (EXPLICIT_READ_TOOLS.has(name)) {
    return { title, readOnlyHint: true, openWorldHint, destructiveHint: false };
  }
  // Verification APIs (didit_verify_*) are billable POST actions — keep them as writes even
  // when the action token reads like a query (kyb_search / face_search).
  const isBillableAction = name.startsWith("didit_verify_");
  if (!isBillableAction && tokens.some((t) => READ_VERB_TOKENS.has(t))) {
    return { title, readOnlyHint: true, openWorldHint, destructiveHint: false };
  }
  return { title, readOnlyHint: false, openWorldHint, destructiveHint: false };
}

/**
 * Build a fully-wired MCP server (tool list + dispatch). A factory rather than a
 * singleton because the stateless Streamable-HTTP transport needs a fresh server
 * instance per request, while stdio uses exactly one. Both share this definition.
 *
 * `hosted: true` marks a remote (Streamable-HTTP / OAuth) server. Hosted servers never
 * expose the account-bootstrap tools (credentials must not travel through a remote
 * conversation) and never honor the DIDIT_IS_STAFF env override (a deployment-wide env
 * var would grant the staff surface to every remote caller; only per-token introspection
 * can mark a hosted caller privileged). The stdio server keeps both conveniences.
 *
 * `profile` selects the catalog served (see catalog-profiles.ts): `full` (default) or `chatgpt`,
 * the reduced allow-list the hosted server exposes at /mcp/chatgpt for the ChatGPT app store.
 */
export function createServer(options: { hosted?: boolean; profile?: CatalogProfile } = {}): Server {
  const hosted = options.hosted === true;
  const profile: CatalogProfile = options.profile ?? "full";
  const server = new Server(
    { name: "didit", version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
  // Privileged operational tools are emitted ONLY to privileged connections; everyone else never
  // sees them in tools/list (and a call is rejected below). In the open-source build there are none.
  const isPrivileged = isPrivilegedCaller(extra?.authInfo, { hosted });
  const tools = [
    // ── Auth ────────────────────────────────────────────────────────────
    {
      name: "didit_account_register",
      description: "Register a new Didit account. A 6-character verification code is sent to the email. Follow up with didit_account_verify_email.",
      inputSchema: {
        type: "object" as const,
        properties: {
          email: { type: "string", description: "Email address" },
          password: { type: "string", description: "Password (min 8 chars, must include uppercase, lowercase, digit, special char)" },
        },
        required: ["email", "password"],
      },
    },
    {
      name: "didit_account_verify_email",
      description: "Verify email with the 6-character code. Returns access_token, refresh_token, organization, application (with client_id and api_key).",
      inputSchema: {
        type: "object" as const,
        properties: {
          email: { type: "string" },
          code: { type: "string", description: "6-character alphanumeric code from email" },
        },
        required: ["email", "code"],
      },
    },
    {
      name: "didit_account_resend_otp",
      description: "Resend the 6-character email verification code for a pending registration. Codes expire after 10 minutes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          email: { type: "string", description: "Email address the code was originally sent to" },
        },
        required: ["email"],
      },
    },
    {
      name: "didit_account_login",
      description: "Login to existing Didit account. Returns access_token and refresh_token.",
      inputSchema: {
        type: "object" as const,
        properties: {
          email: { type: "string" },
          password: { type: "string" },
        },
        required: ["email", "password"],
      },
    },
    {
      name: "didit_org_list",
      description: "List the organizations you belong to (each has an id to pass as organization_id to other tools). In hosted OAuth mode no arguments are needed; in stdio mode pass access_token from login/verify_email.",
      inputSchema: {
        type: "object" as const,
        properties: {
          access_token: { type: "string", description: "Only for stdio mode — Bearer access token from login/verify_email. Omit in hosted OAuth mode." },
        },
      },
    },
    {
      name: "didit_org_list_applications",
      description: "List the applications in an organization (each has an id to pass as application_id). In hosted OAuth mode pass only organization_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: { type: "string", description: "Organization UUID (from didit_org_list)" },
          access_token: { type: "string", description: "Only for stdio mode. Omit in hosted OAuth mode." },
        },
        required: ["organization_id"],
      },
    },
    {
      name: "didit_org_get_application",
      description: "Get application details (client_id etc.). The api_key is REDACTED — a masked preview + api_key_set flag are returned, never the raw secret.",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: { type: "string" },
          application_id: { type: "string" },
          access_token: { type: "string", description: "Only for stdio mode. Omit in hosted OAuth mode." },
        },
        required: ["organization_id", "application_id"],
      },
    },
    {
      name: "didit_org_reveal_application_api_key",
      description: "Return the RAW, un-redacted api_key for an application. This exposes a LIVE SECRET — only call when a human explicitly needs the key to integrate; never log or persist it. Requires confirm:true AND an explicit organization_id + application_id (no defaults).",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: { type: "string", description: "REQUIRED. No env/context default for this raw-secret tool." },
          application_id: { type: "string", description: "REQUIRED. No env/context default for this raw-secret tool." },
          confirm: { type: "boolean", description: "REQUIRED. Must be true to expose the raw key. Only set after explicit user confirmation of this exact action." },
          access_token: { type: "string", description: "Only for stdio mode." },
        },
        required: ["organization_id", "application_id", "confirm"],
      },
    },

    // ── Context + cross-org/app aggregate search ────────────────────────
    {
      name: "didit_context_get",
      description:
        "Return ALL organizations you can access with their applications nested, plus the default org/app when unambiguous — in ONE call (replaces didit_org_list + per-org didit_org_list_applications). Call this first to discover ids.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "didit_session_search",
      description: `Search verification sessions ACROSS ALL your apps and organizations in a single call — the efficient way to answer "the last 5 in-review sessions across my apps". Aggregates server-side and returns newest matches first, each tagged with its organization/application. Omit organization_id/application_id to span everything; pass them to narrow scope. status accepts: ${SESSION_STATUSES}.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          status: { type: "string", description: `Filter by session status (${SESSION_STATUSES})` },
          session_kind: { type: "string", enum: ["user", "business", "all"], description: "KYC (user), KYB (business), or all" },
          workflow_id: { type: "string", description: "Filter by workflow UUID" },
          search: { type: "string", description: "Free-text search" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging across apps (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_transaction_search",
      description:
        "Search transaction-monitoring (AML) transactions ACROSS ALL your apps and organizations in one call. Omit organization_id/application_id to span everything; pass them to narrow. Returns newest first, each tagged with its org/app.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: { type: "string", description: "Filter by transaction status" },
          search: { type: "string", description: "Free-text search" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_case_search",
      description:
        "Search case-management cases ACROSS ALL your apps and organizations in one call. Omit organization_id/application_id to span everything; pass them to narrow. Returns newest first, each tagged with its org/app.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: { type: "string", description: "Filter by case status" },
          search: { type: "string", description: "Free-text search" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_vendor_user_search",
      description:
        "Find vendor users (your end customers) ACROSS ALL your apps and organizations in one call — e.g. locate a customer by vendor_data/email/name without knowing which app they're in. Omit organization_id/application_id to span everything; pass them to narrow. Each hit is tagged with its org/app.",
      inputSchema: {
        type: "object" as const,
        properties: {
          search: { type: "string", description: "Free-text search (name, email, vendor_data)" },
          vendor_data: { type: "string", description: "Filter by your customer identifier" },
          status: { type: "string", description: "Filter by vendor-user status" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_vendor_business_search",
      description:
        "Find vendor businesses (KYB companies) ACROSS ALL your apps and organizations in one call. Omit organization_id/application_id to span everything; pass them to narrow. Each hit is tagged with its org/app.",
      inputSchema: {
        type: "object" as const,
        properties: {
          search: { type: "string", description: "Free-text search (company name, registration number, vendor_data)" },
          vendor_data: { type: "string", description: "Filter by your business identifier" },
          status: { type: "string", description: "Filter by vendor-business status" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          ...LAST_N_DAYS_PROP,
          limit: { type: "number", description: "Max results after merging (default 20, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_analytics",
      description:
        "Aggregate verification analytics ACROSS ALL your apps and organizations in one call — the efficient way to answer questions like \"how many people tried phone verification but dropped off in the last 15 days?\". Returns summed status counts (request_breakdown), a feature_funnel (how many sessions REACHED each step, e.g. PHONE_VERIFICATION), and a recomputed conversion_rate, for a date window. Omit organization_id/application_id to span everything; pass them to narrow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          date_from: { type: "string", description: "ISO date lower bound (YYYY-MM-DD)" },
          date_to: { type: "string", description: "ISO date upper bound (YYYY-MM-DD)" },
          ...LAST_N_DAYS_PROP,
          include_timeseries: { type: "boolean", description: "Also return per-day time series (heavier). Default false." },
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_network_list",
      description:
        "List fraud Networks for one application, with the same filters and KPI aggregate block as the console Networks page. Requires the user's role to have list:networks; pass organization_id/application_id from didit_context_get unless your token/defaults are already scoped.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: { type: "string", enum: NETWORK_STATUSES, description: "Network lifecycle status" },
          signal_type: { type: "string", enum: NETWORK_SIGNAL_TYPES, description: "Filter by one shared signal type" },
          pattern_type: { type: "string", enum: NETWORK_PATTERN_TYPES, description: "Filter by one network pattern type" },
          risk_band: { type: "string", enum: NETWORK_RISK_BANDS, description: "Filter by risk band" },
          min_size: { type: "number", description: "Minimum total members" },
          max_size: { type: "number", description: "Maximum total members" },
          date_from: { type: "string", description: "ISO date/datetime lower bound for last activity" },
          date_to: { type: "string", description: "ISO date/datetime upper bound for first activity" },
          q: { type: "string", description: "Search by network id/name, member name, or pattern" },
          ordering: {
            type: "string",
            enum: ["risk_score", "-risk_score", "last_activity_at", "-last_activity_at", "first_activity_at", "-first_activity_at", "network_number", "-network_number"],
            description: "Ordering used by the console endpoint",
          },
          limit: { type: "number", description: "Page size (default backend limit, max enforced by backend)" },
          offset: { type: "number", description: "Pagination offset" },
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_network_get",
      description:
        "Read one fraud Network from the console API. Returns the detail row plus included sections; include defaults to members and signals. Graph/map/timeline are optional. Cross-organization insights are deliberately not exposed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          network_id: { type: "string", description: "Network UUID" },
          include: {
            type: "array",
            items: { type: "string", enum: NETWORK_DETAIL_INCLUDES },
            description: "Optional sections to include: graph, members, signals, timeline, map. Defaults to [members, signals]. Pass [] for detail only.",
          },
          depth: { type: "string", enum: ["1", "2", "3", "all"], description: "Graph depth when include contains graph" },
          focus_kind: { type: "string", enum: ["user", "business"], description: "Graph focus subject kind; supply with focus_id" },
          focus_id: { type: "string", description: "Graph focus subject UUID; supply with focus_kind" },
          ...ORG_APP_PROPS,
        },
        required: ["network_id"],
      },
    },
    {
      name: "didit_network_membership_get",
      description:
        "Read fraud-network memberships for one subject from the console API. The subject can be a verification session, business session, vendor user, vendor business, or transaction. Requires read:networks.",
      inputSchema: {
        type: "object" as const,
        properties: {
          subject_kind: { type: "string", enum: NETWORK_SUBJECT_KINDS, description: "Subject route to resolve" },
          subject_id: { type: "string", description: "Subject UUID for the selected kind" },
          ...ORG_APP_PROPS,
        },
        required: ["subject_kind", "subject_id"],
      },
    },

    // ── Sessions ────────────────────────────────────────────────────────
    {
      name: "didit_session_create",
      description: "Create a verification session. Requires workflow_id (created in the Console Workflows page) — the workflow defines which steps run and whether the session is KYC or KYB. Returns session_id, url, and session_token.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_id: { type: "string", description: "REQUIRED. UUID of the workflow that defines the verification steps. Selects KYC vs KYB implicitly." },
          vendor_data: { type: "string", description: "Your unique identifier for the user (e.g. user ID). Used to group sessions into a user/business." },
          callback: { type: "string", description: "URL to redirect the user to after verification" },
          callback_method: { type: "string", enum: ["initiator", "completer", "both"], description: "Which device/flow the callback applies to" },
          language: { type: "string", enum: LANGUAGE_CODES, description: "Pre-set the verification UI language (ISO code)" },
          sandbox_scenario: { type: "string", description: "SANDBOX ONLY (an application whose mode is 'sandbox' — see didit_context_get): predefine the outcome instead of running real providers, so the session is never billed. Slugs are 'approve', 'decline_*' (e.g. decline_aml_hit, decline_document_expired, decline_kyb_registry_mismatch) and 'review_*' (e.g. review_aml_possible_match). Ignored by a live application, where every session IS billed." },
          metadata: { type: "object", description: "Arbitrary JSON stored on the session and echoed in webhooks" },
          contact_details: { type: "object", description: "Pre-fill contact info (e.g. email, phone) for the session" },
          expected_details: { type: "object", description: "Expected values to validate against (e.g. expected country, IP)" },
          portrait_image: { type: "string", description: "Base64 or URL reference portrait for Biometric Authentication / Face-Match-first workflows. Optional when the vendor_data user already has a stored face (approved liveness face, ePassport photo, document portrait, or enrolled profile face) - the stored face is reused automatically; 400 if neither is available" },
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_session_list",
      description: `List verification sessions for ONE app. If you have multiple apps (or pass no scope) this automatically spans every app, newest first — but didit_session_search is the canonical cross-app tool and what to reach for to answer "my last N sessions". status accepts session-level values: ${SESSION_STATUSES}.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          status: { type: "string", description: `Filter by session status (${SESSION_STATUSES})` },
          session_kind: { type: "string", enum: ["user", "business", "all"], description: "KYC (user), KYB (business), or all" },
          vendor_data: { type: "string", description: "Filter by vendor_data" },
          workflow_id: { type: "string", description: "Filter by workflow UUID" },
          search: { type: "string", description: "Free-text search" },
          date_from: { type: "string", description: "ISO date lower bound" },
          date_to: { type: "string", description: "ISO date upper bound" },
          limit: { type: "string", description: "Page size (LimitOffset pagination)" },
          offset: { type: "string", description: "Pagination offset" },
        },
      },
    },
    {
      name: "didit_session_get_decision",
      description: "Get the full verification decision and all extracted data for a session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Session UUID" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "didit_session_update_status",
      description: "Approve, decline, or request resubmission of a session. For resubmission, pass new_status='Resubmitted' and nodes_to_resubmit; already-approved steps are kept.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          new_status: { type: "string", enum: ["Approved", "Declined", "Resubmitted"], description: "New decision status" },
          comment: { type: "string", description: "Reviewer note stored on the audit trail" },
          nodes_to_resubmit: { type: "array", items: { type: "string" }, description: "Node IDs the user must redo (only for Resubmitted)" },
          send_email: { type: "boolean", description: "Email the user about the status change" },
          email_address: { type: "string", description: "Override the recipient email" },
          email_language: { type: "string", description: "Language for the notification email" },
        },
        required: ["session_id", "new_status"],
      },
    },
    {
      name: "didit_session_update_data",
      description: "Correct the KYC data extracted from the ID document on a session (reviewer override). Only send the fields you want to change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          document_type: { type: "string", enum: DOCUMENT_TYPES },
          document_subtype: { type: "string" },
          document_number: { type: "string" },
          personal_number: { type: "string" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD" },
          date_of_issue: { type: "string", description: "YYYY-MM-DD" },
          expiration_date: { type: "string", description: "YYYY-MM-DD" },
          issuing_state: { type: "string", description: "ISO 3166-1 alpha-3 issuing country" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          gender: { type: "string", enum: ["M", "F", "U"] },
          address: { type: "string" },
          place_of_birth: { type: "string" },
          nationality: { type: "string" },
          marital_status: { type: "string", enum: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "UNKNOWN"] },
          extra_fields: { type: "object", description: "Document-specific extra fields" },
          parsed_address: { type: "object", description: "Structured address override" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "didit_session_update_poa_data",
      description: "Correct the Proof of Address data extracted from the POA document on a session (reviewer override). Only send the fields you want to change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          issuing_state: { type: "string", description: "ISO 3166-1 alpha-3 issuing country" },
          document_type: { type: "string", enum: ["UTILITY_BILL", "BANK_STATEMENT", "GOVERNMENT_ISSUED_DOCUMENT", "OTHER_POA_DOCUMENT", "UNKNOWN"] },
          document_language: { type: "string" },
          issuer: { type: "string" },
          issue_date: { type: "string", description: "YYYY-MM-DD" },
          poa_address: { type: "string" },
          name_on_document: { type: "string" },
          extra_fields: { type: "object" },
          poa_parsed_address: { type: "object", description: "Structured address override" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "didit_session_delete",
      description: "Permanently and irreversibly delete a single verification session (KYC or KYB) - its verification data and stored media. Blocklist entries, issued share tokens, already-queued webhook deliveries, consumed credits, and the parent user/business are not affected. Requires confirm:true - only pass it after the user has explicitly confirmed this exact deletion.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          confirm: { type: "boolean", description: "REQUIRED. Must be true - deletion is permanent and irreversible. Only set after explicit user confirmation of this exact action." },
        },
        required: ["session_id", "confirm"],
      },
    },
    {
      name: "didit_session_batch_delete",
      description: "Permanently and irreversibly delete multiple KYC sessions by session number, or EVERY KYC session in the application with delete_all:true (KYB sessions are never touched; delete those individually). Requires confirm:true - only pass it after the user has explicitly confirmed this exact deletion.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_numbers: {
            type: "array",
            items: { type: "number" },
            description: "Array of session numbers to delete",
          },
          delete_all: { type: "boolean", description: "Set true to delete ALL sessions (ignores session_numbers)" },
          confirm: { type: "boolean", description: "REQUIRED. Must be true - deletion is permanent and irreversible. Only set after explicit user confirmation of this exact action." },
        },
        required: ["confirm"],
      },
    },
    {
      name: "didit_session_generate_pdf",
      description: "Generate a PDF verification report for a session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "didit_session_list_reviews",
      description: "List the review history and activity log for a session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "didit_session_add_review",
      description: "Add a review note to a session's audit trail, optionally changing its status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          session_id: { type: "string" },
          comment: { type: "string", description: "Review comment or note" },
          new_status: {
            type: "string",
            enum: ["Not Started", "In Progress", "Approved", "Declined", "In Review", "Expired", "Abandoned", "Kyc Expired", "Resubmitted", "Awaiting User"],
            description: "Optional new session status to record with the note",
          },
        },
        required: ["session_id"],
      },
    },
    {
      name: "didit_session_share",
      description: "Share a verified session with a trusted partner for reusable KYC (B2B session sharing).",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          partner_client_id: { type: "string", description: "The partner application's client_id" },
        },
        required: ["session_id", "partner_client_id"],
      },
    },
    {
      name: "didit_session_import_shared",
      description: "Import a shared verification session from a partner (Reusable KYC).",
      inputSchema: {
        type: "object" as const,
        properties: {
          share_token: { type: "string", description: "Token received from the sharing partner" },
        },
        required: ["share_token"],
      },
    },

    // ── Session Imports (bulk migration) ────────────────────────────────
    {
      name: "didit_session_create_import",
      description: "Create a bulk import job from a hosted CSV/NDJSON file (e.g. migrating historical verifications into Didit). Pass source_file_url. All imports use Didit's canonical schema. To label a record's source, include the optional per-row `provider` column in the file itself (defaults to generic) — there is no provider request field.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source_file_url: { type: "string", description: "REQUIRED. Publicly fetchable URL of the CSV/NDJSON file to import." },
          import_type: { type: "string", enum: ["user_verification", "business_verification", "status_rules", "transactions"], description: "What the rows represent (default user_verification)" },
          source_format: { type: "string", enum: ["csv", "ndjson"], description: "File format (default csv)" },
          workflow_id: { type: "string", description: "Workflow to associate imported sessions with" },
        },
        required: ["source_file_url"],
      },
    },
    {
      name: "didit_session_get_import_template",
      description: "Download the canonical import template (column headers and format) used by didit_session_create_import.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "didit_session_get_import",
      description: "Get the status and summary of a bulk import job.",
      inputSchema: {
        type: "object" as const,
        properties: {
          import_id: { type: "string", description: "Import job ID returned by didit_session_create_import" },
        },
        required: ["import_id"],
      },
    },
    {
      name: "didit_session_get_import_errors",
      description: "List per-row errors for a bulk import job (rows that failed validation or processing).",
      inputSchema: {
        type: "object" as const,
        properties: {
          import_id: { type: "string", description: "Import job ID" },
        },
        required: ["import_id"],
      },
    },

    // ── Workflows (Verification Settings) ───────────────────────────────
    {
      name: "didit_workflow_list",
      description: "List verification workflows. With multiple apps (or no scope) it auto-spans every app, each row tagged with its org/app. To find one workflow by id/label across all apps, prefer didit_workflow_search. The `features` on a row do NOT tell you whether a workflow checks age: age assurance done from the DOCUMENT (age restrictions on the OCR step) shows no feature of its own. For any question about which workflows do age assurance, pass `include_age_assurance:true` — it annotates each row with `does_age_assurance`/`methods` server-side, which is the only reliable way to find them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          include_age_assurance: {
            type: "boolean",
            description: "Annotate each non-archived row with whether it does age assurance, and how. Required to find workflows that check age from the document.",
          },
        },
      },
    },
    {
      name: "didit_workflow_create",
      description: "Create a SIMPLE (linear) verification workflow from an ordered list of features. Send `features` in execution order (uppercase values; put dependency features first, e.g. OCR before FACE_MATCH/NFC/DATABASE_VALIDATION). The MCP assembles them into a real workflow graph and publishes it; pass status:'draft' to keep it unpublished. A bad feature order fails validation and leaves a fixable draft. A workflow verifies EITHER a person (KYC) or a business (KYB), never both, and the type follows WHO is verified: KYB workflows use the KYB_* features (company paperwork belongs in KYB_DOCUMENTS or DOCUMENT_AI) and must not mix in person-only features (OCR/LIVENESS/FACE_MATCH/NFC/PROOF_OF_ADDRESS/DATABASE_VALIDATION/AGE_ESTIMATION); to verify the people behind a company, create a separate KYC workflow and link it from the KYB_KEY_PEOPLE node. For BRANCHING or conditional logic, use the graph tools instead: didit_workflow_get_field_definitions, then didit_workflow_validate_graph, then didit_workflow_set_graph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_label: { type: "string", description: "Display name (max 50 chars)" },
          features: {
            type: "array",
            minItems: 1,
            items: WORKFLOW_FEATURE_ITEM,
            description: "Verification features in execution order. Each: { feature, config?, label? }. Example: [{\"feature\":\"OCR\"},{\"feature\":\"LIVENESS\",\"config\":{\"face_liveness_method\":\"PASSIVE\"}},{\"feature\":\"FACE_MATCH\"}]",
          },
          is_default: { type: "boolean", description: "Set as default workflow for new sessions" },
          status: { type: "string", enum: ["draft", "published"], description: "Omit to publish immediately; 'draft' saves without publishing" },
          is_white_label_enabled: { type: "boolean" },
          is_desktop_allowed: { type: "boolean" },
          max_retry_attempts: { type: "number" },
          retry_window_days: { type: "number" },
          session_expiration_time: { type: "number" },
        },
        required: ["features"],
      },
    },
    {
      name: "didit_workflow_get",
      description:
        "Get the full configuration of a specific workflow, including `response_attributes` " +
        "(returned data / data minimization): which data points the client receives per feature.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_id: { type: "string", description: "Workflow UUID" },
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_workflow_update",
      description: "Update a workflow's top-level SETTINGS only (workflow_label, is_default, retry/expiration, white-label, etc.). Omitted status preserves the current draft/published state; publication changes only when status is explicitly passed. It does NOT change which features run: to add/remove/reorder features, add a conditional branch, or add a Document-AI step, edit the graph with didit_workflow_edit_graph (small ops, preserves the big allow-lists) or didit_workflow_set_graph (full replace) — those are the only ways feature changes actually persist.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_id: { type: "string", description: "Workflow UUID" },
          workflow_label: { type: "string" },
          features: {
            type: "array",
            items: WORKFLOW_FEATURE_ITEM,
            description: "Replacement feature list in execution order (same shape as create)",
          },
          is_default: { type: "boolean" },
          status: { type: "string", enum: ["draft", "published"] },
          is_white_label_enabled: { type: "boolean" },
          is_desktop_allowed: { type: "boolean" },
          max_retry_attempts: { type: "number" },
          retry_window_days: { type: "number" },
          session_expiration_time: { type: "number" },
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_workflow_delete",
      description: "Delete a draft verification workflow. If the API forbids deletion (including an only or published version), archive it instead. Existing sessions using it are not affected.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_id: { type: "string", description: "Workflow UUID" },
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_workflow_search",
      description: "Find verification workflows ACROSS ALL your apps/orgs in one call. Pass `workflow_id` to locate a specific workflow by its version uuid OR stable workflow_id (returns which org/app it lives in), or `search` to match by label. Use this instead of guessing the application when you only have a workflow id. `search` matches the LABEL ONLY: a CAPABILITY (age assurance, AML screening, …) is not searchable by name — for age assurance use didit_workflow_list with `include_age_assurance:true`, which reports what each workflow actually does.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Match a specific workflow by version uuid or stable workflow_id" },
          search: { type: "string", description: "Case-insensitive substring match on the workflow label" },
          limit: { type: "number", description: "Max results after merging (default 50, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_workflow_get_graph",
      description: "Get the node/graph for a workflow (the structure: nodes, branches, conditions, Document-AI steps) + `status`/`version`/`is_editable`. Large feature configs (documents_allowed, poa_documents_allowed, phone countries) are SUMMARIZED by default so the response never overflows — set `include_config:true` for the raw config. Includes `returned_data` (response_attributes): the ONLY source of truth for what data the client/relying party receives in the API response and webhooks — never infer that from which features run. Also includes `age_assurance`: whether the workflow checks age, and by which method (document age restrictions and/or AGE_ESTIMATION) — decide that from this block, never from the workflow's name. Pass just `workflow_id`; the owning org/app is resolved automatically. To MODIFY the graph, prefer didit_workflow_edit_graph (small ops, no need to resend big configs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          include_config: { type: "boolean", description: "Return full feature configs verbatim (default false → summarized). Can be very large." },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_workflow_get_field_definitions",
      description: "List every field you can branch on plus the operators valid for each (e.g. kyc.status, kyc.extra_fields.profession with `fuzzy_match`, document_ai.<key>, aml.risk_score). Call this before building branch rules so the field/operator pairs are valid.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Any workflow in the target application (used to resolve the app). Its uuid or stable workflow_id from didit_workflow_search/list — NOT a label, slug or node id. An exact label is resolved when it matches exactly one workflow; otherwise the candidates are listed for you to pick." },
          feature: { type: "string", enum: WORKFLOW_FEATURES, description: "Return only fields for this feature to keep the response small" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_workflow_get_feature_config_schema",
      description:
        "The exact `config` object each workflow feature accepts - every key, its type, bounds, " +
        "default, accepted values and meaning. Generated from the backend serializers that validate " +
        "a save (contract " + FEATURE_CONFIG_CHECKSUM + "), so it is never out of date with the API. " +
        "Call it before configuring a feature you have not configured before, and whenever a config " +
        "key you set came back missing: a key outside this contract is dropped silently. Pass " +
        "`feature` for one feature (" + WORKFLOW_FEATURES.join(", ") + "), or omit it for all of them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          feature: {
            type: "string",
            enum: WORKFLOW_FEATURES,
            description: "Restrict the answer to one feature. Omit for the whole contract.",
          },
        },
      },
    },
    {
      name: "didit_workflow_get_id_verification_methods_catalog",
      description:
        "The ID Verification methods catalog: per country, whether non-doc lookup (the user types their " +
        "national ID number and we check the official government database) is offered, which " +
        "digital-identity wallets (MitID, BankID, itsme, ...) are offered, their availability " +
        "(`available` can be enabled, `coming_soon` cannot), the plain-language request and response " +
        "fields, and catalog prices. Read this BEFORE setting `methods` on an OCR node: a method or " +
        "wallet that is not available for the country is rejected on save. Wallets are an accept-list " +
        "(no ordering). Every non-document price except the document price is a placeholder until " +
        "the pricing catalog is published. Pass `country` (ISO3) to get one country's view.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Any workflow in the target application (used to resolve the app)" },
          country: { type: "string", description: "ISO 3166-1 alpha-3 code to narrow the catalog to one country (e.g. ZAF, DNK)" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_workflow_get_kyb_registry_catalog",
      description:
        "The KYB registry catalog: per country (ISO-2, unlike `methods`/`documents_allowed` which are " +
        "ISO-3), which company-data tiers the registries offer - `basic` (Lite: company profile), " +
        "`shareholders`, `ubo` (beneficial owners) - with their retail price per company selected, and " +
        "whether continuous registry monitoring is sold there (per company per year). Read this BEFORE " +
        "writing `kyb_registry_countries_config` with a tier other than `basic`, or switching " +
        "`kyb_registry_monitoring_enabled` on: a tier the country does not offer is rejected on save, and " +
        "monitoring only applies to countries at an ownership tier where it is available. A company the " +
        "applicant types in by hand is billed a flat fee instead. Without `countries` you get a summary " +
        "(counts, the countries with no registry, the Lite-only ones); pass `countries` for the exact " +
        "per-country table. Prices here are the catalog's retail prices, not placeholders.",
      inputSchema: {
        type: "object" as const,
        properties: {
          countries: {
            type: "array",
            items: { type: "string" },
            description: "ISO 3166-1 alpha-2 codes to narrow the catalog to (e.g. [\"ES\", \"DE\"]). Omit for the summary.",
          },
        },
      },
    },
    {
      name: "didit_workflow_get_branch_fields",
      description: "Given a candidate graph and a branch node, return the fields actually available at that point (only features that completed on every path reaching the branch, plus dynamically-derived Document-AI/questionnaire fields).",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          graph: {
            ...WORKFLOW_GRAPH_SCHEMA,
            description: "REQUIRED. The candidate graph to evaluate: the `graph` object returned by didit_workflow_get_graph / ui_workflow_get_graph (start_node + nodes), optionally with your unsaved edits applied.",
          },
          branch_node_id: { type: "string", description: "REQUIRED. The id of a branch node in that graph (a key of graph.nodes whose node_type is 'branch') — availability is evaluated at that point." },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id", "graph", "branch_node_id"],
      },
    },
    {
      name: "didit_workflow_validate_graph",
      description: "Dry-run validate a graph WITHOUT saving. Returns per-node errors (bad field/operator, missing dependency, branching on a field before its feature runs, etc.). Always validate before didit_workflow_set_graph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: {
            type: "string",
            description:
              "Workflow version uuid or stable workflow_id. OPTIONAL: omit to validate a graph for a workflow " +
              "that does not exist yet (an unsaved canvas); pass workflow_type instead when KYC/KYB matters.",
          },
          workflow_type: { type: "string", enum: ["kyc", "kyb"], description: "Segregation check for a not-yet-created workflow." },
          graph: WORKFLOW_GRAPH_SCHEMA,
          include_config: { type: "boolean", description: "Return the validated graph's full feature configs (default false summarizes large values)" },
          ...ORG_APP_PROPS,
        },
        required: ["graph"],
      },
    },
    {
      name: "didit_workflow_edit_graph",
      description: "MODIFY an existing workflow's graph with small OPERATIONS - the right tool for editing a live workflow. You send only the deltas; the MCP fetches the full current graph SERVER-SIDE, applies your ops in order, validates, auto-creates a DRAFT (the live version is never touched), and saves. This means huge feature configs (documents_allowed, poa_documents_allowed, phone countries) are preserved exactly and you NEVER resend them. Validation failures return `applied:false` with the errors (nothing saved). The six op shapes are documented on the `operations` parameter; a typical edit upserts new nodes with set_node and rewires their neighbors with set_next. To branch after a feature node, point its `next` at a new branch node whose `branches` carry the rules (from didit_workflow_get_field_definitions) and whose goto targets are new status or feature nodes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          operations: {
            type: "array",
            minItems: 1,
            description: "Ordered edits applied to the full server-side graph. Each: one of — {op:'set_node', node_id, node:{…}} upsert a node; {op:'remove_node', node_id}; {op:'set_next', node_id, next:'<id|null>'} rewire a node's unconditional next; {op:'set_branches', node_id, branches:[…]} set conditional branches; {op:'merge_node_config', node_id, config:{…}} shallow-merge config keys (preserves the big allow-lists); {op:'set_start', start_node}.",
            items: { type: "object", properties: { op: { type: "string", enum: ["set_node", "remove_node", "set_next", "set_branches", "merge_node_config", "set_start"] }, node_id: { type: "string" }, node: { type: "object" }, next: { type: ["string", "null"] }, branches: { type: "array", items: { type: "object" } }, config: { type: "object" }, start_node: { type: "string" } }, required: ["op"] },
          },
          publish: { type: "boolean", description: "Publish after saving (default false → leaves a reviewable DRAFT)" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id", "operations"],
      },
    },
    {
      name: "didit_workflow_set_graph",
      description: "Replace a workflow's ENTIRE node/graph. Use this only to build a NEW/small workflow from scratch — to modify an EXISTING workflow prefer didit_workflow_edit_graph (you'd otherwise have to resend every node incl. multi-100KB allow-lists). If the workflow is published, a DRAFT is auto-created and the graph applied there (a live version is NEVER mutated); reviewable DRAFT unless `publish:true`. Validate first. Example graph: OCR → branch[ kyc.status==Declined → status(Declined); kyc.extra_fields.profession fuzzy_match 'Software Engineer' score 80 → DOCUMENT_AI(proof of funds) → status(Determine) ; else → status(Determine) ].",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          graph: WORKFLOW_GRAPH_SCHEMA,
          publish: { type: "boolean", description: "Publish the draft after saving (default false → leaves a reviewable DRAFT)" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id", "graph"],
      },
    },
    {
      name: "didit_workflow_create_draft",
      description: "Create an editable DRAFT version from a published workflow (graph/config edits require a DRAFT). Returns the new draft's uuid.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_workflow_publish",
      description: "Publish the workflow version that holds the pending changes — makes it live for NEW sessions. Existing sessions are unaffected. Pass the `version_uuid` that set_graph/edit_graph returned: a published version can never hold an edit, so a stable workflow_id resolves to the version that is ALREADY live. Publishing a live version with no draft is refused instead of reported as done.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "The DRAFT version uuid to publish — the `version_uuid` returned by didit_workflow_set_graph / didit_workflow_edit_graph. A stable workflow_id also resolves, and then the draft holding the changes is published rather than the version already live." },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },

    // ── Questionnaires ──────────────────────────────────────────────────
    {
      name: "didit_questionnaire_list",
      description: "List all custom questionnaires for your application.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_questionnaire_create",
      description: "Create a custom questionnaire from an ordered list of questions. Send `title` + `form_elements` (an array of form-element objects, each with an UPPERCASE element_type) — NOT `questions`. The MCP assembles them into the questionnaire graph the backend stores (node ids and their ordering are derived here), so send the questions in the order the user should answer them and never build a graph yourself. Pass status:'draft' to keep it unpublished. A choice list longer than ~100 options does NOT fit in one call (the call is emitted token by token and gets cut off mid-JSON): create with status:'draft' carrying only the first ~100 choices, then add the rest with didit_questionnaire_append_choices in batches (its publish flag publishes with the final batch — a published questionnaire cannot be edited further).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          title: { type: "string", description: "Questionnaire title" },
          description: { type: "string", description: "Description shown to the user" },
          ...FORM_ELEMENTS_PROP,
          ...QUESTIONNAIRE_LANG_PROPS,
        },
        required: ["title", "form_elements"],
      },
    },
    {
      name: "didit_questionnaire_append_choices",
      description:
        "Append a batch of answer options to ONE question of an existing DRAFT questionnaire (create it with status:'draft' — a published questionnaire cannot be edited). Use it for long choice lists: create with the first ~100 choices, then append the rest here in batches of ~100 until the source list is exhausted, passing publish:true on the FINAL batch to publish. Choices the question already has (same value) are skipped, so retrying a batch never duplicates. Returns a compact summary whose total_choices is the stored count — verify against it instead of re-fetching the questionnaire.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
          node_id: {
            type: "string",
            description:
              "Graph node id of the question (e.g. 'q1', positional from the create call). Optional when exactly one question has choices.",
          },
          choices: {
            type: "array",
            items: { type: "object" },
            description:
              "Batch of choices to append, ~100 per call maximum. Each: { value, label?, requires_text_input? }",
          },
          publish: {
            type: "boolean",
            description:
              "Pass true on the LAST batch to publish the questionnaire; intermediate batches keep it a draft.",
          },
        },
        required: ["questionnaire_id", "choices"],
      },
    },
    {
      name: "didit_questionnaire_get",
      description: "Get questionnaire questions and options. Translations are summarized to one locale by default to keep the response consumable; pass include_translations:true for every locale.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
          include_translations: { type: "boolean", description: "Return every locale translation (default false returns English or the first available locale)" },
        },
        required: ["questionnaire_id"],
      },
    },
    {
      name: "didit_questionnaire_update",
      description: "Update a questionnaire's title, description, or form_elements (array of form-element objects with UPPERCASE element_type). Sending form_elements REPLACES the whole question list — pass every question you want to keep, in order.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
          title: { type: "string" },
          description: { type: "string" },
          ...FORM_ELEMENTS_PROP,
          ...QUESTIONNAIRE_LANG_PROPS,
        },
        required: ["questionnaire_id"],
      },
    },
    {
      name: "didit_questionnaire_delete",
      description: "Delete a questionnaire.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
        },
        required: ["questionnaire_id"],
      },
    },

    // ── Users (verified individuals / KYC) ──────────────────────────────
    {
      name: "didit_vendor_user_list",
      description: "List verified users (grouped by vendor_data) for ONE app; with multiple apps (or no scope) it auto-spans all your apps. For a cross-app customer lookup prefer didit_vendor_user_search. Supports limit/offset pagination.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          limit: { type: "string" },
          offset: { type: "string" },
        },
      },
    },
    {
      name: "didit_vendor_user_create",
      description: "Create a user record manually (e.g. to pre-register a vendor_data identity or attach allowlisted emails/phones).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "REQUIRED. Your unique identifier for the user" },
          full_name: { type: "string" },
          display_name: { type: "string" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD" },
          status: { type: "string", enum: ENTITY_STATUSES },
          metadata: { type: "object" },
          approved_emails: { type: "array", items: { type: "string" } },
          approved_phones: { type: "array", items: { type: "string" } },
          issuing_states: { type: "array", items: { type: "string" } },
        },
        required: ["vendor_data"],
      },
    },
    {
      name: "didit_vendor_user_get",
      description: "Get details of a specific user by their vendor_data identifier.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "The vendor_data value that identifies the user" },
        },
        required: ["vendor_data"],
      },
    },
    {
      name: "didit_vendor_user_update",
      description: "Update a user's profile fields. Only send the fields you want to change. To change ONLY the monitoring status, prefer didit_vendor_user_update_status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "The vendor_data value that identifies the user" },
          full_name: { type: "string" },
          display_name: { type: "string" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD" },
          status: { type: "string", enum: ENTITY_STATUSES, description: "Monitoring status" },
          metadata: { type: "object" },
          approved_emails: { type: "array", items: { type: "string" } },
          approved_phones: { type: "array", items: { type: "string" } },
          issuing_states: { type: "array", items: { type: "string" } },
        },
        required: ["vendor_data"],
      },
    },
    {
      name: "didit_vendor_user_update_status",
      description: "Set a user's monitoring status (ACTIVE, FLAGGED, or BLOCKED).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "The vendor_data value that identifies the user" },
          status: { type: "string", enum: ENTITY_STATUSES, description: "New status" },
        },
        required: ["vendor_data", "status"],
      },
    },
    {
      name: "didit_vendor_user_delete",
      description: "Batch delete users by vendor_data list, or delete all users.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data_list: {
            type: "array",
            items: { type: "string" },
            description: "Array of vendor_data values to delete",
          },
          delete_all: { type: "boolean", description: "Set true to delete ALL users" },
          confirm: {
            type: "boolean",
            description:
              "REQUIRED when delete_all is true - permanently removes EVERY vendor user. Only set after explicit user confirmation of this exact action.",
          },
        },
      },
    },

    // ── Businesses (KYB) ────────────────────────────────────────────────
    {
      name: "didit_vendor_business_list",
      description: "List verified businesses (KYB, grouped by vendor_data) for ONE app; with multiple apps (or no scope) it auto-spans all your apps. For a cross-app lookup prefer didit_vendor_business_search. Supports limit/offset pagination.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          limit: { type: "string" },
          offset: { type: "string" },
        },
      },
    },
    {
      name: "didit_vendor_business_create",
      description: "Create a business record manually (KYB).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "Your unique identifier for the business" },
          display_name: { type: "string" },
          legal_name: { type: "string" },
          registration_number: { type: "string" },
          country_code: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
          status: { type: "string", enum: ENTITY_STATUSES },
          metadata: { type: "object" },
        },
      },
    },
    {
      name: "didit_vendor_business_get",
      description: "Get details of a specific business by its vendor_data identifier.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "The vendor_data value that identifies the business" },
        },
        required: ["vendor_data"],
      },
    },
    {
      name: "didit_vendor_business_update",
      description: "Update a business's profile fields. Only send the fields you want to change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string" },
          display_name: { type: "string" },
          legal_name: { type: "string" },
          registration_number: { type: "string" },
          country_code: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
          status: { type: "string", enum: ENTITY_STATUSES },
          metadata: { type: "object" },
        },
        required: ["vendor_data"],
      },
    },
    {
      name: "didit_vendor_business_update_status",
      description: "Set a business's monitoring status (ACTIVE, FLAGGED, or BLOCKED).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string" },
          status: { type: "string", enum: ENTITY_STATUSES, description: "New status" },
        },
        required: ["vendor_data", "status"],
      },
    },
    {
      name: "didit_vendor_business_delete",
      description: "Batch delete businesses by vendor_data list and/or didit_internal_id list, or delete all businesses.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data_list: { type: "array", items: { type: "string" } },
          didit_internal_id_list: { type: "array", items: { type: "string" } },
          delete_all: { type: "boolean", description: "Set true to delete ALL businesses" },
          confirm: {
            type: "boolean",
            description:
              "REQUIRED when delete_all is true - permanently removes EVERY vendor business. Only set after explicit user confirmation of this exact action.",
          },
        },
      },
    },

    // ── Transactions (AML transaction monitoring) ───────────────────────
    {
      name: "didit_transaction_list",
      description: "List monitored transactions for ONE app; with multiple apps (or no scope) it auto-spans all your apps. For a cross-app query prefer didit_transaction_search. Supports limit/offset pagination.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          limit: { type: "string" },
          offset: { type: "string" },
        },
      },
    },
    {
      name: "didit_transaction_create",
      description: "Submit a transaction for monitoring and rule evaluation. transaction_details and subject shapes depend on transaction_category.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          transaction_id: { type: "string", description: "REQUIRED. Your unique transaction identifier" },
          transaction_category: {
            type: "string",
            enum: ["finance", "kyc", "travel_rule", "user_event", "audit_trail_event", "gambling_bet", "gambling_limit_change", "gambling_bonus_change"],
            description: "REQUIRED. Determines the expected transaction_details/subject shape",
          },
          transaction_details: { type: "object", description: "REQUIRED. Category-specific transaction payload" },
          subject: { type: "object", description: "REQUIRED. The party initiating the transaction (usually a vendor_data reference)" },
          counterparty: { type: "object", description: "The other party in the transaction" },
          transaction_at: { type: "string", description: "ISO timestamp of the transaction" },
          time_zone: { type: "string" },
          custom_properties: { type: "object", description: "Custom values keyed for monitoring rules (custom_values.<key>)" },
          travel_rule_details: { type: "object" },
          network_snapshot: { type: "object" },
          include_crypto_screening: { type: "boolean" },
        },
        required: ["transaction_id", "transaction_category", "transaction_details", "subject"],
      },
    },
    {
      name: "didit_transaction_get",
      description: "Get a single monitored transaction and its rule-evaluation result.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          transaction_id: { type: "string", description: "Transaction ID" },
        },
        required: ["transaction_id"],
      },
    },
    {
      name: "didit_transaction_screen_wallet",
      description:
        "Screen a single crypto wallet address for AML risk WITHOUT creating a transaction. Returns risk_score, severity, sanctions_hit, source/destination of funds. Requires transaction monitoring to be configured (a provider key) or returns 409.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          wallet_address: { type: "string", description: "REQUIRED. The crypto address to screen (must match the chain's address format)" },
          blockchain: {
            type: "string",
            enum: ["BTC", "ETH", "LTC", "XRP", "BCH", "DOGE", "TRX", "SOL", "MATIC", "BNB", "USDT", "USDC"],
            description: "REQUIRED. Asset / chain identifier",
          },
          direction: {
            type: "string",
            enum: ["inbound", "outbound", "deposit", "withdrawal"],
            description: "Optional screening direction context",
          },
        },
        required: ["wallet_address", "blockchain"],
      },
    },
    {
      name: "didit_transaction_sdk_token",
      description:
        "Mint a short-lived scoped token for client-side transaction submission (the Didit SDKs' submitTransaction). The token binds every submission to one end user (vendor_data) server-side.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "REQUIRED. Your internal identifier for the end user the token is scoped to" },
          ttl_seconds: { type: "number", description: "Token lifetime in seconds. Default 900 (15 min), max 86400 (24 h)" },
          max_uses: { type: "number", description: "Maximum successful submissions allowed. Omit for unlimited within the TTL" },
        },
        required: ["vendor_data"],
      },
    },
    {
      name: "didit_transaction_rule_list",
      description:
        "List transaction-monitoring rules for one app. Filter by source (PRESET or CUSTOM), category, mode " +
        "(ACTIVE evaluates and acts, TEST evaluates and records but skips actions, DISABLED is skipped), bundle, " +
        "or free-text search. ordering accepts one or more comma-separated fields; prefix a field with '-' to reverse it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          source: { type: "string", enum: ["PRESET", "CUSTOM"] },
          category: { type: "string" },
          mode: { type: "string", enum: ["ACTIVE", "DISABLED", "TEST"] },
          bundle: { type: "string" },
          search: { type: "string" },
          ordering: {
            type: "string",
            description:
              "Comma-separated fields from run_count, approved_pct, reviewed_pct, declined_pct, " +
              "latest_triggered_at, title, created_at, source. Prefix any field with '-' for descending order.",
          },
          limit: { type: "string" },
          offset: { type: "string" },
        },
      },
    },
    {
      name: "didit_transaction_rule_get",
      description:
        "Get one transaction-monitoring rule, including its persisted conditions, aggregation, scope, actions, and counters.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          rule_uuid: { type: "string", description: "REQUIRED. Rule UUID from didit_transaction_rule_list." },
        },
        required: ["rule_uuid"],
      },
    },
    {
      name: "didit_transaction_rule_create",
      description:
        "Create a CUSTOM transaction-monitoring rule. Include the entire requested persisted rule in this call: " +
        "conditions, aggregation checks, and actions. Backtest accepts a hypothetical config but never attaches " +
        "aggregation or actions to a created rule. Prefer mode:'TEST', backtest the exact saved config, then switch " +
        "to ACTIVE only after confirming the hit rate. title is unique among non-deleted rules in the app. " +
        "actions is REQUIRED: every outcome the user named (review, decline, approve, score, case) must appear " +
        "there; pass [] ONLY when the user explicitly wants a monitor-only rule that does nothing on match.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          title: { type: "string", description: "REQUIRED. Unique per application." },
          category: { type: "string", description: "REQUIRED. Rule category, e.g. finance or aml_ctf." },
          mode: {
            type: "string",
            enum: ["ACTIVE", "DISABLED", "TEST"],
            description: "REQUIRED. Prefer TEST for a new or materially changed rule.",
          },
          description: { type: "string" },
          ...RULE_EVALUATION_MODE_PROP,
          ...RULE_SCOPE_PROP,
          ...RULE_CONDITIONS_PROP,
          ...RULE_AGGREGATION_PROP,
          ...RULE_ACTIONS_PROP,
          metadata: { type: "object", description: "Free-form key/value metadata." },
        },
        required: ["title", "category", "mode", "actions"],
      },
    },
    {
      name: "didit_transaction_rule_update",
      description:
        "Partially update a transaction-monitoring rule. Send every changed persisted field in this PATCH. PRESET " +
        "rules only allow mode changes. Before raising impact, backtest the exact candidate config and keep the rule " +
        "in TEST until the result is acceptable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          rule_uuid: { type: "string", description: "REQUIRED. Rule UUID." },
          title: { type: "string" },
          category: { type: "string" },
          mode: { type: "string", enum: ["ACTIVE", "DISABLED", "TEST"] },
          description: { type: "string" },
          ...RULE_EVALUATION_MODE_PROP,
          ...RULE_SCOPE_PROP,
          ...RULE_CONDITIONS_PROP,
          ...RULE_AGGREGATION_PROP,
          ...RULE_ACTIONS_PROP,
          metadata: { type: "object" },
        },
        required: ["rule_uuid"],
      },
    },
    {
      name: "didit_transaction_rule_delete",
      description:
        "Delete a CUSTOM transaction-monitoring rule. PRESET rules must be removed with didit_transaction_rule_uninstall.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          rule_uuid: { type: "string", description: "REQUIRED. Rule UUID." },
        },
        required: ["rule_uuid"],
      },
    },
    {
      name: "didit_transaction_rule_backtest",
      description:
        "Dry-run a hypothetical rule config against up to the 10,000 most recent transactions in the app. This " +
        "writes nothing, accepts no rule_uuid, and never changes or completes a saved rule. To test a saved rule, " +
        "read it first and pass its exact conditions, aggregation, evaluation_mode, and scope here.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          ...RULE_CONDITIONS_PROP,
          ...RULE_AGGREGATION_PROP,
          ...RULE_EVALUATION_MODE_PROP,
          ...RULE_SCOPE_PROP,
          period_days: {
            type: "integer",
            minimum: 1,
            maximum: 365,
            description: "Days of history to evaluate, from 1 through 365. Default 90.",
          },
        },
      },
    },
    {
      name: "didit_transaction_rule_library_list",
      description:
        "List Didit's preset rule library. Each entry includes its full config, bundle, tags, industries, and is_installed. " +
        "Filter by bundle, category, or search; paginated.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          bundle: { type: "string" },
          category: { type: "string" },
          search: { type: "string" },
          limit: { type: "string" },
          offset: { type: "string" },
        },
      },
    },
    {
      name: "didit_transaction_rule_install",
      description:
        "Install PRESET rules by library_keys, bundle, or both. If both are supplied, only keys in that bundle are " +
        "installed. At least one selector is required. Installed rules start ACTIVE when transaction monitoring is " +
        "enabled for the app, otherwise DISABLED. Set TEST explicitly before relying on a newly installed rule.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          library_keys: {
            type: "array",
            items: { type: "string" },
            description: "Specific preset library_key values to install.",
          },
          bundle: { type: "string", description: "Install presets from this bundle." },
        },
        anyOf: [{ required: ["library_keys"] }, { required: ["bundle"] }],
      },
    },
    {
      name: "didit_transaction_rule_uninstall",
      description:
        "Remove installed PRESET rules by library_keys, bundle, or both. If both are supplied, only keys in that " +
        "bundle are removed. At least one selector is required. To pause without removing, update mode to DISABLED.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          library_keys: {
            type: "array",
            items: { type: "string" },
            description: "Specific preset library_key values to uninstall.",
          },
          bundle: { type: "string", description: "Uninstall presets from this bundle." },
        },
        anyOf: [{ required: ["library_keys"] }, { required: ["bundle"] }],
      },
    },

    // ── Travel Rule (FATF / EU TFR managed exchange) ─────────────────────
    {
      name: "didit_travel_rule_get_settings",
      description:
        "Get the application's Travel Rule settings: VASP profile, negotiation policy, proof-method toggles, disabled_networks, per-network modes (own/didit/off/unavailable), and your travel address.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_travel_rule_update_settings",
      description:
        "Update Travel Rule settings (partial update - send only fields to change). Enabling (is_enabled: true) requires a non-blank legal_name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          is_enabled: { type: "boolean", description: "Turn the managed exchange on/off for outbound travelRule transactions" },
          legal_name: { type: "string", description: "Your VASP's legal name (required to enable)" },
          lei: { type: "string", description: "Legal Entity Identifier" },
          jurisdiction: { type: "string", description: "Operating jurisdiction code, up to 8 chars (default EU)" },
          compliance_email: { type: "string" },
          is_discoverable: { type: "boolean", description: "Whether other Didit customers can find you in the VASP directory / reach you on the INTERNAL rail" },
          name_matching_strictness: { type: "string", enum: ["NONE", "STRICT", "DEFAULT", "FUZZY"] },
          confirmation_timeout_hours: { type: "number", description: "Hours before an AWAITING_COUNTERPARTY transfer auto-expires (min 1, default 48)" },
          timeout_outcome: { type: "string", enum: ["HOLD", "REJECT", "PROCEED"], description: "What happens to the transaction when a transfer expires" },
          threshold_amount: { type: "string", description: "Minimum amount that triggers an exchange (decimal string; default 0.00 = every transfer, per EU TFR)" },
          inbound_auto_accept: { type: "boolean" },
          allow_self_declaration: { type: "boolean", description: "Offer self-declaration as a wallet-ownership proof method" },
          allow_screenshot_proof: { type: "boolean", description: "Offer screenshot upload as a wallet-ownership proof method" },
          auto_wallet_verification: { type: "boolean", description: "Auto-mint a wallet-ownership widget when a transfer needs end-user proof (default true)" },
          vasp_attribution_enabled: { type: "boolean", description: "Resolve unroutable destination wallets via blockchain analytics (default true)" },
          disabled_networks: {
            type: "array",
            items: { type: "string", enum: ["GTR", "TRUST", "VERIFYVASP", "SYGNA"] },
            description: "Network rails to opt out of Didit's platform membership (your own connected memberships are unaffected)",
          },
        },
      },
    },
    {
      name: "didit_travel_rule_search_vasps",
      description:
        "Search the VASP directory (discoverable Didit customers + catalogued counterparty VASPs) with due-diligence scores and reachable rails.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          search: { type: "string", description: "Name fragment to match" },
          limit: { type: "number", description: "Page size (default 50)" },
          offset: { type: "number" },
        },
      },
    },
    {
      name: "didit_travel_rule_list_wallet_addresses",
      description:
        "List the Travel Rule wallet address book - the wallets you control that inbound INTERNAL-rail transfers resolve against, with ownership-verification state.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
    },
    {
      name: "didit_travel_rule_add_wallet_address",
      description:
        "Register a wallet address in the Travel Rule address book. self_declared: true creates it already ownership-verified (SELF_DECLARATION proof), so inbound transfers skip UNCONFIRMED_OWNERSHIP.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          address: { type: "string", description: "REQUIRED. The wallet address (unique per application among non-deleted entries)" },
          chain: { type: "string", description: "Chain identifier, e.g. ethereum, bitcoin" },
          holder_name: { type: "string", description: "Wallet holder name, used for the beneficiary name match" },
          holder_vendor_data: { type: "string", description: "Your internal identifier for the holder" },
          entity_type: { type: "string", description: "Defaults to 'individual'" },
          travel_address: { type: "string", description: "Counterparty VASP travel address for this wallet - routes its transfers over TRP" },
          self_declared: { type: "boolean", description: "Create the entry already ownership-verified via self-declaration" },
        },
        required: ["address"],
      },
    },
    {
      name: "didit_travel_rule_update_wallet_address",
      description: "Update holder metadata (holder_name, holder_vendor_data, entity_type, travel_address) on a wallet address book entry.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          entry_uuid: { type: "string", description: "REQUIRED. The address book entry UUID" },
          holder_name: { type: "string" },
          holder_vendor_data: { type: "string" },
          entity_type: { type: "string" },
          travel_address: { type: "string" },
        },
        required: ["entry_uuid"],
      },
    },
    {
      name: "didit_travel_rule_delete_wallet_address",
      description:
        "Delete a wallet address book entry. It stops matching new transfers immediately and the address is freed for re-registration.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          entry_uuid: { type: "string", description: "REQUIRED. The address book entry UUID" },
        },
        required: ["entry_uuid"],
      },
    },
    {
      name: "didit_travel_rule_transfer_action",
      description:
        "Act on a Travel Rule transfer: finish a COMPLETED outbound transfer by reporting the on-chain hash (payment_txn_id), cancel any non-terminal transfer (action: cancel), or re-run counterparty routing (action: resend - only from COUNTERPARTY_VASP_NOT_FOUND / NOT_REACHABLE / NOT_ENOUGH_COUNTERPARTY_DATA). Pass exactly one of payment_txn_id or action.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          transaction_id: { type: "string", description: "REQUIRED. The Didit transaction UUID that carries the transfer" },
          payment_txn_id: { type: "string", description: "On-chain transaction hash - finishes a COMPLETED outbound transfer" },
          action: { type: "string", enum: ["cancel", "resend"] },
        },
        required: ["transaction_id"],
      },
    },
    {
      name: "didit_travel_rule_confirm_ownership",
      description:
        "Confirm or deny wallet ownership on a transfer in UNCONFIRMED_OWNERSHIP (e.g. after reviewing a screenshot proof). confirmed: true verifies the address book entry and runs the name match; false declines both sides.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          transaction_id: { type: "string", description: "REQUIRED. The Didit transaction UUID that carries the transfer" },
          confirmed: { type: "boolean", description: "REQUIRED. true to confirm ownership, false to deny" },
        },
        required: ["transaction_id", "confirmed"],
      },
    },
    {
      name: "didit_travel_rule_register_inbound",
      description:
        "Register Travel Rule data for a crypto deposit that already settled on-chain (sunrise flow). Dedupes on txid + wallet_address; resolves against the wallet address book.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          chain: { type: "string", description: "Chain the deposit settled on" },
          txid: { type: "string", description: "REQUIRED. On-chain transaction hash" },
          wallet_address: { type: "string", description: "REQUIRED. The destination wallet the deposit arrived on" },
          amount: { type: "string", description: "Deposit amount (decimal string)" },
          currency: { type: "string", description: "Deposit asset" },
          originator_data: { type: "object", description: "IVMS-101 originator payload from the sending VASP, if known" },
          beneficiary_data: { type: "object", description: "IVMS-101 beneficiary payload (your customer)" },
          originating_vasp: { type: "object", description: "Optional { name, lei, travel_address } describing the sender - catalogued in the VASP directory" },
        },
        required: ["txid", "wallet_address"],
      },
    },
    {
      name: "didit_travel_rule_create_widget_session",
      description:
        "Mint a hosted wallet-ownership widget session (proof of wallet control by message signing, Satoshi test, screenshot, or self-declaration). Returns the url to send the customer to - it must open in a real browser, never an embedded mobile webview.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          wallet_address: { type: "string", description: "REQUIRED. The wallet to verify" },
          chain: { type: "string", description: "Chain identifier (ethereum, bitcoin, solana, tron, ...)" },
          holder_name: { type: "string", description: "Wallet holder name for the beneficiary name match" },
          vendor_data: { type: "string", description: "Your internal identifier for the holder" },
          transaction_id: { type: "string", description: "Optional Didit transaction UUID of a transfer to advance when the proof verifies" },
          satoshi_deposit_address: { type: "string", description: "A deposit address you control - supplying it enables the SATOSHI_TEST method" },
          callback_url: { type: "string", description: "Where the widget returns the customer after completion" },
          expires_in_minutes: { type: "number", description: "Link lifetime; auto-extended to cover the Satoshi test window" },
        },
        required: ["wallet_address"],
      },
    },

    // ── Marketplace (provider catalog & connections) ─────────────────────
    {
      name: "didit_marketplace_list_catalog",
      description:
        "List the provider marketplace catalog: crypto monitoring, AML screening, phone verification, and Travel Rule network memberships (GTR, TRUST, VerifyVASP, Sygna + on-request networks), with BYOK credential schemas and availability.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_marketplace_list_connections",
      description: "List the application's marketplace provider connections (BYOK credentials, network memberships) with status and last-used info. Secrets are never returned.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_marketplace_request_integration",
      description: "Request an integration that is not self-serve yet (on_request catalog entries like the CODE, TRISA, Notabene, or Veriscope Travel Rule networks, or any provider you want added). The Didit team follows up.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          provider_name: { type: "string", description: "REQUIRED. The provider or network you want connected" },
          category: { type: "string", description: "Catalog category, e.g. travel_rule_networks, crypto_monitoring" },
          note: { type: "string", description: "Anything else about your use case" },
        },
        required: ["provider_name"],
      },
    },

    // ── Billing ─────────────────────────────────────────────────────────
    {
      name: "didit_org_get_balance",
      description:
        "Get current credit balance and auto-refill settings. A `0.00` balance does NOT by itself " +
        "block verifications, so never answer a \"not enough credits\" report with \"top up\" from this " +
        "result alone: a workflow whose features are all free-tier (ID verification, passive liveness, " +
        "face match 1:1, device/IP analysis — 500 free each per month) runs fine on a zero balance. " +
        "Read the failing workflow with didit_workflow_list first — `is_white_label_enabled: true` adds " +
        "$0.20/session AND drops the workflow out of the free tier entirely, which is the single most " +
        "common cause. This result also carries `allow_free_usage` (false = the free tier is off for " +
        "this organization) and `usage_summary.white_label_sessions`. Only a NEGATIVE balance stops " +
        "free-tier work; zero does not.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "didit_org_top_up",
      description: "Create a Stripe checkout session to top up credits. Returns a checkout URL.",
      inputSchema: {
        type: "object" as const,
        properties: {
          amount_in_dollars: { type: "number", description: "Amount in USD (minimum $50)" },
          success_url: { type: "string", description: "Optional redirect after successful payment" },
          cancel_url: { type: "string", description: "Optional redirect if payment is cancelled" },
          confirm: {
            type: "boolean",
            description:
              "REQUIRED. Must be true - creates a Stripe checkout that moves money (it never auto-charges). Only set after explicit user confirmation of this exact action.",
          },
        },
        required: ["amount_in_dollars"],
      },
    },

    // ── Customization (verification UI branding) ────────────────────────
    {
      name: "didit_branding_get",
      description: "Get the current branding customization (logos, colors) applied to your verification UI.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_branding_update",
      description: "Update verification UI branding images. Each image is a local absolute *_path (local/stdio runs) or inline *_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_square_path: { type: "string", description: "Absolute path to a square logo image (local/stdio only)" },
          image_rectangular_path: { type: "string", description: "Absolute path to a rectangular logo image (local/stdio only)" },
          image_favicon_path: { type: "string", description: "Absolute path to a favicon image (local/stdio only)" },
          image_square_base64: { type: "string", description: "Square logo as base64 or data URL (or an attachment reference like att_1)" },
          image_rectangular_base64: { type: "string", description: "Rectangular logo as base64 or data URL (or an attachment reference like att_1)" },
          image_favicon_base64: { type: "string", description: "Favicon as base64 or data URL (or an attachment reference like att_1)" },
        },
      },
    },

    // ── Webhook destinations ────────────────────────────────────────────
    {
      name: "didit_webhook_list",
      description: "List configured webhook destinations. Each destination has its own URL, version, enabled flag, subscribed events, and redacted signing-secret metadata.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_webhook_create",
      description: "Create a webhook destination. The signing secret is redacted in the response.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          label: { type: "string", description: "REQUIRED. Human-readable name" },
          url: { type: "string", description: "REQUIRED. HTTPS endpoint to receive events" },
          enabled: { type: "boolean", description: "Whether the destination receives events (default true)" },
          webhook_version: { type: "string", enum: ["v1", "v2", "v3"], description: "Payload version (v3 recommended)" },
          subscribed_events: { type: "array", items: { type: "string" }, description: "Event types to deliver (e.g. status.updated, data.updated, user.created). Omit to receive all." },
        },
        required: ["label", "url"],
      },
    },
    {
      name: "didit_webhook_get",
      description: "Get a single webhook destination with redacted signing-secret metadata.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          destination_uuid: { type: "string", description: "Webhook destination UUID" },
        },
        required: ["destination_uuid"],
      },
    },
    {
      name: "didit_webhook_update",
      description: "Update a webhook destination's URL, version, enabled flag, or subscribed events.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          destination_uuid: { type: "string", description: "Webhook destination UUID" },
          label: { type: "string" },
          url: { type: "string" },
          enabled: { type: "boolean" },
          webhook_version: { type: "string", enum: ["v1", "v2", "v3"] },
          subscribed_events: { type: "array", items: { type: "string" } },
        },
        required: ["destination_uuid"],
      },
    },
    {
      name: "didit_webhook_delete",
      description: "Delete a webhook destination so it stops receiving events.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          destination_uuid: { type: "string", description: "Webhook destination UUID" },
        },
        required: ["destination_uuid"],
      },
    },

    // ── Lists (Blocklists, Allowlists & Custom) ─────────────────────────
    {
      name: "didit_lists_list",
      description: "List all lists (blocklists, allowlists, custom) for the application. Filter by list_type or entry_type.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_type: { type: "string", description: "Filter: blocklist, allowlist, custom" },
          entry_type: { type: "string", description: `Filter: ${LIST_ENTRY_TYPES.join(", ")}` },
          limit: { type: "string" },
          offset: { type: "string" },
        },
      },
    },
    {
      name: "didit_lists_create",
      description: "Create an allowlist or custom list. System blocklists are auto-provisioned (one per entry type) and cannot be created. name must be unique per application.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          name: { type: "string", description: "REQUIRED. Unique list name" },
          list_type: { type: "string", enum: ["allowlist", "custom"], description: "REQUIRED. allowlist or custom (blocklists are auto-provisioned)" },
          entry_type: { type: "string", enum: LIST_ENTRY_TYPES, description: "REQUIRED. What kind of values the list holds" },
          description: { type: "string" },
        },
        required: ["name", "list_type", "entry_type"],
      },
    },
    {
      name: "didit_lists_get",
      description: "Get a single list's details by UUID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
        },
        required: ["list_uuid"],
      },
    },
    {
      name: "didit_lists_update",
      description: "Rename or update the description of an allowlist/custom list. System blocklists are immutable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["list_uuid"],
      },
    },
    {
      name: "didit_lists_delete",
      description: "Delete an allowlist/custom list and all its entries. System blocklists cannot be deleted.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
        },
        required: ["list_uuid"],
      },
    },
    {
      name: "didit_lists_entries_list",
      description: "List entries in a specific list. Use search to filter by value or label.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
          search: { type: "string", description: "Search by value or display label" },
          limit: { type: "string" },
          offset: { type: "string" },
        },
        required: ["list_uuid"],
      },
    },
    {
      name: "didit_lists_entry_create",
      description: "Add an entry to a blocklist/allowlist/custom list. Pass value directly, or reference_session_id to auto-extract from a session (face, document, phone, email, IP, device). Pass both to disambiguate when a session has multiple values of the same type. For face entries without a session, use didit_lists_entry_upload_face instead.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list to add to" },
          value: { type: "string", description: "Value to add (phone, email, IP, etc.). Optional if reference_session_id is provided." },
          reference_session_id: { type: "string", description: "Session UUID — backend auto-extracts the value based on the list's entry type" },
          reference_object_uuid: { type: "string", description: "UUID of the source entity (transaction, vendor user/business) for traceability" },
          display_label: { type: "string", description: "Human-readable label" },
          comment: { type: "string", description: "Reason for adding" },
          metadata: { type: "object", description: "Additional structured data (e.g. reference_type, full_name)" },
        },
        required: ["list_uuid"],
      },
    },
    {
      name: "didit_lists_entry_upload_face",
      description: "Add a face entry to a face list by uploading an image directly (no session needed). Use this when you have a photo but no reference_session_id. Provide the image as image_path (local/stdio runs) or image_base64 (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of a face-type list" },
          image_path: { type: "string", description: "Absolute path to the face image file (local/stdio only)" },
          image_base64: { type: "string", description: "Face image as base64 or data URL (or an attachment reference like att_1)" },
          display_label: { type: "string" },
          comment: { type: "string" },
        },
        required: ["list_uuid"],
      },
    },
    {
      name: "didit_lists_entry_delete",
      description: "Remove an entry from a list. Also unblocks the underlying user/business if applicable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
          entry_uuid: { type: "string", description: "UUID of the entry to remove" },
        },
        required: ["list_uuid", "entry_uuid"],
      },
    },

    // ── Standalone: Identity & Documents ────────────────────────────────
    {
      name: "didit_verify_id",
      description: "Verify an identity document by submitting front (and optionally back) images. Returns structured OCR data and authenticity checks. Each image is a local absolute *_path (local/stdio runs) or inline *_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          front_image_path: { type: "string", description: "Absolute path to front image file (local/stdio only)" },
          back_image_path: { type: "string", description: "Absolute path to back image file (optional; local/stdio only)" },
          front_image_base64: { type: "string", description: "Front image as base64 or data URL (or an attachment reference like att_1)" },
          back_image_base64: { type: "string", description: "Back image as base64 or data URL (optional; or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
          perform_document_liveness: { type: "boolean", description: "Run document-presence (anti-screenshot) checks" },
          minimum_age: { type: "number", description: "Decline if the extracted age is below this value" },
          preferred_characters: { type: "string", enum: ["latin", "non_latin"], description: "Preferred OCR script" },
        },
      },
    },
    {
      name: "didit_verify_poa",
      description: "Proof of Address verification. Submit a single document image to extract and validate address information. The image is a local absolute *_path (local/stdio runs) or inline *_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          document_image_path: { type: "string", description: "Absolute path to the POA document image (local/stdio only)" },
          document_image_base64: { type: "string", description: "POA document image as base64 or data URL (or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
          expected_address: { type: "string", description: "Address to validate the document against" },
          expected_country: { type: "string", description: "ISO 3166-1 alpha-2 country code to validate against" },
          expected_first_name: { type: "string" },
          expected_last_name: { type: "string" },
        },
      },
    },
    {
      name: "didit_verify_database",
      description: "Validate identity data against national and global authoritative data sources. issuing_state (ISO 3166-1 alpha-3) is required and selects which sources run.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          issuing_state: { type: "string", description: "REQUIRED. ISO 3166-1 alpha-3 country code that selects the data sources to query" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          middle_name: { type: "string" },
          full_name: { type: "string" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD" },
          document_number: { type: "string" },
          document_type: { type: "string", enum: DOCUMENT_TYPES },
          personal_number: { type: "string" },
          tax_number: { type: "string" },
          gender: { type: "string", enum: ["M", "F", "X"] },
          nationality: { type: "string" },
          services: { type: "array", items: { type: "string" }, description: "Optional service_ids to restrict which sources run" },
          partial_match_action: { type: "string", enum: ["DECLINE", "NO_ACTION"] },
          no_match_action: { type: "string", enum: ["DECLINE", "NO_ACTION"] },
          vendor_data: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["issuing_state"],
      },
    },

    // ── Standalone: KYB registry ────────────────────────────────────────
    {
      name: "didit_verify_kyb_search",
      description: "Search official company registries for a business by name and/or registration number. Returns candidate matches; pass a candidate's kyb_response_id to didit_verify_kyb_select to pull the full record.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          country_code: { type: "string", description: "REQUIRED. ISO 3166-1 alpha-2 country code" },
          name: { type: "string", description: "Company name to search" },
          registration_number: { type: "string", description: "Registration number to search" },
          search_type: { type: "string", enum: ["contains", "start_with", "fuzzy"], description: "Name match strategy" },
          vendor_data: { type: "string" },
          metadata: { type: "object" },
          webhook_url: { type: "string", description: "Optional URL notified when the registry result resolves" },
        },
        required: ["country_code"],
      },
    },
    {
      name: "didit_verify_kyb_select",
      description: "Resolve a candidate from didit_verify_kyb_search into a full company registry record. kyb_response_id is the per-search candidate handle returned by the search.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          kyb_response_id: { type: "string", description: "REQUIRED. Candidate handle from didit_verify_kyb_search" },
          vendor_data: { type: "string" },
          metadata: { type: "object" },
          save_api_request: { type: "boolean" },
        },
        required: ["kyb_response_id"],
      },
    },

    // ── Standalone: Biometrics & Face ───────────────────────────────────
    {
      name: "didit_verify_passive_liveness",
      description: "Passive liveness detection -- verify a person is physically present from a single image (no interaction required). The image is a local absolute image_path (local/stdio runs) or inline image_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_path: { type: "string", description: "Absolute path to facial image file (local/stdio only)" },
          image_base64: { type: "string", description: "Facial image as base64 or data URL (or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
      },
    },
    {
      name: "didit_verify_face_match",
      description: "Compare two facial images to determine if they belong to the same person (1:1 face matching). The score is symmetric, so image order does not affect the result. Each image is a local absolute *_path (local/stdio runs) or inline *_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_1_path: { type: "string", description: "Absolute path to the first facial image, e.g. the selfie (local/stdio only)" },
          image_2_path: { type: "string", description: "Absolute path to the second facial image, e.g. the ID portrait (local/stdio only)" },
          image_1_base64: { type: "string", description: "First facial image as base64 or data URL (or an attachment reference like att_1)" },
          image_2_base64: { type: "string", description: "Second facial image as base64 or data URL (or an attachment reference like att_2)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
      },
    },
    {
      name: "didit_verify_face_search",
      description: "Search for a face against a database of previously verified faces (1:N face matching). The image is a local absolute image_path (local/stdio runs) or inline image_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_path: { type: "string", description: "Absolute path to facial image file (local/stdio only)" },
          image_base64: { type: "string", description: "Facial image as base64 or data URL (or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
      },
    },
    {
      name: "didit_verify_age",
      description: "Estimate a person's age from a facial image. Also performs passive liveness check. The image is a local absolute image_path (local/stdio runs) or inline image_base64 content (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_path: { type: "string", description: "Absolute path to facial image file (local/stdio only)" },
          image_base64: { type: "string", description: "Facial image as base64 or data URL (or an attachment reference like att_1)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
      },
    },

    // ── Standalone: AML Screening ───────────────────────────────────────
    {
      name: "didit_verify_aml",
      description: "AML screening against global watchlists, PEP lists, sanctions, and (optionally) adverse media. Supports person and company entity types.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          full_name: { type: "string", description: "REQUIRED. Full name to screen" },
          entity_type: { type: "string", enum: ["person", "company"], description: "Defaults to person" },
          date_of_birth: { type: "string", description: "YYYY-MM-DD (improves match accuracy)" },
          nationality: { type: "string", description: "ISO country code (improves match accuracy)" },
          document_number: { type: "string" },
          include_adverse_media: { type: "boolean", description: "Include adverse-media findings" },
          include_ongoing_monitoring: { type: "boolean", description: "Enroll the entity for ongoing monitoring" },
          vendor_data: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["full_name"],
      },
    },

    // ── Standalone: Email & Phone Verification ──────────────────────────
    {
      name: "didit_verify_email_send",
      description: "Send a one-time verification code to an email address. Code valid for 5 minutes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          email: { type: "string", description: "Email address to verify" },
        },
        required: ["email"],
      },
    },
    {
      name: "didit_verify_email_check",
      description: "Verify the OTP code sent to an email. Max 3 attempts per code.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          email: { type: "string" },
          code: { type: "string", description: "Verification code from email" },
        },
        required: ["email", "code"],
      },
    },
    {
      name: "didit_verify_phone_send",
      description: "Send a one-time verification code to a phone number via SMS. Code valid for 5 minutes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          phone_number: { type: "string", description: "Phone number with country code (e.g. +1234567890)" },
        },
        required: ["phone_number"],
      },
    },
    {
      name: "didit_verify_phone_check",
      description: "Verify the OTP code sent to a phone number. Max 3 attempts per code.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          phone_number: { type: "string" },
          code: { type: "string", description: "Verification code from SMS" },
        },
        required: ["phone_number", "code"],
      },
    },

    // ── Blocklist / Allowlist ───────────────────────────────────────────
    {
      name: "didit_blocklist_get",
      description: "List blocklist entries (blocked users/identifiers).",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_blocklist_add",
      description: "Add an entry to the blocklist (e.g. by vendor_data, document number, face).",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS }, required: [] },
    },
    {
      name: "didit_blocklist_remove",
      description: "Remove an entry from the blocklist.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_allowlist_add",
      description: "Add an entry to the allowlist (trusted, bypasses some checks).",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },

    // ── Case management ─────────────────────────────────────────────────
    {
      name: "didit_case_list",
      description: "List investigation/compliance cases for ONE app; with multiple apps (or no scope) it auto-spans all your apps. For a cross-app query prefer didit_case_search.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, status: { type: "string" }, cursor: { type: "string" } } },
    },
    {
      name: "didit_case_get",
      description: "Get a case with its details.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, case_id: { type: "string" } }, required: ["case_id"] },
    },
    {
      name: "didit_case_create",
      description: "Create a case.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_case_statistics",
      description: "Get case statistics (counts by status, etc.).",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_case_manage",
      description: "Act on a case: assign, resolve, reopen, escalate, comment, or update.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          case_id: { type: "string" },
          action: { type: "string", enum: ["assign", "resolve", "reopen", "escalate", "comment", "update"] },
          data: { type: "object", description: "Action payload (e.g. {assignee_id}, {comment}, or fields to update)" },
          confirm: {
            type: "boolean",
            description:
              "REQUIRED when filing a SAR (action 'sar'/'file_sar', or any action whose data.status is 'SAR_FILED') - a high-impact regulatory action. Only set after explicit user confirmation of this exact action.",
          },
        },
        required: ["case_id", "action"],
      },
    },

    // ── Reports (async exports) ─────────────────────────────────────────
    {
      name: "didit_report_list",
      description: "List generated export reports.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_report_get",
      description: "Get a report's status/details.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, report_id: { type: "string" } }, required: ["report_id"] },
    },
    {
      name: "didit_report_get_download_url",
      description: "Get a signed download URL for a finished report.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, report_id: { type: "string" } }, required: ["report_id"] },
    },
    {
      name: "didit_report_export",
      description: "Start an export report. kind ∈ sessions | transactions | businesses | vendor-users | vendor-businesses. `data.columns` is a kind-specific schema — for sessions/vendor-users/vendor-businesses an unknown column 400s with `Invalid columns`, and that error's `allowed` field carries the full valid-column list for that kind, so retry from the error alone rather than guessing names like `date`/`status`/`total_price`.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, kind: { type: "string" }, data: { type: "object", description: "Filters for the export" } },
        required: ["kind"],
      },
    },

    // ── Audit logs + alerts ─────────────────────────────────────────────
    {
      name: "didit_audit_log_list",
      description: "List audit-log entries for the application (who changed what).",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, cursor: { type: "string" } } },
    },
    {
      name: "didit_alert_list",
      description: "List configured alerts.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_alert_configure",
      description: "Configure an alert by type.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, alert_type: { type: "string" }, data: { type: "object" } },
        required: ["alert_type"],
      },
    },

    // ── Org members / roles / API keys (apx/auth/v2) ────────────────────
    {
      name: "didit_org_list_members",
      description: "List the organization's members.",
      inputSchema: { type: "object" as const, properties: { organization_id: ORG_APP_PROPS.organization_id } },
    },
    {
      name: "didit_org_invite_member",
      description: "Invite a member to the organization (email + role).",
      inputSchema: {
        type: "object" as const,
        properties: { organization_id: ORG_APP_PROPS.organization_id, email: { type: "string" }, role: { type: "string" } },
        required: ["email"],
      },
    },
    {
      name: "didit_org_update_member",
      description: "Update a member's role.",
      inputSchema: {
        type: "object" as const,
        properties: { organization_id: ORG_APP_PROPS.organization_id, member_id: { type: "string" }, role: { type: "string" } },
        required: ["member_id"],
      },
    },
    {
      name: "didit_org_remove_member",
      description: "Remove a member from the organization.",
      inputSchema: {
        type: "object" as const,
        properties: { organization_id: ORG_APP_PROPS.organization_id, member_id: { type: "string" } },
        required: ["member_id"],
      },
    },
    {
      name: "didit_org_list_roles",
      description: "List the roles available in the organization.",
      inputSchema: { type: "object" as const, properties: { organization_id: ORG_APP_PROPS.organization_id } },
    },
    {
      name: "didit_org_list_api_keys",
      description: "List API key metadata with raw key values redacted (pass application_id for an app's keys).",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },

    // ── Compliance ──────────────────────────────────────────────────────
    {
      name: "didit_compliance_requirements",
      description: "Get the organization's applicable regulatory obligations with citations, derived from its stored compliance profile. Each obligation carries its source URLs and the kb_version it was evaluated against.",
      inputSchema: {
        type: "object" as const,
        properties: {
          as_of: { type: "string", description: "Evaluate obligations as of this ISO date (defaults to today)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_compliance_check_workflow",
      description: "Deterministically check which regulations a workflow version satisfies or violates. Returns per-obligation status with citations.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "REQUIRED. UUID of the workflow to check (from didit_workflow_search/list) — NOT a label, slug or node id. An exact label is resolved when it matches exactly one workflow; otherwise the candidates are listed for you to pick." },
          ...ORG_APP_PROPS,
          version: { type: "number", description: "Workflow version to check (defaults to the latest)" },
          as_of: { type: "string", description: "Evaluate regulations as of this ISO date (defaults to today)" },
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_compliance_interview_next",
      description: "Given the accumulated onboarding answers so far, return the next question of the adaptive compliance interview, or done:true when it is complete. Stateless — pass every answer collected so far on each call, starting with {}.",
      inputSchema: {
        type: "object" as const,
        properties: {
          answers: { type: "object", description: "REQUIRED. Accumulated interview answers so far (may be an empty object {} to start)" },
          ...ORG_APP_PROPS,
        },
        required: ["answers"],
      },
    },
    {
      name: "didit_compliance_profile_get",
      description:
        "Read the organization's stored compliance profile: the raw interview answers ({answers}, keyed by profileAttr — subjectType, userCountries, industries, …) plus the attributes derived from them ({derived}). Returns the no_profile error when the application has never completed the compliance onboarding.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
        },
      },
    },
    {
      name: "didit_compliance_profile_set",
      description: "Persist the organization's compliance profile from the completed interview answers. Subsequent requirements and workflow checks evaluate against this profile.",
      inputSchema: {
        type: "object" as const,
        properties: {
          answers: { type: "object", description: "REQUIRED. Complete interview answers to store as the compliance profile" },
          ...ORG_APP_PROPS,
        },
        required: ["answers"],
      },
    },
    {
      name: "didit_compliance_generate_workflow",
      description: "Deterministically generate a multi-country verification workflow graph from the org's stored compliance profile: a common trunk plus per-country branches carrying the checks each country requires. Returns {kb_version, graph, branches_summary:[{countries, extra_features, because}], manual_obligations, kyb_obligations, rationale}. `rationale.nodes` maps every feature node id of the graph to {feature, because:[{obligation_id, regulation_id, regulation_name, citation, source_url, countries}]} — the obligations that require that node, with the citation and the official source to link. It is the ONLY sanctioned source for explaining WHY a node exists: never state a regulation, article or URL that is not in it. A node may also carry promoted_for_branching:true, meaning it sits in the trunk for a structural reason (the document-country branch cannot be decided before a document scan), not because every country's regulation demands it — say so rather than attributing it to a regulation. The graph is validated against Didit's workflow schema. Read-only preview — does NOT persist; use didit_workflow_create/set_graph or the ui_* editor tools to apply it. Can also take partial interview answers to preview the graph mid-onboarding, before the profile is stored.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          as_of: { type: "string", description: "Optional ISO date (YYYY-MM-DD) to evaluate against a specific point in time" },
          answers: { type: "object", description: "Optional partial interview answers (compliance profile) to generate from, instead of the org's stored profile. Used during live onboarding to preview the graph as the user answers." },
          subject: { type: "string", enum: ["kyc", "kyb"], description: "Which graph to build: kyc verifies a person, kyb verifies a company. Defaults to what the profile's subjectType implies (persons→kyc, businesses→kyb, both→kyc). The checks the other subject requires are reported in the corresponding *_obligations bucket instead of the graph." },
        },
      },
    },

    {
      name: "didit_workflow_build_graph",
      description:
        "Build a complete workflow graph from a PLAIN FEATURE SPEC in one deterministic call - regulations are " +
        "never consulted (use didit_compliance_generate_workflow for regulation-driven graphs). Gate-then-commit: " +
        "the result is either an accepted build (graph_summary + spec: materialize with ui_workflow_apply_graph " +
        "{spec} on an open editor, or include_graph:true + didit_workflow_set_graph headless), or 'unsupported'/'questions' naming " +
        "exactly what cannot be built or what to ask the user FIRST - in that case build NOTHING and relay them. " +
        "Never rebuild the returned graph by hand and never retry with guesses. Read-only: persists nothing. " +
        "document_rules express per-country/document filtering, including US state-scoped subtypes " +
        "(e.g. exclude the Nevada driver's license) and the country wildcard 'ALL' (every catalog country: " +
        "'only passports, from any country' = one rule {country:'ALL', document:'P', action:'only'}).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          subject: { type: "string", enum: ["kyc", "kyb"], description: "kyc verifies a person (default), kyb a company." },
          features: {
            type: "array",
            items: { type: "string" },
            description:
              "ONLY the verification steps the user NAMED, by feature code (OCR, LIVENESS, FACE_MATCH, NFC, " +
              "PROOF_OF_ADDRESS, QUESTIONNAIRE, PHONE_VERIFICATION, EMAIL_VERIFICATION, AGE_ESTIMATION, " +
              "IP_ANALYSIS, AML, DATABASE_VALIDATION, DOCUMENT_AI; KYB: KYB_REGISTRY, KYB_DOCUMENTS, " +
              "KYB_KEY_PEOPLE). NEVER add 'standard' steps uninvited ('only id verification' means OCR and " +
              "nothing else); the builder itself adds true dependencies and orders the chain.",
          },
          countries: {
            type: "object",
            description:
              "Which countries' DOCUMENTS are configured. OMIT ENTIRELY for 'all countries' (the default). " +
              "NEVER use it to exclude a document or a state — that is document_rules' job: 'all countries " +
              "except the Nevada driver's license' = countries omitted + one document_rule.",
            properties: {
              mode: { type: "string", enum: ["all", "only", "except"] },
              list: {
                type: "array",
                items: { type: "string" },
                description:
                  "Countries EXACTLY as the user named them (a name or ISO3 code per entry). NEVER substitute the country you think they meant — the builder asks when it does not know a name.",
              },
            },
            additionalProperties: false,
          },
          document_rules: {
            type: "array",
            description:
              "Per-country document filtering. 'state' (US state name or USPS code) filters the " +
              "state-scoped document subtypes (how 'exclude the Nevada driver's license' is expressed). " +
              "country 'ALL' applies the rule to every catalog country ('only passports everywhere' = " +
              "{country:'ALL', document:'P', action:'only'}; do NOT enumerate countries for that).",
            items: {
              type: "object",
              properties: {
                country: {
                  type: "string",
                  description: "The country EXACTLY as the user named it (a name or ISO3 code, e.g. USA); never substitute one. 'ALL' = every catalog country (wildcard for rules that apply everywhere).",
                },
                document: {
                  type: "string",
                  enum: ["ID", "P", "DL", "RP", "HIC", "TC", "SSC", "FIREARM"],
                  description: "Catalog document code: ID card, Passport, Driver's License, Residence Permit, ...",
                },
                state: { type: "string", description: "US state (full name or USPS code), for state-scoped subtypes." },
                action: { type: "string", enum: ["exclude", "only"] },
              },
              required: ["country", "document"],
              additionalProperties: false,
            },
          },
          per_feature_config: {
            type: "object",
            description: "Optional per-feature config overrides, {FEATURE: {contract keys...}}; validated server-side.",
          },
          include_graph: {
            type: "boolean",
            description:
              "Return the full graph (for headless didit_workflow_set_graph). Default false: the result carries a " +
              "graph_summary + the accepted spec, and the editor applies by reference with ui_workflow_apply_graph {spec}.",
          },
          branches: {
            type: "array",
            description:
              "Country branches after the routing step; unmatched countries take the else path to the final decision.",
            items: {
              type: "object",
              properties: {
                countries: {
                  type: "array",
                  items: { type: "string" },
                  description: "Countries exactly as the user named them (a name or ISO3 code per entry).",
                },
                features: { type: "array", items: { type: "string" } },
              },
              required: ["countries", "features"],
              additionalProperties: false,
            },
          },
        },
      },
    },

    ...PRIVILEGED_TOOL_DEFS,
  ];
  // Hosted (Bearer-authenticated) catalogs never include the account-bootstrap /
  // checkout / secret-reveal tools — the public app catalog must stay free of
  // credential-collection, checkout, and secret-reveal flows. Privileged (staff)
  // callers and local stdio setups keep the full catalog.
  const hasUserBearer = Boolean(extra?.authInfo?.token || process.env.DIDIT_ACCESS_TOKEN);
  let catalog =
    hasUserBearer && !isPrivileged ? tools.filter((t) => !HOSTED_APP_EXCLUDED_TOOLS.has(t.name)) : tools;
  // Remote connectors authenticate with OAuth, so account credentials must never travel
  // through the conversation: hosted servers drop the bootstrap tools for EVERY caller
  // (staff included), regardless of Bearer state. They remain available on stdio.
  if (hosted) catalog = catalog.filter((t) => !ACCOUNT_BOOTSTRAP_TOOLS.has(t.name));
  // A tool the caller's organization role could never run is not offered (permissions.ts);
  // only in enforce mode — shadow mode lists everything and just records the verdicts.
  const tokenOrg = (extra?.authInfo?.extra as Record<string, unknown> | undefined)?.organization_id as string | undefined;
  const query = { scopes: extra?.authInfo?.scopes, mode: permissionMode(), tokenOrg, targetOrg: tokenOrg };
  catalog = catalog.filter((t) => decidePermission({ ...query, tool: t.name }) !== "deny");
  const visible = isPrivileged ? catalog : catalog.filter((t) => !isPrivilegedToolName(t.name));
  // Endpoint catalog profile (catalog-profiles.ts): the ChatGPT endpoint offers only the
  // allow-listed tools, with restricted input properties removed from their schemas.
  const offered = applyCatalogProfile(visible, profile);
  // Annotate each tool so the connector UI splits them into Read-only / Write / Destructive
  // groups (driven by readOnlyHint + destructiveHint) instead of one flat "Other tools"
  // bucket; also tag the logical domain group via _meta for future UI use.
  return {
    tools: offered.map((t) => ({
      ...t,
      outputSchema: (t as { outputSchema?: unknown }).outputSchema ?? {
        type: "object",
        description: "Structured result. Fields vary by tool; see the success payload.",
        additionalProperties: true,
      },
      annotations: {
        ...((t as { annotations?: Record<string, unknown> }).annotations ?? {}),
        ...annotationsFor(t.name),
      },
      _meta: {
        ...((t as { _meta?: Record<string, unknown> })._meta ?? {}),
        "anthropic/toolGroup": toolGroupOf(t.name),
        category: toolGroupOf(t.name),
      },
    })),
  };
});

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const authInfo = extra?.authInfo;
    // Console (management) tools target /organization/{org}/application/{app}/... paths.
    // An explicit organization_id / application_id in the tool arguments takes precedence
    // over the token's org context; both flow into requestContext so orgAppPath() resolves.
    const callArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    const argOrg = typeof callArgs.organization_id === "string" ? callArgs.organization_id : undefined;
    const argApp = typeof callArgs.application_id === "string" ? callArgs.application_id : undefined;
    // Permission pre-check verdict (permissions.ts): decided once here so the audit line
    // can record a shadow-mode "would_deny" and the dispatch below can refuse a "deny".
    const tokenOrg = (authInfo?.extra as Record<string, unknown> | undefined)?.organization_id as string | undefined;
    const permission = decidePermission({
      tool: request.params.name,
      scopes: authInfo?.scopes,
      mode: permissionMode(),
      tokenOrg,
      targetOrg: argOrg || tokenOrg,
    });
    const permissionCheck = permission === "would_deny" ? permission : undefined;
    return requestContext.run(
      {
        // Hosted mode: per-request Bearer from OAuth introspection. Stdio mode (tests/eval):
        // fall back to DIDIT_ACCESS_TOKEN + MCP_DEFAULT_ORG/APP env so the console-path tools
        // authenticate as that Bearer without the hosted layer.
        accessToken: authInfo?.token || process.env.DIDIT_ACCESS_TOKEN || undefined,
        organizationId:
          argOrg ||
          ((authInfo?.extra as Record<string, unknown> | undefined)?.organization_id as string | undefined) ||
          process.env.MCP_DEFAULT_ORG ||
          undefined,
        applicationId: argApp || process.env.MCP_DEFAULT_APP || undefined,
        toolName: request.params.name,
      },
      () => auditToolCall({ tool: request.params.name, args: callArgs, authInfo, hosted, permissionCheck }, async () => {
  const { name } = request.params;
  // organization_id / application_id are ROUTING, consumed above into
  // requestContext — they are not payload. Removing them here is what makes
  // declaring them on a tool safe: the handlers that forward their args
  // verbatim (lists, webhooks, sessions, transactions, vendors…) would
  // otherwise put them in a query string or a POST body the console API never
  // asked for. Behaviour-preserving for the handlers that DO read them —
  // marketplace/travelRule pass them to resolveOrganizationId /
  // resolveApplicationId, which fall back to the very context set above.
  const args = stripRoutingIds(request.params.arguments);

  // ...but a handful of handlers take the routing ids as EXPLICIT PARAMETERS rather than
  // resolving them from requestContext, and the strip above hands them `undefined`:
  // the auth-service tools build their URL path from the argument (and the reveal tool
  // deliberately refuses every context/env fallback), and the *_search tools use the ids to
  // NARROW their fan-out. Re-attach only what the caller actually sent, and only for those.
  const withRoutingIds = (a?: Record<string, unknown>): Record<string, any> => ({
    ...(a ?? {}),
    ...(argOrg ? { organization_id: argOrg } : {}),
    ...(argApp ? { application_id: argApp } : {}),
  });

  // Privileged operational tools require a privileged token (the verification backend's role
  // permission + 2FA is the authoritative gate; this is defense-in-depth + a clearer error).
  // There are none in the open-source build (isPrivilegedToolName is always false there).
  if (isPrivilegedToolName(name) && !isPrivilegedCaller(authInfo, { hosted })) {
    return { content: [{ type: "text", text: `Tool '${name}' requires elevated (privileged) access.` }], isError: true };
  }

  // Mirror of the tools/list exclusion: a hosted connector authenticates with OAuth, so it
  // never accepts account credentials/OTP codes as tool arguments, from any caller.
  if (hosted && ACCOUNT_BOOTSTRAP_TOOLS.has(name)) {
    return {
      content: [{ type: "text", text: `Tool '${name}' is not available on the hosted connector - authentication is handled by OAuth. Use the local stdio server (npx @didit-protocol/mcp-server) for account setup.` }],
      isError: true,
    };
  }

  // Mirror of the tools/list catalog profile: a tool (or an input property) the endpoint does
  // not offer is refused even if the client memorised it from the full catalog.
  const profileRefusal = catalogProfileRefusal(profile, name, callArgs);
  if (profileRefusal) {
    return { content: [{ type: "text", text: profileRefusal }], isError: true };
  }

  // Single-org/single-app callers: fill the default scope so they needn't pass/discover ids.
  await ensureScopeDefaults(name);

  try {
    // The caller's organization role lacks the permission the backend would demand for
    // this tool: refuse here with the permission named (the backend would 403 anyway).
    if (permission === "deny") throw missingPermissionError(name);

    let result: any;

    // Multi-tenant caller invoked a per-app list tool with no resolvable scope: span all apps
    // (same shape as the *_search sibling) instead of throwing, so the first call succeeds.
    const aggregate = aggregateFallbackFor(name);
    if (isPrivilegedToolName(name)) {
      result = await dispatchPrivilegedTool(name, args);
    } else if (aggregate) {
      // Scope survives the fallback: when the org resolved but the app did not, span only
      // that org's apps rather than every org the caller can reach.
      const scopedOrg = requestContext.getStore()?.organizationId;
      result = await aggregate({
        ...withRoutingIds(args),
        ...(scopedOrg ? { organization_id: scopedOrg } : {}),
      });
    } else
    switch (name) {
      // Auth
      case "didit_account_register":
        result = await auth.register(args!.email as string, args!.password as string);
        break;
      case "didit_account_verify_email":
        result = await auth.verifyEmail(args!.email as string, args!.code as string);
        break;
      case "didit_account_resend_otp":
        result = await auth.resendOtp(args!.email as string);
        break;
      case "didit_account_login":
        result = await auth.login(args!.email as string, args!.password as string);
        break;
      case "didit_org_list":
        result = await auth.listOrganizations(args?.access_token as string | undefined);
        break;
      case "didit_org_list_applications":
        result = await auth.listApplications(argOrg as string, args?.access_token as string | undefined);
        break;
      case "didit_org_get_application":
        result = await auth.getApplication(argOrg as string, argApp as string, args?.access_token as string | undefined);
        break;
      case "didit_org_reveal_application_api_key":
        result = await auth.revealApplicationApiKey(argOrg, argApp, args?.confirm, args?.access_token as string | undefined);
        break;

      // Context + cross-org/app aggregate search
      case "didit_context_get":
        result = await context.getContext();
        break;
      case "didit_session_search":
        result = await search.searchSessions(withRoutingIds(args));
        break;
      case "didit_transaction_search":
        result = await search.searchTransactions(withRoutingIds(args));
        break;
      case "didit_case_search":
        result = await search.searchCases(withRoutingIds(args));
        break;
      case "didit_vendor_user_search":
        result = await search.searchVendorUsers(withRoutingIds(args));
        break;
      case "didit_vendor_business_search":
        result = await search.searchVendorBusinesses(withRoutingIds(args));
        break;
      case "didit_analytics":
        result = await analytics.analytics((args ?? {}) as Record<string, any>);
        break;
      case "didit_network_list":
        result = await networks.listNetworks((args ?? {}) as Record<string, any>);
        break;
      case "didit_network_get":
        result = await networks.getNetwork((args ?? {}) as Record<string, any>);
        break;
      case "didit_network_membership_get":
        result = await networks.getNetworkMembership((args ?? {}) as Record<string, any>);
        break;

      // Sessions
      case "didit_session_create":
        result = await sessions.createSession(args || {});
        break;
      case "didit_session_list":
        result = await sessions.listSessions(args as Record<string, string>);
        break;
      case "didit_session_get_decision":
        result = await sessions.getSessionDecision(args!.session_id as string);
        break;
      case "didit_session_update_status": {
        const { session_id, ...data } = args as Record<string, any>;
        result = await sessions.updateSessionStatus(session_id, data);
        break;
      }
      case "didit_session_update_data": {
        const { session_id, ...data } = args as Record<string, any>;
        result = await sessions.updateSessionData(session_id, data);
        break;
      }
      case "didit_session_update_poa_data": {
        const { session_id, ...data } = args as Record<string, any>;
        result = await sessions.updateSessionPoaData(session_id, data);
        break;
      }
      case "didit_session_delete":
        result = await sessions.deleteSession(args!.session_id as string, args?.confirm);
        break;
      case "didit_session_batch_delete":
        result = await sessions.batchDeleteSessions(args?.session_numbers as number[], args?.delete_all, args?.confirm);
        break;
      case "didit_session_generate_pdf":
        result = await sessions.generateSessionPdf(args!.session_id as string);
        break;
      case "didit_session_list_reviews":
        result = await sessions.listSessionReviews(args!.session_id as string);
        break;
      case "didit_session_add_review": {
        const { session_id, ...data } = args as Record<string, any>;
        result = await sessions.addSessionReview(session_id, data);
        break;
      }
      case "didit_session_share":
        result = await sessions.shareSession(args!.session_id as string, args as Record<string, any>);
        break;
      case "didit_session_import_shared":
        result = await sessions.importSharedSession(args as Record<string, any>);
        break;

      // Session imports
      case "didit_session_create_import":
        result = await sessions.createImport(args as Record<string, any>);
        break;
      case "didit_session_get_import_template":
        result = await sessions.getImportTemplate();
        break;
      case "didit_session_get_import":
        result = await sessions.getImport(args!.import_id as string);
        break;
      case "didit_session_get_import_errors":
        result = await sessions.getImportErrors(args!.import_id as string);
        break;

      // Workflows
      case "didit_workflow_list":
        result = await settings.listWorkflows();
        break;
      case "didit_workflow_create":
        result = await settings.createWorkflow(args || {});
        break;
      case "didit_workflow_get":
        result = await settings.getWorkflow(args!.workflow_id as string);
        break;
      case "didit_workflow_update": {
        const { workflow_id, ...data } = args as Record<string, any>;
        result = await settings.updateWorkflow(workflow_id, data);
        break;
      }
      case "didit_workflow_delete":
        result = await settings.deleteWorkflow(args!.workflow_id as string);
        break;
      case "didit_workflow_search":
        result = await search.searchWorkflows(withRoutingIds(args));
        break;
      case "didit_workflow_get_graph":
        result = await workflowGraph.getWorkflowGraph(args!.workflow_id as string, args as Record<string, any>, Boolean(args?.include_config));
        break;
      case "didit_workflow_get_field_definitions":
        result = await workflowGraph.getWorkflowFieldDefinitions(args!.workflow_id as string, args as Record<string, any>);
        break;
      case "didit_workflow_get_feature_config_schema": {
        // Answered from the artifact this server ships with - no API call, so it
        // works before a workflow or an application even exists.
        const feature = args?.feature as string | undefined;
        if (feature && !FEATURE_CONFIG_SCHEMA.features[feature]) {
          throw new Error(
            `Unknown feature "${feature}". Known features: ${WORKFLOW_FEATURES.join(", ")}.`,
          );
        }
        result = {
          schema_version: FEATURE_CONFIG_SCHEMA.schema_version,
          checksum: FEATURE_CONFIG_CHECKSUM,
          source: FEATURE_CONFIG_SCHEMA.source,
          value_kinds: FEATURE_CONFIG_SCHEMA.value_kinds,
          features: feature
            ? { [feature]: FEATURE_CONFIG_SCHEMA.features[feature] }
            : FEATURE_CONFIG_SCHEMA.features,
        };
        break;
      }
      case "didit_workflow_get_id_verification_methods_catalog":
        result = await workflowGraph.getIdVerificationMethodsCatalog(args!.workflow_id as string, args as Record<string, any>);
        break;
      case "didit_workflow_get_kyb_registry_catalog":
        result = await workflowGraph.getKybRegistryCatalog(args?.countries);
        break;
      case "didit_workflow_get_branch_fields":
        result = await workflowGraph.getWorkflowBranchFields(
          args!.workflow_id as string,
          args!.graph,
          (args?.branch_node_id ?? args?.node_id) as string | undefined,
          args as Record<string, any>,
        );
        break;
      case "didit_workflow_validate_graph":
        result = await workflowGraph.validateWorkflowGraph(
          args?.workflow_id as string | undefined,
          args!.graph,
          args as Record<string, any>,
          Boolean(args?.include_config),
        );
        break;
      case "didit_workflow_edit_graph":
        result = await workflowGraph.editWorkflowGraph(
          args!.workflow_id as string,
          args!.operations as any[],
          Boolean(args?.publish),
          args as Record<string, any>,
        );
        break;
      case "didit_workflow_set_graph":
        result = await workflowGraph.setWorkflowGraph(
          args!.workflow_id as string,
          args!.graph,
          Boolean(args?.publish),
          args as Record<string, any>,
        );
        break;
      case "didit_workflow_create_draft":
        result = await workflowGraph.createWorkflowDraft(args!.workflow_id as string, args as Record<string, any>);
        break;
      case "didit_workflow_publish":
        result = await workflowGraph.publishWorkflow(args!.workflow_id as string, args as Record<string, any>);
        break;

      // Questionnaires
      case "didit_questionnaire_list":
        result = await questionnaires.listQuestionnaires();
        break;
      case "didit_questionnaire_create":
        result = await questionnaires.createQuestionnaire(args as Record<string, any>);
        break;
      case "didit_questionnaire_append_choices": {
        const { questionnaire_id, ...data } = args as Record<string, any>;
        result = await questionnaires.appendQuestionnaireChoices(questionnaire_id, data);
        break;
      }
      case "didit_questionnaire_get":
        result = await questionnaires.getQuestionnaire(
          args!.questionnaire_id as string,
          Boolean(args?.include_translations),
        );
        break;
      case "didit_questionnaire_update": {
        const { questionnaire_id, ...data } = args as Record<string, any>;
        result = await questionnaires.updateQuestionnaire(questionnaire_id, data);
        break;
      }
      case "didit_questionnaire_delete":
        result = await questionnaires.deleteQuestionnaire(args!.questionnaire_id as string);
        break;

      // Users
      case "didit_vendor_user_list":
        result = await users.listUsers(args as Record<string, string>);
        break;
      case "didit_vendor_user_create":
        result = await users.createUser(args as Record<string, any>);
        break;
      case "didit_vendor_user_get":
        result = await users.getUser(args!.vendor_data as string);
        break;
      case "didit_vendor_user_update": {
        const { vendor_data, ...data } = args as Record<string, any>;
        result = await users.updateUser(vendor_data, data);
        break;
      }
      case "didit_vendor_user_update_status":
        result = await users.updateUserStatus(args!.vendor_data as string, args!.status as string);
        break;
      case "didit_vendor_user_delete":
        result = await users.deleteUsers(args?.vendor_data_list as string[], args?.delete_all, args?.confirm);
        break;

      // Businesses
      case "didit_vendor_business_list":
        result = await businesses.listBusinesses(args as Record<string, string>);
        break;
      case "didit_vendor_business_create":
        result = await businesses.createBusiness(args as Record<string, any>);
        break;
      case "didit_vendor_business_get":
        result = await businesses.getBusiness(args!.vendor_data as string);
        break;
      case "didit_vendor_business_update": {
        const { vendor_data, ...data } = args as Record<string, any>;
        result = await businesses.updateBusiness(vendor_data, data);
        break;
      }
      case "didit_vendor_business_update_status":
        result = await businesses.updateBusinessStatus(args!.vendor_data as string, args!.status as string);
        break;
      case "didit_vendor_business_delete":
        result = await businesses.deleteBusinesses(
          args?.vendor_data_list as string[],
          args?.didit_internal_id_list as string[],
          args?.delete_all,
          args?.confirm,
        );
        break;

      // Transactions
      case "didit_transaction_list":
        result = await transactions.listTransactions(args as Record<string, string>);
        break;
      case "didit_transaction_create":
        result = await transactions.createTransaction(args as Record<string, any>);
        break;
      case "didit_transaction_get":
        result = await transactions.getTransaction(args!.transaction_id as string);
        break;
      case "didit_transaction_screen_wallet":
        result = await transactions.screenWallet(args as Record<string, any>);
        break;
      case "didit_transaction_sdk_token":
        result = await travelRule.mintSdkToken(args as Record<string, any>);
        break;
      case "didit_transaction_rule_list":
        result = await transactions.listTransactionRules(args as Record<string, any>);
        break;
      case "didit_transaction_rule_get":
        result = await transactions.getTransactionRule(args!.rule_uuid as string);
        break;
      case "didit_transaction_rule_create":
        result = await transactions.createTransactionRule(args as Record<string, any>);
        break;
      case "didit_transaction_rule_update": {
        const { rule_uuid, ...data } = args as Record<string, any>;
        result = await transactions.updateTransactionRule(rule_uuid as string, data);
        break;
      }
      case "didit_transaction_rule_delete":
        result = await transactions.deleteTransactionRule(args!.rule_uuid as string);
        break;
      case "didit_transaction_rule_backtest":
        result = await transactions.backtestTransactionRule(args as Record<string, any>);
        break;
      case "didit_transaction_rule_library_list":
        result = await transactions.listTransactionRuleLibrary(args as Record<string, any>);
        break;
      case "didit_transaction_rule_install":
        result = await transactions.installTransactionRuleLibrary(args as Record<string, any>);
        break;
      case "didit_transaction_rule_uninstall":
        result = await transactions.uninstallTransactionRuleLibrary(args as Record<string, any>);
        break;

      // Travel Rule
      case "didit_travel_rule_get_settings":
        result = await travelRule.getSettings(args as Record<string, any>);
        break;
      case "didit_travel_rule_update_settings":
        result = await travelRule.updateSettings(args as Record<string, any>);
        break;
      case "didit_travel_rule_search_vasps":
        result = await travelRule.searchVasps(args as Record<string, any>);
        break;
      case "didit_travel_rule_list_wallet_addresses":
        result = await travelRule.listWalletAddresses(args as Record<string, any>);
        break;
      case "didit_travel_rule_add_wallet_address":
        result = await travelRule.createWalletAddress(args as Record<string, any>);
        break;
      case "didit_travel_rule_update_wallet_address":
        result = await travelRule.updateWalletAddress(args as Record<string, any>);
        break;
      case "didit_travel_rule_delete_wallet_address":
        result = await travelRule.deleteWalletAddress(args as Record<string, any>);
        break;
      case "didit_travel_rule_transfer_action":
        result = await travelRule.transferAction(args as Record<string, any>);
        break;
      case "didit_travel_rule_confirm_ownership":
        result = await travelRule.confirmOwnership(args as Record<string, any>);
        break;
      case "didit_travel_rule_register_inbound":
        result = await travelRule.registerInbound(args as Record<string, any>);
        break;
      case "didit_travel_rule_create_widget_session":
        result = await travelRule.createWidgetSession(args as Record<string, any>);
        break;

      // Marketplace
      case "didit_marketplace_list_catalog":
        result = await marketplace.listCatalog(args as Record<string, any>);
        break;
      case "didit_marketplace_list_connections":
        result = await marketplace.listConnections(args as Record<string, any>);
        break;
      case "didit_marketplace_request_integration":
        result = await marketplace.requestIntegration(args as Record<string, any>);
        break;

      // Billing
      case "didit_org_get_balance":
        result = await billing.getBalance();
        break;
      case "didit_org_top_up":
        result = await billing.topUp(
          (args?.amount_in_dollars ?? args?.amount) as number,
          args?.confirm,
          args?.success_url as string,
          args?.cancel_url as string,
        );
        break;

      // Customization
      case "didit_branding_get":
        result = await customization.getCustomization();
        break;
      case "didit_branding_update":
        result = await customization.updateCustomization(args as Record<string, any>);
        break;

      // Webhook destinations
      case "didit_webhook_list":
        result = await webhooks.listDestinations();
        break;
      case "didit_webhook_create":
        result = await webhooks.createDestination(args as Record<string, any>);
        break;
      case "didit_webhook_get":
        result = await webhooks.getDestination(args!.destination_uuid as string);
        break;
      case "didit_webhook_update": {
        const { destination_uuid, ...data } = args as Record<string, any>;
        result = await webhooks.updateDestination(destination_uuid, data);
        break;
      }
      case "didit_webhook_delete":
        result = await webhooks.deleteDestination(args!.destination_uuid as string);
        break;

      // Lists
      case "didit_lists_list":
        result = await lists.listLists(args as Record<string, string>);
        break;
      case "didit_lists_create":
        result = await lists.createList(args as Record<string, any>);
        break;
      case "didit_lists_get":
        result = await lists.getListDetail(args!.list_uuid as string);
        break;
      case "didit_lists_update": {
        const { list_uuid: ulListUuid, ...ulData } = args as Record<string, any>;
        result = await lists.updateList(ulListUuid, ulData);
        break;
      }
      case "didit_lists_delete":
        result = await lists.deleteList(args!.list_uuid as string);
        break;
      case "didit_lists_entries_list": {
        const { list_uuid: leListUuid, ...leParams } = args as Record<string, string>;
        result = await lists.listEntries(leListUuid, leParams);
        break;
      }
      case "didit_lists_entry_create": {
        const { list_uuid: ceListUuid, ...ceData } = args as Record<string, any>;
        result = await lists.createEntry(ceListUuid, ceData);
        break;
      }
      case "didit_lists_entry_upload_face": {
        const { list_uuid: ufListUuid, image_path, image_base64, ...ufData } = args as Record<string, any>;
        result = await lists.uploadFaceEntry(ufListUuid, { image_path, image_base64, ...ufData });
        break;
      }
      case "didit_lists_entry_delete": {
        const { list_uuid: deListUuid, entry_uuid: deEntryUuid } = args as Record<string, string>;
        result = await lists.deleteEntry(deListUuid, deEntryUuid);
        break;
      }

      // Standalone: Identity & Documents
      case "didit_verify_id": {
        const { front_image_path, back_image_path, front_image_base64, back_image_base64, ...idOpts } =
          args as Record<string, any>;
        result = await standalone.idVerification(
          { path: front_image_path, base64: front_image_base64 },
          back_image_path || back_image_base64 ? { path: back_image_path, base64: back_image_base64 } : undefined,
          idOpts,
        );
        break;
      }
      case "didit_verify_poa": {
        const { document_image_path, document_image_base64, ...poaOpts } = args as Record<string, any>;
        result = await standalone.poaVerification(
          { path: document_image_path, base64: document_image_base64 },
          poaOpts,
        );
        break;
      }
      case "didit_verify_database":
        result = await standalone.databaseValidation(args as Record<string, any>);
        break;

      // Standalone: KYB registry
      case "didit_verify_kyb_search":
        result = await standalone.kybSearch(args as Record<string, any>);
        break;
      case "didit_verify_kyb_select":
        result = await standalone.kybSelect(args as Record<string, any>);
        break;

      // Standalone: Biometrics
      case "didit_verify_passive_liveness": {
        const { image_path, image_base64, ...plOpts } = args as Record<string, any>;
        result = await standalone.passiveLiveness({ path: image_path, base64: image_base64 }, plOpts);
        break;
      }
      case "didit_verify_face_match": {
        const { image_1_path, image_2_path, image_1_base64, image_2_base64, ...fmOpts } =
          args as Record<string, any>;
        result = await standalone.faceMatch(
          { path: image_1_path, base64: image_1_base64 },
          { path: image_2_path, base64: image_2_base64 },
          fmOpts,
        );
        break;
      }
      case "didit_verify_face_search": {
        const { image_path, image_base64, ...fsOpts } = args as Record<string, any>;
        result = await standalone.faceSearch({ path: image_path, base64: image_base64 }, fsOpts);
        break;
      }
      case "didit_verify_age": {
        const { image_path, image_base64, ...aeOpts } = args as Record<string, any>;
        result = await standalone.ageEstimation({ path: image_path, base64: image_base64 }, aeOpts);
        break;
      }

      // Standalone: AML
      case "didit_verify_aml":
        result = await standalone.amlScreening(args as Record<string, any>);
        break;

      // Standalone: Email & Phone
      case "didit_verify_email_send":
        result = await standalone.emailSend(args as Record<string, any>);
        break;
      case "didit_verify_email_check":
        result = await standalone.emailCheck(args as Record<string, any>);
        break;
      case "didit_verify_phone_send":
        result = await standalone.phoneSend(args as Record<string, any>);
        break;
      case "didit_verify_phone_check":
        result = await standalone.phoneCheck(args as Record<string, any>);
        break;

      // Blocklist / allowlist
      case "didit_blocklist_get":
        result = await blocklist.getBlocklist(args as Record<string, any>);
        break;
      case "didit_blocklist_add":
        result = await blocklist.addToBlocklist(args as Record<string, any>);
        break;
      case "didit_blocklist_remove":
        result = await blocklist.removeFromBlocklist(args as Record<string, any>);
        break;
      case "didit_allowlist_add":
        result = await blocklist.addToAllowlist(args as Record<string, any>);
        break;

      // Case management
      case "didit_case_list":
        result = await cases.listCases(args as Record<string, any>);
        break;
      case "didit_case_get":
        result = await cases.getCase(args!.case_id as string);
        break;
      case "didit_case_create":
        result = await cases.createCase(args as Record<string, any>);
        break;
      case "didit_case_statistics":
        result = await cases.caseStatistics(args as Record<string, any>);
        break;
      case "didit_case_manage":
        result = await cases.manageCase(args!.case_id as string, args!.action as string, (args?.data as Record<string, any>) || {}, args?.confirm);
        break;

      // Reports
      case "didit_report_list":
        result = await reports.listReports(args as Record<string, any>);
        break;
      case "didit_report_get":
        result = await reports.getReport(args!.report_id as string);
        break;
      case "didit_report_get_download_url":
        result = await reports.getReportDownloadUrl(args!.report_id as string);
        break;
      case "didit_report_export":
        result = await reports.exportReport(args!.kind as string, (args?.data as Record<string, any>) || {});
        break;

      // Audit logs + alerts
      case "didit_audit_log_list":
        result = await observability.listAuditLogs(args as Record<string, any>);
        break;
      case "didit_alert_list":
        result = await observability.listAlerts(args as Record<string, any>);
        break;
      case "didit_alert_configure":
        result = await observability.configureAlert(args!.alert_type as string, (args?.data as Record<string, any>) || {});
        break;

      // Org members / roles / API keys
      case "didit_org_list_members":
        result = await members.listMembers(args?.organization_id as string | undefined, args as Record<string, any>);
        break;
      case "didit_org_invite_member":
        result = await members.inviteMember(args as Record<string, any>, args?.organization_id as string | undefined);
        break;
      case "didit_org_update_member":
        result = await members.updateMember(args!.member_id as string, args as Record<string, any>, args?.organization_id as string | undefined);
        break;
      case "didit_org_remove_member":
        result = await members.removeMember(args!.member_id as string, args?.organization_id as string | undefined);
        break;
      case "didit_org_list_roles":
        result = await members.listRoles(args?.organization_id as string | undefined);
        break;
      case "didit_org_list_api_keys":
        result = await members.listApiKeys(args?.organization_id as string | undefined, args?.application_id as string | undefined);
        break;

      // Compliance
      case "didit_compliance_requirements":
        result = await compliance.getRequirements(args as Record<string, string>);
        break;
      case "didit_compliance_check_workflow":
        result = await compliance.checkWorkflow(args as Record<string, any>);
        break;
      case "didit_compliance_interview_next":
        result = await compliance.interviewNext(args as Record<string, any>);
        break;
      case "didit_compliance_profile_get":
        result = await compliance.getProfile();
        break;
      case "didit_compliance_profile_set":
        result = await compliance.setProfile(args as Record<string, any>);
        break;
      case "didit_compliance_generate_workflow":
        result = await compliance.generateWorkflow(args as Record<string, any>);
        break;
      case "didit_workflow_build_graph":
        result = await compliance.buildWorkflow(args as Record<string, any>);
        break;

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    // Annotated here, after BOTH paths (the scoped list and the cross-app aggregate
    // fallback) have produced their rows, so the flag behaves the same either way.
    if (name === "didit_workflow_list" && args?.include_age_assurance) {
      result = await workflowGraph.annotateAgeAssurance(result);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { value: result },
    };
  } catch (error: any) {
    // Structured, sanitized error: code/field/hint/allowed surfaced; backend secrets,
    // PII and local paths stripped; structuredContent OMITTED so a strict client never
    // validates an error against the tool's success outputSchema.
    const shape = toSafeErrorShape(error);
    const fieldLine = shape.field ? `\nField: ${shape.field}` : "";
    const hintLine = shape.hint ? `\nHint: ${shape.hint}` : "";
    const allowedLine = shape.allowed && shape.allowed.length ? `\nAllowed: ${shape.allowed.join(", ")}` : "";
    return {
      content: [{ type: "text", text: `Error [${shape.code}]: ${shape.message}${fieldLine}${hintLine}${allowedLine}` }],
      isError: true,
    };
  }
      }),
    );
  });

  return server;
}

async function main() {
  const transport = new StdioServerTransport();
  const server = createServer({ profile: resolveCatalogProfile(MCP_TOOL_PROFILE) });
  await server.connect(transport);
  console.error(`Didit MCP Server v${SERVER_VERSION} running on stdio`);
}

// Only auto-start the stdio server when this file is run directly — when the HTTP
// entrypoint (src/http.ts) imports createServer(), main() must NOT fire.
if (require.main === module) {
  main().catch(console.error);
}

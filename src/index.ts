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
import * as customization from "./tools/customization";
import * as webhooks from "./tools/webhooks";
import * as questionnaires from "./tools/questionnaires";
import * as lists from "./tools/lists";
import * as standalone from "./tools/standalone";
import * as blocklist from "./tools/blocklist";
import * as cases from "./tools/cases";
import * as reports from "./tools/reports";
import * as observability from "./tools/observability";
import * as members from "./tools/members";
import * as context from "./tools/context";
import * as search from "./tools/search";
import * as workflowGraph from "./tools/workflow-graph";
import * as analytics from "./tools/analytics";
import { requestContext } from "./config";
import { getOrgAppMap } from "./orgapp";
import { toSafeErrorShape, DiditError } from "./security";

// Single source of truth for the version: package.json (falls back if unreadable).
export let SERVER_VERSION = "5.0.0";
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SERVER_VERSION = require("../package.json").version || SERVER_VERSION;
} catch {
  /* keep fallback */
}

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

// Real backend FormElementType (questionnaires/config/choices.py) — uppercase.
const FORM_ELEMENT_TYPES = [
  "SHORT_TEXT", "LONG_TEXT", "PARAGRAPH", "DROPDOWN", "SINGLE_CHOICE", "MULTIPLE_CHOICE",
  "NUMBER", "IMAGE", "FILE_UPLOAD", "TIME", "EMAIL", "ADDRESS", "PHONE", "COUNTRY",
  "DATE_PICKER", "CONSENT", "SECTION_HEADER", "SEPARATOR", "HEADING", "REPEATABLE_GROUP",
];
const FORM_ELEMENTS_PROP = {
  form_elements: {
    type: "array",
    description:
      "REQUIRED. Array of form-element objects. Each: { element_type (uppercase, one of the allowed types), title (object of locale→string, e.g. {\"en\":\"Your name\"}), is_required (bool), and for choice types a `choices` array }.",
    items: {
      type: "object",
      properties: {
        element_type: { type: "string", enum: FORM_ELEMENT_TYPES, description: "Element type (UPPERCASE)" },
        title: { type: "object", description: "Locale → label, e.g. {\"en\":\"Question text\"}" },
        is_required: { type: "boolean" },
        choices: { type: "array", description: "Options for DROPDOWN/SINGLE_CHOICE/MULTIPLE_CHOICE" },
      },
      required: ["element_type"],
    },
  },
} as const;

const WORKFLOW_FEATURES = [
  "OCR", "NFC", "LIVENESS", "FACE_MATCH", "PROOF_OF_ADDRESS", "QUESTIONNAIRE",
  "PHONE_VERIFICATION", "EMAIL_VERIFICATION", "DATABASE_VALIDATION", "AML",
  "IP_ANALYSIS", "AGE_ESTIMATION", "KYB_REGISTRY", "KYB_DOCUMENTS", "KYB_KEY_PEOPLE",
  "DOCUMENT_AI",
];

const WORKFLOW_FEATURE_ITEM = {
  type: "object" as const,
  properties: {
    feature: { type: "string", enum: WORKFLOW_FEATURES, description: "Feature to run (uppercase)" },
    config: { type: "object", description: "Feature-specific settings (e.g. face_liveness_method, questionnaire_uuid, documents_allowed)" },
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
    "Node/branching workflow graph: { start_node, nodes }. `start_node` is the id of the entry " +
    "node (must be a feature node). `nodes` maps nodeId → node. Node shapes: " +
    "feature = {node_type:'feature', feature:<UPPERCASE, e.g. OCR|DOCUMENT_AI>, config?:{}, next?:<id>, branches?:[]}; " +
    "branch = {node_type:'branch', branches:[{id, logic:'and'|'or', rules:[{field, operator, value, score?}], goto:<id>}], next?:<id fallback>}; " +
    "status (TERMINAL) = {node_type:'status', session_status:'Approved'|'Declined'|'In Review'|'Determine'}. " +
    "Branches are evaluated in order, first match wins; an empty rules:[] is the else/catch-all (kept last). " +
    "Operators include `fuzzy_match` (string fields only, needs a `score` 0-100). Reference a feature's outcome " +
    "with e.g. kyc.status / document_ai.status, and an extracted value with kyc.extra_fields.profession. " +
    "Document AI: feature:'DOCUMENT_AI' with config.document_ai_documents:[{document_key,title,description,fields:[{key,name,type:'text'|'number'|'date',required}]}]. " +
    "Validate with didit_workflow_validate_graph before didit_workflow_set_graph. Get valid fields/operators from didit_workflow_get_field_definitions.",
  properties: {
    start_node: { type: "string", description: "Entry node id (a feature node)." },
    nodes: { type: "object", description: "Map of nodeId → node object (see the node shapes above)." },
  },
  required: ["start_node", "nodes"],
} as const;

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
    description: "Application UUID (from didit_org_list_applications). Optional if a default application is configured.",
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
  ["case_", "Cases"],
  ["webhook_", "Webhooks & Alerts"],
  ["alert_", "Webhooks & Alerts"],
  ["report_", "Reports & Audit"],
  ["audit_", "Reports & Audit"],
  ["analytics", "Reports & Audit"],
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
]);

// Account bootstrap tools accept passwords/OTP codes and are only for unauthenticated
// stdio setup. Hosted OAuth clients already have a user Bearer token and should not see
// credential-collection tools in their public app catalog.
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
  if (SCOPE_AGNOSTIC_TOOLS.has(name)) return;
  const store = requestContext.getStore();
  if (!store?.accessToken) return; // no Bearer (env-default scope) — resolver will surface the error
  if (store.organizationId && store.applicationId) return;
  try {
    const map = await getOrgAppMap();
    if (!store.organizationId && map.length === 1) store.organizationId = map[0].orgId;
    if (!store.applicationId) {
      const org = store.organizationId
        ? map.find((o) => o.orgId === store.organizationId)
        : map.length === 1
          ? map[0]
          : undefined;
      if (org && org.apps.length === 1) store.applicationId = org.apps[0].appId;
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
const READ_VERB_TOKENS = new Set(["list", "get", "search", "statistics", "analytics", "export", "pdf", "validate"]);
const DESTRUCTIVE_VERB_TOKENS = new Set(["delete", "remove"]);
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
 */
export function createServer(): Server {
  const server = new Server(
    { name: "didit", version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
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
          confirm: { type: "boolean", description: "REQUIRED. Must be true to expose the raw key." },
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

    // ── Sessions ────────────────────────────────────────────────────────
    {
      name: "didit_session_create",
      description: "Create a verification session. Requires workflow_id (created in the Console Workflows page) — the workflow defines which steps run and whether the session is KYC or KYB. Returns session_id, url, and session_token.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "REQUIRED. UUID of the workflow that defines the verification steps. Selects KYC vs KYB implicitly." },
          vendor_data: { type: "string", description: "Your unique identifier for the user (e.g. user ID). Used to group sessions into a user/business." },
          callback: { type: "string", description: "URL to redirect the user to after verification" },
          callback_method: { type: "string", enum: ["initiator", "completer", "both"], description: "Which device/flow the callback applies to" },
          language: { type: "string", enum: LANGUAGE_CODES, description: "Pre-set the verification UI language (ISO code)" },
          metadata: { type: "object", description: "Arbitrary JSON stored on the session and echoed in webhooks" },
          contact_details: { type: "object", description: "Pre-fill contact info (e.g. email, phone) for the session" },
          expected_details: { type: "object", description: "Expected values to validate against (e.g. expected country, IP)" },
          portrait_image: { type: "string", description: "Base64 or URL reference portrait used by some workflows" },
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
      description: "Permanently delete a single verification session and all associated data.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "didit_session_batch_delete",
      description: "Delete multiple sessions by session numbers, or delete all sessions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_numbers: {
            type: "array",
            items: { type: "number" },
            description: "Array of session numbers to delete",
          },
          delete_all: { type: "boolean", description: "Set true to delete ALL sessions (ignores session_numbers)" },
        },
      },
    },
    {
      name: "didit_session_generate_pdf",
      description: "Generate a PDF verification report for a session.",
      inputSchema: {
        type: "object" as const,
        properties: {
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
      description: "List verification workflows. With multiple apps (or no scope) it auto-spans every app, each row tagged with its org/app. To find one workflow by id/label across all apps, prefer didit_workflow_search.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    {
      name: "didit_workflow_create",
      description: "Create a SIMPLE (linear) verification workflow from an ordered list of features. Send `features` (uppercase feature values, in execution order) — NOT flat is_*_enabled flags or a workflow_type (those are rejected with 400). Put dependency features first (e.g. OCR before FACE_MATCH/NFC/DATABASE_VALIDATION). KYB workflows use KYB_REGISTRY/KYB_DOCUMENTS/KYB_KEY_PEOPLE. For BRANCHING / conditional logic (e.g. decline on a status, route on an extracted field, Document-AI proof-of-funds), use the graph tools instead: didit_workflow_get_field_definitions → build a graph → didit_workflow_validate_graph → didit_workflow_set_graph.",
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
      description: "Get the full configuration of a specific workflow.",
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
      description: "Update a SIMPLE (linear) workflow's top-level settings or its flat `features` array (same shape as create). This does NOT add branching — to add conditional branches, a Document-AI step, or any node/graph logic, use didit_workflow_set_graph (it never flattens a graph into a linear list). Editing features retroactively affects how past sessions' decisions are read, so change deliberately.",
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
      description: "Delete a verification workflow. Existing sessions using it are not affected.",
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
      description: "Find verification workflows ACROSS ALL your apps/orgs in one call. Pass `workflow_id` to locate a specific workflow by its version uuid OR stable workflow_id (returns which org/app it lives in), or `search` to match by label. Use this instead of guessing the application when you only have a workflow id.",
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
      description: "Get the node/graph for a workflow (the structure: nodes, branches, conditions, Document-AI steps) + `status`/`version`/`is_editable`. Large feature configs (documents_allowed, poa_documents_allowed, phone countries) are SUMMARIZED by default so the response never overflows — set `include_config:true` for the raw config. Pass just `workflow_id`; the owning org/app is resolved automatically. To MODIFY the graph, prefer didit_workflow_edit_graph (small ops, no need to resend big configs).",
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
          workflow_id: { type: "string", description: "Any workflow in the target application (used to resolve the app)" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    {
      name: "didit_workflow_get_branch_fields",
      description: "Given a candidate graph and a branch node, return the fields actually available at that point (only features that completed on every path reaching the branch, plus dynamically-derived Document-AI/questionnaire fields).",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          graph: WORKFLOW_GRAPH_SCHEMA,
          node_id: { type: "string", description: "The branch node id to evaluate availability at" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id", "graph"],
      },
    },
    {
      name: "didit_workflow_validate_graph",
      description: "Dry-run validate a graph WITHOUT saving. Returns per-node errors (bad field/operator, missing dependency, branching on a field before its feature runs, etc.). Always validate before didit_workflow_set_graph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          graph: WORKFLOW_GRAPH_SCHEMA,
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id", "graph"],
      },
    },
    {
      name: "didit_workflow_edit_graph",
      description: "MODIFY an existing workflow's graph with small OPERATIONS — the right tool for editing a live workflow. You send only the deltas; the MCP fetches the full current graph SERVER-SIDE, applies your ops, validates, auto-creates a DRAFT (the live version is never touched), and saves. This means huge feature configs (documents_allowed, poa_documents_allowed, phone countries) are preserved exactly and you NEVER resend them. Validation failures return `applied:false` with the errors (nothing saved). Example to insert a branch after OCR and rejoin the existing pipeline at the Liveness node: ops = [ {op:'set_next', node_id:'<ocr_node>', next:'branch1'}, {op:'set_node', node_id:'branch1', node:{node_type:'branch', branches:[{id:'declined',logic:'or',rules:[{field:'kyc.status',operator:'equals',value:'Declined'}],goto:'decline1'},{id:'eng',logic:'and',rules:[{field:'kyc.extra_fields.profession',operator:'fuzzy_match',value:'Software Engineer',score:80}],goto:'pof1'}], next:'<liveness_node>'}}, {op:'set_node', node_id:'decline1', node:{node_type:'status',session_status:'Declined'}}, {op:'set_node', node_id:'pof1', node:{node_type:'feature',feature:'DOCUMENT_AI',config:{document_ai_documents:[...]},next:'<liveness_node>'}} ].",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          operations: {
            type: "array",
            minItems: 1,
            description: "Ordered edits applied to the full server-side graph. Each: one of — {op:'set_node', node_id, node:{…}} upsert a node; {op:'remove_node', node_id}; {op:'set_next', node_id, next:'<id|null>'} rewire a node's unconditional next; {op:'set_branches', node_id, branches:[…]} set conditional branches; {op:'merge_node_config', node_id, config:{…}} shallow-merge config keys (preserves the big allow-lists); {op:'set_start', start_node}.",
            items: { type: "object", properties: { op: { type: "string", enum: ["set_node", "remove_node", "set_next", "set_branches", "merge_node_config", "set_start"] }, node_id: { type: "string" }, node: { type: "object" }, next: { type: ["string", "null"] }, branches: { type: "array" }, config: { type: "object" }, start_node: { type: "string" } }, required: ["op"] },
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
      description: "Publish a draft workflow version — makes it the live version for NEW sessions. Existing sessions are unaffected.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Draft workflow version uuid or stable workflow_id" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },

    // ── Questionnaires ──────────────────────────────────────────────────
    {
      name: "didit_questionnaire_list",
      description: "List all custom questionnaires for your application.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "didit_questionnaire_create",
      description: "Create a custom questionnaire. The backend expects `title` + `form_elements` (an array of form-element objects, each with an UPPERCASE element_type) — NOT `questions`.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Questionnaire title" },
          description: { type: "string", description: "Description shown to the user" },
          ...FORM_ELEMENTS_PROP,
        },
        required: ["title", "form_elements"],
      },
    },
    {
      name: "didit_questionnaire_get",
      description: "Get full details of a specific questionnaire (questions, options, translations).",
      inputSchema: {
        type: "object" as const,
        properties: {
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
        },
        required: ["questionnaire_id"],
      },
    },
    {
      name: "didit_questionnaire_update",
      description: "Update a questionnaire's title, description, or form_elements (array of form-element objects with UPPERCASE element_type).",
      inputSchema: {
        type: "object" as const,
        properties: {
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
          title: { type: "string" },
          description: { type: "string" },
          ...FORM_ELEMENTS_PROP,
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
          vendor_data_list: {
            type: "array",
            items: { type: "string" },
            description: "Array of vendor_data values to delete",
          },
          delete_all: { type: "boolean", description: "Set true to delete ALL users" },
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
          vendor_data_list: { type: "array", items: { type: "string" } },
          didit_internal_id_list: { type: "array", items: { type: "string" } },
          delete_all: { type: "boolean", description: "Set true to delete ALL businesses" },
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

    // ── Billing ─────────────────────────────────────────────────────────
    {
      name: "didit_org_get_balance",
      description: "Get current credit balance and auto-refill settings.",
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
        },
        required: ["amount_in_dollars"],
      },
    },

    // ── Customization (verification UI branding) ────────────────────────
    {
      name: "didit_branding_get",
      description: "Get the current branding customization (logos, colors) applied to your verification UI.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "didit_branding_update",
      description: "Update verification UI branding images. Provide absolute file paths for the images you want to set.",
      inputSchema: {
        type: "object" as const,
        properties: {
          image_square_path: { type: "string", description: "Absolute path to a square logo image" },
          image_rectangular_path: { type: "string", description: "Absolute path to a rectangular logo image" },
          image_favicon_path: { type: "string", description: "Absolute path to a favicon image" },
        },
      },
    },

    // ── Webhook destinations ────────────────────────────────────────────
    {
      name: "didit_webhook_list",
      description: "List configured webhook destinations. Each destination has its own URL, version, enabled flag, subscribed events, and redacted signing-secret metadata.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "didit_webhook_create",
      description: "Create a webhook destination. The signing secret is redacted in the response.",
      inputSchema: {
        type: "object" as const,
        properties: {
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
      description: "Add a face entry to a face list by uploading an image directly (no session needed). Use this when you have a photo but no reference_session_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          list_uuid: { type: "string", description: "UUID of a face-type list" },
          image_path: { type: "string", description: "Absolute path to the face image file" },
          display_label: { type: "string" },
          comment: { type: "string" },
        },
        required: ["list_uuid", "image_path"],
      },
    },
    {
      name: "didit_lists_entry_delete",
      description: "Remove an entry from a list. Also unblocks the underlying user/business if applicable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          list_uuid: { type: "string", description: "UUID of the list" },
          entry_uuid: { type: "string", description: "UUID of the entry to remove" },
        },
        required: ["list_uuid", "entry_uuid"],
      },
    },

    // ── Standalone: Identity & Documents ────────────────────────────────
    {
      name: "didit_verify_id",
      description: "Verify an identity document by submitting front (and optionally back) images. Returns structured OCR data and authenticity checks.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          front_image_path: { type: "string", description: "Absolute path to front image file" },
          back_image_path: { type: "string", description: "Absolute path to back image file (optional)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
          perform_document_liveness: { type: "boolean", description: "Run document-presence (anti-screenshot) checks" },
          minimum_age: { type: "number", description: "Decline if the extracted age is below this value" },
          preferred_characters: { type: "string", enum: ["latin", "non_latin"], description: "Preferred OCR script" },
        },
        required: ["front_image_path"],
      },
    },
    {
      name: "didit_verify_poa",
      description: "Proof of Address verification. Submit a single document image to extract and validate address information.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          document_image_path: { type: "string", description: "Absolute path to the POA document image" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
          expected_address: { type: "string", description: "Address to validate the document against" },
          expected_country: { type: "string", description: "ISO 3166-1 alpha-2 country code to validate against" },
          expected_first_name: { type: "string" },
          expected_last_name: { type: "string" },
        },
        required: ["document_image_path"],
      },
    },
    {
      name: "didit_verify_database",
      description: "Validate identity data against national and global authoritative data sources. issuing_state (ISO 3166-1 alpha-2) is required and selects which sources run.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          issuing_state: { type: "string", description: "REQUIRED. ISO 3166-1 alpha-2 country code that selects the data sources to query" },
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
      description: "Passive liveness detection -- verify a person is physically present from a single image (no interaction required).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_path: { type: "string", description: "Absolute path to facial image file" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
        required: ["image_path"],
      },
    },
    {
      name: "didit_verify_face_match",
      description: "Compare two facial images to determine if they belong to the same person (1:1 face matching). The score is symmetric, so image order does not affect the result.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_1_path: { type: "string", description: "Absolute path to the first facial image (e.g. the selfie)" },
          image_2_path: { type: "string", description: "Absolute path to the second facial image (e.g. the ID portrait)" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
        required: ["image_1_path", "image_2_path"],
      },
    },
    {
      name: "didit_verify_face_search",
      description: "Search for a face against a database of previously verified faces (1:N face matching).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_path: { type: "string", description: "Absolute path to facial image file" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
        required: ["image_path"],
      },
    },
    {
      name: "didit_verify_age",
      description: "Estimate a person's age from a facial image. Also performs passive liveness check.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          image_path: { type: "string", description: "Absolute path to facial image file" },
          vendor_data: { type: "string", description: "Optional identifier to link the result to a user" },
        },
        required: ["image_path"],
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
      description: "Start an export report. kind ∈ sessions | transactions | businesses | vendor-users | vendor-businesses.",
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
  ];
  const hasUserBearer = Boolean(extra?.authInfo?.token || process.env.DIDIT_ACCESS_TOKEN);
  const visible = hasUserBearer ? tools.filter((t) => !HOSTED_APP_EXCLUDED_TOOLS.has(t.name)) : tools;
  // Annotate each tool so the connector UI splits them into Read-only / Write / Destructive
  // groups (driven by readOnlyHint + destructiveHint) instead of one flat "Other tools"
  // bucket; also tag the logical domain group via _meta for future UI use.
  return {
    tools: visible.map((t) => ({
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
      },
      async () => {
  const { name, arguments: args } = request.params;

  // Single-org/single-app callers: fill the default scope so they needn't pass/discover ids.
  await ensureScopeDefaults(name);

  try {
    let result: any;

    // Multi-tenant caller invoked a per-app list tool with no resolvable scope: span all apps
    // (same shape as the *_search sibling) instead of throwing, so the first call succeeds.
    const aggregate = aggregateFallbackFor(name);
    if (aggregate) {
      result = await aggregate((args ?? {}) as Record<string, any>);
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
        result = await auth.listApplications(args!.organization_id as string, args?.access_token as string | undefined);
        break;
      case "didit_org_get_application":
        result = await auth.getApplication(args!.organization_id as string, args!.application_id as string, args?.access_token as string | undefined);
        break;
      case "didit_org_reveal_application_api_key":
        result = await auth.revealApplicationApiKey(args?.organization_id, args?.application_id, args?.confirm, args?.access_token as string | undefined);
        break;

      // Context + cross-org/app aggregate search
      case "didit_context_get":
        result = await context.getContext();
        break;
      case "didit_session_search":
        result = await search.searchSessions((args ?? {}) as Record<string, any>);
        break;
      case "didit_transaction_search":
        result = await search.searchTransactions((args ?? {}) as Record<string, any>);
        break;
      case "didit_case_search":
        result = await search.searchCases((args ?? {}) as Record<string, any>);
        break;
      case "didit_vendor_user_search":
        result = await search.searchVendorUsers((args ?? {}) as Record<string, any>);
        break;
      case "didit_vendor_business_search":
        result = await search.searchVendorBusinesses((args ?? {}) as Record<string, any>);
        break;
      case "didit_analytics":
        result = await analytics.analytics((args ?? {}) as Record<string, any>);
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
        result = await sessions.deleteSession(args!.session_id as string);
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
        result = await search.searchWorkflows((args ?? {}) as Record<string, any>);
        break;
      case "didit_workflow_get_graph":
        result = await workflowGraph.getWorkflowGraph(args!.workflow_id as string, args as Record<string, any>, Boolean(args?.include_config));
        break;
      case "didit_workflow_get_field_definitions":
        result = await workflowGraph.getWorkflowFieldDefinitions(args!.workflow_id as string, args as Record<string, any>);
        break;
      case "didit_workflow_get_branch_fields":
        result = await workflowGraph.getWorkflowBranchFields(
          args!.workflow_id as string,
          args!.graph,
          args?.node_id as string | undefined,
          args as Record<string, any>,
        );
        break;
      case "didit_workflow_validate_graph":
        result = await workflowGraph.validateWorkflowGraph(args!.workflow_id as string, args!.graph, args as Record<string, any>);
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
      case "didit_questionnaire_get":
        result = await questionnaires.getQuestionnaire(args!.questionnaire_id as string);
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
        const { list_uuid: ufListUuid, image_path, ...ufData } = args as Record<string, any>;
        result = await lists.uploadFaceEntry(ufListUuid, { image_path, ...ufData });
        break;
      }
      case "didit_lists_entry_delete": {
        const { list_uuid: deListUuid, entry_uuid: deEntryUuid } = args as Record<string, string>;
        result = await lists.deleteEntry(deListUuid, deEntryUuid);
        break;
      }

      // Standalone: Identity & Documents
      case "didit_verify_id": {
        const { front_image_path, back_image_path, ...idOpts } = args as Record<string, any>;
        result = await standalone.idVerification(front_image_path, back_image_path, idOpts);
        break;
      }
      case "didit_verify_poa": {
        const { document_image_path, ...poaOpts } = args as Record<string, any>;
        result = await standalone.poaVerification(document_image_path, poaOpts);
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
        const { image_path, ...plOpts } = args as Record<string, any>;
        result = await standalone.passiveLiveness(image_path, plOpts);
        break;
      }
      case "didit_verify_face_match": {
        const { image_1_path, image_2_path, ...fmOpts } = args as Record<string, any>;
        result = await standalone.faceMatch(image_1_path, image_2_path, fmOpts);
        break;
      }
      case "didit_verify_face_search": {
        const { image_path, ...fsOpts } = args as Record<string, any>;
        result = await standalone.faceSearch(image_path, fsOpts);
        break;
      }
      case "didit_verify_age": {
        const { image_path, ...aeOpts } = args as Record<string, any>;
        result = await standalone.ageEstimation(image_path, aeOpts);
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

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
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
      },
    );
  });

  return server;
}

async function main() {
  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
  console.error(`Didit MCP Server v${SERVER_VERSION} running on stdio`);
}

// Only auto-start the stdio server when this file is run directly — when the HTTP
// entrypoint (src/http.ts) imports createServer(), main() must NOT fire.
if (require.main === module) {
  main().catch(console.error);
}

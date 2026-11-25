#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import * as auth from "./tools/auth";
import { SESSION_IMPORT_TOOLS, SESSION_TOOLS } from "./tools/sessions";
import { SESSION_REVIEW_TOOLS } from "./tools/session-review";
import { KYB_TOOLS } from "./tools/kyb";
import { explainSessionDecision } from "./tools/session-explain";
import { WORKFLOW_TOOLS } from "./tools/workflows";
import * as billing from "./tools/billing";
import { BILLING_TOOLS } from "./tools/billing";
import { VENDOR_USER_TOOLS } from "./tools/users";
import { VENDOR_BUSINESS_TOOLS } from "./tools/businesses";
import { RULE_CONTRACT_PROPS, TRANSACTION_RULE_TOOLS, TRANSACTION_TOOLS } from "./tools/transactions";
import { EVENT_TOOLS } from "./tools/events";
import { MONITORING_TOOLS } from "./tools/monitoring";
import { BRANDING_TOOLS } from "./tools/customization";
import { AUTHENTICATION_TOOLS } from "./tools/authentication";
import { MESSAGE_TOOLS } from "./tools/messages";
import { PHONE_TOOLS } from "./tools/phone";
import { BANK_DATA_TOOLS } from "./tools/bank-data";
import { WEBHOOK_TOOLS } from "./tools/webhooks";
import { REGISTERED_TOOLS } from "./tools/registered";
import { ENTITY_STATUSES, LAST_N_DAYS_PROP, SESSION_STATUSES, WORKFLOW_GRAPH_SCHEMA } from "./tools/shared-schema";
import { registeredAnnotations } from "./tools/registry";
import { QUESTIONNAIRE_TOOLS } from "./tools/questionnaires";
import { LIST_TOOLS } from "./tools/lists";
import {
  STANDALONE_AML_TOOLS,
  STANDALONE_BIOMETRIC_TOOLS,
  STANDALONE_CONTACT_TOOLS,
  STANDALONE_DOCUMENT_TOOLS,
  STANDALONE_INTELLIGENCE_TOOLS,
  STANDALONE_KYB_TOOLS,
} from "./tools/standalone";
import {
  PRIVILEGED_TOOL_DEFS,
  PRIVILEGED_READ_TOOLS,
  isPrivilegedToolName,
  isPrivilegedCaller,
  dispatchPrivilegedTool,
} from "./privileged-tools";
import {
  internalToolDefs,
  isInternalToolName,
  dispatchInternalTool,
  INTERNAL_DESTRUCTIVE_TOOLS,
  INTERNAL_OPEN_WORLD_TOOLS,
  INTERNAL_READ_TOOLS,
  REGULATION_GRAPH_HINT,
} from "./internal-tools";
import { BLOCKLIST_TOOLS } from "./tools/blocklist";
import { CASE_TOOLS } from "./tools/cases";
import { REGULATORY_REPORT_TOOLS } from "./tools/regulatory-reports";
import {
  INVESTIGATOR_DECISION_TOOLS,
  INVESTIGATOR_OPEN_WORLD_TOOLS,
  INVESTIGATOR_TOOL_DEFS,
  INVESTIGATOR_WRITE_TOOLS,
  actorViaFromHeaders,
  dispatchInvestigatorTool,
  isInvestigatorToolName,
} from "./tools/investigator";
import { REPORT_TOOLS } from "./tools/reports";
import { AUDIT_AND_ALERT_TOOLS } from "./tools/observability";
import { ORG_MEMBER_TOOLS } from "./tools/members";
import * as context from "./tools/context";
import { SEARCH_TOOLS } from "./tools/search";
import * as analytics from "./tools/analytics";
import * as compliance from "./tools/compliance";
import { DeviceLoginError } from "./device-login";
import { keepSignIn, localGrantScopes, localSignInToken } from "./account-session";
import {
  KEY_ONLY_TOOLS,
  PERSON_ONLY_TOOLS,
  apiKeyApplication,
  apiKeyOrganizations,
  apiKeyScopeOf,
  apiKeyScopeRefusal,
  keyOnlyRefusal,
  personOnlyRefusal,
} from "./api-key-connection";
import { loginCliCommand, runLoginCli } from "./login-cli";
import { requestContext, stripRoutingIds, SERVER_VERSION, permissionMode } from "./config";
import { dropBlankOptionals, type InputSchema } from "./blank-args";
import { applyCatalogProfile, applyCatalogResult, catalogProfileRefusal, stdioCatalogProfile, CONSOLE_OPEN_TOOL, consoleOpenResult, listWidgetResources, profileServesWidgets, readWidgetResource, widgetToolMeta, widgetTools, type CatalogProfile, type CatalogTool } from "./chatgpt-app";
import { APPLICATION_IDS_PROP, getOrgAppMap, ORG_APP_PROPS } from "./orgapp";
import { MAX_PAGE_SIZE, PAGE_PROPS, pageParams } from "./paging";
import { toSafeErrorShape, DiditError } from "./security";
// Type only: wakeshift.ts (and @wakeshift/sdk) load only when http.ts turns Wakeshift on.
import type { WakeshiftHooks } from "./wakeshift";
import { auditToolCall } from "./audit-log";
import {
  acceptedPermissions,
  currentAccessRefusal,
  decidePermission,
  isAuthenticationSetup,
  setupCredentialRefusal,
  missingPermissionError,
  tokenPermissions,
  type LiveAccess,
  type OrganizationAccess,
} from "./permissions";
import { liveAccessFor } from "./live-access";
import {
  FULL_SELECTION,
  SELECTABLE_TOOLSET_IDS,
  TOOLSETS,
  selectionFromArgv,
  selectionLabel,
  selectionLists,
  toolGroupOf,
  toolsetOf,
  type CatalogSelection,
} from "./toolsets";
import {
  TOOL_CALL_READ,
  TOOL_CALL_WRITE,
  TOOL_DESCRIBE,
  TOOL_SEARCH,
  describeTools,
  discoveryToolDefs,
  isToolCallProxy,
  searchTools,
  unwrapToolCall,
  type DiscoverableTool,
} from "./tools/discovery";
import { DOCS_SEARCH_TOOL, docsMcpUrl, docsSearchToolDef, searchDocs } from "./tools/docs";
import { getPrompt, listPrompts, serverInstructions } from "./guidance";


// Tool names are domain-first (`didit_<domain>_<action>`). The name prefix decides both the
// toolset a tool loads with and the group a connector's permission screen shows it under
// (`_meta["anthropic/toolGroup"]`): see toolsets.ts.

// Tools that don't operate on an org/app scope — never auto-resolve a default for them.
const SCOPE_AGNOSTIC_NAMED = [
  "didit_account_register",
  "didit_account_verify_email",
  "didit_account_resend_otp",
  "didit_account_login",
  "didit_account_verify_2fa",
  "didit_account_device_login_start",
  "didit_account_device_login_poll",
  "didit_org_list",
  "didit_context_get",
  // The catalog and the documentation are the same whatever the organization.
  TOOL_SEARCH,
  TOOL_DESCRIBE,
  DOCS_SEARCH_TOOL,
];
const SCOPE_AGNOSTIC_TOOLS = new Set([
  ...SCOPE_AGNOSTIC_NAMED,
  // A registered tool declares it (tools/registry.ts).
  ...[...REGISTERED_TOOLS.values()].filter((tool) => tool.scopeAgnostic).map((tool) => tool.def.name),
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
  "didit_account_verify_2fa",
  "didit_account_device_login_start",
  "didit_account_device_login_poll",
]);

// These tools remain available in local/stdio contexts, but should not be part
// of the authenticated ChatGPT app catalog because public app review disallows
// digital-credit checkout flows and live credential/secret exposure.
const MONEY_TOOL = "didit_org_top_up";

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
      // `default_application_id`. Requiring a single ORG here (the earlier rule) is what
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
      } else if (candidates.length > 0) {
        // Several applications (or one, with an organization that could not be listed): the call
        // is not guessed for. The resolver's error names these, so the retry needs no lookup.
        store.scopeChoices = scoped.flatMap((o) =>
          o.apps.map((a) => ({
            organizationId: o.orgId,
            organizationName: o.orgName,
            applicationId: a.appId,
            applicationName: a.appName,
            ...(a.mode ? { mode: a.mode } : {}),
          })),
        );
        store.scopeChoicesPartial = blind;
      }
    }
  } catch {
    /* discovery failed — let the normal resolver surface the actionable error */
  }
}


/**
 * The application a call ACTS ON, for the caller's live membership to judge, or undefined when the
 * tool acts on the organization itself.
 *
 * What a tool's scope already declares decides it, never a list of tool names:
 * - a tool carrying the shared routing id (`ORG_APP_PROPS.application_id`, the documented "optional
 *   when you own exactly one application — it is resolved automatically") acts on one application,
 *   and the dispatcher resolves it when the caller names none, so the resolved default is judged
 *   too. Identity, not the property name: `didit_audit_log_list` takes an `application_id` that
 *   only narrows the organization's log and never routes the call, so it words its own and stays
 *   an organization-level tool.
 * - a tool that words its own `application_id` and REQUIRES it (creating an API key for one
 *   application) acts on the id the caller sends, and on no other.
 * Anything else is organization-level: an application it never acts in must not refuse it.
 */
function applicationForCall(
  schema: { properties?: Record<string, unknown>; required?: readonly string[] } | undefined,
  namedApp: string | undefined,
  resolvedApp: string | undefined,
): string | undefined {
  const properties = schema?.properties;
  if (!properties || !("application_id" in properties)) return undefined;
  if (properties.application_id === ORG_APP_PROPS.application_id) return namedApp ?? resolvedApp;
  return schema?.required?.includes("application_id") ? namedApp : undefined;
}

/**
 * The organization whose membership lists this application — from the same 60 s organisation map the
 * scope defaults are resolved from (orgapp.ts), so a call that names only an `application_id` (a
 * member of several organizations naming one of their applications) can still be judged by the live
 * answer for the organization it acts in. No extra request: the map is the one the resolver already
 * read for this call.
 */
async function organizationOfApplication(applicationId: string): Promise<string | undefined> {
  try {
    const map = await getOrgAppMap();
    const wanted = applicationId.toLowerCase();

    return map.find((o) => o.apps.some((a) => a.appId.toLowerCase() === wanted))?.orgId;
  } catch {
    return undefined; // discovery failed: the live check is skipped, as when no organization resolves
  }
}

// Per-app list tools that have a cross-org/app aggregate sibling declare it (spanAllApplications,
// tools/registry.ts). A multi-tenant caller who invokes one of these without a resolvable scope
// would otherwise hit "organization_id is required". Instead we transparently span every app
// (identical to the matching *_search tool: newest-first, each row attributed to its org/app), so a
// general "list my sessions" by a multi-app user succeeds on the FIRST call rather than erroring
// then recovering.
//
// The aggregate to run in place of a per-app list when scope is unresolved; undefined when the
// caller is fully scoped (org+app present) and the real single-app list should run.
function aggregateFallbackFor(name: string): ((a: Record<string, any>) => Promise<any>) | undefined {
  const fn = REGISTERED_TOOLS.get(name)?.spanAllApplications;
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
// name: revealing a live secret, moving money, consequential decisions, and overwrites.
const EXPLICIT_DESTRUCTIVE_TOOLS = new Set([
  "didit_org_reveal_application_api_key",
  "didit_org_top_up",
  // Investigator decisions and policy answers: human decisions behind confirm:true.
  ...INVESTIGATOR_DECISION_TOOLS,
  ...INTERNAL_DESTRUCTIVE_TOOLS,
  // Runs any tool that changes data (tools/discovery.ts), so a client asks before each call.
  TOOL_CALL_WRITE,
]);

// Tools that can reach outside the current Didit workspace/account boundary by
// sending email/SMS, creating third-party checkout, registering webhook delivery
// endpoints, or sharing verification data with a partner.
const EXPLICIT_OPEN_WORLD_TOOLS = new Set([
  "didit_account_register",
  "didit_account_resend_otp",
  "didit_org_top_up",
  ...INVESTIGATOR_OPEN_WORLD_TOOLS,
  ...INTERNAL_OPEN_WORLD_TOOLS,
]);

// These tools have names that include read-like tokens, but their handlers
// create server-side artifacts/jobs rather than strictly retrieving data.
const EXPLICIT_WRITE_TOOLS = new Set([
  ...INVESTIGATOR_WRITE_TOOLS,
]);

// The inverse: tools whose names carry no read-like token but whose handlers never
// change server state (requirements/workflow-check are deterministic reads over the
// stored profile + knowledge base; interview/next is pure computation; generate_workflow
// computes and returns a graph WITHOUT persisting anything — the backend view only
// requires read:workflows, and applying the graph goes through the didit_workflow_* writes).
const EXPLICIT_READ_TOOLS = new Set([
  ...INTERNAL_READ_TOOLS,
  ...PRIVILEGED_READ_TOOLS,
  // build_graph computes a graph from a plain feature spec, persisting nothing.
  "didit_workflow_build_graph",
  // Discovery (tools/discovery.ts): describe reads the catalog, call_read refuses anything that writes.
  TOOL_DESCRIBE,
  TOOL_CALL_READ,
]);

/**
 * Every table in this file that is keyed by a tool's name, for the one test that holds them to
 * the tool list (test/tables-name-real-tools.test.mjs).
 *
 * A tool is defined in one place and classified in several. Rename it in its definition and not
 * here, and nothing fails: the entry simply stops matching. A destructive tool then reads as an
 * ordinary write and a client no longer asks before running it; a tool kept off the hosted
 * server is listed there again. So an entry that names no tool is an error, not dead weight.
 */
export const NAME_KEYED_TABLES: Readonly<Record<string, readonly string[]>> = {
  SCOPE_AGNOSTIC_TOOLS: SCOPE_AGNOSTIC_NAMED,
  ACCOUNT_BOOTSTRAP_TOOLS: [...ACCOUNT_BOOTSTRAP_TOOLS],
  HOSTED_APP_EXCLUDED_TOOLS: [...HOSTED_APP_EXCLUDED_TOOLS],
  EXPLICIT_DESTRUCTIVE_TOOLS: [...EXPLICIT_DESTRUCTIVE_TOOLS],
  EXPLICIT_OPEN_WORLD_TOOLS: [...EXPLICIT_OPEN_WORLD_TOOLS],
  EXPLICIT_WRITE_TOOLS: [...EXPLICIT_WRITE_TOOLS],
  EXPLICIT_READ_TOOLS: [...EXPLICIT_READ_TOOLS],
};

function annotationsFor(name: string): {
  title: string;
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint: boolean;
} {
  const tokens = name.replace(/^didit_/, "").split("_");
  const title = toolTitle(name);
  // A registered tool says what it does itself (tools/registry.ts); the tables below hold the rest.
  const registered = REGISTERED_TOOLS.get(name);
  if (registered) return registeredAnnotations(registered, title);
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

// ---------------------------------------------------------------------------
// Listing a tool without what a model does not need repeated
// ---------------------------------------------------------------------------
// Nearly every tool takes the two routing ids. A listed tool carries them in one short line
// each; the server instructions (guidance.ts) explain once how they resolve.
const ROUTING_ID_SUMMARY = {
  organization_id: "Organization id.",
  application_id: "Application id (didit_context_get).",
} as const;
const ROUTING_ID_OPTIONAL = " Optional.";
// So does every paged list, for its two paging arguments.
const PAGE_SUMMARY = {
  limit: { type: "number", description: `1 to ${MAX_PAGE_SIZE}. \`count\` is the total.` },
  offset: { type: "number", description: "How many you already read." },
} as const;

function trimDefinition(tool: CatalogTool): CatalogTool {
  const properties = tool.inputSchema?.properties;
  if (!properties) return tool;
  const required = new Set(tool.inputSchema?.required ?? []);
  const trimmed: Record<string, unknown> = { ...properties };
  let changed = false;
  // Identity, not name: a tool that words its own organization_id ("REQUIRED. ...") keeps it.
  for (const key of ["organization_id", "application_id"] as const) {
    if (properties[key] === ORG_APP_PROPS[key]) {
      trimmed[key] = { type: "string", description: ROUTING_ID_SUMMARY[key] + (required.has(key) ? "" : ROUTING_ID_OPTIONAL) };
      changed = true;
    }
  }

  for (const key of ["limit", "offset"] as const) {
    if (properties[key] === PAGE_PROPS[key]) {
      trimmed[key] = PAGE_SUMMARY[key];
      changed = true;
    }
  }

  return changed ? { ...tool, inputSchema: { ...tool.inputSchema, properties: trimmed } } : tool;
}

const ROUTING_IDS = ["organization_id", "application_id", "application_ids"] as const;

/**
 * An API key connection is one application (api-key-connection.ts): every tool acts on it, and
 * a call that names another one is refused. Its tools therefore do not take the two routing ids
 * at all. A model cannot get them wrong, and about 36 KB of the tool list is not sent.
 */
function withoutRoutingIds(tool: CatalogTool): CatalogTool {
  const schema = tool.inputSchema;
  const properties = schema?.properties;
  if (!schema || !properties || !ROUTING_IDS.some((key) => key in properties)) return tool;
  const isRoutingId = (key: string): boolean => (ROUTING_IDS as readonly string[]).includes(key);
  const kept = Object.fromEntries(Object.entries(properties).filter(([key]) => !isRoutingId(key)));
  const { required: declared, ...rest } = schema;
  const required = (declared ?? []).filter((key) => !isRoutingId(key));

  return { ...tool, inputSchema: { ...rest, properties: kept, ...(required.length > 0 ? { required } : {}) } };
}

/** A tool as one connection is given it, in tools/list and by the discovery tools alike. */
function definitionFor(tool: CatalogTool, connection: { apiKey: boolean }): CatalogTool {
  return connection.apiKey ? withoutRoutingIds(tool) : trimDefinition(tool);
}

// The workflow graph manual (WORKFLOW_GRAPH_SCHEMA: about 26 KB of text, a tenth of the whole
// list) is the `graph` argument of the tool that saves a graph and of the tool that validates
// one. A connection that lists both gets the manual once and a pointer to it on the other tool.
//
// The manual stays on the tool that SAVES. A graph built without the feature-config contract
// and saved is the failure this manual exists to prevent (the API drops a config key it does
// not know, and nothing fails: test/feature-config-contract.test.mjs), so the saving tool never
// depends on another definition having been read. A graph built without it and only CHECKED
// comes back with its errors, and the pointer says where the contract is.
//
// A tool shown on its own (didit_tool_describe, or a list without the saving tool, such as a
// read-only connection) always carries the manual itself.
const GRAPH_MANUAL_TOOL = "didit_workflow_set_graph";
// Only the text goes: the shape itself (start_node, nodes, both required) costs 250 bytes and is
// what lets a client check a graph before it makes the call.
const GRAPH_MANUAL_POINTER = {
  ...WORKFLOW_GRAPH_SCHEMA,
  description:
    `The graph to check, { start_node, nodes }: exactly the object the \`graph\` argument of ${GRAPH_MANUAL_TOOL} ` +
    "describes (node shapes, branches, operators, every feature's config keys, allow-list shorthands). Read that " +
    "description to build the graph, check it here, then save it there.",
};

function shareGraphManual(tools: CatalogTool[]): CatalogTool[] {
  if (!tools.some((tool) => tool.name === GRAPH_MANUAL_TOOL)) return tools;

  return tools.map((tool) => {
    const properties = tool.inputSchema?.properties;
    // Identity, not name: a tool that words its own `graph` argument keeps it.
    if (tool.name === GRAPH_MANUAL_TOOL || properties?.graph !== WORKFLOW_GRAPH_SCHEMA) return tool;

    return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...properties, graph: GRAPH_MANUAL_POINTER } } };
  });
}

// The transaction rule contract (RULE_CONTRACT_PROPS) is shared the same way: its text stays on the
// tool that creates a rule, and the update and backtest tools of the same list keep its whole shape
// (types, enums, patterns, required) with a pointer in place of each text.
const RULE_CONTRACT_TOOL = "didit_transaction_rule_create";

function withoutText(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutText);
  if (!schema || typeof schema !== "object") return schema;
  const entries = Object.entries(schema).filter(([key, value]) => !(key === "description" && typeof value === "string"));

  return Object.fromEntries(entries.map(([key, value]) => [key, withoutText(value)]));
}

const RULE_CONTRACT_POINTERS = Object.fromEntries(
  Object.entries(RULE_CONTRACT_PROPS).map(([key, schema]) => [
    key,
    { ...(withoutText(schema) as object), description: `As in ${RULE_CONTRACT_TOOL}.` },
  ]),
);

function shareRuleContract(tools: CatalogTool[]): CatalogTool[] {
  if (!tools.some((tool) => tool.name === RULE_CONTRACT_TOOL)) return tools;

  return tools.map((tool) => {
    const properties = tool.inputSchema?.properties;
    // Identity, not name: a tool that words its own argument keeps it.
    const isShared = (key: string): boolean => properties?.[key] !== undefined && properties[key] === RULE_CONTRACT_PROPS[key];
    if (tool.name === RULE_CONTRACT_TOOL || !Object.keys(RULE_CONTRACT_PROPS).some(isShared)) return tool;
    const shared = Object.fromEntries(
      Object.entries(properties ?? {}).map(([key, schema]) => [key, isShared(key) ? RULE_CONTRACT_POINTERS[key] : schema]),
    );

    return { ...tool, inputSchema: { ...tool.inputSchema, properties: shared } };
  });
}

/** What a server announces about itself, kept so the modern dispatch can answer server/discover. */
export interface ServerDescriptor {
  capabilities: { tools: {}; prompts?: {}; resources?: {} };
  instructions?: string;
}
const serverDescriptors = new WeakMap<Server, ServerDescriptor>();

/** The capabilities and instructions `createServer` gave this server. */
export function serverDescriptorOf(server: Server): ServerDescriptor {
  return serverDescriptors.get(server) ?? { capabilities: { tools: {} } };
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
 * `profile` selects the catalog served (see chatgpt-app.ts): `full` (default) or `chatgpt`,
 * the reduced allow-list the hosted server exposes at /mcp/chatgpt for the ChatGPT app store.
 *
 * `selection` is what one connection asked to load (toolsets.ts): which toolsets tools/list
 * returns and whether the connection is read-only. Omitted, nothing is narrowed. The entry
 * points pass it: http.ts from the request URL and headers, the stdio main from argv and env.
 */
export function createServer(
  options: {
    hosted?: boolean;
    profile?: CatalogProfile;
    moneyTools?: boolean;
    selection?: CatalogSelection;
    /**
     * The connection authenticated with an application API key (api-key-connection.ts). Only what
     * the server SAYS about itself reads this: the instructions are written before any request is
     * seen. What a key may list and call is decided per request, from the verified credential.
     */
    apiKey?: boolean;
    /** Wakeshift (wakeshift.ts): handed in by http.ts only when it is on. */
    wakeshift?: WakeshiftHooks;
    /**
     * The caller's CURRENT access to one organization, read from service-didit-auth on every
     * tool call (permissions.ts `currentAccessRefusal`). http.ts hands it in only for the
     * introspection mode: an API key is an application, a stdio token is the person's own, and a
     * JWKS-verified token has no live membership to ask about.
     */
    liveAccess?: LiveAccess;
  } = {},
): Server {
  const hosted = options.hosted === true;
  const describesApiKey = hosted && options.apiKey === true;
  const profile: CatalogProfile = options.profile ?? "full";
  // The reduced ChatGPT catalog is an allow-list that was reviewed tool by tool, descriptor by
  // descriptor. It is served exactly as it is defined: never narrowed by a selection, never
  // trimmed, with no discovery tools, instructions or prompts. Everything below that is new
  // behaviour is gated on `lean`.
  const lean = profile === "full";
  const selection: CatalogSelection = lean ? options.selection ?? FULL_SELECTION : FULL_SELECTION;
  // Wakeshift (wakeshift.ts): handed in by http.ts only when it is on, and served only on the
  // hosted full profile (every toolset selection of it). stdio and the ChatGPT catalog never see it.
  const wakeshift = hosted && lean ? options.wakeshift : undefined;
  // The watch tools Wakeshift adds read Didit and change no Didit data (wakeshift.ts): read-only.
  const annotate = (name: string): ReturnType<typeof annotationsFor> =>
    wakeshift?.readOnly(name) ? { ...annotationsFor(name), readOnlyHint: true, destructiveHint: false } : annotationsFor(name);
  // THE money gate of the hosted server. Every hosted endpoint hides and refuses didit_org_top_up
  // unless it passes `moneyTools: true`, and only the unlisted /mcp/payments endpoint does (http.ts).
  // It never opens on a reduced catalog profile (the ChatGPT catalog has no credit-purchase flow),
  // and stdio is the person's own local server, where the tool is always offered. Checked in three
  // places below: tools/list, the tools/call refusal, and the balance enrichment.
  const moneyTools = hosted && options.moneyTools === true && profile === "full";
  const hostedMoneyBlocked = hosted && !moneyTools;

  // `access_token` on the auth-service discovery tools is a stdio full-profile convenience: it lets
  // someone running the local server hand over the Bearer that didit_account_login returned.
  // A hosted server authenticates with OAuth and reads the caller's Bearer from
  // requestContext, so the property is never needed there - and advertising it would solicit
  // an authentication secret through tool arguments, which the OpenAI Apps guidelines
  // prohibit outright ("do not collect, solicit, or process ... access credentials and
  // authentication secrets"; app review finding policy-review-47fabf436877, 2026-09).
  // Hosted catalogs omit both the property and the sentence that tells the model to fill it,
  // on EVERY profile - the full catalog at /mcp is a public directory listing too. The stdio
  // ChatGPT profile mirrors this omission for local catalog review.
  const stdioOnlyAccessToken = (description: string) =>
    hosted || profile === "chatgpt" ? {} : { access_token: { type: "string" as const, description } };
  const stdioTokenHint = hosted || profile === "chatgpt" ? "" : " In stdio mode the sign-in from login/verify_email is used automatically.";
  // Call-time mirror: hosted and ChatGPT calls never process a token handed in as
  // an argument, even if a client crafted one from a memorised stdio schema. Ignoring (rather
  // than refusing) keeps every existing hosted caller working - the header Bearer that already
  // authenticated the request is the identity used either way.
  const stdioAccessTokenArg = (a?: Record<string, unknown>): string | undefined =>
    hosted || profile === "chatgpt" ? undefined : (a?.access_token as string | undefined);

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------
  // Built per call of tools/list (the catalog is filtered per caller below) and
  // once for the dispatcher, which reads each tool's `required` list to tell a
  // blank optional argument from a blank required one (blank-args.ts).
  const toolDefinitions = () => [
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
      description:
        "Verify email with the 6-character code. Returns the new organization with its live application and its sandbox_application (each with client_id and api_key) and an access_token, " +
        "and signs the local server in: the tools that follow are authenticated automatically. " +
        "If the account already has two-factor authentication it returns 2fa_required (and a temp_token when it has an authenticator) instead of tokens: finish with didit_account_verify_2fa. " +
        "If the account's organization enforces SSO it returns sso_required: no token or API key is issued here, so ask the person to sign in through their organization's SSO in the Didit console in a browser; do not retry.",
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
      description:
        "Log in to an existing Didit account. Signs the local server in, so the tools that follow are authenticated automatically, and returns access_token. If the account has two-factor " +
        "authentication it returns 2fa_required and a temp_token instead: finish with didit_account_verify_2fa. " +
        "If the account's organization enforces SSO it returns sso_required: no token is issued by password, so ask the person to sign in through SSO in the console, or use didit_account_device_login_start. " +
        "For an account that signs in with a passkey or SSO (no password), use didit_account_device_login_start instead.",
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
      name: "didit_account_device_login_start",
      description:
        "Sign in WITHOUT a password or local browser (OAuth device code): returns a short user_code and a URL the " +
        "person opens on any device to approve this connection. Works for passkey and SSO accounts. Then call " +
        "didit_account_device_login_poll. Credentials are stored locally and used automatically afterwards.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "didit_account_device_login_poll",
      description:
        "Wait (up to about 45 seconds) for the person to approve the sign-in started with " +
        "didit_account_device_login_start. Returns status pending (call again) or connected with the granted scope.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "didit_account_verify_2fa",
      description:
        "Finish logging in to an account with two-factor authentication, using the temp_token from didit_account_login " +
        "and the current 6-digit authenticator code (or an unused backup code). Signs the local server in, like didit_account_login, and returns access_token.",
      inputSchema: {
        type: "object" as const,
        properties: {
          temp_token: { type: "string", description: "temp_token returned by didit_account_login (valid for 5 minutes)" },
          code: { type: "string", description: "6-digit code from the authenticator app, or an unused backup code" },
        },
        required: ["temp_token", "code"],
      },
    },
    {
      name: "didit_org_list",
      description:
        "List the organizations you belong to (each has an id to pass as organization_id to other tools). In hosted OAuth mode no arguments are needed." +
        stdioTokenHint,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...stdioOnlyAccessToken("Only for stdio mode, and only to act as another account than the one signed in: a Bearer access token from login/verify_email."),
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
          ...stdioOnlyAccessToken("Only for stdio mode. Omit in hosted OAuth mode."),
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
          ...stdioOnlyAccessToken("Only for stdio mode. Omit in hosted OAuth mode."),
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
          ...stdioOnlyAccessToken("Only for stdio mode."),
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
    // Search across every organization and application the caller can open
    // Declared with what they do, their permission and their handler in tools/search.ts.
    ...SEARCH_TOOLS.map((tool) => tool.def),

    {
      name: "didit_analytics",
      description:
        "Aggregate verification analytics ACROSS ALL your apps and organizations in one call - the efficient way to answer questions like \"how many people tried phone verification but dropped off in the last 15 days?\". Returns summed status counts (request_breakdown), a feature_funnel (how many sessions REACHED each step: OCR, LIVENESS, FACE_MATCH, AML, POA, PHONE, EMAIL, ...), warning_stats by risk code, the previous period's request_breakdown, per-workflow session totals and a recomputed conversion_rate, for a date window. Omit organization_id/application_id to span everything; pass them to narrow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          date_from: { type: "string", description: "ISO date lower bound (YYYY-MM-DD)" },
          date_to: { type: "string", description: "ISO date upper bound (YYYY-MM-DD)" },
          ...LAST_N_DAYS_PROP,
          include_timeseries: { type: "boolean", description: "Also return per-day time series (heavier). Default false." },
          workflow_ids: { type: "array", items: { type: "string" }, description: "Only these workflows" },
          country: { type: "string", description: "Country codes, comma separated" },
          compare: { type: "string", enum: ["previous_period", "same_period_last_year"], description: "What the previous_* numbers describe" },
          today_by_hour: { type: "boolean", description: "Instead: today's verifications per hour and outcome, against the same weekday last week" },
          time_zone: { type: "string", description: "IANA zone of today_by_hour (default UTC)" },
          ...ORG_APP_PROPS,
          ...APPLICATION_IDS_PROP,
        },
      },
    },
    ...internalToolDefs("network"),

    // ── Sessions ────────────────────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/sessions.ts.
    ...SESSION_TOOLS.map((tool) => tool.def),
    ...SESSION_REVIEW_TOOLS.map((tool) => tool.def),
    ...KYB_TOOLS.map((tool) => tool.def),

    // ── Session Imports (bulk migration) ────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/sessions.ts.
    ...SESSION_IMPORT_TOOLS.map((tool) => tool.def),

    // ── Workflows (Verification Settings) ───────────────────────────────
    // Declared with what they do, their permission and their handler in tools/workflows.ts.
    ...WORKFLOW_TOOLS.map((tool) => tool.def),

    // ── Questionnaires ──────────────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/questionnaires.ts.
    ...QUESTIONNAIRE_TOOLS.map((tool) => tool.def),

    // ── Users (verified individuals / KYC) ──────────────────────────────
    // Declared with what they do, their permission and their handler in tools/users.ts.
    ...VENDOR_USER_TOOLS.map((tool) => tool.def),

    // ── Businesses (KYB) ────────────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/businesses.ts.
    ...VENDOR_BUSINESS_TOOLS.map((tool) => tool.def),

    // ── AML ongoing monitoring of users and businesses ──────────────────
    // Declared with what they do, their permission and their handler in tools/monitoring.ts.
    ...MONITORING_TOOLS.map((tool) => tool.def),

    // ── Transactions (AML transaction monitoring) ───────────────────────
    // Declared with what they do, their permission and their handler in tools/transactions.ts.
    ...TRANSACTION_TOOLS.map((tool) => tool.def),

    ...internalToolDefs("transaction_sdk_token"),
    // Transaction-monitoring rules
    // Declared with what they do, their permission and their handler in tools/transactions.ts.
    ...TRANSACTION_RULE_TOOLS.map((tool) => tool.def),

    // ── Monitoring events ───────────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/events.ts.
    ...EVENT_TOOLS.map((tool) => tool.def),

    // ── Travel Rule (FATF / EU TFR managed exchange) ─────────────────────
    ...internalToolDefs("travel_rule"),

    // ── Marketplace (provider catalog & connections) ─────────────────────
    ...internalToolDefs("marketplace"),

    // ── Billing ─────────────────────────────────────────────────────────
    {
      name: "didit_org_get_balance",
      description:
        "Get current credit balance and auto-refill settings. Every check is billed from the first one: " +
        "from 1 Nov 2026 an eligible Free organization gets $10 of monthly credit usable on any feature, paid " +
        "plans carry their monthly plan credit (Growth $115, Scale $350), and no workflow is free of charge. " +
        "The Free credit is decided per organization: `free_credit.receives` says whether this one gets it, " +
        "and `free_credit.this_month` holds this month's credit, also once used up. `free_credit.eligibility` " +
        "says why an organization does NOT get it, because the credit needs a work email: personal_email " +
        "means it signed up with a personal email, temporary_email with a temporary one, company_exists " +
        "that its company already has an organization, api_created that it was created through the API. " +
        "Such an organization never had the credit, so it was not used up. Answer from these fields, never " +
        "from the plan alone; when `free_credit` is absent, say you could not read it. Never answer " +
        "a \"not enough credits\" report from this result alone: read the failing workflow with " +
        "didit_workflow_list first - `is_white_label_enabled: true` adds $0.20/session, which is a common " +
        "cause of credit running out faster than expected. This result also carries `allow_free_usage` " +
        "(organizations on negotiated terms keep the monthly free allowance they were sold until renewal; " +
        "false means that allowance is off for this organization) and `usage_summary.white_label_sessions`. " +
        "When the balance cannot cover what the person wants to run, give them `next_steps.top_up_url` (the console " +
        "top-up dialog with the amount filled in; replace the number to change it) or `next_steps.automatic_top_up_url` " +
        "(save a card and turn on automatic top-up so the balance never runs out). Didit tools never charge a card. " +
        "Meanwhile keep building in the organization's sandbox application (`mode: sandbox` in didit_context_get), " +
        "which is never billed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: ORG_APP_PROPS.organization_id,
          date_from: { type: "string", description: "Usage from (YYYY-MM-DD); never filters the balance" },
          date_to: { type: "string" },
          usage_application_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      name: "didit_org_top_up",
      description:
        "Top up credits ($50 to $20,000 per top-up). payment_method \"checkout\" (default) creates a Stripe Checkout " +
        "page and returns checkout_session_url for the person to pay; it never charges a card by itself. " +
        "payment_method \"saved_card\" charges the organization's saved primary card off-session, now, when a person " +
        "turned on \"Connected AI agents can top up with your saved card\" in the Didit console (Billing > Payment " +
        "methods; off by default; didit_org_get_balance shows it as agent_top_up.enabled where this tool is offered). " +
        "It needs idempotency_key: choose ONE unique key per intended top-up (for example a UUID) and reuse that same " +
        "key on any retry of that same top-up, so a retry can never charge twice; never reuse a key for another " +
        "amount and never retry with a new key. A refusal carries `code`, `detail` and `next_step` {action, url, " +
        "description}: agent_top_up_not_enabled (the switch is off), authentication_required (the card's bank asks the " +
        "cardholder to approve), payment_method_required (no saved card) and card_declined are finished by the " +
        "person: give them next_step.url (a Top up dialog link that says which agent asked, with the amount filled in).",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: ORG_APP_PROPS.organization_id,
          amount_in_dollars: { type: "number", description: "Amount in USD (minimum $50, maximum $20,000 per self-serve top-up)" },
          payment_method: {
            type: "string",
            enum: ["checkout", "saved_card"],
            description:
              "checkout (default): a Stripe Checkout page for the person to pay. saved_card: charge the organization's saved primary card now, only while a person has turned on the agent top-up switch in the console; requires idempotency_key.",
          },
          idempotency_key: {
            type: "string",
            minLength: 1,
            maxLength: 255,
            description:
              "REQUIRED for payment_method saved_card (1 to 255 characters). One unique key per intended top-up; reuse the same key on any retry of that same top-up so the card is never charged twice. Ignored for checkout.",
          },
          confirm: {
            type: "boolean",
            description:
              "REQUIRED. Must be true. Only set after explicit user confirmation of this exact action: checkout creates a payment page, saved_card charges the saved card immediately.",
          },
        },
        required: ["amount_in_dollars"],
      },
    },

    // Plan, payment methods, receipts and billing details
    // Declared with what they do, their permission and their handler in tools/billing.ts.
    ...BILLING_TOOLS.map((tool) => tool.def),

    // ── Customization (verification UI branding) ────────────────────────
    // Declared with what they do, their permission and their handler in tools/customization.ts.
    ...BRANDING_TOOLS.map((tool) => tool.def),

    // ── Webhook destinations ────────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/webhooks.ts.
    ...WEBHOOK_TOOLS.map((tool) => tool.def),

    // ── Lists (Blocklists, Allowlists & Custom) ─────────────────────────
    // Declared with what they do, their permission and their handler in tools/lists.ts.
    ...LIST_TOOLS.map((tool) => tool.def),

    // ── Standalone: Identity & Documents ────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/standalone.ts.
    ...STANDALONE_DOCUMENT_TOOLS.map((tool) => tool.def),

    // ── Standalone: KYB registry ────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/standalone.ts.
    ...STANDALONE_KYB_TOOLS.map((tool) => tool.def),

    // ── Standalone: Biometrics & Face ───────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/standalone.ts.
    ...STANDALONE_BIOMETRIC_TOOLS.map((tool) => tool.def),

    // ── Standalone: AML Screening ───────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/standalone.ts.
    ...STANDALONE_AML_TOOLS.map((tool) => tool.def),

    // ── Standalone: Email & Phone Verification ──────────────────────────
    // Declared with what they do, their permission and their handler in tools/standalone.ts.
    ...STANDALONE_CONTACT_TOOLS.map((tool) => tool.def),
    ...PHONE_TOOLS.map((tool) => tool.def),

    // ── Standalone: document contents, address, risk and fraud ──────────
    // Declared with what they do, their permission and their handler in tools/standalone.ts.
    ...STANDALONE_INTELLIGENCE_TOOLS.map((tool) => tool.def),

    // ── Messages (reads) ────────────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/messages.ts.
    ...MESSAGE_TOOLS.map((tool) => tool.def),

    // ── Blocklist / Allowlist ───────────────────────────────────────────
    // The blocklist and the allowlist are written from a SESSION: an entry is an item that session
    // holds (its face, its document, its phone number, its email address), never a free value.
    // Declared with what they do, their permission and their handler in tools/blocklist.ts.
    ...BLOCKLIST_TOOLS.map((tool) => tool.def),

    // ── Case management ─────────────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/cases.ts.
    ...CASE_TOOLS.map((tool) => tool.def),
    ...REGULATORY_REPORT_TOOLS.map((tool) => tool.def),

    // ── Investigator (AI case reviewer; decisions need human approval) ──
    ...INVESTIGATOR_TOOL_DEFS,

    // ── Reports (async exports) ─────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/reports.ts.
    ...REPORT_TOOLS.map((tool) => tool.def),

    // ── Audit logs + alerts ─────────────────────────────────────────────
    // Declared with what they do, their permission and their handler in tools/observability.ts.
    ...AUDIT_AND_ALERT_TOOLS.map((tool) => tool.def),

    // ── Org members / roles / API keys (apx/auth/v2) ────────────────────
    // Declared with what they do, their permission and their handler in tools/members.ts.
    ...ORG_MEMBER_TOOLS.map((tool) => tool.def),

    // ── Didit Authentication setup (apx/auth/v2) ────────────────────────
    // Declared with what they do, their permission and their handler in tools/authentication.ts.
    ...AUTHENTICATION_TOOLS.map((tool) => tool.def),

    // ── Bank data and Bank Link (/v3/bank/, application API key) ────────
    // Declared with what they do, their permission and their handler in tools/bank-data.ts.
    ...BANK_DATA_TOOLS.map((tool) => tool.def),

    // ── Compliance ──────────────────────────────────────────────────────
    ...internalToolDefs("compliance"),

    {
      name: "didit_workflow_build_graph",
      description:
        "Build a complete workflow graph from a PLAIN FEATURE SPEC in one deterministic call - regulations are " +
        "never consulted" + REGULATION_GRAPH_HINT + ". Gate-then-commit: " +
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
              "The TRUNK: the steps EVERY session runs, by feature code (OCR, LIVENESS, FACE_MATCH, NFC, " +
              "PROOF_OF_ADDRESS, QUESTIONNAIRE, PHONE_VERIFICATION, EMAIL_VERIFICATION, AGE_ESTIMATION, " +
              "IP_ANALYSIS, AML, DATABASE_VALIDATION, DOCUMENT_AI; KYB: KYB_REGISTRY, KYB_DOCUMENTS, " +
              "KYB_KEY_PEOPLE). ONLY steps the user NAMED: NEVER add 'standard' steps uninvited ('only id " +
              "verification' means OCR and nothing else); the builder itself adds true dependencies and orders " +
              "the chain. A step only SOME countries take goes in that branch's features ONLY, never here too " +
              "('ID verification, then liveness and AML for UAE IDs, otherwise finish' = features [OCR] + " +
              "branches [{countries: ['UAE'], features: ['LIVENESS', 'AML']}]).",
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
              "Country branches after the routing step; unmatched countries take the else path to the final decision. The ONLY key that carries branching.",
            items: {
              type: "object",
              properties: {
                countries: {
                  type: "array",
                  items: { type: "string" },
                  description: "Countries exactly as the user named them (a name or ISO3 code per entry).",
                },
                features: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The steps ONLY these countries take, after the trunk's routing step. Never repeat a trunk step here.",
                },
              },
              required: ["countries", "features"],
              additionalProperties: false,
            },
          },
        },
        // CLOSED, like every nested object above it. The root was the one level
        // left open, and a model filled it: `branch_rules` for `branches`
        // reached the backend's serializer and three console users of one
        // organization lost their workflow to its 400. Client-side
        // validation of this is best-effort — buildWorkflow enforces it.
        additionalProperties: false,
      },
    },

    // The documentation, searched from the same connection (tools/docs.ts).
    ...(docsMcpUrl() ? [docsSearchToolDef()] : []),

    ...PRIVILEGED_TOOL_DEFS,
    ...(wakeshift?.toolDefinitions ?? []),
  ].map((t) => (wakeshift ? { ...t, description: wakeshift.describe(t.name, t.description) } : t));
  const inputSchemaByTool = new Map(toolDefinitions().map((t) => [t.name, t.inputSchema as InputSchema]));

  // ---------------------------------------------------------------------------
  // What a caller may use, and what a connection lists
  // ---------------------------------------------------------------------------
  /**
   * Every tool this caller may use on this endpoint, before the connection's selection
   * narrows what is LISTED. tools/list, the discovery tools and the server instructions all
   * start from here, so they can never disagree about what exists.
   */
  const usableBy = (authInfo: AuthInfo | undefined): CatalogTool[] => {
    // Privileged operational tools are emitted ONLY to privileged connections; everyone else never
    // sees them in tools/list (and a call is rejected below). In the open-source build there are none.
    const isPrivileged = isPrivilegedCaller(authInfo, { hosted });
    const tools: CatalogTool[] = toolDefinitions();
    // Hosted (Bearer-authenticated) catalogs never include the account-bootstrap /
    // checkout / secret-reveal tools — the public app catalog must stay free of
    // credential-collection, checkout, and secret-reveal flows. Privileged (staff)
    // callers and local stdio setups keep the full catalog.
    // Only a remote (HTTP) request carries authInfo. A local stdio server started with
    // DIDIT_ACCESS_TOKEN is a local setup and keeps the full catalog, as documented; counting
    // that env token as a remote Bearer hid didit_org_top_up and the key reveal from it.
    const remoteBearer = Boolean(authInfo?.token);
    let catalog =
      remoteBearer && !isPrivileged
        ? tools.filter((t) => !HOSTED_APP_EXCLUDED_TOOLS.has(t.name) || (moneyTools && t.name === MONEY_TOOL))
        : tools;
    // Remote connectors authenticate with OAuth, so account credentials must never travel
    // through the conversation: hosted servers drop the bootstrap tools for EVERY caller
    // (staff included), regardless of Bearer state. They remain available on stdio.
    if (hosted) catalog = catalog.filter((t) => !ACCOUNT_BOOTSTRAP_TOOLS.has(t.name));
    // An API key connection is one application and no person (api-key-connection.ts): the tools
    // that act for a member of an organization are not offered to it, and a call is refused below.
    // `describesApiKey` covers the instructions, which describe the catalog with no request at hand.
    const refusedByCredential = describesApiKey || apiKeyScopeOf(authInfo) ? PERSON_ONLY_TOOLS : KEY_ONLY_TOOLS;
    catalog = catalog.filter((t) => !refusedByCredential.has(t.name));
    // A tool the caller's organization role could never run is not offered (permissions.ts);
    // only in enforce mode — shadow mode lists everything and just records the verdicts.
    const tokenOrg = (authInfo?.extra as Record<string, unknown> | undefined)?.organization_id as string | undefined;
    const query = { scopes: authInfo?.scopes, mode: permissionMode(), tokenOrg, targetOrg: tokenOrg };
    const grantScopes = authInfo?.scopes ?? (hosted ? [] : localGrantScopes());
    const key = apiKeyScopeOf(authInfo);
    catalog = catalog.filter((t) => !setupCredentialRefusal(t.name, grantScopes, key));
    catalog = catalog.filter((t) => decidePermission({ ...query, tool: wakeshift?.permissionAs(t.name) ?? t.name }) !== "deny");
    const visible = isPrivileged ? catalog : catalog.filter((t) => !isPrivilegedToolName(t.name));
    // A read-only connection has no use for a tool that changes data: it is neither listed nor
    // discoverable, and a call is refused below.
    return selection.readOnly ? visible.filter((t) => annotate(t.name).readOnlyHint) : visible;
  };
  /** Whether this connection lists the tool. The payments endpoint always lists its money tool. */
  const isListed = (name: string): boolean => selectionLists(selection, name) || (moneyTools && name === MONEY_TOOL);
  /** The usable catalog as the discovery tools read it (tools/discovery.ts). */
  const discoverable = (usable: readonly CatalogTool[], authInfo: AuthInfo | undefined): DiscoverableTool[] =>
    usable.map((tool) => {
      const { readOnlyHint, destructiveHint } = annotate(tool.name);
      const trimmed = definitionFor(tool, { apiKey: Boolean(apiKeyScopeOf(authInfo)) });

      return {
        name: tool.name,
        description: String(trimmed.description ?? ""),
        inputSchema: trimmed.inputSchema ?? {},
        access: readOnlyHint ? "read" : destructiveHint ? "destructive" : "write",
        listed: isListed(tool.name),
      };
    });

  // Capabilities, and what the server says about itself when a client connects (guidance.ts).
  // The instructions describe the catalog of an ordinary (non-staff) caller: they are fixed
  // when the server is built, before any request is seen.
  const servesWidgets = profileServesWidgets(profile);
  const capabilities: ServerDescriptor["capabilities"] = lean
    ? { tools: {}, prompts: {} }
    : servesWidgets
      ? { tools: {}, resources: {} }
      : { tools: {} };
  const unloadedToolsets = (): string[] => {
    const unloaded = new Set(
      usableBy(undefined)
        .filter((tool) => !isListed(tool.name))
        .map((tool) => toolsetOf(tool.name))
        .filter((id): id is string => Boolean(id)),
    );

    return TOOLSETS.map((toolset) => toolset.id).filter((id) => unloaded.has(id));
  };
  const instructions = lean
    ? serverInstructions({
        hosted,
        apiKey: describesApiKey,
        selection,
        unloaded: unloadedToolsets(),
        selectable: SELECTABLE_TOOLSET_IDS,
      })
    : undefined;
  const server = new Server(
    { name: "didit", version: SERVER_VERSION },
    { capabilities, ...(instructions ? { instructions } : {}) },
  );
  serverDescriptors.set(server, { capabilities, ...(instructions ? { instructions } : {}) });

  if (servesWidgets) {
    // The UI templates (`ui://` resources) the tools reference. Static, identical for every
    // caller, and behind the same Bearer gate as the rest of the endpoint (http.ts).
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listWidgetResources() }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => readWidgetResource(request.params.uri));
  }

  if (lean) {
    // Starting points a person picks from the client's prompt menu (guidance.ts). Static and
    // identical for every caller.
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts() }));
    // A prompt names each tool the way this connection reaches it: directly when it is listed,
    // through the discovery tool that runs it when it is not.
    const promptContext = {
      use: (tool: string) =>
        isListed(tool) ? tool : `${annotate(tool).readOnlyHint ? TOOL_CALL_READ : TOOL_CALL_WRITE} (name: ${tool})`,
      docs: Boolean(docsMcpUrl()),
      wakes: Boolean(wakeshift),
    };
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompt = getPrompt(request.params.name, request.params.arguments, promptContext);
      if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);

      return prompt;
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
  const usable = usableBy(extra?.authInfo);
  // Endpoint catalog profile (chatgpt-app.ts): the ChatGPT endpoint offers only the
  // allow-listed tools, with restricted input properties removed from their schemas.
  const allowed = applyCatalogProfile(usable, profile);
  // The connection's selection (toolsets.ts): list what it asked to load, trimmed of what a
  // model does not need repeated, and keep the rest one step away through the discovery tools.
  // They appear only when something the caller may use is left out of the list.
  const connection = { apiKey: Boolean(apiKeyScopeOf(extra?.authInfo)) };
  const listed = lean
    ? shareRuleContract(shareGraphManual(allowed.filter((t) => isListed(t.name)).map((t) => definitionFor(t, connection))))
    : allowed;
  // Discovery reads the same profile-filtered catalog the list is cut from, so a match is always
  // a tool this endpoint will run.
  const offered =
    lean && listed.length < allowed.length
      ? [...listed, ...discoveryToolDefs(discoverable(allowed, extra?.authInfo), { readOnly: selection.readOnly })]
      : listed;
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
        ...annotate(t.name),
      },
      _meta: {
        ...((t as { _meta?: Record<string, unknown> })._meta ?? {}),
        "anthropic/toolGroup": toolGroupOf(t.name),
        category: toolGroupOf(t.name),
        // MCP Apps linkage for the ChatGPT console (chatgpt-app.ts); `{}` on every other
        // profile, so their descriptors are unchanged.
        ...widgetToolMeta(profile, t.name),
      },
    })).concat(
      // The console's entry tool (ChatGPT sidebar entrypoint), on /mcp/chatgpt only.
      widgetTools(profile) as never[],
    ),
  };
});

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const authInfo = extra?.authInfo;
    // A call through didit_tool_call_read / _write (tools/discovery.ts) names the real tool and
    // carries its arguments. It is unwrapped HERE, before anything else looks at the request, so
    // every check below - the hosted exclusions, the permission pre-check, read-only mode, the
    // confirm guards, the audit line - sees the real tool, exactly as on a direct call.
    const via = lean && isToolCallProxy(request.params.name) ? request.params.name : undefined;
    const unwrapped = via ? unwrapToolCall(request.params.arguments as Record<string, unknown> | undefined) : undefined;
    const unwrapError = typeof unwrapped === "string" ? unwrapped : undefined;
    const proxied = unwrapped && typeof unwrapped !== "string" ? unwrapped : undefined;
    const toolName = proxied?.name ?? request.params.name;
    const toolArgs = proxied ? proxied.arguments : request.params.arguments;
    // Console (management) tools target /organization/{org}/application/{app}/... paths.
    // An explicit organization_id / application_id in the tool arguments takes precedence
    // over the token's org context; both flow into requestContext so orgAppPath() resolves.
    const callArgs = (toolArgs ?? {}) as Record<string, unknown>;
    const argOrg = typeof callArgs.organization_id === "string" ? callArgs.organization_id : undefined;
    const argApp = typeof callArgs.application_id === "string" ? callArgs.application_id : undefined;
    // Permission pre-check verdict (permissions.ts): decided once here so the audit line
    // can record a shadow-mode "would_deny" and the dispatch below can refuse a "deny".
    const tokenOrg = (authInfo?.extra as Record<string, unknown> | undefined)?.organization_id as string | undefined;
    // What the token carried when the connection was verified. Only used to tell a change the live
    // answer shows apart from a privilege the role never had; the introspection at connect answers
    // without permissions unless MCP_DEFAULT_ORG is set, so it is often empty.
    const signedInPermissions = tokenPermissions(authInfo?.scopes);
    const permission = decidePermission({
      tool: wakeshift?.permissionAs(toolName) ?? toolName,
      scopes: authInfo?.scopes,
      mode: permissionMode(),
      tokenOrg,
      targetOrg: argOrg || tokenOrg,
    });
    const permissionCheck = permission === "would_deny" ? permission : undefined;
    // Local sign-in (device code): only a stdio server with no Bearer of its own reads the stored
    // credentials, so hosted mode and DIDIT_ACCESS_TOKEN setups are untouched.
    const storedToken =
      !authInfo?.token && !hosted && !process.env.DIDIT_ACCESS_TOKEN && !ACCOUNT_BOOTSTRAP_TOOLS.has(toolName)
        ? await storedDeviceLoginToken()
        : undefined;
    // An API key connection (api-key-connection.ts) is one application: its key goes out as
    // x-api-key and never as a Bearer, and the organization and application are the key's own.
    // A call that names another one is refused below rather than silently redirected.
    const keyScope = apiKeyScopeOf(authInfo);
    // The caller's CURRENT membership, read from service-didit-auth for the organization a call
    // acts in: the dispatcher below asks it for that organization, and a
    // cross-organisation fan-out asks it for each organization it is about to read.
    // Only a hosted OAuth connection has a member role to ask about, and `off` turns it off.
    const liveAccessReader =
      hosted && !keyScope && options.liveAccess && authInfo?.token && permissionMode() !== "off"
        ? (organizationId: string) => options.liveAccess!(authInfo!.token!, organizationId)
        : undefined;
    return requestContext.run(
      keyScope
        ? {
            apiKey: authInfo?.token,
            apiKeyScope: keyScope,
            organizationId: keyScope.organizationId,
            applicationId: keyScope.applicationId,
            toolName,
            actorVia: actorViaFromHeaders(extra?.requestInfo?.headers),
          }
        : {
        // Hosted mode: per-request Bearer from OAuth introspection. Stdio mode (tests/eval):
        // fall back to DIDIT_ACCESS_TOKEN + MCP_DEFAULT_ORG/APP env so the console-path tools
        // authenticate as that Bearer without the hosted layer.
        accessToken: authInfo?.token || process.env.DIDIT_ACCESS_TOKEN || storedToken || undefined,
        organizationId:
          argOrg ||
          ((authInfo?.extra as Record<string, unknown> | undefined)?.organization_id as string | undefined) ||
          process.env.MCP_DEFAULT_ORG ||
          undefined,
        applicationId: argApp || process.env.MCP_DEFAULT_APP || undefined,
        toolName,
        acceptedPermissions: acceptedPermissions(wakeshift?.permissionAs(toolName) ?? toolName),
        liveAccess: liveAccessReader,
        actorVia: actorViaFromHeaders(extra?.requestInfo?.headers),
      },
      () => auditToolCall({ tool: toolName, args: callArgs, authInfo, hosted, permissionCheck, via }, async () => {
  const name = toolName;
  const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  if (unwrapError) return refuse(unwrapError);
  // A read-only connection never changes data, whatever the client has listed or remembers.
  if (selection.readOnly && !annotate(name).readOnlyHint) {
    return refuse(
      `'${name}' changes data and this connection is read-only. To allow changes, the person reconnects without ` +
        (hosted ? "`read_only=true` in the server URL (or the X-MCP-Readonly header)." : "--read-only (or DIDIT_READ_ONLY)."),
    );
  }
  // Mirror of the tools/list exclusion for an API key connection, and its one-application rule.
  if (keyScope) {
    const outOfScope = apiKeyScopeRefusal(keyScope, argOrg, argApp);
    if (outOfScope) return refuse(outOfScope);
    if (PERSON_ONLY_TOOLS.has(name)) return refuse(personOnlyRefusal(name));
  } else if (KEY_ONLY_TOOLS.has(name)) {
    return refuse(keyOnlyRefusal(name));
  }
  if (isAuthenticationSetup(name)) {
    const localToken = !hosted && (process.env.DIDIT_ACCESS_TOKEN || storedToken);
    const grantScopes = authInfo?.scopes ?? (localToken ? localGrantScopes(localToken) : []);
    const refusal = setupCredentialRefusal(name, grantScopes, keyScope);
    if (refusal) return refuse(refusal);
  }
  // The read proxy is annotated read-only, so it only ever runs a tool that is.
  if (via === TOOL_CALL_READ && !annotate(name).readOnlyHint) {
    return refuse(`'${name}' changes data, so ${TOOL_CALL_READ} does not run it. Use ${TOOL_CALL_WRITE} with the same name and arguments.`);
  }
  // organization_id / application_id are ROUTING, consumed above into
  // requestContext — they are not payload. Removing them here is what makes
  // declaring them on a tool safe: the handlers that forward their args
  // verbatim (lists, webhooks, sessions, transactions, vendors…) would
  // otherwise put them in a query string or a POST body the console API never
  // asked for. Behaviour-preserving for the handlers that DO read them —
  // marketplace/travelRule pass them to resolveOrganizationId /
  // resolveApplicationId, which fall back to the very context set above.
  // A blank OPTIONAL argument (`""`, or a `null` the schema never admits) is the
  // model filling every declared argument, not a value: dropped here so the
  // handlers forward the call a schema-honouring model would have made. READ
  // tools only — on an update tool a `""` can mean "clear this field", and a
  // dropped one would PATCH nothing and report success.
  const args = dropBlankOptionals(
    stripRoutingIds(toolArgs),
    annotate(name).readOnlyHint ? inputSchemaByTool.get(name) : undefined,
  );

  // ...but a handful of handlers take the routing ids as EXPLICIT PARAMETERS rather than
  // resolving them from requestContext, and the strip above hands them `undefined`:
  // the auth-service tools build their URL path from the argument (and the reveal tool
  // deliberately refuses every context/env fallback), the *_search tools use the ids to
  // NARROW their fan-out, and the staff tools either build a URL path from organization_id
  // (the staff organization read) or filter by it (the staff warnings search and siblings).
  // Re-attach only what the caller actually sent, and only for those.
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

  // Mirror of the tools/list exclusion for the secret-reveal tool: a remote Bearer that is not
  // staff never has it listed, so it never runs it either, whatever scopes the token carries.
  // Leaving a tool out of tools/list is not access control; this refusal is (2026-11-10 report:
  // an openid-only grant called the unlisted reveal tool directly). The money tool has its own
  // refusal below, with a link the person can pay through.
  if (
    authInfo?.token &&
    !isPrivilegedCaller(authInfo, { hosted }) &&
    HOSTED_APP_EXCLUDED_TOOLS.has(name) &&
    name !== MONEY_TOOL
  ) {
    return {
      content: [
        {
          type: "text",
          text: `Tool '${name}' is not available to a remote connector. Copy the API key from the application's page in the Didit console, or use the local stdio server (npx @didit-protocol/mcp-server).`,
        },
      ],
      isError: true,
    };
  }

  // Mirror of the tools/list exclusion for the one money tool: a remote connector never creates
  // a payment page itself, even when a client calls the unlisted name. The person pays in the
  // console, through the link didit_org_get_balance returns.
  // saved_card moves money with no person present, so not even a staff caller gets it on an endpoint
  // that is not the payments one; staff keep the Checkout page they always had.
  if (
    hostedMoneyBlocked &&
    name === MONEY_TOOL &&
    (!isPrivilegedCaller(authInfo, { hosted }) || callArgs?.payment_method === "saved_card")
  ) {
    // A signed request link creates no payment and moves no money, so it is allowed here; best
    // effort, the static text below is the fallback.
    const signedUrl = await billing.signedTopUpLink(
      callArgs?.amount_in_dollars ?? callArgs?.amount,
      callArgs?.organization_id as string | undefined,
    );
    const text = signedUrl
      ? `Top-ups are paid by the person in the Didit console. Give them this link: ${signedUrl} (it opens the top-up dialog with the amount filled in and says which agent asked; nothing is charged until they pay), or next_steps.automatic_top_up_url from didit_org_get_balance.`
      : "Top-ups are paid by the person in the Didit console. Call didit_org_get_balance and give them next_steps.top_up_url (the top-up dialog with the amount filled in) or next_steps.automatic_top_up_url.";
    return { content: [{ type: "text", text }], isError: true };
  }

  // Mirror of the tools/list catalog profile: a tool (or an input property) the endpoint does
  // not offer is refused even if the client memorised it from the full catalog.
  const profileRefusal = catalogProfileRefusal(profile, name, callArgs);
  if (profileRefusal) {
    return { content: [{ type: "text", text: profileRefusal }], isError: true };
  }

  // The console's entry tool (chatgpt-app.ts): no Didit call, it names the page to open.
  if (name === CONSOLE_OPEN_TOOL) {
    if (!profileServesWidgets(profile)) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    return consoleOpenResult(callArgs);
  }

  // The discovery tools (tools/discovery.ts) answer from the caller's own catalog: no Didit call.
  // Same catalog as tools/list: what the caller may use, cut to this endpoint's profile.
  if (lean && (name === TOOL_SEARCH || name === TOOL_DESCRIBE)) {
    const catalog = discoverable(applyCatalogProfile(usableBy(authInfo), profile), authInfo);
    const found = name === TOOL_SEARCH ? searchTools(catalog, callArgs) : describeTools(catalog, callArgs);

    return { content: [{ type: "text", text: JSON.stringify(found) }], structuredContent: found };
  }

  // Single-org/single-app callers: fill the default scope so they needn't pass/discover ids.
  await ensureScopeDefaults(name);

  // the caller's CURRENT access to the organization this call acts in, asked of
  // service-didit-auth on this call instead of being taken from the token that was verified (and
  // remembered) when the connection opened. That service re-derives the answer on every
  // introspection and drops its cached copy on every membership, role and application-access
  // change, so a demotion, a removal or an application taken away reaches an already-open
  // connection on its very next call — and a promotion does not have to wait out the 60 s token
  // cache either. Only a hosted OAuth connection has a member role to ask about (see the option).
  const liveStore = requestContext.getStore();
  // The application this call will actually use, when the tool acts on one (applicationForCall, from
  // what the tool's schema declares): named, or the default the dispatcher resolved.
  const liveApplication = applicationForCall(inputSchemaByTool.get(name), argApp, liveStore?.applicationId);
  // The organization is the one the call names or resolved, or - when the call names an application
  // and no organization (a member of several organizations naming one application) - the one whose
  // membership lists that application. Without it the live question was never asked for such a call,
  // and a fan-out below read every organization instead of refusing (an internal issue review).
  const liveOrganization =
    liveStore?.organizationId ?? (liveStore?.liveAccess && liveApplication ? await organizationOfApplication(liveApplication) : undefined);
  let liveChecked = false;
  // The live answer positively carries a permission this tool accepts: the connection may be
  // ahead of the verification service's own cached copy. Kept for the error path below.
  let liveConfirmed = false;
  // Staff tools are exempt from the membership check: a staff caller reads a customer organization it
  // is not a member of, so the live answer is `org_role: null` by design (introspection-verifier.ts).
  // The staff gate is the verification service's, re-decided on every staff endpoint call
  // (tools/staff.ts); the server's own is_privileged check is only defense-in-depth. Exempted through
  // the same predicate ensureScopeDefaults uses above, not a second list of tool names.
  if (liveStore?.liveAccess && liveOrganization && !isPrivilegedToolName(name)) {
    let access: OrganizationAccess | null | undefined;
    try {
      // Memoised for this call (live-access.ts liveAccessFor): a fan-out below asks the same
      // reader for every other organization, and none of them is asked twice.
      access = await liveAccessFor(liveOrganization);
    } catch {
      // The auth service did not answer. That is not a verdict on the person's role: the call is
      // not sent (nothing confirmed its permissions) and the message says so, retryable, never a
      // bare refusal — the same rule the token verifier follows (auth/introspection-verifier.ts).
      return refuse(
        `Didit could not confirm your access to this organization just now (the sign-in service did not answer), ` +
          `so ${name} was not sent. Retry in a moment.`,
      );
    }
    if (access === null) {
      return refuse(
        `Your Didit sign-in is no longer valid, so ${name} cannot run. Reconnect this connection and sign in again.`,
      );
    }
    if (access) {
      liveChecked = true;
      // The application the call will ACTUALLY use, when the tool acts on one (applicationForCall,
      // from what the tool's schema declares). Organization-level tools — including one whose
      // `application_id` only filters the organization's records — are not refused for an
      // application they never act in. For an application tool, the resolved default is judged
      // too: naming no `application_id` is the documented way to use the one application you own,
      // so an access removal must reach it. The default comes from the 60 s
      // organisation map; the answer compared against it is live.
      const refusal = currentAccessRefusal({
        tool: name,
        permissionFor: wakeshift?.permissionAs(name),
        access,
        applicationId: liveApplication,
        signedInPermissions,
      });
      if (refusal) return refuse(refusal);
      const acceptedNow = acceptedPermissions(wakeshift?.permissionAs(name) ?? name);
      liveConfirmed = acceptedNow.length > 0 && (access.permissions ?? []).some((p) => acceptedNow.includes(p));
    }
  }

  try {
    // The caller's organization role lacks the permission the backend would demand for
    // this tool: refuse here with the permission named (the backend would 403 anyway). When the
    // live answer above has just decided the call, it is the current one and this cached verdict
    // (up to MCP_INTROSPECTION_CACHE_TTL_MS old) must not refuse a role the person has now.
    if (permission === "deny" && !liveChecked) throw missingPermissionError(wakeshift?.permissionAs(name) ?? name);

    let result: any;

    // Multi-tenant caller invoked a per-app list tool with no resolvable scope: span all apps
    // (same shape as the *_search sibling) instead of throwing, so the first call succeeds.
    const aggregate = aggregateFallbackFor(name);
    if (isPrivilegedToolName(name)) {
      // Same re-attachment as the auth-service/*_search branches: the staff organization read builds
      // its URL path from organization_id, so the stripped args would always be undefined.
      result = await dispatchPrivilegedTool(name, withRoutingIds(args));
    } else if (isInternalToolName(name)) {
      result = await dispatchInternalTool(name, args);
    } else if (isInvestigatorToolName(name)) {
      result = await dispatchInvestigatorTool(name, args);
    } else if (wakeshift?.handles(name)) {
      result = await wakeshift.call(name, args ?? {});
    } else if (aggregate) {
      // Scope survives the fallback: when the org resolved but the app did not, span only
      // that org's apps rather than every org the caller can reach.
      const scopedOrg = requestContext.getStore()?.organizationId;
      result = await aggregate({
        ...withRoutingIds(args),
        ...(scopedOrg ? { organization_id: scopedOrg } : {}),
      });
    } else if (REGISTERED_TOOLS.has(name)) {
      const registered = REGISTERED_TOOLS.get(name)!;
      result = await registered.run(registered.routingIds ? withRoutingIds(args) : ((args ?? {}) as Record<string, any>));
    } else
    switch (name) {
      // Auth
      case "didit_account_register":
        result = await auth.register(args!.email as string, args!.password as string);
        break;
      // The three tools that answer with a sign-in: the local server keeps it (account-session.ts).
      case "didit_account_verify_email":
        result = keepSignIn(await auth.verifyEmail(args!.email as string, args!.code as string), { hosted });
        break;
      case "didit_account_resend_otp":
        result = await auth.resendOtp(args!.email as string);
        break;
      case "didit_account_login":
        result = keepSignIn(await auth.login(args!.email as string, args!.password as string), { hosted });
        break;
      case "didit_account_device_login_start":
        result = await auth.deviceLoginStart();
        break;
      case "didit_account_device_login_poll":
        result = await auth.deviceLoginPoll();
        break;
      case "didit_account_verify_2fa":
        result = keepSignIn(await auth.verify2fa(args!.temp_token as string, args!.code as string), { hosted });
        break;
      // An API key connection answers these from the key's own application: the membership
      // routes behind them only answer to a person (api-key-connection.ts).
      case "didit_org_list":
        result = keyScope ? apiKeyOrganizations(keyScope) : await auth.listOrganizations(stdioAccessTokenArg(args));
        break;
      case "didit_org_list_applications":
        result = keyScope ? [apiKeyApplication(keyScope)] : await auth.listApplications(argOrg as string, stdioAccessTokenArg(args));
        break;
      case "didit_org_get_application":
        result = keyScope
          ? apiKeyApplication(keyScope)
          : await auth.getApplication(argOrg as string, argApp as string, stdioAccessTokenArg(args));
        break;
      case "didit_org_reveal_application_api_key":
        result = await auth.revealApplicationApiKey(argOrg, argApp, args?.confirm, stdioAccessTokenArg(args));
        break;

      // Context + cross-org/app aggregate search
      case "didit_context_get":
        result = await context.getContext();
        break;
      case "didit_analytics":
        // Like the *_search tools: the routing ids NARROW the fan-out (one org, or one app).
        result = await analytics.analytics(withRoutingIds(args));
        break;


      // Transactions



      // Billing
      case "didit_org_get_balance":
        // The ChatGPT catalog carries no credit-purchase flow (app review), so no top-up links there.
        result = await billing.getBalance(args?.organization_id as string | undefined, {
          links: profile !== "chatgpt",
          // The agent top-up switch only where an agent may top up: /mcp/payments and stdio.
          agentTopUp: profile === "full" && !hostedMoneyBlocked,
          usage: args,
        });
        break;
      case "didit_org_top_up":
        result = await billing.topUp(
          (args?.amount_in_dollars ?? args?.amount) as number,
          args?.confirm,
          args?.organization_id as string | undefined,
          { payment_method: args?.payment_method, idempotency_key: args?.idempotency_key },
        );
        break;





      // Compliance
      case "didit_workflow_build_graph":
        result = await compliance.buildWorkflow(args as Record<string, any>);
        break;

      // Documentation search: a public corpus, no Didit credentials involved.
      case DOCS_SEARCH_TOOL:
        result = await searchDocs(args);
        break;

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}${lean ? `. Find the right name with ${TOOL_SEARCH}.` : ""}` }],
          isError: true,
        };
    }

    // Wakeshift: subscribe the conversation to what this call started (a session, an
    // import job, a transaction). Never fails the call.
    if (wakeshift) await wakeshift.after(name, args ?? {}, result);

    // Apply the endpoint's data boundary to BOTH response channels, including modern RPC.
    result = applyCatalogResult(profile, name, result);

    // `content` is the model-facing channel (a client with an outputSchema hands
    // THIS text to the model, not structuredContent), so it is COMPACT: the
    // 2-space pretty print ran ~3× the compact form — seven didit_workflow_get
    // reads of ~50k chars reached the assistant's model as ~147k chars each and
    // burst its 1.05M-token window (didit-ai-assistant, Sentry
    // DIDIT-AI-ASSISTANT-2K, 429 turns 11-15 Sep 2026). Same data, same order.
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { value: result },
    };
  } catch (error: any) {
    // Structured, sanitized error: code/field/hint/allowed surfaced; backend secrets,
    // PII and local paths stripped; structuredContent OMITTED so a strict client never
    // validates an error against the tool's success outputSchema.
    const shape = toSafeErrorShape(error);
    // the caller's CURRENT membership carries a permission this tool accepts (the live
    // answer above said so), but service-didit-verification decides permissions from its own
    // introspection cache, INTROSPECT_CACHE_TIMEOUT = 600 s (core/utils/authentication.py), and
    // refuses with a bare 403 until it expires. Say what that means instead of passing it on. The
    // copy names no change of its own: the connect introspection answers without permissions, so a
    // raised role cannot be told apart from a stale downstream copy, and a 403 for another reason
    // must not be reported as a promotion. A 403 whose body names another reason (no balance, a plan
    // gate) is passed on as it is: called a role delay, it sent the agent into identical retries.
    if (liveConfirmed && !isAuthenticationSetup(name) && shape.status === 403 && shape.role_refusal !== false) {
      return refuse(
        `Didit's verification service refused ${name}, although your current role in this organization carries ` +
          "the permission it needs. That service keeps its own copy of a role for up to 10 minutes (600 seconds), so a " +
          "role raised just now may not have reached it yet: retry in a few minutes or sign in again. " +
          "If it still refuses then, this call is being refused for another reason.",
      );
    }
    const codeLine = shape.backend_code ? `\nCode: ${shape.backend_code}` : "";
    const fieldLine = shape.field ? `\nField: ${shape.field}` : "";
    const hintLine = shape.hint ? `\nHint: ${shape.hint}` : "";
    // A backend that says how long to wait (the Bank data API on a used-up fetch budget) says it here, so
    // the agent retries after that time instead of guessing.
    const retryLine = shape.retry_after !== undefined ? `\nRetry after: ${shape.retry_after}s` : "";
    const allowedLine = shape.allowed && shape.allowed.length ? `\nAllowed: ${shape.allowed.join(", ")}` : "";
    // A backend refusal that names where a person finishes the action (agent top-ups) passes it on unchanged.
    const nextStepLine = shape.next_step ? `\nNext step: ${JSON.stringify(shape.next_step)}` : "";
    return {
      content: [{ type: "text", text: `Error [${shape.code}]: ${shape.message}${codeLine}${fieldLine}${hintLine}${allowedLine}${nextStepLine}${retryLine}` }],
      isError: true,
    };
  }
      }),
    );
  });

  // After the handlers are set: attach wraps them in place.
  wakeshift?.attach(server);

  return server;
}

// Never throws: a revoked grant is reported once on stderr and the tool then fails like any
// unauthenticated call. The message carries no token.
async function storedDeviceLoginToken(): Promise<string | undefined> {
  try {
    return await localSignInToken();
  } catch (err) {
    if (err instanceof DeviceLoginError) console.error(`Didit: ${err.message}`);
    return undefined;
  }
}

async function main() {
  const cliCommand = loginCliCommand(process.argv.slice(2));
  if (cliCommand) {
    process.exitCode = await runLoginCli(cliCommand);
    return;
  }
  const transport = new StdioServerTransport();
  // A local server lists everything unless told otherwise, like the hosted one: `--toolsets` /
  // DIDIT_TOOLSETS and `--read-only` / DIDIT_READ_ONLY change it (toolsets.ts).
  const selection = selectionFromArgv(process.argv.slice(2), process.env);
  const server = createServer({ profile: stdioCatalogProfile(), selection });
  await server.connect(transport);
  console.error(
    `Didit MCP Server v${SERVER_VERSION} running on stdio (toolsets: ${selectionLabel(selection)}${selection.readOnly ? ", read-only" : ""})`,
  );
}

// Only auto-start the stdio server when this file is run directly — when the HTTP
// entrypoint (src/http.ts) imports createServer(), main() must NOT fire.
if (require.main === module) {
  main().catch(console.error);
}

/**
 * Toolsets: which part of the tool catalog a connection loads.
 *
 * The whole catalog is more than 200 tools and tens of thousands of tokens of definitions. A
 * client sends all of that to the model with every request, and some clients cap how many tools
 * they accept. A short catalog trades those tokens for one search step. Measured (the
 * tool-selection eval): a model does not pick worse from the long list, it picks a little
 * better, at about ten times the tokens. So a connection can name what it wants instead:
 *
 *   hosted   https://mcp.didit.me/mcp?toolsets=core,transactions&read_only=true
 *            (or the `X-MCP-Toolsets` / `X-MCP-Readonly` headers)
 *   stdio    --toolsets=core,transactions --read-only
 *            (or DIDIT_TOOLSETS / DIDIT_READ_ONLY)
 *
 * `core` is a short list of the tools most work starts from; `all` is everything. A connection
 * that names nothing gets the server default, which is `all`: nothing changes for a client
 * that never heard of toolsets. A deployment may set another default (MCP_DEFAULT_TOOLSETS).
 * Whatever a connection does not load stays reachable through the discovery tools
 * (tools/discovery.ts), so a smaller catalog never removes a capability.
 *
 * Two different things, on purpose:
 *
 *   - a TOOLSET is a context budget. It decides what tools/list returns. It is not access
 *     control: a tool outside the selection still runs when called by name, exactly as before.
 *   - READ-ONLY is a safety boundary. It is enforced on every call, whatever the client lists.
 *
 * Membership is by tool-name prefix (`didit_<domain>_<action>`), the same convention that
 * groups the tools in a connector's permission screen, so a new tool lands in its toolset
 * without touching this file. A tool whose name matches no prefix fails the catalog test.
 */
import { INTERNAL_TOOLSETS } from "./internal-tools";
import { PRIVILEGED_TOOLSET } from "./privileged-tools";

export interface Toolset {
  /** Stable id: what a person types in `?toolsets=`. Lowercase, no spaces. */
  id: string;
  /** One line for people and models choosing what to load. */
  description: string;
  /** Tool-name prefixes (after `didit_`), each with the label a connector UI groups it under. */
  groups: readonly (readonly [prefix: string, label: string])[];
}

/** The short catalog: the tools most work starts from (see CORE_TOOLS). */
export const CORE_TOOLSET = "core";
/** Every tool the caller may use. */
export const ALL_TOOLSETS = "all";
/** What a connection loads when neither it nor the deployment names anything. */
export const DEFAULT_TOOLSETS = ALL_TOOLSETS;
/** Alias for whatever the server's default selection is. */
const DEFAULT_ALIAS = "default";

/**
 * The server's default selection: MCP_DEFAULT_TOOLSETS (a comma-separated list of toolset ids,
 * or `all`), else everything. Read per request, so a deployment changes it without a rebuild.
 * `core` there makes the short catalog what every connection gets unless it asks for more.
 */
export function defaultToolsets(env: Record<string, string | undefined> = process.env): string {
  return env.MCP_DEFAULT_TOOLSETS?.trim() || DEFAULT_TOOLSETS;
}

const PUBLIC_TOOLSETS: readonly Toolset[] = [
  {
    id: "account",
    description: "Organizations, applications, API keys, members and roles.",
    groups: [
      ["account_", "Account Setup"],
      ["context_", "Account & Org"],
      ["org_", "Account & Org"],
    ],
  },
  {
    id: "billing",
    description: "Plan, credit balance, payment methods, receipts and billing details.",
    groups: [["billing_", "Billing"]],
  },
  {
    id: "sessions",
    description: "Verification sessions: create, find, decide, review, share, import, PDFs and webhook deliveries.",
    groups: [["session_", "Sessions"]],
  },
  {
    id: "workflows",
    description: "Verification workflows and questionnaires: build, edit, validate and publish.",
    groups: [
      ["workflow_", "Workflows & Questionnaires"],
      ["questionnaire_", "Workflows & Questionnaires"],
    ],
  },
  {
    id: "lists",
    description: "Custom lists, the blocklist and the allowlist.",
    groups: [
      ["lists_", "Lists & Blocklist"],
      ["blocklist_", "Lists & Blocklist"],
      ["allowlist_", "Lists & Blocklist"],
    ],
  },
  {
    id: "vendors",
    description: "The people and companies you verify: vendor users and vendor businesses.",
    groups: [["vendor_", "Vendor Users & Businesses"]],
  },
  {
    id: "transactions",
    description: "Transaction monitoring: transactions, wallet screening and rules with backtesting.",
    groups: [["transaction_", "Transactions (AML)"]],
  },
  {
    id: "cases",
    description: "Case management: create, assign, escalate and resolve cases.",
    groups: [["case_", "Cases"]],
  },
  {
    id: "investigator",
    description: "The AI Investigator: its review queue, reports, decisions, policy questions and performance.",
    groups: [["investigator_", "Investigator"]],
  },
  {
    id: "webhooks",
    description: "Webhook destinations and alerts.",
    groups: [
      ["webhook_", "Webhooks & Alerts"],
      ["alert_", "Webhooks & Alerts"],
    ],
  },
  {
    id: "reports",
    description: "Analytics, exports and the audit log.",
    groups: [
      ["report_", "Reports & Audit"],
      ["audit_", "Reports & Audit"],
      ["analytics", "Reports & Audit"],
    ],
  },
  {
    id: "branding",
    description: "White-label branding of the verification flow.",
    groups: [["branding_", "Branding"]],
  },
  {
    id: "verification",
    description:
      "Standalone verification APIs: ID document, face, AML, proof of address, phone, email, database and business checks.",
    groups: [["verify_", "Verification APIs"]],
  },
  {
    id: "docs",
    description: "Search the Didit documentation.",
    groups: [["docs_", "Documentation"]],
  },
];

/** Every toolset this build serves, in the order a listing shows them. */
export const TOOLSETS: readonly Toolset[] = [
  ...PUBLIC_TOOLSETS,
  ...INTERNAL_TOOLSETS,
  ...(PRIVILEGED_TOOLSET ? [PRIVILEGED_TOOLSET] : []),
];

const TOOLSET_IDS: ReadonlySet<string> = new Set(TOOLSETS.map((toolset) => toolset.id));

/** The ids a person may ask for. The staff toolset is not one of them: it follows the caller. */
export const SELECTABLE_TOOLSET_IDS: readonly string[] = TOOLSETS.map((toolset) => toolset.id).filter(
  (id) => id !== PRIVILEGED_TOOLSET?.id,
);

/** `[prefix, toolset, group label]`, longest prefix first so a longer prefix always wins. */
const PREFIX_INDEX: readonly (readonly [string, Toolset, string])[] = TOOLSETS.flatMap((toolset) =>
  toolset.groups.map(([prefix, label]) => [prefix, toolset, label] as const),
).sort((a, b) => b[0].length - a[0].length);

function match(name: string): readonly [string, Toolset, string] | undefined {
  const rest = name.replace(/^didit_/, "");

  return PREFIX_INDEX.find(([prefix]) => rest.startsWith(prefix));
}

/** The toolset a tool belongs to, or undefined for a name no toolset claims. */
export function toolsetOf(name: string): string | undefined {
  return match(name)?.[1].id;
}

/** The label a connector UI groups the tool under (`_meta["anthropic/toolGroup"]`). */
export function toolGroupOf(name: string): string {
  // The discovery tools (tools/discovery.ts) belong to no toolset: they stand in for the rest.
  if (name.startsWith("didit_tool_")) return "Tool Discovery";

  return match(name)?.[2] ?? "Other";
}

/**
 * The `core` catalog: the tools most conversations start from, picked across toolsets.
 *
 * It began from production telemetry of the console assistant (2026-08-07 to 2026-09-06), where
 * a list of about 45 tools carried roughly 94% of calls, and was cut further: of each
 * list/search pair only the search stays (it is the superset), building and editing workflows
 * lives in the `workflows` toolset (the definitions of those tools are several times larger
 * than this whole list), and the developer loop is covered end to end (create a session,
 * simulate its outcome in the sandbox, read its webhook deliveries, manage webhooks and the
 * API key).
 *
 * Keep it under 30 hosted tools. Every addition is paid by every conversation that chose the
 * short catalog, and anything left out is still one search away. Revisit it with fresh
 * `mcp.tool_call` audit data.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  // Where everything starts: the caller's organizations and applications.
  "didit_context_get",
  "didit_docs_search",
  // Signing in. Local (stdio) servers only; a hosted server authenticates with OAuth.
  "didit_account_device_login_start",
  "didit_account_device_login_poll",
  "didit_account_register",
  "didit_account_verify_email",
  "didit_account_resend_otp",
  "didit_account_login",
  "didit_account_verify_2fa",
  // Sessions
  "didit_session_create",
  "didit_session_search",
  "didit_session_get_decision",
  "didit_session_explain_decision",
  "didit_session_update_status",
  "didit_session_simulate",
  "didit_session_webhooks",
  // Workflows
  "didit_workflow_search",
  "didit_workflow_get",
  // Numbers
  "didit_analytics",
  "didit_org_get_balance",
  // Integration: the application, its API key and its webhooks
  "didit_org_get_application",
  "didit_org_list_api_keys",
  "didit_org_create_api_key",
  "didit_webhook_list",
  "didit_webhook_create",
  "didit_webhook_update",
  // Finding records across applications
  "didit_case_search",
  "didit_case_get",
  "didit_vendor_user_search",
  "didit_vendor_business_search",
  "didit_transaction_search",
  "didit_transaction_get",
]);

/** Listed on every connection, whatever it selects: nothing works before the ids it returns. */
const ALWAYS_LISTED: ReadonlySet<string> = new Set(["didit_context_get"]);

/** What one connection asked to load. */
export interface CatalogSelection {
  /** Toolset ids to list (`core` included when selected), or "all". */
  toolsets: ReadonlySet<string> | typeof ALL_TOOLSETS;
  /** List read-only tools only, and refuse every other call. */
  readOnly: boolean;
  /** Ids the caller named that do not exist. Reported back, never an error. */
  unknown: readonly string[];
}

/** No narrowing at all: what `createServer()` serves when the caller passes no selection. */
export const FULL_SELECTION: CatalogSelection = { toolsets: ALL_TOOLSETS, readOnly: false, unknown: [] };

function splitIds(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((id) => id.trim().toLowerCase().replace(/-/g, "_"))
    .filter(Boolean);
}

/** "1", "true", "yes" and "on" (any case) switch a flag on; anything else leaves it off. */
export function parseFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Turn what a connection asked for into a selection.
 *
 * `requested` is the raw `toolsets` value (comma or space separated); undefined or empty means
 * the default. `fallback` is the server's default selection in the same syntax (see
 * defaultToolsets). Unknown ids are dropped and reported in `unknown`: refusing the connection
 * instead would show up in most clients as "cannot connect", with the reason nowhere the person
 * can read it. A request that names nothing valid falls back to the default rather than to an
 * empty catalog.
 */
export function parseSelection(
  requested: string | null | undefined,
  readOnly: unknown,
  fallback: string = DEFAULT_TOOLSETS,
): CatalogSelection {
  const expand = (ids: string[]): { ids: Set<string>; all: boolean; unknown: string[] } => {
    const result = { ids: new Set<string>(), all: false, unknown: [] as string[] };

    for (const id of ids) {
      if (id === ALL_TOOLSETS) result.all = true;
      else if (id === CORE_TOOLSET || TOOLSET_IDS.has(id)) result.ids.add(id);
      else result.unknown.push(id);
    }

    return result;
  };
  // The default itself may not name `default`; an operator typo there falls back to everything.
  const base = expand(splitIds(fallback).filter((id) => id !== DEFAULT_ALIAS));
  const baseIds = base.all || base.ids.size > 0 ? base : expand([DEFAULT_TOOLSETS]);

  const asked = splitIds(requested ?? "");
  const wantsDefault = asked.includes(DEFAULT_ALIAS);
  const named = expand(asked.filter((id) => id !== DEFAULT_ALIAS));
  const nothingValid = !named.all && named.ids.size === 0 && !wantsDefault;
  const useBase = wantsDefault || nothingValid;

  const all = named.all || (useBase && baseIds.all);
  const ids = new Set([...named.ids, ...(useBase ? baseIds.ids : [])]);

  return {
    toolsets: all ? ALL_TOOLSETS : ids,
    readOnly: parseFlag(readOnly),
    unknown: named.unknown,
  };
}

/** Whether the selection lists this tool. Staff tools ride along for staff callers. */
export function selectionLists(selection: CatalogSelection, name: string): boolean {
  if (selection.toolsets === ALL_TOOLSETS || ALWAYS_LISTED.has(name)) return true;
  if (selection.toolsets.has(CORE_TOOLSET) && CORE_TOOLS.has(name)) return true;
  const toolset = toolsetOf(name);
  if (!toolset) return false;

  return selection.toolsets.has(toolset) || toolset === PRIVILEGED_TOOLSET?.id;
}

/** The selection as a person would type it: `core,transactions` or `all`. */
export function selectionLabel(selection: CatalogSelection): string {
  if (selection.toolsets === ALL_TOOLSETS) return ALL_TOOLSETS;
  const ids = selection.toolsets;
  const ordered = [
    ...(ids.has(CORE_TOOLSET) ? [CORE_TOOLSET] : []),
    ...TOOLSETS.map((toolset) => toolset.id).filter((id) => ids.has(id)),
  ];

  return ordered.join(",");
}

/**
 * The selection of a local (stdio) server: `--toolsets=a,b` (or `--toolsets a,b`) and
 * `--read-only` on the command line, else DIDIT_TOOLSETS and DIDIT_READ_ONLY, else everything.
 */
export function selectionFromArgv(argv: readonly string[], env: Record<string, string | undefined> = process.env): CatalogSelection {
  let toolsets: string | undefined;
  let readOnly = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--read-only" || arg === "--readonly") readOnly = true;
    else if (arg.startsWith("--toolsets=")) toolsets = arg.slice("--toolsets=".length);
    else if (arg === "--toolsets" && argv[index + 1] !== undefined) toolsets = argv[++index];
  }

  return parseSelection(toolsets ?? env.DIDIT_TOOLSETS, readOnly || parseFlag(env.DIDIT_READ_ONLY));
}

type HeaderValue = string | string[] | undefined;

function first(value: unknown): string | undefined {
  const item = Array.isArray(value) ? value[0] : value;

  return typeof item === "string" ? item : undefined;
}

/**
 * The selection of a hosted request: the `toolsets` and `read_only` query parameters of the
 * server URL, else the `X-MCP-Toolsets` and `X-MCP-Readonly` headers (for clients that can set
 * a header but not edit the URL), else the server default. Read-only is on when either says so:
 * a safety switch is never overridden by the other source.
 */
export function selectionFromRequest(
  query: Record<string, unknown>,
  headers: Record<string, HeaderValue>,
  fallback: string,
): CatalogSelection {
  const toolsets = first(query.toolsets) ?? first(headers["x-mcp-toolsets"]);
  const readOnly =
    parseFlag(first(query.read_only)) || parseFlag(first(query.readonly)) || parseFlag(first(headers["x-mcp-readonly"]));

  return parseSelection(toolsets, readOnly, fallback);
}

import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { searchTransactions } from "./search";
import { ORG_APP_PROPS } from "../orgapp";
import { DiditError, pathSegment } from "../security";

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

// Transaction monitoring (AML) — org/app-scoped console resource.

export async function listTransactions(params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/"), { params });
}

export async function createTransaction(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/"), { method: "POST", json: data });
}

export async function getTransaction(transactionId: string): Promise<any> {
  return apiRequest(orgAppPath(`/transactions/${pathSegment(transactionId, "transaction_id")}/`));
}

export async function screenWallet(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/screen-wallet/"), { method: "POST", json: data });
}

const ruleUuid = (id: string) => pathSegment(id, "rule_uuid");

function validateAggregationWindows(data: Record<string, unknown>): void {
  if (data.aggregation === undefined) return;
  if (!Array.isArray(data.aggregation)) {
    throw new DiditError({
      code: "bad_request",
      message: "aggregation must be an array of velocity checks.",
      field: "aggregation",
      hint: "Provide an array, or [] to deliberately use no aggregation checks.",
    });
  }
  const aggregation: unknown[] = data.aggregation;
  for (const [index, entry] of aggregation.entries()) {
    const window = typeof entry === "object" && entry !== null && "window" in entry
      ? entry.window
      : undefined;
    // Enforce the advertised window contract before the backend can default to 1d.
    if (typeof window !== "string" || !/^\d+[mhd]$/.test(window) || window !== window.trim()) {
      const field = `aggregation[${index}].window`;
      throw new DiditError({
        code: "bad_request",
        message: `${field} requires an explicit velocity window.`,
        field,
        hint: "Use digits followed by m (minutes), h (hours), or d (days), e.g. 30m, 24h, or 7d.",
      });
    }
  }
}

export async function listTransactionRules(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/rules/"), { params });
}

export async function getTransactionRule(ruleUuidValue: string): Promise<any> {
  return apiRequest(orgAppPath(`/transactions/rules/${ruleUuid(ruleUuidValue)}/`));
}

export async function createTransactionRule(data: Record<string, any>): Promise<any> {
  validateAggregationWindows(data);
  return apiRequest(orgAppPath("/transactions/rules/"), { method: "POST", json: data });
}

export async function updateTransactionRule(ruleUuidValue: string, data: Record<string, any>): Promise<any> {
  validateAggregationWindows(data);
  return apiRequest(orgAppPath(`/transactions/rules/${ruleUuid(ruleUuidValue)}/`), {
    method: "PATCH",
    json: data,
  });
}

export async function deleteTransactionRule(ruleUuidValue: string): Promise<any> {
  return apiRequest(orgAppPath(`/transactions/rules/${ruleUuid(ruleUuidValue)}/`), { method: "DELETE" });
}

export async function backtestTransactionRule(data: Record<string, any>): Promise<any> {
  validateAggregationWindows(data);
  return apiRequest(orgAppPath("/transactions/rules/backtest/"), { method: "POST", json: data });
}

export async function listTransactionRuleLibrary(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/rules/library/"), { params });
}

/**
 * Install and uninstall act on a selection of presets: specific library_keys, a bundle, or both.
 * The two input schemas used to say "one of the two" with a top-level `anyOf`, which nothing
 * enforced (the low-level MCP server does not validate arguments) and which the Claude API
 * refuses for the whole tool list. It is said in the descriptions and enforced here instead,
 * before anything is sent.
 */
function requirePresetSelector(data: Record<string, unknown>, verb: "install" | "uninstall"): void {
  const hasKeys = Array.isArray(data?.library_keys) && data.library_keys.length > 0;
  const hasBundle = typeof data?.bundle === "string" && data.bundle.trim() !== "";
  if (hasKeys || hasBundle) return;
  throw new DiditError({
    code: "bad_request",
    message: `Say which preset rules to ${verb}: pass library_keys, bundle or both.`,
    field: "library_keys",
    hint: "didit_transaction_rule_library_list returns every preset with its library_key and its bundle.",
  });
}

export async function installTransactionRuleLibrary(data: Record<string, any>): Promise<any> {
  requirePresetSelector(data, "install");
  return apiRequest(orgAppPath("/transactions/rules/install/"), { method: "POST", json: data });
}

export async function uninstallTransactionRuleLibrary(data: Record<string, any>): Promise<any> {
  requirePresetSelector(data, "uninstall");
  return apiRequest(orgAppPath("/transactions/rules/install/"), { method: "DELETE", json: data });
}

// ── The transaction rule tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const TRANSACTION_RULE_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
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
    access: "read",
    permission: "list:transactions", // GET …/transactions/rules/ → transactions.py:754
    run: (args) => listTransactionRules(args),
  },
  {
    def: {
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
    access: "read",
    permission: "list:transactions", // GET …/transactions/rules/{uuid}/ → transactions.py:785
    run: (args) => getTransactionRule(args.rule_uuid),
  },
  {
    def: {
      name: "didit_transaction_rule_create",
      description:
        "Create a CUSTOM transaction-monitoring rule. Include the entire requested persisted rule in this call: " +
        "conditions, aggregation checks, and actions. Backtest accepts a hypothetical config but never attaches " +
        "aggregation or actions to a created rule. Prefer mode:'TEST', backtest the exact saved config, then switch " +
        "to ACTIVE only after confirming the hit rate. title is unique among non-deleted rules in the app. " +
        "actions is REQUIRED: every outcome the user named (review, decline, approve, score, case) must appear " +
        "there; pass [] ONLY when the user explicitly wants a monitor-only rule that does nothing on match. " +
        "To change a library (PRESET) rule, send its definition as a copy with metadata.based_on (the library key) " +
        "and metadata.based_on_rule_uuid.",
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
    access: "write",
    permission: "write:transactions", // POST …/transactions/rules/ → transactions.py:766
    run: (args) => createTransactionRule(args),
  },
  {
    def: {
      name: "didit_transaction_rule_update",
      description:
        "Partially update a transaction-monitoring rule. Send every changed persisted field in this PATCH. PRESET " +
        "rules only allow mode changes: to change a PRESET rule's conditions, create a CUSTOM copy with " +
        "didit_transaction_rule_create (the library rule's definition plus metadata.based_on = its library key and " +
        "metadata.based_on_rule_uuid), then set the library rule's mode to DISABLED so a transaction does not alert " +
        "twice. Before raising impact, backtest the exact candidate config and keep the rule " +
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
    access: "write",
    permission: "write:transactions", // PATCH …/transactions/rules/{uuid}/ → transactions.py:790
    run: ({ rule_uuid, ...data }) => updateTransactionRule(rule_uuid, data),
  },
  {
    def: {
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
    access: "destructive",
    permission: "write:transactions", // DELETE …/transactions/rules/{uuid}/ → transactions.py:801
    run: (args) => deleteTransactionRule(args.rule_uuid),
  },
  {
    def: {
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
    // Replays a draft rule over past transactions: nothing is saved.
    access: "read",
    permission: "list:transactions", // POST …/transactions/rules/backtest/ → transactions.py:816
    run: (args) => backtestTransactionRule(args),
  },
  {
    def: {
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
    // install / uninstall need library_keys or bundle. That is said in the descriptions and enforced
    // by the handlers (tools/transactions.ts), never with a top-level anyOf in the input schema:
    // model APIs refuse a tool list that has one (test/tool-schemas-portable.test.mjs).,
    access: "read",
    permission: "list:transactions", // GET …/transactions/rules/library/ → transactions.py:895
    run: (args) => listTransactionRuleLibrary(args),
  },
  {
    def: {
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
      },
    },
    access: "write",
    permission: "write:transactions", // POST …/transactions/rules/install/ → transactions.py:914
    run: (args) => installTransactionRuleLibrary(args),
  },
  {
    def: {
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
      },
    },
    access: "destructive",
    permission: "write:transactions", // DELETE …/transactions/rules/install/ → transactions.py:926
    run: (args) => uninstallTransactionRuleLibrary(args),
  },
];

// ── The transaction tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const TRANSACTION_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
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
    access: "read",
    permission: "list:transactions", // GET …/transactions/ → transactions.py:278
    run: (args) => listTransactions(args),
    spanAllApplications: (args) => searchTransactions(args),
  },
  {
    def: {
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
    access: "write",
    permission: "create:transactions", // POST …/transactions/ → transactions.py:331
    run: (args) => createTransaction(args),
  },
  {
    def: {
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
    access: "read",
    permission: "list:transactions", // GET …/transactions/{id}/ → transactions.py:479
    run: (args) => getTransaction(args.transaction_id),
  },
  {
    def: {
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
    access: "write",
    permission: "create:transactions", // POST …/transactions/screen-wallet/ → transactions.py:371
    run: (args) => screenWallet(args),
  },
];

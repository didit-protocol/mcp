import { apiRequest, orgAppPath } from "../config";
import { DiditError, pathSegment } from "../security";

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

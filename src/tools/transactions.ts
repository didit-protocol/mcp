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

export async function installTransactionRuleLibrary(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/rules/install/"), { method: "POST", json: data });
}

export async function uninstallTransactionRuleLibrary(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/rules/install/"), { method: "DELETE", json: data });
}

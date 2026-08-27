import { apiRequest, orgAppPath } from "../config";
import { pathSegment } from "../security";

// Transaction monitoring (AML) — org/app-scoped console resource.

export async function listTransactions(params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/"), { params });
}

export async function createTransaction(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/"), { method: "POST", json: data });
}

export async function getTransaction(transactionId: string): Promise<any> {
  return apiRequest(orgAppPath(`/transactions/${transactionId}/`));
}

export async function screenWallet(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/screen-wallet/"), { method: "POST", json: data });
}

// Transaction-monitoring rules (KYT) — org/app-scoped console resource, same paths the
// business console itself calls. Rules evaluate conditions/aggregations against monitored
// transactions and apply actions (score, status change, tags, notes, list adds, cases).

const ruleUuid = (id: string) => pathSegment(id, "rule_uuid");

export async function listTransactionRules(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/rules/"), { params });
}

export async function getTransactionRule(ruleUuidValue: string): Promise<any> {
  return apiRequest(orgAppPath(`/transactions/rules/${ruleUuid(ruleUuidValue)}/`));
}

export async function createTransactionRule(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/transactions/rules/"), { method: "POST", json: data });
}

export async function updateTransactionRule(ruleUuidValue: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/transactions/rules/${ruleUuid(ruleUuidValue)}/`), { method: "PATCH", json: data });
}

export async function deleteTransactionRule(ruleUuidValue: string): Promise<any> {
  return apiRequest(orgAppPath(`/transactions/rules/${ruleUuid(ruleUuidValue)}/`), { method: "DELETE" });
}

export async function backtestTransactionRule(data: Record<string, any>): Promise<any> {
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

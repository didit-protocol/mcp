import { apiRequest, orgAppPath } from "../config";

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

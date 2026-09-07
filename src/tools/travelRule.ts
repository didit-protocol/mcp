import { apiRequest, getHeaders, resolveApplicationId, resolveOrganizationId } from "../config";
import type { OrgAppArgs } from "../config";

// Travel Rule — the /v3 client API surface (the same endpoints API-key integrations
// call: /v3/travel-rule/... and /v3/transactions/{uuid}/travel-rule/...). Unlike the
// console (management) tools there is no org/app segment in the path; the backend's
// IsValidUserOrgClient authorizes the acting user's Bearer token through the
// X-Didit-Organization-Id / X-Didit-Application-Id headers instead.

function clientHeaders(opts: OrgAppArgs = {}): Record<string, string> {
  return {
    ...getHeaders(),
    "X-Didit-Organization-Id": resolveOrganizationId(opts.organizationId),
    "X-Didit-Application-Id": resolveApplicationId(opts.applicationId),
  };
}

/** Split a tool-call args object into the org/app scope and the remaining payload. */
function splitScope(args: Record<string, any> = {}): { scope: OrgAppArgs; rest: Record<string, any> } {
  const { organization_id, application_id, ...rest } = args;
  return { scope: { organizationId: organization_id, applicationId: application_id }, rest };
}

export async function getSettings(args: Record<string, any> = {}): Promise<any> {
  const { scope } = splitScope(args);
  return apiRequest("/travel-rule/settings/", { headers: clientHeaders(scope) });
}

export async function updateSettings(args: Record<string, any>): Promise<any> {
  const { scope, rest } = splitScope(args);
  // PUT is a partial update on this endpoint — send only the fields to change.
  return apiRequest("/travel-rule/settings/", { method: "PUT", json: rest, headers: clientHeaders(scope) });
}

export async function searchVasps(args: Record<string, any> = {}): Promise<any> {
  const { scope, rest } = splitScope(args);
  return apiRequest("/travel-rule/vasps/", { params: rest, headers: clientHeaders(scope) });
}

export async function listWalletAddresses(args: Record<string, any> = {}): Promise<any> {
  const { scope, rest } = splitScope(args);
  return apiRequest("/travel-rule/wallet-addresses/", { params: rest, headers: clientHeaders(scope) });
}

export async function createWalletAddress(args: Record<string, any>): Promise<any> {
  const { scope, rest } = splitScope(args);
  return apiRequest("/travel-rule/wallet-addresses/", { method: "POST", json: rest, headers: clientHeaders(scope) });
}

export async function updateWalletAddress(args: Record<string, any>): Promise<any> {
  const { scope, rest } = splitScope(args);
  const { entry_uuid, ...body } = rest;
  return apiRequest(`/travel-rule/wallet-addresses/${entry_uuid}/`, {
    method: "PATCH",
    json: body,
    headers: clientHeaders(scope),
  });
}

export async function deleteWalletAddress(args: Record<string, any>): Promise<any> {
  const { scope, rest } = splitScope(args);
  return apiRequest(`/travel-rule/wallet-addresses/${rest.entry_uuid}/`, {
    method: "DELETE",
    headers: clientHeaders(scope),
  });
}

export async function transferAction(args: Record<string, any>): Promise<any> {
  const { scope, rest } = splitScope(args);
  const { transaction_id, action, payment_txn_id } = rest;
  // Exactly one of: {payment_txn_id} (finish), {action: "cancel"}, {action: "resend"}.
  const body = payment_txn_id ? { payment_txn_id } : { action };
  return apiRequest(`/transactions/${transaction_id}/travel-rule/`, {
    method: "PATCH",
    json: body,
    headers: clientHeaders(scope),
  });
}

export async function confirmOwnership(args: Record<string, any>): Promise<any> {
  const { scope, rest } = splitScope(args);
  const { transaction_id, confirmed } = rest;
  return apiRequest(`/transactions/${transaction_id}/travel-rule/ownership/`, {
    method: "POST",
    json: { confirmed },
    headers: clientHeaders(scope),
  });
}

export async function registerInbound(args: Record<string, any>): Promise<any> {
  const { scope, rest } = splitScope(args);
  return apiRequest("/travel-rule/inbound/", { method: "POST", json: rest, headers: clientHeaders(scope) });
}

export async function createWidgetSession(args: Record<string, any>): Promise<any> {
  const { scope, rest } = splitScope(args);
  return apiRequest("/travel-rule/widget-session/", { method: "POST", json: rest, headers: clientHeaders(scope) });
}

export async function mintSdkToken(args: Record<string, any>): Promise<any> {
  const { scope, rest } = splitScope(args);
  return apiRequest("/transactions/sdk-token/", { method: "POST", json: rest, headers: clientHeaders(scope) });
}

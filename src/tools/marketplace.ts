import { apiRequest, orgAppPath } from "../config";
import type { OrgAppArgs } from "../config";

// Marketplace — org/app-scoped console resource: the provider catalog (crypto
// monitoring / AML screening / phone verification / Travel Rule networks), the
// application's provider connections, and integration requests for on_request entries.

function scope(args: Record<string, any> = {}): OrgAppArgs {
  return { organizationId: args.organization_id, applicationId: args.application_id };
}

export async function listCatalog(args: Record<string, any> = {}): Promise<any> {
  return apiRequest(orgAppPath("/marketplace/catalog/", scope(args)));
}

export async function listConnections(args: Record<string, any> = {}): Promise<any> {
  return apiRequest(orgAppPath("/marketplace/connections/", scope(args)));
}

export async function requestIntegration(args: Record<string, any>): Promise<any> {
  const { organization_id, application_id, ...body } = args;
  return apiRequest(orgAppPath("/marketplace/requests/", { organizationId: organization_id, applicationId: application_id }), {
    method: "POST",
    json: body,
  });
}

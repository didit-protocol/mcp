import { getOrgAppMap } from "../orgapp";

// One-shot discovery: every organization the caller can access with its applications
// nested, plus an unambiguous default org/app when there is only one. Replaces the
// didit_org_list + N×didit_org_list_applications round-trips with a single call.
export async function getContext(): Promise<any> {
  const map = await getOrgAppMap();
  const organizations = map.map((o) => ({
    organization_id: o.orgId,
    organization_name: o.orgName,
    applications: o.apps.map((a) => ({
      application_id: a.appId,
      application_name: a.appName,
      // "live" | "sandbox". A name is not a mode: an application called
      // "Acme (Sandbox)" can be live, and a live one bills every session it
      // creates. Never infer this from application_name.
      ...(a.mode ? { mode: a.mode } : {}),
    })),
  }));
  const allApps = map.flatMap((o) => o.apps.map((a) => ({ orgId: o.orgId, appId: a.appId })));
  return {
    organizations,
    organization_count: organizations.length,
    application_count: allApps.length,
    default_organization_id:
      organizations.length === 1 ? organizations[0].organization_id : undefined,
    default_application_id: allApps.length === 1 ? allApps[0].appId : undefined,
    hint: "Pass organization_id/application_id to target one scope, or omit them on *_search tools to aggregate across all apps. `mode` is the application's environment: a LIVE application bills every verification session created in it, a SANDBOX one mocks every provider and never bills. Read the field — never guess the environment from application_name.",
  };
}

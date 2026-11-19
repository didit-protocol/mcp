import { requestContext } from "../config";
import { getOrgAppMap } from "../orgapp";

// One-shot discovery: every organization the caller can access with its applications
// nested, plus an unambiguous default org/app when there is only one. Replaces the
// didit_org_list + N×didit_org_list_applications round-trips with a single call.

// Said beside applications read from the member's own row: they are the person's access.
const MEMBERSHIP_NOTE =
  "These applications come from this member's own membership of the organization (their row in the member list), " +
  "not from the organization's application list, which only Owner and Admin may read. They are the applications " +
  "this connection can open.";
// Added only when an application of that row carries no `mode`: the member row gives it since
// service-didit-auth v3.197, but an entry written as a bare id, or an older answer,
// has none. Saying "not known" beside applications that do carry a mode made an assistant doubt
// the field it had just been given.
const MODE_UNKNOWN_NOTE =
  " An application listed here without a `mode` field has an unknown mode (live or sandbox): do not guess it from " +
  "the name - a live application bills every session. Read it in the Didit console before a live action.";
// Said when neither route produced a list: UNKNOWN, which must never be read as none.
const UNKNOWN_NOTE =
  "The applications of at least one organization could not be listed, and this member's own access could not be read " +
  "either, so their applications are unknown - not none. Do not tell the person they have no applications. Retry, or " +
  "check the person's role and application access in the Didit console.";

export async function getContext(): Promise<any> {
  const map = await getOrgAppMap();
  const organizations = map.map((o) => ({
    organization_id: o.orgId,
    organization_name: o.orgName,
    // An organization whose applications could not be listed carries no `applications` key at
    // all: an empty list next to `application_count: 0` is what made every assistant tell a
    // Reader, Developer or Compliance Officer "your organization has no applications".
    ...(o.appsError
      ? { applications_unknown: true }
      : {
          applications: o.apps.map((a) => ({
            application_id: a.appId,
            application_name: a.appName,
            // "live" | "sandbox". A name is not a mode: an application called
            // "Acme (Sandbox)" can be live, and a live one bills every session it
            // creates. Never infer this from application_name.
            ...(a.mode ? { mode: a.mode } : {}),
          })),
          ...(o.appsSource === "membership"
            ? {
                applications_source: "membership",
                applications_note: MEMBERSHIP_NOTE + (o.apps.every((a) => a.mode) ? "" : MODE_UNKNOWN_NOTE),
              }
            : {}),
        }),
  }));
  const allApps = map.flatMap((o) => o.apps.map((a) => ({ orgId: o.orgId, appId: a.appId })));
  // An org whose applications failed to list is UNKNOWN, not empty - it may hold a second
  // application, so a lone visible app is not a default. The scope resolver applies the same
  // rule, and the two must agree: a default advertised here that the resolver then refuses is
  // exactly the "application_id is required" dead end this field exists to prevent.
  const appsUnknown = map.some((o) => o.appsError);
  // An API key connection (api-key-connection.ts): say so, because what it can do follows the
  // key and not a person's role, and the tools that need a person are not on it.
  const key = requestContext.getStore()?.apiKeyScope;
  return {
    ...(key
      ? {
          connection: {
            type: "api_key",
            ...(key.keyLabel ? { key_label: key.keyLabel } : {}),
            ...(key.keyPrefix ? { key_prefix: key.keyPrefix } : {}),
            access: key.restricted ? "restricted" : "full",
            note:
              "This connection uses an application API key: it acts on this one application, with the access the key has. " +
              "Members, roles, API key management, the plan, cards and receipts need a person's sign-in (the Didit console, or an OAuth connection).",
          },
        }
      : {}),
    organizations,
    organization_count: organizations.length,
    // A count is only a fact when every organization's applications were listed. Otherwise it is
    // omitted: "application_count: 0" read as a fact is exactly the wrong answer, and the
    // per-organization `applications_unknown` flag says where the gap is.
    ...(appsUnknown ? { applications_unknown: true, applications_note: UNKNOWN_NOTE } : { application_count: allApps.length }),
    default_organization_id:
      organizations.length === 1 ? organizations[0].organization_id : undefined,
    default_application_id: allApps.length === 1 && !appsUnknown ? allApps[0].appId : undefined,
    hint: "Pass organization_id/application_id to target one scope, or omit them on *_search tools to aggregate across all apps. `mode` is the application's environment: a LIVE application bills every verification session created in it, a SANDBOX one mocks every provider and never bills. Read the field — never guess the environment from application_name.",
  };
}

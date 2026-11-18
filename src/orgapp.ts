import { DIDIT_AUTH_BASE_URL, apiRequest, requestContext } from "./config";
import { everyPage } from "./paging";
import { pathSegment } from "./security";
import { listOrganizations, listApplications } from "./tools/auth";

// Cross-org/app context layer. The Didit management API is resource-path-scoped
// (/organization/{org}/application/{app}/...) with no cross-app endpoint, so answering
// "across all my apps" means fanning out over every (org, app) the caller can access.
// This module discovers + caches that map and runs fan-out branches in the right scope,
// so the aggregate search tools (and auto-default resolution) reuse the existing per-app
// list functions verbatim.

export interface AppRef {
  appId: string;
  appName: string;
  /** "live" | "sandbox" — the application's mode, as the auth API reports it. Carried through
   *  because "am I about to bill this customer?" is unanswerable without it: sandbox sessions are
   *  never billed and mock every provider, and a copilot that cannot see this told a customer she
   *  was testing in sandbox while it drove her live application. Absent when the API omits it. */
  mode?: string;
}
export interface OrgRef {
  orgId: string;
  orgName: string;
  apps: AppRef[];
  /** listApplications failed for this org — its apps are UNKNOWN, not empty. */
  appsError?: boolean;
  /** Where `apps` came from when the organization's application list was refused: the signed-in
   *  member's own row in the member list. Those applications carry no `mode`. */
  appsSource?: "membership";
}

interface CacheEntry {
  map: OrgRef[];
  expires: number;
}

// Keyed by the caller's access token; the MCP process is long-lived so module state
// persists across the per-request Server instances. Short TTL keeps it fresh.
const orgAppCache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

function extractResults(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.results)) return payload.results;
  if (payload && Array.isArray(payload.organizations)) return payload.organizations;
  if (payload && Array.isArray(payload.applications)) return payload.applications;
  return [];
}

const idOf = (o: any): string | undefined =>
  o?.uuid ?? o?.id ?? o?.organization_id ?? o?.application_id;
const nameOf = (o: any): string => o?.name ?? o?.display_name ?? idOf(o) ?? "";
const modeOf = (o: any): { mode?: string } =>
  typeof o?.mode === "string" && o.mode ? { mode: o.mode } : {};

const toAppRef = (a: any): AppRef | null => {
  const appId = idOf(a);
  return appId ? { appId, appName: nameOf(a), ...modeOf(a) } : null;
};
const toAppRefs = (payload: any): AppRef[] =>
  extractResults(payload).map(toAppRef).filter((a): a is AppRef => a !== null);

/**
 * The applications on the signed-in member's own row, or undefined when any of them is unreadable.
 *
 * The read shape of `accessible_applications` is expanded objects (`OrganizationApplicationSerializer`,
 * `{ uuid, name }`); the write shape is a list of bare UUIDs (`OrganizationMemberUpdateSerializer`).
 * Both are accepted, so a row that answers in either shape gives the person their applications.
 *
 * One entry that is neither an object carrying an id nor a non-empty string makes the whole list
 * UNKNOWN. Dropping it would answer a shorter list, or an empty one, and "your organization has no
 * applications" is the answer this fallback exists to stop giving: unreadable is not none.
 */
function membershipAppRefs(entries: any[]): AppRef[] | undefined {
  const refs: AppRef[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const appId = entry.trim();
      if (!appId) return undefined;
      // A bare id carries no name and no mode. The id is the only label the row gave, the same
      // fallback toAppRef uses for an object whose name the API omitted.
      refs.push({ appId, appName: appId });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const ref = toAppRef(entry);
    if (!ref) return undefined;
    refs.push(ref);
  }
  return refs;
}

/** The signed-in member's identifier (their e-mail/SSO id), to find their own row in a member list. */
async function memberIdentifier(): Promise<string | undefined> {
  const me = await apiRequest("/users/me/", { baseUrl: DIDIT_AUTH_BASE_URL });
  return typeof me?.identifier === "string" && me.identifier ? me.identifier : undefined;
}

/**
 * The applications the signed-in member may open, read from their OWN row in the member list.
 *
 * GET /organizations/me/{org}/applications/ answers 403 to every role but Owner and Admin
 * ("Only organization owners and admins can manage applications."), while the same person can
 * list the team (list:members) and their row carries `accessible_applications` — the ids the
 * app-scoped tools already accept. Reading it separates "refused" from "none": before this,
 * every non-admin role was shown an empty organization and told it had no applications.
 *
 * The member list is paged (`?limit=` / `?offset=`, answering `{count, next, previous, results}`),
 * and the caller's own row is not necessarily on the first page: in a large organization that
 * row can be on page 2 or later, so reading one page answered "could not be determined" for
 * exactly the teams this fallback exists for. everyPage (paging.ts) is the same reader the
 * organization and application discovery use; its callback hands back only the page holding the
 * caller's row, with no `next`, so paging stops there. The read keeps that helper's page cap, so
 * a list that never ends cannot hang the call. A page that cannot be read, or a read the cap
 * stopped before the end, answers undefined (UNKNOWN), never "no applications".
 *
 * The row has no `mode`, so these applications carry none. Undefined means the row could not be
 * read (not that it is empty): the caller must report the organization's apps as UNKNOWN.
 */
async function appsFromOwnMembership(orgId: string, identifier: string): Promise<AppRef[] | undefined> {
  // Called directly rather than through tools/members.listMembers: that module imports ORG_APP_PROPS
  // from here, and importing it back would be a cycle.
  const path = `/organizations/${pathSegment(orgId, "organization_id")}/members/`;
  const wanted = identifier.toLowerCase();
  const ownRow = (rows: any[]): any =>
    rows.find((m) => typeof m?.identifier === "string" && m.identifier.toLowerCase() === wanted);
  const whole = await everyPage(async (page) => {
    const answer = await apiRequest(path, { baseUrl: DIDIT_AUTH_BASE_URL, params: page });
    // A bare array is a list the API did not page; everyPage returns it whole, so nothing to trim.
    if (Array.isArray(answer)) return answer;
    const found = ownRow(extractResults(answer));
    // Stop at the page that has the row: everyPage ends a paged read on a page with no `next`.
    return found ? { ...answer, results: [found], next: null } : answer;
  });
  if (!whole.complete) return undefined;
  const mine = ownRow(whole.rows);
  if (!mine || !Array.isArray(mine.accessible_applications)) return undefined;
  return membershipAppRefs(mine.accessible_applications);
}

async function buildOrgAppMap(): Promise<OrgRef[]> {
  const orgs = extractResults(await listOrganizations());
  // Fetched at most once per map, and only when an organization's applications are refused.
  let identifier: Promise<string | undefined> | undefined;
  const ownIdentifier = () => (identifier ??= memberIdentifier().catch(() => undefined));
  const refs = await Promise.all(
    orgs.map(async (o): Promise<OrgRef | null> => {
      const orgId = idOf(o);
      if (!orgId) return null;
      let apps: AppRef[] = [];
      let appsError = false;
      let appsSource: OrgRef["appsSource"];
      try {
        apps = toAppRefs(await listApplications(orgId));
      } catch {
        // Refused or failed, which is UNKNOWN, not "none". A non-admin role is refused here by
        // design, so ask the member list for the applications this person can actually open.
        try {
          const own = await ownIdentifier();
          const fromMembership = own ? await appsFromOwnMembership(orgId, own) : undefined;
          if (fromMembership) {
            apps = fromMembership;
            appsSource = "membership";
          } else {
            appsError = true;
          }
        } catch {
          appsError = true;
        }
      }
      return { orgId, orgName: nameOf(o), apps, ...(appsSource ? { appsSource } : {}), ...(appsError ? { appsError } : {}) };
    }),
  );
  return refs.filter((r): r is OrgRef => r !== null);
}

/** The caller's organizations with their applications nested, cached per token (60s TTL). */
export async function getOrgAppMap(forceRefresh = false): Promise<OrgRef[]> {
  // An API key connection is its one application (api-key-connection.ts). The auth service
  // already named it when it accepted the key, and the membership routes a person's map is
  // built from do not answer to a key, so nothing is fetched and nothing is cached.
  const key = requestContext.getStore()?.apiKeyScope;
  if (key) {
    return [
      {
        orgId: key.organizationId,
        orgName: key.organizationName ?? key.organizationId,
        apps: [{ appId: key.applicationId, appName: key.applicationName ?? key.applicationId, ...(key.mode ? { mode: key.mode } : {}) }],
      },
    ];
  }
  const token = requestContext.getStore()?.accessToken ?? "__stdio__";
  const now = Date.now();
  const cached = orgAppCache.get(token);
  if (!forceRefresh && cached && cached.expires > now) return cached.map;
  const map = await buildOrgAppMap();
  orgAppCache.set(token, { map, expires: now + TTL_MS });
  return map;
}

/** Run `fn` with the request context scoped to a specific (org, app) so the existing
 *  per-app tools resolve orgAppPath() and the X-Didit-Organization-Id header correctly. */
export async function runForScope<R>(
  orgId: string,
  appId: string | undefined,
  fn: () => Promise<R>,
): Promise<R> {
  const ctx = requestContext.getStore();
  return requestContext.run(
    { accessToken: ctx?.accessToken, apiKey: ctx?.apiKey, apiKeyScope: ctx?.apiKeyScope, organizationId: orgId, applicationId: appId },
    fn,
  );
}

/** Bounded-parallel map — caps concurrent fan-out so we don't hammer the API. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return results;
}

// Org/app selectors shared by the console (management) tools, which target
// /organization/{org}/application/{app}/... endpoints. Spread into each such tool's
// `properties`. Resolved (arg → token context → env default) by orgAppPath in config.ts;
// discover ids via didit_org_list / didit_org_list_applications.
export const ORG_APP_PROPS = {
  organization_id: {
    type: "string",
    description: "Organization UUID (from didit_org_list). Optional if your token has a single/default org.",
  },
  application_id: {
    type: "string",
    description: "Application UUID (from didit_context_get). Optional when you own exactly one application - it is resolved automatically, even if you belong to several organizations.",
  },
} as const;

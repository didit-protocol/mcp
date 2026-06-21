import { requestContext } from "./config";
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
}
export interface OrgRef {
  orgId: string;
  orgName: string;
  apps: AppRef[];
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

async function buildOrgAppMap(): Promise<OrgRef[]> {
  const orgs = extractResults(await listOrganizations());
  const refs = await Promise.all(
    orgs.map(async (o): Promise<OrgRef | null> => {
      const orgId = idOf(o);
      if (!orgId) return null;
      let apps: AppRef[] = [];
      try {
        apps = extractResults(await listApplications(orgId))
          .map((a): AppRef | null => {
            const appId = idOf(a);
            return appId ? { appId, appName: nameOf(a) } : null;
          })
          .filter((a): a is AppRef => a !== null);
      } catch {
        apps = []; // org whose apps the caller can't list — leave it appless
      }
      return { orgId, orgName: nameOf(o), apps };
    }),
  );
  return refs.filter((r): r is OrgRef => r !== null);
}

/** The caller's organizations with their applications nested, cached per token (60s TTL). */
export async function getOrgAppMap(forceRefresh = false): Promise<OrgRef[]> {
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
    { accessToken: ctx?.accessToken, organizationId: orgId, applicationId: appId },
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

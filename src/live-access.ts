// The caller's CURRENT membership, asked of service-didit-auth while a call runs.
//
// `permissions.ts` predicts what the backend will demand from the token that was verified when the
// connection opened; this module asks the source of truth what the person may do NOW, for the
// organization a call acts in and for every organization a cross-organisation fan-out is about to
// read. It lives here rather than in permissions.ts so a tool module can use it without
// loading the permission map, which is built from the tool modules (a require cycle otherwise).
import { requestContext } from "./config";
import { DiditError } from "./security";
import type { OrganizationAccess } from "./permissions";

/** The same read for the organization a call is about, with the connection's own token already
 *  applied (index.ts puts it in the request context, config.ts RequestCredentials.liveAccess). */
export type LiveAccessReader = (organizationId: string) => Promise<OrganizationAccess | null>;

/** The organization id shape every console path and the auth service use; a malformed one is the
 *  resolver's to report, and asking the auth service about it would only answer "no such organization". */
export const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The caller's CURRENT access to one organization for THIS call, from the reader the request
 * context carries (a hosted OAuth connection with the live check on), or undefined when the call
 * has none to ask (an API key connection, a local stdio server, `MCP_PERMISSION_MODE=off`).
 *
 * Asked at most once per organization per call: the dispatcher checks the organization a call
 * names and a cross-organisation fan-out checks every organization it is about to read, and both
 * must cost ONE introspection, not one each. A rejection is kept too: an auth service that did not
 * answer is not asked again a second time in the same call.
 */
export async function liveAccessFor(organizationId: string): Promise<OrganizationAccess | null | undefined> {
  const store = requestContext.getStore();
  const reader = store?.liveAccess;
  if (!reader || !ORGANIZATION_ID.test(organizationId)) return undefined;

  const answers = (store.liveAnswers ??= new Map());
  const key = organizationId.toLowerCase();
  const asked = answers.get(key) ?? reader(organizationId);
  answers.set(key, asked);

  return asked;
}

/** One organization a cross-organisation fan-out left out, and why — part of the result, so a
 *  partial read never looks like a whole one (tools/search.ts, tools/analytics.ts put these in
 *  their answer). */
export interface LeftOutOrganization {
  organization_id: string;
  organization_name?: string;
  /** Why nothing was read there, in the words the result shows. */
  reason: string;
}

/** One application a fan-out left out, and why: the membership there no longer opens it. */
export interface LeftOutApplication {
  organization_id: string;
  organization_name?: string;
  application_id: string;
  application_name?: string;
  reason: string;
}

/** The organization and application fields of a map entry this module judges (orgapp.ts OrgRef). */
interface ScopedApplication {
  appId: string;
  appName?: string;
}
interface ScopedOrganization<A extends ScopedApplication> {
  orgId: string;
  orgName?: string;
  apps: A[];
}

/**
 * The organizations and applications a cross-organisation fan-out may still read, and the ones it
 * must leave out with the reason.
 *
 * A call that names no organization fans out over every organization and application the 60 s
 * organisation map remembers, and that map keeps a removed membership — and an application taken
 * off the membership — for up to a minute. Asking the live answer for each organization before
 * reading it, and comparing every application the fan-out is about to query with the applications
 * that answer lists, is what makes a removal reach the very next call there too, instead of
 * fetching data the person may no longer see. One question per organization, in parallel, inside
 * the call's own time limit; the applications of an organization cost no second question.
 *
 * `droppedApps` names, per organization id, the applications this call left out, so a result that
 * comes back from an organization-wide endpoint (rows tagged by application) can drop their rows.
 *
 * It fails the whole call when the auth service does not answer, or when it says the sign-in is
 * gone: rows from the organizations that did answer would silently read as "this is all there is".
 */
export async function liveReadableScopes<
  A extends ScopedApplication,
  T extends ScopedOrganization<A>,
>(organizations: readonly T[]): Promise<{
  readable: T[];
  leftOutOrganizations: LeftOutOrganization[];
  leftOutApplications: LeftOutApplication[];
  droppedApps: Map<string, Set<string>>;
}> {
  const store = requestContext.getStore();
  const tool = store?.toolName ?? "this call";
  const accepted = store?.acceptedPermissions ?? [];
  const answers = await Promise.all(
    organizations.map(async (org) => {
      try {
        return { org, access: await liveAccessFor(org.orgId) };
      } catch {
        return { org, access: undefined, failed: true };
      }
    }),
  );

  if (answers.some((answer) => "failed" in answer)) {
    throw new DiditError({
      code: "unavailable",
      message:
        `Didit could not confirm your access to your organizations just now (the sign-in service did not answer), ` +
        `so ${tool} did not run. Retry in a moment.`,
    });
  }
  if (answers.some((answer) => answer.access === null)) {
    throw new DiditError({
      code: "missing_auth",
      message: `Your Didit sign-in is no longer valid, so ${tool} cannot run. Reconnect this connection and sign in again.`,
    });
  }

  const readable: T[] = [];
  const leftOutOrganizations: LeftOutOrganization[] = [];
  const leftOutApplications: LeftOutApplication[] = [];
  const droppedApps = new Map<string, Set<string>>();
  for (const { org, access } of answers) {
    // No live answer to judge from (a connection with no live check): read it as before.
    if (!access) {
      readable.push(org);
      continue;
    }
    const named = org.orgName ? { organization_name: org.orgName } : {};
    if (access.role === null) {
      leftOutOrganizations.push({ organization_id: org.orgId, ...named, reason: "you are no longer a member of it" });
      continue;
    }
    if (access.permissions && accepted.length > 0 && !access.permissions.some((p) => accepted.includes(p))) {
      leftOutOrganizations.push({
        organization_id: org.orgId,
        ...named,
        // "does not include", never "no longer": the live answer cannot see whether the role ever had
        // it, and a Reader who never held the privilege must not be told a change happened.
        reason: "your role there does not include the permission it needs",
      });
      continue;
    }
    // The applications this person may open there, when the live answer says. A call that names no
    // application must not read one the membership no longer opens — the 60 s map still holds it.
    const open = access.accessibleApplications;
    if (!open) {
      readable.push(org);
      continue;
    }
    const kept = org.apps.filter((app) => open.some((id) => sameId(id, app.appId)));
    const dropped = org.apps.filter((app) => !open.some((id) => sameId(id, app.appId)));
    if (dropped.length > 0) {
      droppedApps.set(org.orgId.toLowerCase(), new Set(dropped.map((app) => app.appId.toLowerCase())));
      for (const app of dropped) {
        leftOutApplications.push({
          organization_id: org.orgId,
          ...(org.orgName ? { organization_name: org.orgName } : {}),
          application_id: app.appId,
          ...(app.appName ? { application_name: app.appName } : {}),
          // "does not include", never "no longer": the live answer lists what the membership opens
          // now and cannot see whether it ever had the application, so a member who never had it
          // must not be told that access was taken away.
          reason: "does not include access to it",
        });
      }
    }
    readable.push({ ...org, apps: kept as A[] });
  }

  return { readable, leftOutOrganizations, leftOutApplications, droppedApps };
}

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * What a fan-out result says about the organizations and applications it was told to leave out:
 * one plain sentence, so a partial read is never mistaken for a whole one.
 */
export function leftOutFields(
  organizations: readonly LeftOutOrganization[],
  applications: readonly LeftOutApplication[] = [],
): Record<string, unknown> {
  if (organizations.length === 0 && applications.length === 0) return {};
  const orgNames = organizations.map((org) => `${org.organization_name ?? org.organization_id} (${org.reason})`);
  const orgClause = organizations.length > 0
    ? `${organizations.length} organization${organizations.length === 1 ? "" : "s"}: ${orgNames.join(", ")}`
    : undefined;
  const appNames = applications.map((app) => {
    const inOrg = app.organization_name ? ` in ${app.organization_name}` : "";
    return `${app.application_name ?? app.application_id}${inOrg} (${app.reason})`;
  });
  const appClause = applications.length > 0
    ? `${applications.length} application${applications.length === 1 ? "" : "s"}: ${appNames.join(", ")}`
    : undefined;
  const what = [orgClause, appClause].filter(Boolean).join(", and ");
  const count = organizations.length + applications.length;
  return {
    ...(organizations.length > 0 ? { left_out_organizations: organizations } : {}),
    ...(applications.length > 0 ? { left_out_applications: applications } : {}),
    left_out_note: `Left out ${what}; nothing was read from ${count === 1 ? "it" : "them"}.`,
  };
}

/**
 * WAKESHIFT_ORGANIZATIONS: which organizations agent wakes are on for.
 *
 * WAKESHIFT_KEY with DIDIT_EVENTS_SECRET is the server's switch (http.ts). This is the roll-out's:
 *
 *   - unset, or a list that names `*`: wakes are on for every organization;
 *   - a comma-separated list of organization IDs: only for those;
 *   - set and empty: for none.
 *
 * For an organization that is not listed, the server is the server it is with Wakeshift off: its
 * connections list no watch tool, no description changes, nothing subscribes, and a backend
 * notification of its is acknowledged and dropped, never emitted. So what reaches Wakeshift is
 * decided here, by the service that talks to it, whatever the backend chooses to send.
 *
 * Who a connection is. An application API key is its application's organization, and a sign-in
 * whose token names an organization is that one. Most sign-ins name none: a person belongs to
 * organizations, and the token does not say which one a call is for. With a list, such a
 * connection is offered wakes when the person belongs to a listed organization, and each watch is
 * then decided again where it is made, by the organization the call acts in (wakeshift.ts), so
 * belonging to a listed organization never makes another one of the person's watchable.
 *
 * This module has no Wakeshift dependency: http.ts reads it before anything of the SDK is loaded.
 */

import { createHash } from "node:crypto";

export type WakeshiftOrganizations = { all: true } | { all: false; ids: ReadonlySet<string> };

const normalize = (id: string): string => id.trim().toLowerCase();

export function wakeshiftOrganizations(raw: string | undefined = process.env.WAKESHIFT_ORGANIZATIONS): WakeshiftOrganizations {
  if (raw === undefined) return { all: true };
  const ids = raw.split(",").map(normalize).filter(Boolean);
  if (ids.includes("*")) return { all: true };
  return { all: false, ids: new Set(ids) };
}

/** Whether wakes are on for this organization. With a list, an unknown organization is not on it. */
export function organizationAllowed(organizations: WakeshiftOrganizations, organizationId: unknown): boolean {
  if (organizations.all) return true;
  return typeof organizationId === "string" && organizations.ids.has(normalize(organizationId));
}

/**
 * The organization a connection acts for: the one its token names (a person's sign-in, or an
 * application API key, whose organization is its application's). A sign-in that is not tied to
 * one organization has none, so with a list it is not offered wakes.
 */
export function organizationOf(authInfo: { extra?: Record<string, unknown> } | undefined): string | undefined {
  const organizationId = authInfo?.extra?.organization_id;
  return typeof organizationId === "string" && organizationId.trim() ? organizationId : undefined;
}

/** A connection, as far as the roll-out reads it: the verified credential's token and what it names. */
export type ConnectionAuth = { token?: string; extra?: Record<string, unknown> } | undefined;

/** The organizations a person belongs to, asked with the person's own token. */
export type MembershipLookup = (token: string) => Promise<string[]>;

/** How long a person's answer is remembered, and for how many people at most. */
export const MEMBERSHIP_TTL_MS = 10 * 60 * 1000;
export const MEMBERSHIP_MAX_ENTRIES = 5000;

/**
 * Whether wakes are offered to a connection.
 *
 *   - no list: yes, and nothing is looked up;
 *   - the token names an organization (every API key does): that organization decides;
 *   - a sign-in that names none: yes when the person belongs to a listed organization. The answer
 *     is remembered for ten minutes under a hash of the token, never the token, so a list costs
 *     one membership read per person and ten minutes, and none once the list is `*`.
 *
 * A lookup that fails answers no and is not remembered: the next request asks again, and until
 * then the connection is served as it is with Wakeshift off, which is always safe.
 */
export function createWakeshiftAccess(
  organizations: WakeshiftOrganizations,
  memberships: MembershipLookup,
  now: () => number = Date.now,
): (authInfo: ConnectionAuth) => Promise<boolean> {
  const remembered = new Map<string, { allowed: boolean; expires: number }>();
  return async (authInfo) => {
    if (organizations.all) return true;
    const named = organizationOf(authInfo);
    if (named) return organizationAllowed(organizations, named);
    const token = typeof authInfo?.token === "string" ? authInfo.token : "";
    if (!token) return false;
    const key = createHash("sha256").update(token).digest("hex");
    const known = remembered.get(key);
    if (known && known.expires > now()) return known.allowed;
    let allowed: boolean;
    try {
      allowed = (await memberships(token)).some((id) => organizationAllowed(organizations, id));
    } catch {
      return false;
    }
    if (remembered.size >= MEMBERSHIP_MAX_ENTRIES) {
      // Oldest first: a Map keeps insertion order, and an entry is re-inserted when it is refreshed.
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) remembered.delete(oldest);
    }
    remembered.delete(key);
    remembered.set(key, { allowed, expires: now() + MEMBERSHIP_TTL_MS });
    return allowed;
  };
}

/**
 * Whether the call being answered may make a watch: the roll-out's second check, asked where each
 * watch is made (wakeshift.ts), after the tool's own access check.
 *
 *   - no list: yes;
 *   - the call acts in an organization (the one it names, the token's, the API key's, or the
 *     caller's only one): that organization decides;
 *   - the call resolved none: a person with several organizations who named none, watching a
 *     session by its ID. The session belongs to one of them and the server cannot tell which, so
 *     it is watchable only when every organization the person belongs to is listed. Otherwise the
 *     person names the organization on the call, and the tool's read is then made in it.
 *
 * A membership read that fails answers no.
 */
export function createWatchable(
  organizations: WakeshiftOrganizations,
  actingOrganization: () => string | undefined,
  memberships: () => Promise<string[]>,
): () => Promise<boolean> {
  return async () => {
    if (organizations.all) return true;
    const acting = actingOrganization();
    if (acting) return organizationAllowed(organizations, acting);
    try {
      const ids = await memberships();
      return ids.length > 0 && ids.every((id) => organizationAllowed(organizations, id));
    } catch {
      return false;
    }
  };
}

/** For the startup line: who wakes are on for, never an ID. */
export function describeOrganizations(organizations: WakeshiftOrganizations): string {
  if (organizations.all) return "every organization";
  return organizations.ids.size === 1 ? "1 organization" : `${organizations.ids.size} organizations`;
}

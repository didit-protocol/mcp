import { apiRequest, orgAppPath, resolveOrganizationId } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { pathSegment } from "../security";

// Audit logs (organization-scoped) + alerts (org/app-scoped console resources).

/**
 * The organization's audit log: `/audit/{org}/audit-logs/` on the verification API
 * (service-didit-verification audit/urls.py), outside `/organization/`, so neither orgPath
 * nor orgAppPath builds it. Every other argument is a list filter: an explicit
 * `application_id` narrows the log to that application instead of routing the request.
 */
export async function listAuditLogs(params: Record<string, any> = {}): Promise<any> {
  const { organization_id: organizationId, ...filters } = params;
  const org = pathSegment(resolveOrganizationId(organizationId), "organization_id");

  return apiRequest(`/audit/${org}/audit-logs/`, { params: filters });
}

export async function listAlerts(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/alerts/"), { params });
}

export async function configureAlert(alertType: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/alerts/${pathSegment(alertType, "alert_type")}/`), { method: "PATCH", json: data });
}

// ── The audit log and alert tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const AUDIT_AND_ALERT_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_audit_log_list",
      description:
        "List the organization's audit log, newest first: who did what in the organization (members, API keys, " +
        "Didit itself, the Didit assistant and the Investigator). Each entry has actor {type, name, email}, action, " +
        "description, target {type, id, label} and changes. Decisions the Investigator took on its own are entries " +
        "with actor_type 'investigator' and changes.investigator {run_id, outcome, recommendation, confidence, policy}. " +
        "A person's decision on an Investigator report is that member's entry with changes.investigator.outcome " +
        "'accepted' or 'overridden'. To answer \"who approved session 20458\", pass search='20458' (or target_id=<the " +
        "record's uuid>) and read the actor of the decision entry.",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: ORG_APP_PROPS.organization_id,
          application_id: { type: "string", description: "Only this application's entries (application UUID). Omit for the whole organization." },
          actor_type: { type: "string", enum: ["member", "api_key", "system", "assistant_delegated", "investigator"], description: "Only this kind of actor." },
          action_category: { type: "string", description: "e.g. sessions, transactions, cases, api-keys, members; comma-separated for several." },
          target_type: { type: "string", description: "The kind of record acted on, e.g. session, transaction, case." },
          target_id: { type: "string", description: "The UUID of the record acted on." },
          search: { type: "string", description: "A session number, event id (evt_...), email, IP, path or record label." },
          created_at_start: { type: "string", description: "ISO date-time, inclusive." },
          created_at_end: { type: "string", description: "ISO date-time, inclusive." },
          page: { type: "integer", minimum: 1, description: "1-based page (default 1)." },
          page_size: { type: "integer", minimum: 1, maximum: 100, description: "Entries per page (default 25, max 100)." },
        },
      },
    },
    // application_id filters the organization's audit log; it does not route the call.
    access: "read",
    permission: ["read:audit-logs", "list:audit-logs"], // GET /audit/{org}/audit-logs/ → audit/views/audit_log.py:292
    routingIds: true,
    run: (args) => listAuditLogs(args),
  },
  {
    def: {
      name: "didit_alert_list",
      description:
        "List the application's alerts, one per channel: `alert_type` (email or slack), where it is sent (`value`) and whether it is on (`is_active`).",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    access: "read",
    permission: ["read:applications", "list:applications"], // GET …/alerts/ → alerts.py:62
    run: (args) => listAlerts(args),
  },
  {
    def: {
      name: "didit_alert_configure",
      description:
        "Set where one of the application's alerts is sent, or turn it on or off. `alert_type` is the channel. An " +
        "alert with no destination is always off. If the API answers 409 legacy_alerts_read_only, this " +
        "application's alerts are managed in the console's Notification settings and cannot be changed here.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          alert_type: { type: "string", enum: ["email", "slack"], description: "The channel to change." },
          data: {
            type: "object",
            description: "What to change; a field left out keeps its value.",
            properties: {
              value: { type: "string", description: "The destination: an email address for email, a Slack webhook URL for slack." },
              is_active: { type: "boolean", description: "Whether the alert is on." },
            },
          },
        },
        required: ["alert_type"],
      },
    },
    access: "write",
    permission: "write:applications", // PATCH …/alerts/{type}/ → alerts.py:42
    run: (args) => configureAlert(args.alert_type, args.data || {}),
  },
];

import { apiRequest, orgAppPath } from "../config";
import { ORG_APP_PROPS } from "../orgapp";
import type { RegisteredTool } from "./registry";
import { PAGE_PROPS, pageParams } from "../paging";
import { DiditError, redactWebhookDestination, redactCollection, assertSafeWebhookUrl, pathSegment } from "../security";

// Webhook destinations are org/app-scoped console resources (paths match 1:1).
// The signing secret is redacted on every read; the destination URL is SSRF-guarded
// (the backend dereferences it) before create/update.

// The backend's WebhookTypeChoices (common/config/choices.py), in its order. bank.* is refused
// where Bank data is not open (customer_webhook_types).
const WEBHOOK_EVENTS = [
  "status.updated", "data.updated", "user.status.updated", "user.data.updated", "business.status.updated",
  "business.data.updated", "activity.created", "transaction.created", "transaction.status.updated",
  "travel_rule.status.updated", "message.status.updated", "message.received", "contact.consent.updated",
  "workflow.compliance_changed", "transaction_rule_suggestions.created", "investigator.report.ready",
  "investigator.decision.automated", "investigator.decision.overridden", "investigator.question.raised",
  "investigator.automation.paused", "investigator.rfi.answered", "investigator.rfi.overdue",
  "investigator.decision.contested", "investigator.drift.detected", "investigator.qa.failed",
  "investigator.external.report.ready", "investigator.sla.breached", "bank.link.completed", "bank.link.cancelled",
  "bank.link.expired", "bank.link.failed", "bank.connection.created", "bank.connection.updated",
  "bank.connection.consent_expiring", "bank.connection.renewal_required", "bank.connection.renewed",
  "bank.connection.revoked", "bank.connection.deleted", "bank.connection.history_complete", "bank.data.updated",
  "bank.sync.completed", "bank.sync.failed", "bank.sync.recovered", "auth.signup", "auth.login", "auth.login_failed",
  "auth.password_reset_requested", "auth.password_reset_completed", "auth.mfa_changed", "auth.new_device",
  "auth.account_locked",
];

function guardWebhookData(data: Record<string, any>): Record<string, any> {
  const out = { ...data };
  for (const field of ["url", "webhook_url", "endpoint", "target_url"]) {
    if (typeof out[field] === "string") out[field] = assertSafeWebhookUrl(out[field], field);
  }
  return out;
}

export async function listDestinations(): Promise<any> {
  return redactCollection(await apiRequest(orgAppPath("/webhook/destinations/")), redactWebhookDestination);
}

/** With no subscription stored, a destination never receives anything. */
function assertSubscribes(events: unknown): void {
  if (Array.isArray(events) && events.length > 0) return;
  throw new DiditError({
    code: "bad_request",
    message: "Say which events the destination receives: without subscribed_events it would receive none.",
    field: "subscribed_events",
    allowed: WEBHOOK_EVENTS,
  });
}

export async function createDestination(data: Record<string, any>): Promise<any> {
  assertSubscribes(data.subscribed_events);

  return redactWebhookDestination(
    await apiRequest(orgAppPath("/webhook/destinations/"), { method: "POST", json: guardWebhookData(data) }),
  );
}

export async function getDestination(destinationUuid: string): Promise<any> {
  return redactWebhookDestination(
    await apiRequest(orgAppPath(`/webhook/destinations/${pathSegment(destinationUuid, "destination_uuid")}/`)),
  );
}

export async function updateDestination(destinationUuid: string, data: Record<string, any>): Promise<any> {
  if (data.subscribed_events !== undefined) assertSubscribes(data.subscribed_events);

  return redactWebhookDestination(
    await apiRequest(orgAppPath(`/webhook/destinations/${pathSegment(destinationUuid, "destination_uuid")}/`), {
      method: "PATCH",
      json: guardWebhookData(data),
    }),
  );
}

export async function deleteDestination(destinationUuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/webhook/destinations/${pathSegment(destinationUuid, "destination_uuid")}/`), {
    method: "DELETE",
  });
}

const deliveriesPath = (destinationUuid: string): string =>
  `/webhook/destinations/${pathSegment(destinationUuid, "destination_uuid")}/deliveries/`;

/** One destination's deliveries, or one of them with its request and answer; `include` adds its daily figures. */
export async function listDeliveries(args: Record<string, any>): Promise<any> {
  const { destination_uuid, delivery_uuid, include, outcome, date_from, date_to } = args;
  if (delivery_uuid) {
    return apiRequest(orgAppPath(deliveriesPath(destination_uuid) + `${pathSegment(delivery_uuid, "delivery_uuid")}/`));
  }
  const window = { date_from, date_to };
  const deliveries = await apiRequest(orgAppPath(deliveriesPath(destination_uuid)), {
    params: { outcome, ...window, ...pageParams(args) },
  });
  if (!Array.isArray(include) || !include.includes("analytics")) return deliveries;
  const analyticsPath = `/webhook/destinations/${pathSegment(destination_uuid, "destination_uuid")}/analytics/`;

  return { ...deliveries, analytics: await apiRequest(orgAppPath(analyticsPath), { params: window }) };
}

export async function resendDelivery(destinationUuid: string, deliveryUuid: string): Promise<any> {
  const path = deliveriesPath(destinationUuid) + `${pathSegment(deliveryUuid, "delivery_uuid")}/resend/`;

  return apiRequest(orgAppPath(path), { method: "POST" });
}

// ── The webhook tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where the webhook tools always were, so the tool list does not change.
export const WEBHOOK_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_webhook_list",
      description: "List configured webhook destinations. Each destination has its own URL, version, enabled flag, subscribed events, and redacted signing-secret metadata.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    access: "read",
    permission: ["read:webhooks", "list:webhooks"], // GET …/webhook/destinations/ → webhook_destinations.py:106
    run: () => listDestinations(),
  },
  {
    def: {
      name: "didit_webhook_create",
      description: "Create a webhook destination. The signing secret is redacted in the response.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          label: { type: "string", description: "REQUIRED. Human-readable name" },
          url: { type: "string", description: "REQUIRED. HTTPS endpoint to receive events" },
          enabled: { type: "boolean", description: "Whether the destination receives events (default true)" },
          webhook_version: { type: "string", enum: ["v1", "v2", "v3"], description: "Payload version (v3 recommended)" },
          subscribed_events: {
            type: "array",
            items: { type: "string", enum: WEBHOOK_EVENTS },
            description: "REQUIRED. The events to deliver, at least one; no other is sent. bank.* only where Bank data is open.",
          },
        },
        required: ["label", "url", "subscribed_events"],
      },
    },
    // Registers an endpoint outside Didit that Didit then delivers verification data to.
    access: "write",
    openWorld: true,
    permission: "write:webhooks", // POST …/webhook/destinations/ → webhook_destinations.py:112
    run: (args) => createDestination(args),
  },
  {
    def: {
      name: "didit_webhook_get",
      description: "Get a single webhook destination with redacted signing-secret metadata.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          destination_uuid: { type: "string", description: "Webhook destination UUID" },
        },
        required: ["destination_uuid"],
      },
    },
    access: "read",
    permission: ["read:webhooks", "list:webhooks"], // GET …/webhook/destinations/{uuid}/ → webhook_destinations.py:151
    run: (args) => getDestination(args.destination_uuid),
  },
  {
    def: {
      name: "didit_webhook_update",
      description: "Overwrite the supplied settings of an existing webhook destination. Changing its URL redirects future deliveries; disabling it stops deliveries, and subscribed_events replaces its event subscriptions. Before calling, show the destination UUID and each proposed field change and obtain explicit user confirmation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          destination_uuid: { type: "string", description: "Webhook destination UUID" },
          label: { type: "string" },
          url: { type: "string" },
          enabled: { type: "boolean" },
          webhook_version: { type: "string", enum: ["v1", "v2", "v3"] },
          subscribed_events: { type: "array", items: { type: "string" }, description: "The whole new list, as in didit_webhook_create" },
        },
        required: ["destination_uuid"],
      },
    },
    // Can redirect future deliveries to another URL, or stop them: a client asks before running it.
    access: "destructive",
    openWorld: true,
    permission: "write:webhooks", // PATCH …/webhook/destinations/{uuid}/ → webhook_destinations.py:160
    run: ({ destination_uuid, ...data }) => updateDestination(destination_uuid, data),
  },
  {
    def: {
      name: "didit_webhook_delete",
      description: "Delete a webhook destination so it stops receiving events.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          destination_uuid: { type: "string", description: "Webhook destination UUID" },
        },
        required: ["destination_uuid"],
      },
    },
    access: "destructive",
    permission: "write:webhooks", // DELETE …/webhook/destinations/{uuid}/ → webhook_destinations.py:181
    run: (args) => deleteDestination(args.destination_uuid),
  },
  {
    def: {
      name: "didit_webhook_delivery_list",
      description:
        "List the deliveries of one webhook destination, newest first, or read one (delivery_uuid) with its signed request and what the endpoint answered.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          destination_uuid: { type: "string", description: "Webhook destination UUID" },
          delivery_uuid: { type: "string", description: "Only this delivery, in full" },
          outcome: {
            type: "string",
            enum: ["failed", "retryable"],
            description: "failed: every attempt the endpoint did not accept; retryable: the recent events still not delivered",
          },
          date_from: { type: "string", description: "YYYY-MM-DD, inclusive" },
          date_to: { type: "string", description: "YYYY-MM-DD, inclusive" },
          include: { type: "array", items: { type: "string", enum: ["analytics"] }, description: "analytics: totals, error rate and response times per day" },
          ...PAGE_PROPS,
        },
        required: ["destination_uuid"],
      },
    },
    access: "read",
    permission: ["read:webhooks", "list:webhooks"], // GET …/webhook/destinations/{uuid}/deliveries/ → webhook_destinations.py:418
    run: (args) => listDeliveries(args),
  },
  {
    def: {
      name: "didit_webhook_delivery_resend",
      description: "Send one recorded delivery again, to the destination's current URL; returns the new attempt with its response_status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          destination_uuid: { type: "string", description: "Webhook destination UUID" },
          delivery_uuid: { type: "string", description: "The delivery's uuid (didit_webhook_delivery_list)" },
        },
        required: ["destination_uuid", "delivery_uuid"],
      },
    },
    access: "write",
    openWorld: true,
    permission: "write:webhooks", // POST …/deliveries/{uuid}/resend/ → webhook_destinations.py:461
    run: (args) => resendDelivery(args.destination_uuid, args.delivery_uuid),
  },
];

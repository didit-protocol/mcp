import { apiRequest, orgAppPath } from "../config";
import { ORG_APP_PROPS } from "../orgapp";
import type { RegisteredTool } from "./registry";
import { redactWebhookDestination, redactCollection, assertSafeWebhookUrl, pathSegment } from "../security";

// Webhook destinations are org/app-scoped console resources (paths match 1:1).
// The signing secret is redacted on every read; the destination URL is SSRF-guarded
// (the backend dereferences it) before create/update.

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

export async function createDestination(data: Record<string, any>): Promise<any> {
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
    permission: "read:webhooks", // GET …/webhook/destinations/ → webhook_destinations.py:106
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
          subscribed_events: { type: "array", items: { type: "string" }, description: "Event types to deliver (e.g. status.updated, data.updated, user.created). Omit to receive all." },
        },
        required: ["label", "url"],
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
    permission: "read:webhooks", // GET …/webhook/destinations/{uuid}/ → webhook_destinations.py:151
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
          subscribed_events: { type: "array", items: { type: "string" } },
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
];

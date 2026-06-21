import { apiRequest, orgAppPath } from "../config";
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

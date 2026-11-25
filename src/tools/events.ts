import { apiRequest, getHeaders, resolveApplicationId, resolveOrganizationId } from "../config";
import { ORG_APP_PROPS } from "../orgapp";
import { PAGE_PROPS, pageParams } from "../paging";
import { pathSegment } from "../security";
import type { RegisteredTool } from "./registry";

// Monitoring events (sign-ins, sessions, gameplay, payments...) over the /v3 client API: there is no
// org/app segment in the path, the backend authorizes the acting user's Bearer through the two headers.

function clientHeaders(): Record<string, string> {
  return {
    ...getHeaders(),
    "X-Didit-Organization-Id": resolveOrganizationId(),
    "X-Didit-Application-Id": resolveApplicationId(),
  };
}

export async function listEvents({ device_session_id, ...args }: Record<string, any> = {}): Promise<any> {
  return apiRequest("/events/", { params: { ...args, session_id: device_session_id, ...pageParams(args) }, headers: clientHeaders() });
}

export async function getEvent(eventId: string): Promise<any> {
  return apiRequest(`/events/${pathSegment(eventId, "event_id")}/`, { headers: clientHeaders() });
}

/** One subject's timeline: `vendor_data` is the customer's own id, so any text but a slash. */
export async function getEventSubject({ vendor_data, ...filters }: Record<string, any>): Promise<any> {
  return apiRequest(`/events/subjects/${pathSegment(vendor_data, "vendor_data", { opaque: true })}/`, {
    params: { ...filters, ...pageParams(filters) },
    headers: clientHeaders(),
  });
}

const EVENT_FILTER_PROPS = {
  event_category: {
    type: "string",
    enum: ["auth", "session", "gameplay", "bonus", "affiliate", "payment", "dispute", "security", "responsible_gambling", "custom"],
  },
  status: { type: "string", enum: ["ACCEPTED", "APPROVED", "IN_REVIEW", "DECLINED"], description: "ACCEPTED: stored, its rules run later" },
  occurred_from: { type: "string", description: "ISO date-time" },
  occurred_to: { type: "string", description: "ISO date-time" },
} as const;
const READ_EVENTS = ["read:transactions", "list:transactions"] as const;

export const EVENT_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_event_list",
      description: "List an application's monitoring events (sign-ins, sessions, payments, gameplay...), newest first, with the rules each matched.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          ...EVENT_FILTER_PROPS,
          search: { type: "string", description: "Event id, action or subject" },
          action_type: { type: "string" },
          ingest_source: { type: "string", enum: ["API", "SDK", "BATCH", "IMPORT", "AUTH"], description: "AUTH: Didit Authentication's sign-ins" },
          subject_vendor_data: { type: "string" },
          subject_entity_type: { type: "string", enum: ["individual", "company"] },
          counterparty_vendor_data: { type: "string" },
          // Not `session_id`: everywhere else that is a verification session.
          device_session_id: { type: "string", description: "Browser or app session" },
          device_fingerprint: { type: "string" },
          ip_address: { type: "string" },
          matched_only: { type: "boolean", description: "Only events that matched a rule" },
          ...PAGE_PROPS,
        },
      },
    },
    access: "read",
    permission: READ_EVENTS, // GET /v3/events/ → monitoring_events_v3.py:33
    run: (args) => listEvents(args),
  },
  {
    def: {
      name: "didit_event_get",
      description: "Get one monitoring event with its device, network and rule evaluations.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, event_id: { type: "string", description: "Event UUID" } },
        required: ["event_id"],
      },
    },
    access: "read",
    permission: READ_EVENTS, // GET /v3/events/{id}/ → monitoring_events_v3.py:120
    run: (args) => getEvent(args.event_id),
  },
  {
    def: {
      name: "didit_event_subject_get",
      description: "Get one person's or company's monitoring event timeline, newest first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          vendor_data: { type: "string", description: "Your id of the subject" },
          entity_type: { type: "string", enum: ["individual", "company"], description: "Default individual: the same id can name one of each" },
          ...EVENT_FILTER_PROPS,
          ...PAGE_PROPS,
        },
        required: ["vendor_data"],
      },
    },
    access: "read",
    permission: READ_EVENTS, // GET /v3/events/subjects/{vendor_data}/ → monitoring_events_v3.py:152
    run: (args) => getEventSubject(args),
  },
];

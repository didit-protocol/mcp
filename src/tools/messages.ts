import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { PAGE_PROPS, pageParams } from "../paging";
import { DiditError, pathSegment } from "../security";

// Messages (email, SMS and WhatsApp with the people being verified): reads only. The console routes
// under …/messages/ (service-didit-verification messages/urls.py), which take `<action>:messages` or,
// for a role that predates it, the same action on sessions (messages/views/common.py).

const CHANNELS = ["email", "sms", "whatsapp"];

export async function listConversations({ search, tab, channel, event, ...page }: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/messages/conversations/"), { params: { q: search, tab, channel, event, ...pageParams(page) } });
}

/** A thread by its conversation, or by the session it belongs to (both answer the same payload). */
export async function getConversation({ conversation_id, session_id }: Record<string, any>): Promise<any> {
  if (Boolean(conversation_id) === Boolean(session_id)) {
    throw new DiditError({ code: "bad_request", message: "Send conversation_id or session_id, exactly one.", field: "conversation_id" });
  }
  const resource = conversation_id
    ? `/messages/conversations/${pathSegment(conversation_id, "conversation_id")}/`
    : `/messages/sessions/${pathSegment(session_id, "session_id")}/messages/`;

  return apiRequest(orgAppPath(resource));
}

export async function listTemplates({ channel, include_channels }: Record<string, any>): Promise<any> {
  const templates = await apiRequest(orgAppPath("/messages/templates/"), { params: { channel } });
  if (include_channels !== true) return templates;

  return { ...templates, channels: await apiRequest(orgAppPath("/messages/channels/")) };
}

// ── The message tools (tools/registry.ts) ──────────────────────────────────
export const MESSAGE_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_message_conversation_list",
      description: "List the application's message conversations (email, SMS, WhatsApp) with the people being verified, newest first. `count` is the total and `tab_counts` how many need a reply or failed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          search: { type: "string", description: "Name, email, phone number, vendor_data or session number (S-12, B-3)" },
          tab: { type: "string", enum: ["all", "needs_reply", "failed"] },
          channel: { type: "string", enum: CHANNELS },
          event: { type: "string", enum: ["code", "link", "review", "decision", "retry", "reminder", "resubmission", "reply", "other"], description: "What the messages are about" },
          ...PAGE_PROPS,
        },
      },
    },
    access: "read",
    permission: ["list:messages", "list:sessions"], // GET …/messages/conversations/ → messages/views/console.py ConversationListView
    run: (args) => listConversations(args),
  },
  {
    def: {
      name: "didit_message_conversation_get",
      description: "Get one conversation's whole thread: every message with its delivery events, and the state of each channel. By conversation_id or by the session_id it belongs to. Reading does not mark it read.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, conversation_id: { type: "string" }, session_id: { type: "string" } },
      },
    },
    access: "read",
    permission: ["read:messages", "read:sessions"], // GET …/messages/conversations/{id}/ → ConversationDetailView; …/messages/sessions/{id}/messages/ → SessionMessagesView
    run: (args) => getConversation(args),
  },
  {
    def: {
      name: "didit_message_template_list",
      description: "List every message template, Didit's and the application's own, with the variables a template can use.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          channel: { type: "string", enum: CHANNELS },
          include_channels: { type: "boolean", description: "Add each channel's settings, sender, whether it can send and its last 30 days" },
        },
      },
    },
    access: "read",
    permission: ["list:messages", "list:sessions"], // GET …/messages/templates/ and …/messages/channels/ → TemplateListCreateView, ChannelListView
    run: (args) => listTemplates(args),
  },
];

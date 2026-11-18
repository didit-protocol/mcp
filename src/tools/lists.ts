import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { requireFileSource, resolveFileSource, pathSegment } from "../security";

// What a list can hold, as the list tools' definitions (below) name it; moved here with them.
const LIST_ENTRY_TYPES = [
  "face", "document", "phone", "email", "ip_address", "device_fingerprint",
  "wallet_address", "bank_account", "user", "business", "country", "key",
];

// Lists are org/app-scoped console resources; org/app resolve from the tool args via the
// request context (see orgAppPath). Sub-paths match the console inventory 1:1.

export async function listLists(params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath("/lists/"), { params });
}

export async function createList(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/lists/"), { method: "POST", json: data });
}

export async function getListDetail(listUuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${pathSegment(listUuid, "list_uuid")}/`));
}

export async function updateList(listUuid: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${pathSegment(listUuid, "list_uuid")}/`), { method: "PATCH", json: data });
}

export async function deleteList(listUuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${pathSegment(listUuid, "list_uuid")}/`), { method: "DELETE" });
}

export async function listEntries(listUuid: string, params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${pathSegment(listUuid, "list_uuid")}/entries/`), { params });
}

export async function createEntry(listUuid: string, data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${pathSegment(listUuid, "list_uuid")}/entries/`), { method: "POST", json: data });
}

export async function deleteEntry(listUuid: string, entryUuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/lists/${pathSegment(listUuid, "list_uuid")}/entries/${pathSegment(entryUuid, "entry_uuid")}/`), { method: "DELETE" });
}

export async function uploadFaceEntry(listUuid: string, data: Record<string, any>): Promise<any> {
  // The face-upload endpoint expects a base64-encoded `image` field in a JSON body.
  // The image arrives as a local path (stdio/local runs) or inline base64 (hosted runs).
  const { image_path, image_base64, ...rest } = data;
  const source = requireFileSource({ path: image_path, base64: image_base64 }, "image");
  const { buffer } = resolveFileSource(source, "image", { required: true })!;
  return apiRequest(orgAppPath(`/lists/${pathSegment(listUuid, "list_uuid")}/entries/face-upload/`), {
    method: "POST",
    json: { image: buffer.toString("base64"), ...rest },
  });
}

// ── The list tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const LIST_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_lists_list",
      description: "List all lists (blocklists, allowlists, custom) for the application. Filter by list_type or entry_type.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_type: { type: "string", description: "Filter: blocklist, allowlist, custom" },
          entry_type: { type: "string", description: `Filter: ${LIST_ENTRY_TYPES.join(", ")}` },
          limit: { type: "string" },
          offset: { type: "string" },
        },
      },
    },
    access: "read",
    permission: ["read:lists", "list:lists"], // GET …/lists/ → lists.py:40
    run: (args) => listLists(args),
  },
  {
    def: {
      name: "didit_lists_create",
      description: "Create an allowlist or custom list. System blocklists are auto-provisioned (one per entry type) and cannot be created. name must be unique per application.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          name: { type: "string", description: "REQUIRED. Unique list name" },
          list_type: { type: "string", enum: ["allowlist", "custom"], description: "REQUIRED. allowlist or custom (blocklists are auto-provisioned)" },
          entry_type: { type: "string", enum: LIST_ENTRY_TYPES, description: "REQUIRED. What kind of values the list holds" },
          description: { type: "string" },
        },
        required: ["name", "list_type", "entry_type"],
      },
    },
    access: "write",
    permission: "create:lists", // POST …/lists/ → lists.py:69
    run: (args) => createList(args),
  },
  {
    def: {
      name: "didit_lists_get",
      description: "Get a single list's details by UUID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
        },
        required: ["list_uuid"],
      },
    },
    access: "read",
    permission: ["read:lists", "list:lists"], // GET …/lists/{uuid}/ → lists.py:110
    run: (args) => getListDetail(args.list_uuid),
  },
  {
    def: {
      name: "didit_lists_update",
      description: "Rename or update the description of an allowlist/custom list. System blocklists are immutable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["list_uuid"],
      },
    },
    access: "write",
    permission: "write:lists", // PATCH …/lists/{uuid}/ → lists.py:114
    run: ({ list_uuid, ...data }) => updateList(list_uuid, data),
  },
  {
    def: {
      name: "didit_lists_delete",
      description: "Delete an allowlist/custom list and all its entries. System blocklists cannot be deleted.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
        },
        required: ["list_uuid"],
      },
    },
    access: "destructive",
    permission: "delete:lists", // DELETE …/lists/{uuid}/ → lists.py:122
    run: (args) => deleteList(args.list_uuid),
  },
  {
    def: {
      name: "didit_lists_entries_list",
      description: "List entries in a specific list. Use search to filter by value or label.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
          search: { type: "string", description: "Search by value or display label" },
          reference_session_id: { type: "string", description: "Only the entries created from this session UUID (e.g. which of its faces are already blocklisted)" },
          limit: { type: "string" },
          offset: { type: "string" },
        },
        required: ["list_uuid"],
      },
    },
    access: "read",
    permission: ["read:lists", "list:lists"], // GET …/lists/{uuid}/entries/ → lists.py:153
    run: ({ list_uuid, ...params }) => listEntries(list_uuid, params),
  },
  {
    def: {
      name: "didit_lists_entry_create",
      description: "Add an entry to a blocklist/allowlist/custom list. Pass value directly, or reference_session_id to auto-extract from a session (face, document, phone, email, IP, device). Pass both to disambiguate when a session has multiple values of the same type. For the face blocklist, face_image_source picks which of the session's faces to block: the liveness selfie (default) or a selfie the front camera took while the user photographed their document. For face entries without a session, use didit_lists_entry_upload_face instead.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list to add to" },
          value: { type: "string", description: "Value to add (phone, email, IP, etc.). Optional if reference_session_id is provided." },
          reference_session_id: { type: "string", description: "Session UUID — backend auto-extracts the value based on the list's entry type" },
          reference_object_uuid: { type: "string", description: "UUID of the source entity (transaction, vendor user/business) for traceability" },
          face_image_source: {
            type: "string",
            enum: ["liveness", "front_image_camera_front", "back_image_camera_front"],
            description: "Face blocklist with reference_session_id only: which of the session's faces to block. liveness (default) is the liveness selfie; front_image_camera_front / back_image_camera_front are the selfies taken while the user photographed the front / back of their document. Leave value empty with a document-capture source.",
          },
          reference_node_id: { type: "string", description: "With a document-capture face_image_source: the ID verification node whose selfie to use, for workflows with several ID verification steps" },
          display_label: { type: "string", description: "Human-readable label" },
          comment: { type: "string", description: "Reason for adding" },
          metadata: { type: "object", description: "Additional structured data (e.g. reference_type, full_name)" },
        },
        required: ["list_uuid"],
      },
    },
    access: "write",
    permission: "create:lists", // POST …/lists/{uuid}/entries/ → lists.py:197
    run: ({ list_uuid, ...data }) => createEntry(list_uuid, data),
  },
  {
    def: {
      name: "didit_lists_entry_upload_face",
      description: "Add a face entry to a face list by uploading an image directly (no session needed). Use this when you have a photo but no reference_session_id. Provide the image as image_path (local/stdio runs) or image_base64 (hosted runs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of a face-type list" },
          image_path: { type: "string", description: "Absolute path to the face image file (local/stdio only)" },
          image_base64: { type: "string", description: "Face image as base64 or data URL (or an attachment reference like att_1)" },
          display_label: { type: "string" },
          comment: { type: "string" },
        },
        required: ["list_uuid"],
      },
    },
    access: "write",
    permission: "create:lists", // POST …/lists/{uuid}/entries/face-upload/ → list_face_upload.py:126
    run: ({ list_uuid, image_path, image_base64, ...data }) => uploadFaceEntry(list_uuid, { image_path, image_base64, ...data }),
  },
  {
    def: {
      name: "didit_lists_entry_delete",
      description: "Remove an entry from a list. Also unblocks the underlying user/business if applicable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          list_uuid: { type: "string", description: "UUID of the list" },
          entry_uuid: { type: "string", description: "UUID of the entry to remove" },
        },
        required: ["list_uuid", "entry_uuid"],
      },
    },
    access: "destructive",
    permission: "delete:lists", // DELETE …/lists/{uuid}/entries/{entry}/ → lists.py:233
    run: (args) => deleteEntry(args.list_uuid, args.entry_uuid),
  },
];

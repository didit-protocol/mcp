import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { PAGE_PROPS, pageParams } from "../paging";
import { assertBoolean, DiditError, pathSegment } from "../security";

// What a reviewer does on one session beyond its overall decision: its AML hits, the status of one
// check, the email the person would get, every file of it, and the progress of a bulk deletion.
// The per-session routes are flat (/session/{id}/...), for user and business verifications alike.

const sid = (id: string) => pathSegment(id, "session_id");

const badRequest = (field: string, message: string, allowed?: string[]): DiditError =>
  new DiditError({ code: "bad_request", message, field, ...(allowed ? { allowed } : {}) });

function assertConfirmed(confirm: unknown, what: string): void {
  assertBoolean(confirm, "confirm");
  if (confirm === true) return;
  throw new DiditError({
    code: "unsafe_operation",
    message: `${what} is a human decision.`,
    field: "confirm",
    hint: "Show the person the exact change, and re-call with confirm:true only once they have explicitly approved it.",
  });
}

export async function getSessionDeletion(jobId: string): Promise<any> {
  return apiRequest(orgAppPath(`/sessions/delete/${pathSegment(jobId, "job_id")}/`));
}

export async function createSessionFiles(sessionId: string): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/files-export/`, { method: "POST" });
}

export async function getSessionFiles(sessionId: string, exportId: string): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/files-export/${pathSegment(exportId, "export_id")}/`);
}

export async function updateSessionAml({ session_id, hits, status, node_id, confirm }: Record<string, any>): Promise<any> {
  if ((hits === undefined) === (status === undefined)) throw badRequest("hits", "Pass hits or status, one of the two.");
  assertConfirmed(confirm, "The review of an AML check");
  const params = { node_id };

  return hits === undefined
    ? apiRequest(`/session/${sid(session_id)}/update-aml-status/`, { method: "PATCH", params, json: { status } })
    : apiRequest(`/session/${sid(session_id)}/bulk-update-aml-hit-status/`, { method: "PATCH", params, json: { hit_updates: hits } });
}

export async function listSessionAmlHistory(args: Record<string, any>): Promise<any> {
  const { session_id, node_id, month } = args;

  return apiRequest(`/session/${sid(session_id)}/aml-screening-history/`, { params: { node_id, month, ...pageParams(args) } });
}

export async function listFeatureOverrides(sessionId: string): Promise<any> {
  return apiRequest(`/session/${sid(sessionId)}/features/overrides/`);
}

export async function updateFeatureOverride(args: Record<string, any>): Promise<any> {
  const { session_id, node_id, cancel_override_id, confirm, new_status, comment, feature_type, defer_until_flow_finishes } = args;
  if ((node_id === undefined) === (cancel_override_id === undefined)) {
    throw badRequest("node_id", "Pass node_id with new_status, or cancel_override_id.");
  }
  assertConfirmed(confirm, "The status of a check");
  if (cancel_override_id !== undefined) {
    return apiRequest(`/session/${sid(session_id)}/features/overrides/${pathSegment(cancel_override_id, "cancel_override_id")}/cancel/`, { method: "POST", json: {} });
  }

  return apiRequest(`/session/${sid(session_id)}/features/${pathSegment(node_id, "node_id")}/update-status/`, {
    method: "PATCH",
    json: { new_status, comment, feature_type, defer_until_flow_finishes },
  });
}

/** The email as the person would get it. Its HTML embeds the logo and repeats the text: left out. */
export async function previewSessionEmail(args: Record<string, any>): Promise<any> {
  const { session_id, kind, new_status, email_language, nodes_to_resubmit, email_address } = args;
  if (kind !== "decision" && kind !== "resubmission") throw badRequest("kind", "kind must be decision or resubmission.", ["decision", "resubmission"]);
  const preview =
    kind === "decision"
      ? await apiRequest(`/session/${sid(session_id)}/decision-email-preview/`, { method: "POST", json: { new_status, email_language } })
      : await apiRequest(`/session/${sid(session_id)}/resubmission-preview/`, { method: "POST", json: { nodes_to_resubmit, email_address, email_language } });
  const { html: _html, ...rest } = preview;

  return rest;
}

const SESSION_ID = { type: "string", description: "User (KYC) or business (KYB) verification" } as const;
const CONFIRM = { type: "boolean", description: "REQUIRED true. Only set after explicit user confirmation of this exact action." } as const;
const AML_NODE = { type: "string", description: "Which AML step, when the session has several" } as const;

// ── The session review tools (tools/registry.ts) ──────────────────────────────────
export const SESSION_REVIEW_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_session_deletion_get",
      description: "Progress of a didit_session_batch_delete that runs as a job: status, total, processed and outcomes.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, job_id: { type: "string" } }, required: ["job_id"] },
    },
    access: "read",
    permission: ["read:sessions", "list:sessions"], // GET …/sessions/delete/{job}/ → session_deletion.py
    run: (args) => getSessionDeletion(args.job_id),
  },
  {
    def: {
      name: "didit_session_files_create",
      description:
        "Start a ZIP with every image, video and document of a session (sensitive personal data). Returns export_id: read it with didit_session_files_get. " +
        "The ZIP is deleted after 24 hours.",
      inputSchema: { type: "object" as const, properties: { session_id: SESSION_ID }, required: ["session_id"] },
    },
    access: "write",
    permission: ["read:sessions", "list:sessions"], // POST /session/{id}/files-export/ → files_export.py:52
    run: (args) => createSessionFiles(args.session_id),
  },
  {
    def: {
      name: "didit_session_files_get",
      description: "State of a session files ZIP; download_url once READY. The link is short-lived and sensitive: read again for a new one.",
      inputSchema: {
        type: "object" as const,
        properties: { session_id: SESSION_ID, export_id: { type: "string" } },
        required: ["session_id", "export_id"],
      },
    },
    access: "read",
    permission: ["read:sessions", "list:sessions"], // GET /session/{id}/files-export/{export}/ → files_export.py:52
    run: (args) => getSessionFiles(args.session_id, args.export_id),
  },
  {
    def: {
      name: "didit_session_aml_update",
      description:
        "Record the review of a session's AML check: the review_status of its hits (a False Positive leaves the AML score), or the overall " +
        "status of the check. Hit ids are in the decision's AML hits. It does not decide the session: didit_session_update_status does.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: SESSION_ID,
          hits: {
            type: "array",
            items: {
              type: "object",
              properties: { hit_id: { type: "string" }, review_status: { type: "string", enum: ["Unreviewed", "Confirmed Match", "False Positive", "Inconclusive"] } },
              required: ["hit_id", "review_status"],
            },
          },
          status: { type: "string", enum: ["Approved", "Declined", "In Review"] },
          node_id: AML_NODE,
          confirm: CONFIRM,
        },
        required: ["session_id", "confirm"],
      },
    },
    access: "destructive",
    permission: "write:sessions", // PATCH /session/{id}/bulk-update-aml-hit-status/, /update-aml-status/ → aml/views/aml.py
    run: (args) => updateSessionAml(args),
  },
  {
    def: {
      name: "didit_session_aml_history_list",
      description: "The ongoing-monitoring screenings of a session's AML check, newest first, those that found nothing new included.",
      inputSchema: {
        type: "object" as const,
        properties: { session_id: SESSION_ID, node_id: AML_NODE, month: { type: "string", description: "YYYY-MM" }, ...PAGE_PROPS },
        required: ["session_id"],
      },
    },
    access: "read",
    permission: ["read:sessions", "list:sessions"], // GET /session/{id}/aml-screening-history/ → screening_history.py:149
    run: (args) => listSessionAmlHistory(args),
  },
  {
    def: {
      name: "didit_session_feature_override_list",
      description: "The statuses reviewers set on single checks of a session, and whether the person is still in the flow.",
      inputSchema: { type: "object" as const, properties: { session_id: SESSION_ID }, required: ["session_id"] },
    },
    access: "read",
    permission: ["read:sessions", "list:sessions"], // GET /session/{id}/features/overrides/ → feature_overrides.py
    run: (args) => listFeatureOverrides(args.session_id),
  },
  {
    def: {
      name: "didit_session_feature_override_update",
      description: "Set the status of ONE check of a session (its node_id, from the decision), or cancel an override that still waits for the flow to finish.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: SESSION_ID,
          node_id: { type: "string" },
          new_status: { type: "string", enum: ["Approved", "Declined", "In Review"] },
          comment: { type: "string" },
          feature_type: { type: "string", description: "When several checks share the node" },
          defer_until_flow_finishes: { type: "boolean", description: "Apply it when the person finishes" },
          cancel_override_id: { type: "string", description: "A pending override (didit_session_feature_override_list)" },
          confirm: CONFIRM,
        },
        required: ["session_id", "confirm"],
      },
    },
    access: "destructive",
    permission: "write:sessions", // PATCH …/features/{node}/update-status/ → session.py, POST …/features/overrides/{id}/cancel/ → feature_overrides.py
    run: (args) => updateFeatureOverride(args),
  },
  {
    def: {
      name: "didit_session_email_preview",
      description:
        "Preview the email of a decision or of a resubmission: recipient, sender, subject, text and preview_token. Sends nothing. Send it with " +
        "didit_session_update_status: send_email, email_address = recipient, email_language = language, email_preview_token.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: SESSION_ID,
          kind: { type: "string", enum: ["decision", "resubmission"] },
          new_status: { type: "string", enum: ["Approved", "Declined"], description: "decision only" },
          email_language: { type: "string" },
          nodes_to_resubmit: { type: "array", items: { type: "object" }, description: "resubmission: as in didit_session_update_status" },
          email_address: { type: "string", description: "resubmission: another recipient" },
        },
        required: ["session_id", "kind"],
      },
    },
    // A POST that renders and stores nothing.
    access: "read",
    permission: "write:sessions", // POST /session/{id}/decision-email-preview/ → decision_email_preview.py, /resubmission-preview/ → resubmission_preview.py
    run: (args) => previewSessionEmail(args),
  },
];

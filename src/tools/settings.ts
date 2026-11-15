import { everyPage, type WholeList } from "../paging";
import { apiRequest, orgAppPath } from "../config";
import { pathSegment } from "../security";
import {
  carriesSettings,
  droppedSettingsNote,
  lostSettings,
  unconfirmedSettingsNote,
  UNVERIFIED_SETTINGS_NOTE,
  assertKycKybSegregation,
  buildLinearGraphFromFeatures,
  normalizeFeatureConfigs,
  workflowTypeForFeatures,
} from "./feature-config";

// Workflows are the console's "verification-settings" resource, scoped per org+app.
// org/application are resolved from the tool arguments (organization_id/application_id)
// via the request context — see orgAppPath / the CallTool dispatch in index.ts.

/** One page of the application's workflows (20 unless `limit` says otherwise), most recently changed first. */
export async function listWorkflows(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/verification-settings/"), { params });
}

/** Every workflow of the application, for the lookups that must not miss one (paging.ts). */
export async function listEveryWorkflow(): Promise<WholeList> {
  return everyPage((page) => listWorkflows(page));
}

export async function getWorkflow(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/verification-settings/${pathSegment(uuid, "workflow_id")}/`));
}

/** Which id is which. Sessions accept both, and a customer who integrated a version uuid kept
 *  running a superseded version for two days after newer ones were published (prod 12-nov). */
export const WORKFLOW_IDS_NOTE =
  "workflow_id is the STABLE id: give it for integrations, SDKs and session creation — it stays " +
  "the same across versions and runs the live published version. version_uuid (= uuid) is ONE " +
  "exact version: a session created with it stays pinned to that version and ignores later " +
  "publishes, so never give it as the id to integrate. is_live_version says whether this version " +
  "is the one new sessions run.";

export const isPublishedVersion = (row: any): boolean => String(row?.status ?? "").toLowerCase() === "published";

/** A version labelled with its version_uuid and, when the live version is known (`live`: that
 *  version, or null when nothing is published), whether it is the one new sessions run. A
 *  superseded version still says status "published", so status alone never answers that. */
export function labelWorkflowVersion(row: any, live?: any): any {
  const liveness = live === undefined ? {} : { is_live_version: Boolean(live) && live.uuid === row.uuid };

  return { ...row, version_uuid: row.uuid, ...liveness };
}

/** The live version of a workflow: the newest published one in its version history (listed newest
 *  first). undefined when the history cannot be read. */
async function liveWorkflowVersion(workflowId: string): Promise<any> {
  const history = await apiRequest(orgAppPath(`/verification-settings/${pathSegment(workflowId, "workflow_id")}/versions/`)).catch(
    () => null,
  );
  const versions = Array.isArray(history) ? history : history?.results;

  if (!Array.isArray(versions) || versions.length === 0) return undefined;

  return versions.find(isPublishedVersion) ?? null;
}

/** didit_workflow_list in one application, its rows labelled like a search row: the list shows
 *  each workflow's live version, or its draft when nothing is published. */
export async function listWorkflowVersions(params?: Record<string, any>): Promise<any> {
  const page = await listWorkflows(params);

  if (!Array.isArray(page?.results)) return page;

  const results = page.results.map((row: any) => labelWorkflowVersion(row, isPublishedVersion(row) ? row : null));

  return { ...page, results, ids_note: WORKFLOW_IDS_NOTE };
}

/** didit_workflow_get: one version, labelled with which id integrations use and whether it is live. */
export async function getWorkflowVersion(uuid: string): Promise<any> {
  const wf = await getWorkflow(uuid);

  if (!wf?.uuid || !wf.workflow_id) return wf;

  return { ...labelWorkflowVersion(wf, await liveWorkflowVersion(wf.workflow_id)), ids_note: WORKFLOW_IDS_NOTE };
}

/**
 * Create a simple (linear) workflow from an ordered `features` list.
 *
 * IMPORTANT: the console verification-settings endpoint does NOT persist a `features` payload —
 * `features` is a read-only computed property there, so POSTing it produces a workflow that runs
 * NONE of the requested features (and whose derived graph is a featureless, branch-rooted graph
 * that used to crash the console editor). The only way to make the requested features actually
 * run is to express them as a workflow GRAPH and save that. So we: build a linear graph from the
 * features (normalizing each config) and check its KYC/KYB coherence BEFORE creating anything,
 * then create an empty DRAFT, validate the graph against the backend, PUT it, and finally publish
 * (unless the caller asked for a draft). A mixed KYC/KYB list creates nothing at all, because the
 * type a create fixes cannot be changed afterwards; on backend validation failure nothing is
 * published and the draft is left for the agent to fix with set_graph / edit_graph.
 */
export async function createWorkflow(data: Record<string, any>): Promise<any> {
  const { features, status, ...rest } = data || {};
  // A bare feature name (["OCR", "LIVENESS"]) is the most common shorthand agents send; it used to
  // be dropped item by item and answered "no features". It means exactly { feature: "OCR" }.
  const featureList = (Array.isArray(features) ? features : []).map((item: any) =>
    typeof item === "string" ? { feature: item } : item,
  );

  // Assemble and check the feature list BEFORE anything is created. The backend types a workflow
  // on CREATE and then refuses to change it ("Workflow type cannot be changed once it has been
  // set"), so creating the draft first would leave a mixed KYC/KYB request behind a draft
  // permanently typed `kyb`, and the pure-KYC repair would then be rejected by the backend's own
  // declared-type segregation rule, making the advice we hand back impossible to follow. Nothing
  // is POSTed until the list is known to be assemblable and KYC/KYB-coherent.
  const graph = featureList.length > 0 ? buildLinearGraphFromFeatures(featureList) : undefined;
  if (graph) {
    normalizeFeatureConfigs(graph);
    try {
      assertKycKybSegregation(graph);
    } catch (e: any) {
      return {
        created: false,
        graph_applied: false,
        validation: { is_valid: false, error: e?.message ?? String(e) },
        note:
          "NOTHING WAS CREATED: the requested features mix business (KYB) and person (KYC) " +
          "verification, which cannot share one workflow. Call didit_workflow_create again with a " +
          "pure-KYB or pure-KYC feature list. A workflow's type is fixed when it is created, so a " +
          "mixed request cannot be repaired with didit_workflow_set_graph. To verify the people " +
          "behind a company, create a SEPARATE KYC workflow and reference it from the KYB Key " +
          "People node.",
      };
    }
  }

  // The type is settable on CREATE only (see workflowTypeForFeatures): the graph PUT below
  // never retypes the draft, so a KYB feature list must declare it here or the draft is a
  // KYC workflow with business steps as far as the console's validator is concerned.
  const workflowType = workflowTypeForFeatures(featureList);
  const base = await apiRequest(orgAppPath("/verification-settings/"), {
    method: "POST",
    json: { ...rest, ...(workflowType && { workflow_type: workflowType }), status: "draft" },
  });
  const uuid: string | undefined = base?.uuid ?? base?.workflow_id;
  if (!uuid) return base;
  if (!graph) {
    return { workflow_id: uuid, created: true, graph_applied: false, status: "draft", workflow: base };
  }

  let validation: any;
  try {
    validation = await apiRequest(orgAppPath("/workflow-graph/validate/"), {
      method: "POST",
      json: { graph, workflow_uuid: uuid },
    });
  } catch (e: any) {
    validation = { is_valid: false, error: e?.message ?? String(e) };
  }
  if (validation && validation.is_valid === false) {
    return {
      workflow_id: uuid,
      created: true,
      graph_applied: false,
      status: "draft",
      validation,
      ...(workflowType && { workflow_type: workflowType }),
      note:
        "Created an empty DRAFT, but the requested features could not be assembled into a valid " +
        "graph (see validation — usually a feature ordered before a dependency, e.g. FACE_MATCH/NFC " +
        "before OCR). Fix the order/config and apply with didit_workflow_set_graph, then publish." +
        (workflowType
          ? ` The draft is permanently typed ${workflowType}, so the repair graph must stay pure-${workflowType.toUpperCase()}.`
          : ""),
    };
  }

  await apiRequest(orgAppPath(`/verification-settings/${pathSegment(uuid, "workflow_id")}/workflow-graph/`), {
    method: "PUT",
    json: { graph },
  });

  // The validation answer carries each config as the API accepted it. A setting that was sent and
  // is not in it was left out without an error, and a workflow that lost a setting is not put live:
  // on staging this tool answered "created and published" for a workflow whose made-up
  // "decline at 95" key was gone (12 November 2026).
  // When the validation answer carries no graph, the stored one is read instead. If neither can be
  // read, what the API kept is unknown: a workflow with settings is then not put live either.
  const sentSettings = carriesSettings(graph);
  const accepted = validation?.graph ?? (sentSettings ? await storedWorkflowGraph(uuid) : null);
  const lost = lostSettings(graph, accepted);
  const unverified = sentSettings && !accepted;
  const wantPublished = status === undefined || String(status).toLowerCase() === "published";
  const heldBack = wantPublished && (lost.dropped.length > 0 || unverified);
  let final = base;
  if (wantPublished && !heldBack) {
    final = await apiRequest(orgAppPath(`/verification-settings/${pathSegment(uuid, "workflow_id")}/`), {
      method: "PATCH",
      json: { status: "published" },
    });
  }

  // Return only the accurate, post-graph summary — NOT the base create body, whose `features`/
  // `workflow_graph` reflect the pre-graph draft and would read as "nothing was configured".
  const published = wantPublished && !heldBack;
  const state = heldBack
    ? unverified
      ? "Workflow created as a DRAFT and NOT published, because what the API stored could not be checked."
      : "Workflow created as a DRAFT and NOT published, because it does not hold everything that was asked for."
    : published
      ? "Workflow created and published - live for new sessions."
      : "Workflow created as a DRAFT. Publish it in the console or with didit_workflow_publish.";

  return {
    workflow_id: uuid,
    status: published ? "published" : "draft",
    created: true,
    graph_applied: true,
    features: featureList.map((f: any) => String(f?.feature ?? "").toUpperCase()).filter(Boolean),
    workflow_url: final?.workflow_url ?? base?.workflow_url,
    ...(lost.dropped.length > 0 ? { dropped_config_keys: lost.dropped } : {}),
    ...(lost.unconfirmed.length > 0 ? { unconfirmed_config_keys: lost.unconfirmed } : {}),
    ...(unverified ? { settings_verified: false } : {}),
    note: [
      state,
      droppedSettingsNote(lost),
      unverified ? UNVERIFIED_SETTINGS_NOTE : "",
      heldBack ? "Then publish it with didit_workflow_publish." : "",
      unconfirmedSettingsNote(lost),
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * The graph as the API STORED it, or null when it could not be read. Deliberately has no fallback
 * to the graph that was sent: returning the intent as if it were the result is how "I removed
 * those fields" survived a save that kept them.
 */
export async function storedWorkflowGraph(uuid: string): Promise<any | null> {
  try {
    const res = await apiRequest(orgAppPath(`/verification-settings/${pathSegment(uuid, "workflow_id")}/workflow-graph/`));

    return res?.graph ?? res ?? null;
  } catch {
    return null;
  }
}

export async function updateWorkflow(uuid: string, data: Record<string, any>): Promise<any> {
  const patch = { ...data };
  if (patch.status === undefined) {
    const current = await getWorkflow(uuid);
    if (!current?.status) throw new Error(`Could not preserve the publication state of workflow ${uuid}.`);
    patch.status = current.status;
  }
  return apiRequest(orgAppPath(`/verification-settings/${pathSegment(uuid, "workflow_id")}/`), { method: "PATCH", json: patch });
}

export async function deleteWorkflow(uuid: string): Promise<any> {
  try {
    return await apiRequest(orgAppPath(`/verification-settings/${pathSegment(uuid, "workflow_id")}/`), { method: "DELETE" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/only version|only draft versions|archive it instead/i.test(message)) throw error;
    const current = await getWorkflow(uuid);
    if (!current?.status) throw error;
    const archived = await apiRequest(orgAppPath(`/verification-settings/${pathSegment(uuid, "workflow_id")}/`), {
      method: "PATCH",
      json: { is_archived: true, status: current.status },
    });
    return {
      ...archived,
      deleted: false,
      archived: true,
      note: "The API would not delete this workflow version, so the workflow was archived instead.",
    };
  }
}

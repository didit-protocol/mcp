import { apiRequest, orgAppPath } from "../config";
import { pathSegment } from "../security";
import {
  assertKycKybSegregation,
  buildLinearGraphFromFeatures,
  normalizeFeatureConfigs,
  workflowTypeForFeatures,
} from "./feature-config";

// Workflows are the console's "verification-settings" resource, scoped per org+app.
// org/application are resolved from the tool arguments (organization_id/application_id)
// via the request context — see orgAppPath / the CallTool dispatch in index.ts.

export async function listWorkflows(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/verification-settings/"), { params });
}

export async function getWorkflow(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/verification-settings/${pathSegment(uuid, "workflow_id")}/`));
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
  const featureList = Array.isArray(features) ? features : [];

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

  const wantPublished = status === undefined || String(status).toLowerCase() === "published";
  let final = base;
  if (wantPublished) {
    final = await apiRequest(orgAppPath(`/verification-settings/${pathSegment(uuid, "workflow_id")}/`), {
      method: "PATCH",
      json: { status: "published" },
    });
  }

  // Return only the accurate, post-graph summary — NOT the base create body, whose `features`/
  // `workflow_graph` reflect the pre-graph draft and would read as "nothing was configured".
  return {
    workflow_id: uuid,
    status: wantPublished ? "published" : "draft",
    created: true,
    graph_applied: true,
    features: featureList.map((f: any) => String(f?.feature ?? "").toUpperCase()).filter(Boolean),
    workflow_url: final?.workflow_url ?? base?.workflow_url,
    note: wantPublished
      ? "Workflow created and published — live for new sessions."
      : "Workflow created as a DRAFT. Publish it in the console or with didit_workflow_publish.",
  };
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

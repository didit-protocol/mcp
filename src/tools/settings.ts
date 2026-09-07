import { apiRequest, orgAppPath } from "../config";
import {
  assertKycKybSegregation,
  buildLinearGraphFromFeatures,
  normalizeFeatureConfigs,
} from "./feature-config";

// Workflows are the console's "verification-settings" resource, scoped per org+app.
// org/application are resolved from the tool arguments (organization_id/application_id)
// via the request context — see orgAppPath / the CallTool dispatch in index.ts.

export async function listWorkflows(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/verification-settings/"), { params });
}

export async function getWorkflow(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/verification-settings/${uuid}/`));
}

/**
 * Create a simple (linear) workflow from an ordered `features` list.
 *
 * IMPORTANT: the console verification-settings endpoint does NOT persist a `features` payload —
 * `features` is a read-only computed property there, so POSTing it produces a workflow that runs
 * NONE of the requested features (and whose derived graph is a featureless, branch-rooted graph
 * that used to crash the console editor). The only way to make the requested features actually
 * run is to express them as a workflow GRAPH and save that. So we: create an empty DRAFT, build a
 * linear graph from the features (normalizing each config), validate it, PUT it, and finally
 * publish (unless the caller asked for a draft). On validation failure nothing is published — the
 * draft is left for the agent to fix with set_graph / edit_graph.
 */
export async function createWorkflow(data: Record<string, any>): Promise<any> {
  const { features, status, ...rest } = data || {};
  const featureList = Array.isArray(features) ? features : [];

  const base = await apiRequest(orgAppPath("/verification-settings/"), {
    method: "POST",
    json: { ...rest, status: "draft" },
  });
  const uuid: string | undefined = base?.uuid ?? base?.workflow_id;
  if (!uuid) return base;
  if (featureList.length === 0) {
    return { workflow_id: uuid, created: true, graph_applied: false, status: "draft", workflow: base };
  }

  const graph = buildLinearGraphFromFeatures(featureList);
  normalizeFeatureConfigs(graph);

  try {
    assertKycKybSegregation(graph);
  } catch (e: any) {
    return {
      workflow_id: uuid,
      created: true,
      graph_applied: false,
      status: "draft",
      validation: { is_valid: false, error: e?.message ?? String(e) },
      note:
        "Created an empty DRAFT, but the requested features mix business (KYB) and person (KYC) " +
        "verification, which cannot share one workflow. Build a pure-KYB or pure-KYC workflow; to " +
        "verify the people behind a company, reference a separate KYC workflow from the KYB Key " +
        "People node. Then apply with didit_workflow_set_graph and publish.",
    };
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
      note:
        "Created an empty DRAFT, but the requested features could not be assembled into a valid " +
        "graph (see validation — usually a feature ordered before a dependency, e.g. FACE_MATCH/NFC " +
        "before OCR). Fix the order/config and apply with didit_workflow_set_graph, then publish.",
    };
  }

  await apiRequest(orgAppPath(`/verification-settings/${uuid}/workflow-graph/`), {
    method: "PUT",
    json: { graph },
  });

  const wantPublished = status === undefined || String(status).toLowerCase() === "published";
  let final = base;
  if (wantPublished) {
    final = await apiRequest(orgAppPath(`/verification-settings/${uuid}/`), {
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
  return apiRequest(orgAppPath(`/verification-settings/${uuid}/`), { method: "PATCH", json: patch });
}

export async function deleteWorkflow(uuid: string): Promise<any> {
  try {
    return await apiRequest(orgAppPath(`/verification-settings/${uuid}/`), { method: "DELETE" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/only version|only draft versions|archive it instead/i.test(message)) throw error;
    const current = await getWorkflow(uuid);
    if (!current?.status) throw error;
    const archived = await apiRequest(orgAppPath(`/verification-settings/${uuid}/`), {
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

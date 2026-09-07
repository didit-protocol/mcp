import { apiRequest, orgAppPath } from "../config";
import { runForScope } from "../orgapp";
import { resolveWorkflowScope, withWorkflowResolution } from "./search";

// Compliance endpoints are org/app-scoped console resources; org/app resolve from the tool
// args via the request context (see orgAppPath). Requirements/workflow-check are deterministic
// reads over the stored profile + knowledge base; interview/next is pure computation (the
// caller accumulates answers client-side); the profile PUT is the only write.

// organization_id/application_id are routing args: the CallTool wrapper already resolved them
// into the request context (and thus the URL path), so keep them out of query params/bodies.
function withoutScope(data?: Record<string, any>): Record<string, any> {
  const { organization_id, application_id, ...rest } = data ?? {};
  return rest;
}

export async function getRequirements(params?: Record<string, string>): Promise<any> {
  return apiRequest(orgAppPath("/compliance/requirements/"), { params: withoutScope(params) });
}

export async function checkWorkflow(data: Record<string, any>): Promise<any> {
  const { organization_id, application_id, ...body } = data ?? {};
  // Workflows often live outside the caller's default app — resolve the owning (org, app)
  // the same way the workflow-graph tools do, so cross-app checks don't 404.
  const resolved = await resolveWorkflowScope(body.workflow_id, organization_id, application_id);
  const { organizationId, applicationId, workflow } = resolved;
  // A label resolved to a row: send its id (a version uuid passed by the caller is kept as-is).
  const json = resolved.resolved_from ? { ...body, workflow_id: workflow.workflow_id ?? workflow.uuid } : body;
  const result = await runForScope(organizationId, applicationId, () =>
    apiRequest(orgAppPath("/compliance/workflow-check/"), { method: "POST", json }),
  );
  return withWorkflowResolution(result, resolved);
}

export async function interviewNext(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/compliance/interview/next/"), { method: "POST", json: withoutScope(data) });
}

export async function getProfile(): Promise<any> {
  return apiRequest(orgAppPath("/compliance/profile/"));
}

export async function setProfile(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/compliance/profile/"), { method: "PUT", json: withoutScope(data) });
}

export async function generateWorkflow(data?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/compliance/generate-workflow/"), { method: "POST", json: withoutScope(data) });
}

/** Slim by default: the graph itself stays OUT of the model's context (the
 * document catalog alone is ~100KB and stalled the flash arm into reasoning-only
 * steps, 2026-09-02). The model gets a summary + the accepted spec and applies by
 * reference — ui_workflow_apply_graph {spec} — while headless callers pass
 * include_graph:true to receive the graph for didit_workflow_set_graph. */
export async function buildWorkflow(data?: Record<string, any>): Promise<any> {
  const { include_graph, ...spec } = withoutScope(data) ?? {};
  const built = await apiRequest(orgAppPath("/compliance/build-workflow/"), { method: "POST", json: spec });
  if (!built?.graph || include_graph) return { ...built, spec };
  const nodes = Object.values(built.graph.nodes ?? {}) as Array<Record<string, any>>;
  const { graph: _graph, ...rest } = built;
  return {
    ...rest,
    built: true,
    spec,
    graph_summary: {
      node_count: nodes.length,
      features: [...new Set(nodes.filter((node) => node.node_type === "feature").map((node) => node.feature))],
      branches: nodes.filter((node) => node.node_type === "branch").length,
    },
    how_to_apply:
      "Editor open: call ui_workflow_apply_graph with {spec: <this exact spec>} — the console rebuilds " +
      "and applies it byte-perfect. Headless: re-run with include_graph:true and didit_workflow_set_graph.",
  };
}

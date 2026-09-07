import { apiRequest, orgAppPath } from "../config";

// The deterministic spec-to-graph builder (POST …/compliance/build-workflow/). It is the one
// compliance-service endpoint the open-source build exposes: no regulations are consulted,
// nothing is persisted, and the result is a plain workflow graph the workflow tools apply.

// organization_id/application_id are routing args: the CallTool wrapper already resolved them
// into the request context (and thus the URL path), so keep them out of query params/bodies.
function withoutScope(data?: Record<string, any>): Record<string, any> {
  const { organization_id, application_id, ...rest } = data ?? {};
  return rest;
}

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

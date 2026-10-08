import { apiRequest, orgAppPath } from "../config";
import { DiditError } from "../security";

// The build-workflow endpoint is an org/app-scoped console resource; org/app resolve from the
// tool args via the request context (see orgAppPath). The rest of the compliance tools
// (requirements, workflow-check, interview, profile, generate) are internal-only and live in a
// module the open-source sync omits.

// organization_id/application_id are routing args: the CallTool wrapper already resolved them
// into the request context (and thus the URL path), so keep them out of query params/bodies.
export function withoutScope(data?: Record<string, any>): Record<string, any> {
  const { organization_id, application_id, ...rest } = data ?? {};
  return rest;
}

/**
 * The spec vocabulary, mirroring service-didit-verification's
 * `ComplianceBuildWorkflowSerializer` (compliance/serializers/compliance.py)
 * and the tool schema in index.ts. Keep all three in sync.
 */
const BUILD_SPEC_KEYS = ["branches", "countries", "document_rules", "features", "per_feature_config", "subject"] as const;

/** The valid key a drifted one most likely meant, or "". A model does not invent
 * names from nothing — it blends a real key with the naming convention of its
 * neighbours, so the first underscore-token is the part it got right
 * (`branch_rules` -> `branches`, `document_rules`' suffix landing on
 * `branches`). Only when exactly ONE valid key matches, so the hint is never a
 * coin flip. */
function nearestSpecKey(invented: string): string {
  const stem = invented.split("_")[0] ?? "";
  if (stem.length < 4) return "";
  const matches = BUILD_SPEC_KEYS.filter((key) => key.startsWith(stem) || stem.startsWith(key));

  return matches.length === 1 ? matches[0]! : "";
}

/**
 * Refuse a spec key the builder does not have, BEFORE the request.
 *
 * the console copilot sent `branch_rules` and the backend answered
 * `Unknown key(s) branch_rules. Valid keys: ...` — correct, but a whole HTTP
 * round trip after the mistake, and on the console's apply path the user
 * watched their workflow fail to build. `additionalProperties: false` on the
 * tool schema tells the model; this enforces it, because a declared schema is
 * advice a client may or may not validate against.
 */
function refuseUnknownSpecKeys(spec: Record<string, any>): void {
  const allowed = new Set<string>(BUILD_SPEC_KEYS);
  const unknown = Object.keys(spec).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;

  const hints = unknown
    .map((key) => {
      const nearest = nearestSpecKey(key);

      return nearest ? `${key} (the key is "${nearest}")` : key;
    })
    .join(", ");

  // DiditError so the CallTool wrapper renders the structured shape the model
  // already knows how to read (code / field / hint / allowed), rather than a
  // bare message it has to parse out of prose.
  throw new DiditError({
    code: "bad_request",
    message: `Unknown spec key(s) ${hints}.`,
    field: unknown.join(", "),
    allowed: [...BUILD_SPEC_KEYS],
    hint:
      "Rewrite the spec with the allowed keys only and call didit_workflow_build_graph again - " +
      "do not resend the same spec, and do not invent keys the builder does not have.",
  });
}

/** Slim by default: the graph itself stays OUT of the model's context (the
 * document catalog alone is ~100KB and stalled the flash arm into reasoning-only
 * steps, 2026-09-02). The model gets a summary + the accepted spec and applies by
 * reference — ui_workflow_apply_graph {spec} — while headless callers pass
 * include_graph:true to receive the graph for didit_workflow_set_graph. */
export async function buildWorkflow(data?: Record<string, any>): Promise<any> {
  const { include_graph, ...spec } = withoutScope(data) ?? {};
  refuseUnknownSpecKeys(spec);
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

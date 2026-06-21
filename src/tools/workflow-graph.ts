import { apiRequest, orgAppPath } from "../config";
import { runForScope } from "../orgapp";
import { resolveWorkflowScope } from "./search";

// Node/graph ("branching") workflows. The console drives these through dedicated endpoints on
// the verification-settings resource — the flat `features: [...]` list the older workflow tools
// send can't express branches, conditions, or Document AI. These tools speak the real graph:
//   { start_node, nodes: { id: { node_type, feature?, config?, branches?, next?, ... } } }
// Branch rules support operators incl. `fuzzy_match` (string fields, with a 0-100 `score`),
// Document-AI proof-of-funds feature nodes, and terminal `status` nodes (e.g. Declined).
//
// Every tool takes a bare `workflow_id` and resolves the owning (org, app) automatically (pass
// organization_id/application_id to skip the cross-app lookup), so the agent never has to know
// which application a workflow lives in.

interface Scope {
  organization_id?: string;
  application_id?: string;
}

// Real workflows carry huge feature configs (OCR `documents_allowed` ~157KB, POA
// `poa_documents_allowed` ~49KB, phone-country lists, …). Returning or requiring those verbatim
// overflows the model's context and makes edits fragile. We (a) summarize big config values when
// returning a graph, and (b) edit graphs by applying small ops to the FULL graph SERVER-SIDE, so
// the allow-lists never round-trip through a tool parameter and are preserved byte-for-byte.
const MAX_VALUE_CHARS = 800;

function summarizeValue(v: any): any {
  const s = (() => {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  })();
  if (s.length <= MAX_VALUE_CHARS) return v;
  if (Array.isArray(v)) return { _omitted: true, _type: "array", _items: v.length, _bytes: s.length };
  if (v && typeof v === "object") {
    return { _omitted: true, _type: "object", _keys: Object.keys(v).length, _bytes: s.length, _sample_keys: Object.keys(v).slice(0, 8) };
  }
  return { _omitted: true, _bytes: s.length };
}

function summarizeConfig(config: any): any {
  if (!config || typeof config !== "object") return config;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config)) out[k] = summarizeValue(v);
  return out;
}

/** A structure-only view: node ids/types/features/labels/next/branches kept; large config values
 *  replaced with `{_omitted, _bytes, …}` markers so the response stays small. */
function summarizeGraph(graph: any): any {
  if (!graph || typeof graph !== "object") return graph;
  const nodes: Record<string, any> = {};
  for (const [id, node] of Object.entries<any>(graph.nodes || {})) {
    const n = { ...node };
    if (n.config) n.config = summarizeConfig(n.config);
    nodes[id] = n;
  }
  return { start_node: graph.start_node, nodes };
}

interface GraphOp {
  op: string;
  node_id?: string;
  node?: any;
  next?: string | null;
  branches?: any[];
  start_node?: string;
  config?: Record<string, any>;
}

function requireNode(graph: any, id: string | undefined): void {
  if (!id || !graph.nodes?.[id]) {
    throw new Error(
      `Graph op references node '${id}' which does not exist. Existing nodes: ` +
        `${Object.keys(graph.nodes || {}).join(", ")}.`,
    );
  }
}

/** Apply edit operations to a (full) graph in memory. Small deltas only — never the big config. */
function applyGraphOps(graph: any, operations: GraphOp[]): { graph: any; changes: string[] } {
  const g = JSON.parse(JSON.stringify(graph ?? {}));
  g.nodes = g.nodes || {};
  const changes: string[] = [];
  for (const op of operations || []) {
    switch (op.op) {
      case "set_node":
      case "add_node":
        if (!op.node_id || !op.node) throw new Error("set_node requires node_id + node.");
        g.nodes[op.node_id] = op.node;
        changes.push(`set node ${op.node_id} (${op.node.node_type}${op.node.feature ? ":" + op.node.feature : ""})`);
        break;
      case "remove_node":
        requireNode(g, op.node_id);
        delete g.nodes[op.node_id!];
        changes.push(`removed node ${op.node_id}`);
        break;
      case "set_next":
        requireNode(g, op.node_id);
        g.nodes[op.node_id!].next = op.next ?? null;
        changes.push(`${op.node_id}.next = ${op.next ?? "null"}`);
        break;
      case "set_branches":
        requireNode(g, op.node_id);
        g.nodes[op.node_id!].branches = op.branches ?? [];
        changes.push(`${op.node_id}.branches (${(op.branches ?? []).length})`);
        break;
      case "set_start":
        if (!op.start_node) throw new Error("set_start requires start_node.");
        g.start_node = op.start_node;
        changes.push(`start_node = ${op.start_node}`);
        break;
      case "merge_node_config":
        requireNode(g, op.node_id);
        g.nodes[op.node_id!].config = { ...(g.nodes[op.node_id!].config || {}), ...(op.config || {}) };
        changes.push(`${op.node_id}.config merged (${Object.keys(op.config || {}).join(", ")})`);
        break;
      default:
        throw new Error(
          `Unknown graph op '${op.op}'. Use one of: set_node, remove_node, set_next, ` +
            `set_branches, set_start, merge_node_config.`,
        );
    }
  }
  return { graph: g, changes };
}

/** Branch nodes must express their catch-all as an EXPLICIT else branch (empty rules), not a bare
 *  `next` fallback — a bare `next` renders ambiguously in the builder and is easy to omit. Convert
 *  each branch node's `next` into an else branch so a branch always carries a visible else path.
 *  (Mirrors the backend's own normalization; applied client-side so validate/save reflect it now.) */
function normalizeBranchElse(graph: any): any {
  if (!graph || typeof graph !== "object" || !graph.nodes) return graph;
  for (const node of Object.values<any>(graph.nodes)) {
    if (!node || node.node_type !== "branch") continue;
    const branches: any[] = Array.isArray(node.branches) ? node.branches : [];
    const hasElse = branches.some((b) => !b?.rules || b.rules.length === 0);
    if (node.next && !hasElse) {
      branches.push({ id: "else", logic: "and", rules: [], goto: node.next });
    }
    node.branches = branches;
    delete node.next; // the catch-all is now the else branch
  }
  return graph;
}

async function inScope<R>(
  workflowId: string,
  scope: Scope,
  fn: (workflow: any) => Promise<R>,
): Promise<R> {
  const { organizationId, applicationId, workflow } = await resolveWorkflowScope(
    workflowId,
    scope.organization_id,
    scope.application_id,
  );
  return runForScope(organizationId, applicationId, () => fn(workflow));
}

/** GET the current graph for a workflow, plus its status/version and whether it's editable.
 *  Large feature configs are SUMMARIZED by default (set includeConfig to get them verbatim) so
 *  the response never overflows context. */
export async function getWorkflowGraph(
  workflowId: string,
  scope: Scope = {},
  includeConfig = false,
): Promise<any> {
  return inScope(workflowId, scope, async (wf) => {
    const res = await apiRequest(orgAppPath(`/verification-settings/${wf.uuid}/workflow-graph/`));
    if (includeConfig || !res?.graph) return res;
    return {
      ...res,
      graph: summarizeGraph(res.graph),
      config_summarized: true,
      hint:
        "Large feature configs (documents_allowed, poa_documents_allowed, phone countries, …) are " +
        "summarized to keep this small. To CHANGE the graph, use didit_workflow_edit_graph with small " +
        "ops (set_next / set_node / set_branches / merge_node_config) — it merges them into the full " +
        "graph server-side, so you never resend those lists. Pass include_config:true to see them.",
    };
  });
}

/** The full catalog of branchable fields + the operators valid on each (so the agent builds
 *  valid rules — e.g. kyc.extra_fields.profession supports `fuzzy_match`). */
export async function getWorkflowFieldDefinitions(workflowId: string, scope: Scope = {}): Promise<any> {
  return inScope(workflowId, scope, () =>
    apiRequest(orgAppPath(`/workflow-graph/field-definitions/`)),
  );
}

/** Fields available at a specific branch point given a candidate graph (incl. dynamically-derived
 *  Document-AI / questionnaire fields from earlier nodes). */
export async function getWorkflowBranchFields(
  workflowId: string,
  graph: any,
  nodeId?: string,
  scope: Scope = {},
): Promise<any> {
  return inScope(workflowId, scope, (wf) =>
    apiRequest(orgAppPath(`/verification-settings/${wf.uuid}/workflow-graph/branch-fields/`), {
      method: "POST",
      json: { graph, node_id: nodeId },
    }),
  );
}

/** Dry-run validate a graph without saving. Call this BEFORE set_graph and fix any per-node errors. */
export async function validateWorkflowGraph(workflowId: string, graph: any, scope: Scope = {}): Promise<any> {
  normalizeBranchElse(graph);
  return inScope(workflowId, scope, (wf) =>
    apiRequest(orgAppPath(`/workflow-graph/validate/`), {
      method: "POST",
      json: { graph, workflow_uuid: wf.uuid },
    }),
  );
}

/** Create an editable DRAFT version from a (published) workflow. */
export async function createWorkflowDraft(workflowId: string, scope: Scope = {}): Promise<any> {
  return inScope(workflowId, scope, (wf) =>
    apiRequest(orgAppPath(`/verification-settings/${wf.uuid}/create-draft/`), { method: "POST" }),
  );
}

/** Publish a draft workflow version (makes it the live version for new sessions). */
export async function publishWorkflow(workflowId: string, scope: Scope = {}): Promise<any> {
  return inScope(workflowId, scope, (wf) =>
    apiRequest(orgAppPath(`/verification-settings/${wf.uuid}/`), {
      method: "PATCH",
      json: { status: "published" },
    }),
  );
}

/** Replace a workflow's graph. If the resolved version is published, a DRAFT is auto-created and
 *  the graph applied there (a live version is never mutated). `publish=true` publishes afterwards;
 *  otherwise it stays a reviewable DRAFT. */
export async function setWorkflowGraph(
  workflowId: string,
  graph: any,
  publish = false,
  scope: Scope = {},
): Promise<any> {
  normalizeBranchElse(graph);
  const { organizationId, applicationId, workflow } = await resolveWorkflowScope(
    workflowId,
    scope.organization_id,
    scope.application_id,
  );
  return runForScope(organizationId, applicationId, async () => {
    let targetUuid: string = workflow.uuid;
    let createdDraft = false;
    const status = String(workflow.status ?? "").toLowerCase();
    if (status && status !== "draft") {
      const draft = await apiRequest(
        orgAppPath(`/verification-settings/${workflow.uuid}/create-draft/`),
        { method: "POST" },
      );
      targetUuid = draft?.uuid ?? draft?.workflow_id ?? targetUuid;
      createdDraft = true;
    }
    const saved = await apiRequest(
      orgAppPath(`/verification-settings/${targetUuid}/workflow-graph/`),
      { method: "PUT", json: { graph } },
    );
    let published = false;
    if (publish) {
      await apiRequest(orgAppPath(`/verification-settings/${targetUuid}/`), {
        method: "PATCH",
        json: { status: "published" },
      });
      published = true;
    }
    return {
      workflow_id: workflowId,
      version_uuid: targetUuid,
      organization_id: organizationId,
      application_id: applicationId,
      created_draft: createdDraft,
      published,
      status: published ? "published" : "draft",
      graph: summarizeGraph(saved?.graph ?? graph),
      note: published
        ? "Graph saved and published — live for new sessions."
        : "Graph saved to a DRAFT version. Review it in the console and publish it (or call " +
          "didit_workflow_publish) to make it live. Existing sessions are unaffected.",
    };
  });
}

/** Edit a workflow's graph with small OPERATIONS instead of resending the whole thing. The MCP
 *  fetches the full current graph SERVER-SIDE, applies the ops, validates, and (auto-drafting a
 *  published workflow) saves it — so huge feature configs (documents_allowed, poa lists, phone
 *  countries) are preserved byte-for-byte and never pass through a tool parameter. This is the way
 *  to modify an EXISTING workflow; `set_graph` (full replace) is only for building one from scratch. */
export async function editWorkflowGraph(
  workflowId: string,
  operations: GraphOp[],
  publish = false,
  scope: Scope = {},
): Promise<any> {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("edit_graph requires a non-empty `operations` array.");
  }
  const { organizationId, applicationId, workflow } = await resolveWorkflowScope(
    workflowId,
    scope.organization_id,
    scope.application_id,
  );
  return runForScope(organizationId, applicationId, async () => {
    // 1. Fetch the FULL current graph server-side (allow-lists included; never sent by the model).
    const current = await apiRequest(orgAppPath(`/verification-settings/${workflow.uuid}/workflow-graph/`));
    const baseGraph = current?.graph ?? current;
    // 2. Apply the small ops in memory, then normalize branch catch-alls to explicit else branches.
    const { graph: merged, changes } = applyGraphOps(baseGraph, operations);
    normalizeBranchElse(merged);
    // 3. Dry-run validate server-side. Return cleanly on failure — never save a broken graph.
    let validation: any;
    try {
      validation = await apiRequest(orgAppPath(`/workflow-graph/validate/`), {
        method: "POST",
        json: { graph: merged, workflow_uuid: workflow.uuid },
      });
    } catch (e: any) {
      validation = { is_valid: false, error: e?.message ?? String(e) };
    }
    if (validation && validation.is_valid === false) {
      return {
        applied: false,
        changes,
        validation,
        note: "Validation failed — nothing was saved. Fix the reported issues and retry.",
      };
    }
    // 4. Apply to a DRAFT (the live published version is never mutated).
    let targetUuid: string = workflow.uuid;
    let createdDraft = false;
    if (String(workflow.status ?? "").toLowerCase() !== "draft") {
      const draft = await apiRequest(
        orgAppPath(`/verification-settings/${workflow.uuid}/create-draft/`),
        { method: "POST" },
      );
      targetUuid = draft?.uuid ?? draft?.workflow_id ?? targetUuid;
      createdDraft = true;
    }
    const saved = await apiRequest(
      orgAppPath(`/verification-settings/${targetUuid}/workflow-graph/`),
      { method: "PUT", json: { graph: merged } },
    );
    let published = false;
    if (publish) {
      await apiRequest(orgAppPath(`/verification-settings/${targetUuid}/`), {
        method: "PATCH",
        json: { status: "published" },
      });
      published = true;
    }
    return {
      applied: true,
      changes,
      workflow_id: workflowId,
      version_uuid: targetUuid,
      organization_id: organizationId,
      application_id: applicationId,
      created_draft: createdDraft,
      published,
      status: published ? "published" : "draft",
      node_count: Object.keys(merged.nodes || {}).length,
      graph: summarizeGraph(saved?.graph ?? merged),
      note: published
        ? "Edits applied and published — live for new sessions."
        : "Edits applied to a DRAFT (all existing config preserved server-side). Review in the " +
          "console and publish (or call didit_workflow_publish) when ready. Existing sessions are unaffected.",
    };
  });
}

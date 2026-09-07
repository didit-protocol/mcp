import { isDeepStrictEqual } from "node:util";
import { apiRequest, orgAppPath } from "../config";
import { mapWithConcurrency, runForScope } from "../orgapp";
import { resolveWorkflowScope, withWorkflowResolution } from "./search";
import { DiditError } from "../security";
import { assertKycKybSegregation, normalizeFeatureConfigs, resolveBranchRuleNodeIds } from "./feature-config";

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
  const resolved = await resolveWorkflowScope(workflowId, scope.organization_id, scope.application_id);
  const { organizationId, applicationId, workflow } = resolved;
  const result = await runForScope(organizationId, applicationId, () => fn(workflow));
  return withWorkflowResolution(result, resolved);
}

/** Returned data (data minimization): which data points the client/relying party receives in the
 *  decision API and webhooks. The graph endpoint does not carry `response_attributes`, and an
 *  agent that cannot see it fills the gap by guessing from which features run ("it has OCR, so
 *  the client gets kyc.*") — the exact hallucination this block exists to prevent. The resolved
 *  `wf` only carries the field when it came from the settings-detail endpoint, so fall back to
 *  fetching it; if even that fails, say so explicitly instead of implying the default. */
async function returnedData(wf: any): Promise<any> {
  const settings =
    wf && typeof wf === "object" && "response_attributes" in wf
      ? wf
      : await apiRequest(orgAppPath(`/verification-settings/${wf.uuid}/`)).catch(() => null);

  // A payload that omits the key is NOT an explicit null: null means "all data
  // points", and that permissive default must never be implied on uncertain data.
  if (!settings || typeof settings !== "object" || !("response_attributes" in settings)) {
    return {
      unavailable: true,
      hint: "The returned-data config could not be read this turn — tell the user you cannot see it; do NOT guess.",
    };
  }

  return {
    response_attributes: settings.response_attributes ?? null,
    semantics:
      "The ONLY source of truth for what the client/relying party receives in the decision API " +
      "and webhooks. null or missing (the whole object or a feature key) = ALL data points " +
      "returned; [] = NONE (the client only sees status/warnings/node id); [names] = only " +
      "those fields. Never infer this from which features the workflow runs. When the value is " +
      "null/missing ('all data points'), do NOT enumerate field names — you do not have the " +
      "field catalogue here: say the client receives everything those features produce, " +
      "including document data and, when a selfie/liveness step runs, the selfie image and " +
      "liveness video, and point at the workflow's Returned data panel for the exact list. " +
      "Only an explicit [names] list may be enumerated.",
  };
}

/** Age assurance is an umbrella PURPOSE, not a feature: verifying age from a document (the OCR
 *  node's age restrictions) and estimating it from a selfie (AGE_ESTIMATION) both count, and
 *  neither shows up in the workflow's NAME. Asked "what do my age assurance workflows return?",
 *  an agent that can only substring-match the label finds nothing and answers for whichever
 *  workflow looked closest — the failure this block exists to prevent. Derived from the FULL
 *  graph (before summarizing, which collapses the big `age_restrictions_by_country` map). */
const AGE_VERIFICATION_FIELDS = ["kyc.age"];
const AGE_ESTIMATION_FIELDS = ["face.estimated_age", "age_estimation."];

const AGE_ASSURANCE_SEMANTICS =
  "Age assurance is the UMBRELLA: verifying age from a document (OCR age restrictions) and " +
  "estimating it from a selfie (AGE_ESTIMATION) both count, as does inferring it. This " +
  "workflow does age assurance if `does_age_assurance` is true — decide from THIS, never " +
  "from the workflow's name, and never narrow the question to age estimation alone. When " +
  "it is false the workflow does NOT do age assurance: if that is what the user asked " +
  "about, tell them they have none rather than answering for this workflow instead.";

const matchesAny = (field: string, prefixes: string[]) =>
  prefixes.some((prefix) => field === prefix || field.startsWith(prefix));

/** The age fields a branch rule reads, deduped. `field@node_id` is the console's encoding. */
function ageConditionFields(nodes: any[]): string[] {
  const fields = nodes
    .flatMap((node) => (Array.isArray(node?.branches) ? node.branches : []))
    .flatMap((branch: any) =>
      Array.isArray(branch?.rules) ? branch.rules : [],
    )
    .map((rule: any) => String(rule?.field ?? "").split("@")[0])
    .filter((field: string) =>
      matchesAny(field, [...AGE_VERIFICATION_FIELDS, ...AGE_ESTIMATION_FIELDS]),
    );

  return [...new Set(fields)];
}

function ageAssurance(graph: any): any {
  // No graph read, no verdict: "does_age_assurance: false" on missing data would
  // deny a capability the workflow may well have — the same permissive-default
  // trap `returned_data` guards against.
  if (!graph || typeof graph !== "object" || !graph.nodes) {
    return {
      unavailable: true,
      hint: "The graph could not be read this turn — say you cannot tell whether this workflow does age assurance; do NOT report that it does not.",
    };
  }

  const nodes = Object.values<any>(graph.nodes);
  const ocr_age_restrictions = nodes.some(
    (n) => n?.config?.is_age_restrictions_enabled === true,
  );
  const age_estimation_feature = nodes.some(
    (n) => n?.feature === "AGE_ESTIMATION",
  );
  const age_conditions = ageConditionFields(nodes);
  const verifies =
    ocr_age_restrictions ||
    age_conditions.some((f) => matchesAny(f, AGE_VERIFICATION_FIELDS));
  const estimates =
    age_estimation_feature ||
    age_conditions.some((f) => matchesAny(f, AGE_ESTIMATION_FIELDS));
  const methods = [
    ...(verifies ? ["age_verification"] : []),
    ...(estimates ? ["age_estimation"] : []),
  ];

  return {
    methods,
    does_age_assurance: methods.length > 0,
    signals: { ocr_age_restrictions, age_estimation_feature, age_conditions },
    semantics: AGE_ASSURANCE_SEMANTICS,
  };
}

/** Age assurance on a LIST row. The listing endpoint returns `features` but no graph, so the
 *  document route (age restrictions on the OCR step) is invisible there — asked which workflows
 *  do age assurance, the agent can only preselect by the AGE_ESTIMATION feature it can see and
 *  silently misses the rest (observed 2026-08-17 against a real account). Reading every graph is
 *  the only way to know, so it happens SERVER-side, in parallel, behind an opt-in flag. Rows stay
 *  TINY on purpose: the verdict and its methods, never the shared semantics (repeating that
 *  string per row cost 20KB of context on a 40-row list) and never the signals, which
 *  didit_workflow_get_graph already carries for the one workflow the agent drills into. */
const AGE_ANNOTATION_CAP = 50; // matches searchWorkflows' default limit, so no row is left unjudged
const AGE_ANNOTATION_CONCURRENCY = 8;

/** One encoding of "unknown", carrying its own instruction: an unreadable row that merely went
 *  missing from the verdict list would re-open the false negative this whole flag exists to close. */
const AGE_UNREADABLE = {
  does_age_assurance: null,
  age_assurance_note:
    "Graph unreadable this turn: say you could not check this workflow — never leave it out of " +
    "the answer and never report it as not doing age assurance.",
};

async function rowAgeAssurance(row: any): Promise<void> {
  const read = () => apiRequest(orgAppPath(`/verification-settings/${row.uuid}/workflow-graph/`));
  const inRowScope =
    row.organization_id && row.application_id
      ? () => runForScope(row.organization_id, row.application_id, read)
      : read;
  const res = await inRowScope().catch(() => null);
  const verdict = res?.graph ? ageAssurance(res.graph) : null;

  Object.assign(row, verdict ? { does_age_assurance: verdict.does_age_assurance, methods: verdict.methods } : AGE_UNREADABLE);
}

function listRows(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  const rows = payload?.results ?? payload?.workflows;

  return Array.isArray(rows) ? rows : [];
}

/** Annotate each non-archived row with its age-assurance verdict, in place. */
export async function annotateAgeAssurance(payload: any): Promise<any> {
  // Only `uuid` addresses the graph endpoint: a stable workflow_id needs the extra
  // resolve probe and would 404 into a spurious "unreadable".
  const targets = listRows(payload).filter((r) => r && !r.is_archived && r.uuid);
  const checked = targets.slice(0, AGE_ANNOTATION_CAP);

  await mapWithConcurrency(checked, AGE_ANNOTATION_CONCURRENCY, rowAgeAssurance);

  // Spreading an ARRAY payload into an object literal would hand back {"0":…,"1":…}, so the
  // truncation note only rides on an object; the per-row verdicts survive either way.
  if (checked.length === targets.length || Array.isArray(payload) || !payload) return payload;

  return {
    ...payload,
    age_assurance_note: `Only the first ${AGE_ANNOTATION_CAP} of ${targets.length} non-archived workflows were checked; the rest carry no verdict, so do not report them as not doing age assurance.`,
  };
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
    const [res, returned_data] = await Promise.all([
      apiRequest(orgAppPath(`/verification-settings/${wf.uuid}/workflow-graph/`)),
      returnedData(wf),
    ]);
    if (!res || typeof res !== "object") return res;
    const age_assurance = ageAssurance(res.graph);

    if (includeConfig || !res.graph) return { ...res, returned_data, age_assurance };

    return {
      ...res,
      returned_data,
      age_assurance,
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
export async function getWorkflowFieldDefinitions(
  workflowId: string,
  scope: Scope & { feature?: string } = {},
): Promise<any> {
  return inScope(workflowId, scope, async () => {
    const result = await apiRequest(orgAppPath(`/workflow-graph/field-definitions/`));
    const feature = scope.feature?.trim().toUpperCase();
    if (!feature) return result;
    return {
      feature,
      fields: result?.fields_by_feature?.[feature] ?? [],
      operators_by_field_type: result?.operators_by_field_type ?? {},
      filtered: true,
    };
  });
}

/** The ID verification methods capability and pricing catalog (DID-57): which countries support
 *  non-doc lookup, which digital-identity wallets each country offers, their availability
 *  (available / coming_soon), plain-language request and response fields, and catalog prices.
 *  Served by the backend with integration routes and costs already stripped. */
export async function getIdVerificationMethodsCatalog(
  workflowId: string,
  scope: Scope & { country?: string } = {},
): Promise<any> {
  return inScope(workflowId, scope, async () => {
    const result = await apiRequest(orgAppPath(`/workflow-graph/id-verification-methods-catalog/`));
    const country = scope.country?.trim().toUpperCase();
    if (!country) return result;
    const wallets = Object.fromEntries(
      Object.entries(result?.wallets ?? {}).filter(([, w]: [string, any]) => (w?.countries ?? []).includes(country)),
    );
    return {
      country,
      document: result?.document,
      id_lookup: result?.id_lookup?.[country] ?? null,
      wallets,
      fallback_actions: result?.fallback_actions,
      max_attempts: result?.max_attempts,
      filtered: true,
    };
  });
}

/** Retail names the console shows for the KYB registry data tiers (its i18n keys
 *  kyb-registry-tier-basic / -shareholders / -ubo). */
const KYB_REGISTRY_TIER_NAMES = { basic: "Lite", shareholders: "Shareholders", ubo: "UBOs" } as const;
/** Flat fee for a company the applicant types in by hand. The pricing endpoint does not
 *  serve it; this mirrors the backend's KYB_REGISTRY_MANUAL_ENTRY_PRICE_USD, and the
 *  contract test pins it to the number the contract's description prints. */
export const KYB_REGISTRY_MANUAL_ENTRY_PRICE_USD = "0.75";

type KybRegistryTier = keyof typeof KYB_REGISTRY_TIER_NAMES;
const KYB_REGISTRY_TIERS = Object.keys(KYB_REGISTRY_TIER_NAMES) as KybRegistryTier[];
type KybRegistryCountry = {
  name?: string;
  validated?: boolean;
  tiers?: Partial<Record<KybRegistryTier, { available?: boolean; price_usd?: string }>>;
  monitoring?: { available?: boolean; price_usd?: string };
};
type KybRegistryRow = [string, KybRegistryCountry];

const ISO2 = /^[A-Z]{2}$/;

/** The backend's normalize_registry_catalog_country: upper-case, `_` → `-`, and keep
 *  only the country part of a subdivision key ("es_md" → "ES"). */
function normalizeCountryKey(value: unknown): string {
  return String(value).trim().toUpperCase().replace(/_/g, "-").split("-")[0] ?? "";
}

/** A model often sends one code as a bare string; anything else non-array is ignored. */
function requestedCountries(countries: unknown): string[] {
  const list = Array.isArray(countries) ? countries : typeof countries === "string" ? [countries] : [];
  return [...new Set(list.filter((c) => typeof c === "string").map(normalizeCountryKey))].filter(Boolean);
}

function offers(country: KybRegistryCountry, tier: KybRegistryTier): boolean {
  return country.tiers?.[tier]?.available === true;
}

const byAmount = (a: string, b: string) => Number(a) - Number(b);
const distinctPrices = (prices: (string | undefined)[]) =>
  [...new Set(prices.filter((p): p is string => typeof p === "string"))].sort(byAmount);

function summarizeTier(rows: KybRegistryRow[], tier: KybRegistryTier) {
  const offering = rows.filter(([, c]) => offers(c, tier));
  return {
    name: KYB_REGISTRY_TIER_NAMES[tier],
    available_in: offering.length,
    price_usd: distinctPrices(offering.map(([, c]) => c.tiers?.[tier]?.price_usd)),
  };
}

/** Counts plus the SHORT exception lists: which countries have no registry at all and which
 *  stop at Lite. The full per-country table is ~250 rows, so it only travels on request. */
function summarizeKybRegistryCatalog(rows: KybRegistryRow[]) {
  const monitored = rows.filter(([, c]) => c.monitoring?.available === true);
  return {
    countries_total: rows.length,
    tiers: Object.fromEntries(KYB_REGISTRY_TIERS.map((tier) => [tier, summarizeTier(rows, tier)])),
    no_registry: rows.filter(([, c]) => !offers(c, "basic")).map(([code]) => code),
    lite_only: rows.filter(([, c]) => offers(c, "basic") && !offers(c, "shareholders") && !offers(c, "ubo")).map(([code]) => code),
    monitoring: {
      available_in: monitored.length,
      price_usd_per_company_per_year: distinctPrices(monitored.map(([, c]) => c.monitoring?.price_usd)),
    },
    note: "Pass `countries` (ISO-2) for a country's exact tiers, prices and monitoring availability.",
  };
}

/** The KYB registry catalog (DID-1571 / DID-2389): per ISO-2 country, which data tiers the
 *  registries offer (basic = Lite, shareholders, ubo), their retail price, and whether continuous
 *  monitoring is sold there. Public endpoint: no org/app scope, no provider identity. */
export async function getKybRegistryCatalog(countries?: unknown): Promise<any> {
  const catalog = (await apiRequest("/organization/kyb-registry-pricing/")) as Record<string, KybRegistryCountry>;
  const rows: KybRegistryRow[] =
    catalog && typeof catalog === "object" && !Array.isArray(catalog)
      ? Object.entries(catalog).filter(([code]) => ISO2.test(code))
      : [];
  if (!rows.length) {
    // A maintenance page, an empty body or a redirect would otherwise read as
    // "no country has a registry"; say the catalog could not be read instead.
    throw new DiditError({
      code: "server_error",
      message: "The KYB registry pricing catalog could not be read (unexpected response shape).",
      hint: "Retry in a moment; if it keeps failing, tell the user the catalog is unavailable rather than guessing tiers.",
    });
  }
  const shared = { tier_names: KYB_REGISTRY_TIER_NAMES, manual_entry_price_usd: KYB_REGISTRY_MANUAL_ENTRY_PRICE_USD };
  const wanted = requestedCountries(countries);
  if (!wanted.length) return { ...summarizeKybRegistryCatalog(rows), ...shared };
  const known = new Map(rows);
  const unknown = wanted.filter((code) => !known.has(code));
  return {
    countries: Object.fromEntries(wanted.filter((code) => known.has(code)).map((code) => [code, known.get(code)])),
    ...(unknown.length ? { unknown_countries: unknown, unknown_hint: "Not an ISO 3166-1 alpha-2 code in the catalog (Spain is ES, Germany is DE)." } : {}),
    ...shared,
    filtered: true,
  };
}

/** Fields available at a specific branch point given a candidate graph (incl. dynamically-derived
 *  Document-AI / questionnaire fields from earlier nodes). Both inputs are checked here, before
 *  any network call: the backend reads `branch_node_id` (the old `node_id` wire key was silently
 *  dropped, so every call answered "Both 'graph' and 'branch_node_id' are required"). */
export async function getWorkflowBranchFields(
  workflowId: string,
  graph: any,
  branchNodeId?: string,
  scope: Scope = {},
): Promise<any> {
  requireBranchFieldsArgs(graph, branchNodeId);
  normalizeFeatureConfigs(graph);
  return inScope(workflowId, scope, (wf) =>
    apiRequest(orgAppPath(`/verification-settings/${wf.uuid}/workflow-graph/branch-fields/`), {
      method: "POST",
      json: { graph, branch_node_id: branchNodeId },
    }),
  );
}

function requireBranchFieldsArgs(graph: any, branchNodeId: string | undefined): void {
  const field = !graph?.nodes ? "graph" : !branchNodeId ? "branch_node_id" : "";
  if (!field) return;
  throw new DiditError({
    code: "bad_request",
    field,
    message: "Both 'graph' and 'branch_node_id' are required.",
    hint: "graph is the object returned by didit_workflow_get_graph / ui_workflow_get_graph; branch_node_id is the id of a branch node inside that graph's nodes.",
  });
}

/** Dry-run validate a graph without saving. Call this BEFORE set_graph and fix any per-node errors. */
export async function validateWorkflowGraph(
  workflowId: string | undefined,
  graph: any,
  scope: Scope = {},
  includeConfig = false,
): Promise<any> {
  normalizeFeatureConfigs(graph);
  normalizeBranchElse(graph);
  resolveBranchRuleNodeIds(graph);
  assertKycKybSegregation(graph);
  // The backend endpoint is application-scoped: workflow_uuid only feeds the
  // KYC/KYB segregation check for EXISTING workflows. A graph for a workflow
  // that does not exist yet (an unsaved editor canvas) is validated without it.
  const workflowType = (scope as Record<string, unknown>).workflow_type;
  const validate = async (identity: Record<string, unknown>) => {
    const result = await apiRequest(orgAppPath(`/workflow-graph/validate/`), {
      method: "POST",
      json: { graph, ...identity },
    });
    if (includeConfig || !result?.graph) return result;
    return {
      ...result,
      graph: summarizeGraph(result.graph),
      config_summarized: true,
      hint: "Large feature config values are summarized. Pass include_config:true to return them verbatim.",
    };
  };
  if (!workflowId) return validate(workflowType ? { workflow_type: workflowType } : {});
  return inScope(workflowId, scope, (wf) => validate({ workflow_uuid: wf.uuid }));
}

/** Create an editable DRAFT version from a (published) workflow. */
export async function createWorkflowDraft(workflowId: string, scope: Scope = {}): Promise<any> {
  return inScope(workflowId, scope, (wf) =>
    apiRequest(orgAppPath(`/verification-settings/${wf.uuid}/create-draft/`), { method: "POST" }),
  );
}

/** The graph as the backend STORED it, or null when it could not be re-read. Deliberately has no
 *  fallback to the graph we sent: returning the intent as if it were the result is how "I removed
 *  those fields" survived a save that kept them. */
async function persistedGraph(uuid: string): Promise<any | null> {
  try {
    const res = await apiRequest(orgAppPath(`/verification-settings/${uuid}/workflow-graph/`));

    return res?.graph ?? res ?? null;
  } catch {
    return null;
  }
}

/** Config keys a merge_node_config op asked for that the STORED graph does not match. Reported as
 *  UNCONFIRMED rather than dropped: the backend may legitimately normalise a value it accepted, so
 *  the honest claim is "re-read this before telling the user it changed" — which is the check that
 *  was missing when seven registry fields were reported removed and were still being collected. */
function unconfirmedConfigKeys(stored: any, operations: GraphOp[]): string[] {
  const nodes = stored?.nodes ?? {};

  return operations.flatMap((op) =>
    op.op !== "merge_node_config" || !op.config || !op.node_id
      ? []
      : Object.keys(op.config)
          .filter((key) => !isDeepStrictEqual(nodes[op.node_id!]?.config?.[key], op.config![key]))
          .map((key) => `${op.node_id}.config.${key}`),
  );
}

/** What the caller may claim about a save. Names the version_uuid a publish has to target, because
 *  the stable workflow_id resolves to the already-published version and telling the caller to
 *  "call didit_workflow_publish" without naming the version is what sent it to the wrong one. */
function readBackNote(stored: any, published: boolean, versionUuid: string): string {
  if (stored === null) {
    return (
      `The save was accepted but the stored graph could NOT be re-read, so what is actually in ` +
      `version ${versionUuid} is unverified. Re-read it with didit_workflow_get_graph before ` +
      `telling the user what changed.`
    );
  }
  if (published) return `Saved and published — version ${versionUuid} is live for new sessions.`;

  return (
    `Saved to DRAFT version ${versionUuid}, which is NOT live. Publish it with ` +
    `didit_workflow_publish({ workflow_id: "${versionUuid}" }) — passing the stable workflow_id ` +
    `instead targets the version that is already published. Existing sessions are unaffected.`
  );
}

/** PATCH one version to published and report the status the API CONFIRMS, never the one we asked
 *  for. A body carrying no status (204, bare success) means the PATCH did not error but nothing
 *  read it back, so it is reported as unconfirmed instead of being dressed up as a read-back. */
async function publishVersion(uuid: string): Promise<{ status: string; confirmed: boolean }> {
  const res = await apiRequest(orgAppPath(`/verification-settings/${uuid}/`), {
    method: "PATCH",
    json: { status: "published" },
  });
  const status = typeof res?.status === "string" ? res.status.toLowerCase() : null;

  return { status: status ?? "published", confirmed: status !== null };
}

/** The version a publish must target. A draft publishes itself; a PUBLISHED version can never
 *  carry an edit, because set_graph/edit_graph apply to a draft — so its pending changes live in
 *  that draft and publishing the published version again makes nothing live. create-draft is
 *  idempotent (max 1 draft per workflow group), so it hands back the draft that holds the edits
 *  rather than making another one. */
async function versionToPublish(wf: any): Promise<string> {
  if (String(wf.status ?? "").toLowerCase() === "draft") return wf.uuid;
  // Requires a POSITIVE signal that a draft exists (list rows carry has_draft). Without one,
  // create-draft would clone the live version and publishing that clone is a new version that
  // changes nothing — a no-op dressed up as a publish, which is the whole defect.
  if (wf.has_draft !== true) {
    throw new Error(
      `Workflow version ${wf.uuid} is already published, with no draft version to publish, so ` +
        `there is nothing to publish and nothing changed. Edit the workflow first ` +
        `(didit_workflow_edit_graph) and publish the version_uuid that edit returns.`,
    );
  }
  const draft = await apiRequest(orgAppPath(`/verification-settings/${wf.uuid}/create-draft/`), {
    method: "POST",
  });
  const uuid = draft?.uuid ?? draft?.workflow_id;
  if (!uuid) throw new Error(`Could not resolve the draft version of ${wf.uuid} to publish.`);

  return uuid;
}

/** Publish the version that actually holds the pending changes (makes it live for new sessions).
 *  Accepts a draft version uuid or the stable workflow_id: the stable id resolves to the LISTED
 *  version, which is the published one, so publishing it verbatim republished a version nobody had
 *  edited and reported success. */
export async function publishWorkflow(workflowId: string, scope: Scope = {}): Promise<any> {
  return inScope(workflowId, scope, async (wf) => {
    const target = await versionToPublish(wf);
    const { status, confirmed } = await publishVersion(target);
    const live = status === "published";

    return {
      workflow_id: wf.workflow_id ?? workflowId,
      version_uuid: target,
      status,
      published: live,
      status_confirmed: confirmed,
      note: live
        ? `Version ${target} is live for new sessions. Existing sessions are unaffected.`
        : `The API reports status "${status}" for version ${target} after the publish — it is NOT ` +
          `live. Say so; do not report this workflow as published.`,
    };
  });
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
  normalizeFeatureConfigs(graph);
  normalizeBranchElse(graph);
  resolveBranchRuleNodeIds(graph);
  assertKycKybSegregation(graph);
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
    await apiRequest(orgAppPath(`/verification-settings/${targetUuid}/workflow-graph/`), {
      method: "PUT",
      json: { graph },
    });
    const stored = await persistedGraph(targetUuid);
    const published = publish ? (await publishVersion(targetUuid)).status === "published" : false;

    return {
      workflow_id: workflowId,
      version_uuid: targetUuid,
      organization_id: organizationId,
      application_id: applicationId,
      created_draft: createdDraft,
      published,
      status: published ? "published" : "draft",
      graph_read_back: stored !== null,
      ...(stored ? { graph: summarizeGraph(stored) } : {}),
      note: readBackNote(stored, published, targetUuid),
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
    normalizeFeatureConfigs(merged);
    normalizeBranchElse(merged);
    resolveBranchRuleNodeIds(merged);
    assertKycKybSegregation(merged);
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
    await apiRequest(orgAppPath(`/verification-settings/${targetUuid}/workflow-graph/`), {
      method: "PUT",
      json: { graph: merged },
    });
    const stored = await persistedGraph(targetUuid);
    const unconfirmed = stored ? unconfirmedConfigKeys(stored, operations) : [];
    const published = publish ? (await publishVersion(targetUuid)).status === "published" : false;

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
      graph_read_back: stored !== null,
      ...(stored ? { graph: summarizeGraph(stored) } : {}),
      ...(unconfirmed.length > 0 ? { unconfirmed_config_keys: unconfirmed } : {}),
      note:
        unconfirmed.length > 0
          ? `The stored graph does NOT match what was requested for ${unconfirmed.join(", ")}. ` +
            `Re-read those with didit_workflow_get_graph before telling the user they changed. ` +
            readBackNote(stored, published, targetUuid)
          : readBackNote(stored, published, targetUuid),
    };
  });
}

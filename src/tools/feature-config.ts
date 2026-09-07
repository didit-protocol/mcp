// Feature-config normalization.
//
// The backend stores a feature node's allow-lists in strict, non-obvious shapes:
//   documents_allowed / poa_documents_allowed:
//     { "<ISO3>": { "<DOC_CODE>": { "enabled": 1, ... } } }   // per-country -> per-doc -> object
//   poa_languages_allowed:
//     { "<lang>": 0 | 1 }                                     // per-language flag
//
// Agents (and humans) reliably get these wrong — it is the single biggest source of
// workflow-creation failures. The natural things people try all get rejected with opaque
// errors like "At least one document type must be allowed for a country.":
//   • a flat array of doc types        ["PASSPORT"]                 (no country wrapper)
//   • an "ALL" pseudo-country          {"ALL": {...}}               ("ALL" is not a country)
//   • full doc NAMES instead of codes  {"ESP": {"PASSPORT": ...}}   ("PASSPORT" is not a code)
//   • scalar truthy values             {"ESP": {"P": true}}         (must be { enabled: 1 })
//   • a language array                 ["es"]                       (must be { es: 1 })
//
// We normalize every one of those into the canonical shape BEFORE validate/save, so a natural
// payload just works and the agent never has to reverse-engineer the format. Unknown country
// codes / doc codes are passed through untouched — the backend remains the source of truth and
// will report a precise error if a code really is invalid.

/** Every ISO-3166 alpha-3 code the backend's country allow-list accepts (its own catalog).
 *  Used to fan out an array / "ALL" allow-list to "these documents, every country". */
const ALL_ISO3: string[] = [
  "ABK", "ABW", "AFG", "AGO", "AIA", "ALA", "ALB", "AND", "ARE", "ARG", "ARM", "ASM",
  "ATG", "AUS", "AUT", "AZE", "BDI", "BEL", "BEN", "BES", "BFA", "BGD", "BGR", "BHR",
  "BHS", "BIH", "BLR", "BLZ", "BMU", "BOL", "BRA", "BRB", "BRN", "BTN", "BWA", "CAF",
  "CAN", "CCK", "CHE", "CHL", "CHN", "CIV", "CMR", "COD", "COG", "COK", "COL", "COM",
  "CPV", "CRI", "CUB", "CUW", "CXR", "CYM", "CYP", "CZE", "DEU", "DJI", "DMA", "DNK",
  "DOM", "DPR", "DZA", "ECU", "EGY", "ERI", "ESH", "ESP", "EST", "ETH", "FIN", "FJI",
  "FLK", "FRA", "FRO", "FSM", "GAB", "GBR", "GEO", "GGY", "GHA", "GIB", "GIN", "GMB",
  "GNB", "GNQ", "GRC", "GRD", "GRL", "GTM", "GUM", "GUY", "HKG", "HND", "HRV", "HTI",
  "HUN", "IDN", "IMN", "IND", "IRL", "IRN", "IRQ", "ISL", "ISR", "ITA", "JAM", "JEY",
  "JOR", "JPN", "KAZ", "KEN", "KGZ", "KHM", "KIR", "KNA", "KOR", "KWT", "LAO", "LBN",
  "LBR", "LBY", "LCA", "LIE", "LKA", "LPR", "LSO", "LTU", "LUX", "LVA", "MAC", "MAF",
  "MAR", "MCO", "MDA", "MDG", "MDV", "MEX", "MHL", "MKD", "MLI", "MLT", "MMR", "MNE",
  "MNG", "MNP", "MOZ", "MRT", "MSR", "MUS", "MWI", "MYS", "NAM", "NCL", "NER", "NGA",
  "NIC", "NIU", "NLD", "NOR", "NPL", "NRU", "NZL", "OMN", "PAK", "PAN", "PER", "PHL",
  "PLW", "PNG", "POL", "PRI", "PRK", "PRT", "PRY", "PSE", "PYF", "QAT", "RKS", "ROU",
  "RSL", "RUS", "RWA", "SAU", "SDN", "SEN", "SGP", "SHN", "SLB", "SLE", "SLV", "SMR",
  "SOM", "SRB", "SSD", "STP", "SUR", "SVK", "SVN", "SWE", "SWZ", "SXM", "SYC", "SYR",
  "TCA", "TCD", "TGO", "THA", "TJK", "TKM", "TLS", "TON", "TRN", "TTO", "TUN", "TUR",
  "TUV", "TWN", "TZA", "UGA", "UKR", "URY", "USA", "UZB", "VAT", "VCT", "VEN", "VGB",
  "VIR", "VNM", "VUT", "WSM", "XOM", "YEM", "ZAF", "ZMB", "ZWE",
];

/** Human doc-type names / short aliases -> the canonical document CODE the backend expects.
 *  Only the seven core types carry short codes; longer codes (EPASSPORT, ID_CARD_GENERIC, …)
 *  are already valid and pass straight through `canonicalDocCode`. */
const DOC_NAME_TO_CODE: Record<string, string> = {
  // Passport -> P
  PASSPORT: "P", PASSPORTS: "P", P: "P",
  // National ID -> ID
  ID: "ID", ID_CARD: "ID", IDENTITY_CARD: "ID", IDENTITY: "ID", NATIONAL_ID: "ID",
  NATIONAL_ID_CARD: "ID", NATIONAL_IDENTITY_CARD: "ID", IDENTITY_DOCUMENT: "ID",
  // Driver license -> DL
  DL: "DL", DRIVER_LICENSE: "DL", DRIVERS_LICENSE: "DL", DRIVER_LICENCE: "DL",
  DRIVERS_LICENCE: "DL", DRIVING_LICENSE: "DL", DRIVING_LICENCE: "DL",
  // Residence permit -> RP
  RP: "RP", RESIDENCE_PERMIT: "RP", RESIDENT_PERMIT: "RP", RESIDENCE_CARD: "RP", RESIDENCE: "RP",
  // Social security card -> SSC
  SSC: "SSC", SOCIAL_SECURITY_CARD: "SSC", SOCIAL_SECURITY: "SSC",
  // Health insurance card -> HIC
  HIC: "HIC", HEALTH_INSURANCE_CARD: "HIC", HEALTH_INSURANCE: "HIC",
  // Tax card -> TC
  TC: "TC", TAX_CARD: "TC", TAX_ID: "TC", TAX: "TC",
};

function normKey(s: unknown): string {
  return String(s).trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/** Map a human doc name/alias to the backend doc CODE. Unknown -> returned upper-snake unchanged
 *  (it may already be a valid long code like EPASSPORT; the backend validates the full catalog). */
function canonicalDocCode(key: unknown): string {
  const k = normKey(key);
  return DOC_NAME_TO_CODE[k] ?? k;
}

function isAllCountriesKey(key: unknown): boolean {
  const k = normKey(key);
  return k === "ALL" || k === "*" || k === "ANY" || k === "GLOBAL" || k === "WORLDWIDE" || k === "WORLD";
}

/** A single doc value -> the required `{ enabled: 0|1, ... }` object. Accepts bool / number /
 *  "enabled" / an already-shaped object (its other keys, e.g. `sides`, are preserved). */
function normalizeDocValue(v: unknown): Record<string, unknown> {
  if (v === false || v === 0 || v === "0" || (typeof v === "string" && v.toLowerCase() === "disabled")) {
    return { enabled: 0 };
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    if (out.enabled === undefined || out.enabled === true) out.enabled = 1;
    else if (out.enabled === false) out.enabled = 0;
    return out;
  }
  // true / 1 / "1" / "enabled" / any other truthy scalar -> allowed
  return { enabled: 1 };
}

/** A per-country doc map (array of types OR { code: value }) -> { CODE: { enabled, … } }. */
function normalizeDocMap(docMap: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(docMap)) {
    for (const d of docMap) out[canonicalDocCode(d)] = { enabled: 1 };
  } else if (docMap && typeof docMap === "object") {
    for (const [code, val] of Object.entries(docMap as Record<string, unknown>)) {
      out[canonicalDocCode(code)] = normalizeDocValue(val);
    }
  }
  return out;
}

/** documents_allowed / poa_documents_allowed -> canonical `{ ISO3: { CODE: { enabled } } }`.
 *  A flat array or an "ALL" country fans the doc set out to every country (= "these docs,
 *  any country"); per-country maps are normalized in place. Returns the input untouched when it
 *  is already canonical or there is nothing to do. */
export function normalizeDocumentsAllowed(input: unknown): unknown {
  if (input == null) return input;

  // Flat array of doc types -> those documents for EVERY country.
  if (Array.isArray(input)) {
    const docMap = normalizeDocMap(input);
    if (Object.keys(docMap).length === 0) return input;
    const out: Record<string, unknown> = {};
    for (const iso of ALL_ISO3) out[iso] = { ...docMap };
    return out;
  }

  if (typeof input !== "object") return input;

  const out: Record<string, unknown> = {};
  for (const [country, docMap] of Object.entries(input as Record<string, unknown>)) {
    const normMap = normalizeDocMap(docMap);
    if (isAllCountriesKey(country)) {
      for (const iso of ALL_ISO3) out[iso] = { ...(out[iso] as object ?? {}), ...normMap };
    } else {
      const iso = normKey(country);
      out[iso] = { ...(out[iso] as object ?? {}), ...normMap };
    }
  }
  return out;
}

/** poa_languages_allowed -> canonical `{ <lang>: 0|1 }`. Accepts a language array (all enabled)
 *  or a map with bool / number / string flags. */
export function normalizeLanguagesAllowed(input: unknown): unknown {
  if (input == null) return input;
  const truthy = (v: unknown): number =>
    v === true || v === 1 || v === "1" || (typeof v === "string" && v.toLowerCase() === "true") ? 1 : v ? 1 : 0;

  if (Array.isArray(input)) {
    const out: Record<string, number> = {};
    for (const l of input) out[String(l).trim().toLowerCase()] = 1;
    return out;
  }
  if (typeof input === "object") {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const off = v === false || v === 0 || v === "0" || (typeof v === "string" && v.toLowerCase() === "false");
      out[String(k).trim().toLowerCase()] = off ? 0 : truthy(v);
    }
    return out;
  }
  return input;
}

/** Normalize a single feature node's `config` IN PLACE (documents_allowed, poa_documents_allowed,
 *  poa_languages_allowed). Safe to call on any config object — keys that aren't present are skipped. */
export function normalizeFeatureConfig(config: unknown): void {
  if (!config || typeof config !== "object") return;
  const cfg = config as Record<string, unknown>;
  if ("documents_allowed" in cfg) cfg.documents_allowed = normalizeDocumentsAllowed(cfg.documents_allowed);
  if ("poa_documents_allowed" in cfg) cfg.poa_documents_allowed = normalizeDocumentsAllowed(cfg.poa_documents_allowed);
  if ("poa_languages_allowed" in cfg) cfg.poa_languages_allowed = normalizeLanguagesAllowed(cfg.poa_languages_allowed);
}

/** Walk every node of a graph and normalize its feature config in place. Returns the same graph. */
export function normalizeFeatureConfigs(graph: unknown): unknown {
  if (!graph || typeof graph !== "object") return graph;
  const nodes = (graph as { nodes?: Record<string, unknown> }).nodes;
  if (!nodes || typeof nodes !== "object") return graph;
  for (const node of Object.values(nodes)) {
    normalizeFeatureConfig((node as { config?: unknown })?.config);
  }
  return graph;
}

export interface WorkflowFeatureInput {
  feature?: string;
  config?: Record<string, unknown>;
  label?: string;
}

/** Build a linear workflow graph from an ordered feature list: each feature becomes a feature
 *  node wired to the next, terminating in an auto-decide status node. This is how the MCP creates
 *  a "simple" workflow — the console verification-settings endpoint ignores a `features` payload
 *  (it's a read-only computed property), so the only way to make the requested features actually
 *  run is to express them as a graph and save THAT. Configs are normalized by the caller.
 *  Throws if no usable feature is given (a featureless workflow is exactly the broken state we
 *  are preventing). */
export function buildLinearGraphFromFeatures(features: WorkflowFeatureInput[]): {
  start_node: string;
  nodes: Record<string, unknown>;
} {
  const nodes: Record<string, Record<string, unknown>> = {};
  const used = new Set<string>();
  const order: string[] = [];

  for (const f of Array.isArray(features) ? features : []) {
    const feat = String(f?.feature ?? "").trim().toUpperCase();
    if (!feat) continue;
    const base = feat.toLowerCase();
    let id = base;
    let n = 1;
    while (used.has(id)) id = `${base}_${++n}`;
    used.add(id);
    const node: Record<string, unknown> = { node_type: "feature", feature: feat };
    if (f.config && typeof f.config === "object") node.config = f.config;
    if (f.label) node.label = f.label;
    nodes[id] = node;
    order.push(id);
  }

  if (order.length === 0) {
    throw new Error("Cannot build a workflow with no features — provide at least one feature.");
  }

  for (let i = 0; i < order.length - 1; i++) nodes[order[i]].next = order[i + 1];

  const statusId = used.has("final_status") ? "final_decision" : "final_status";
  nodes[statusId] = { node_type: "status", session_status: "Determine" };
  nodes[order[order.length - 1]].next = statusId;

  return { start_node: order[0], nodes };
}

// A branch rule reads a `field` (e.g. "kyc.extra_fields.profession") whose value is produced by a
// specific FEATURE node. The rule's `node_id` tells the runtime WHICH node instance to read from.
// Without it, the backend silently falls back to the FIRST instance of that feature — so a workflow
// with more than one node of the same feature branches on the wrong data, with no error, just broken
// branching. (The console encodes this as a `field@node_id` suffix; agents reliably omit both.) We
// resolve `node_id` here from the field's feature + the graph so the branch always reads the right
// node. The prefix -> feature map mirrors the backend's workflow_field_definitions catalog.
const FIELD_PREFIX_TO_FEATURE: Record<string, string> = {
  kyc: "OCR",
  nfc: "NFC",
  liveness: "LIVENESS",
  face: "LIVENESS",
  face_match: "FACE_MATCH",
  poa: "PROOF_OF_ADDRESS",
  phone: "PHONE_VERIFICATION",
  email: "EMAIL_VERIFICATION",
  aml: "AML",
  database_validation: "DATABASE_VALIDATION",
  ip_analysis: "IP_ANALYSIS",
  age_estimation: "AGE_ESTIMATION",
  questionnaire: "QUESTIONNAIRE",
  document_ai: "DOCUMENT_AI",
};

type GraphNodes = Record<string, Record<string, unknown>>;

function nodeSuccessors(node: Record<string, unknown> | undefined): string[] {
  if (!node) return [];
  const out: string[] = [];
  if (typeof node.next === "string") out.push(node.next as string);
  const branches = node.branches;
  if (Array.isArray(branches)) {
    for (const b of branches) {
      const goto = (b as { goto?: unknown })?.goto;
      if (typeof goto === "string") out.push(goto);
    }
  }
  return out;
}

/** True if `targetId` is reachable from `fromId` following next + branches[].goto. */
function canReach(nodes: GraphNodes, fromId: string, targetId: string): boolean {
  const seen = new Set<string>();
  const stack = [fromId];
  while (stack.length) {
    const id = stack.pop() as string;
    for (const s of nodeSuccessors(nodes[id])) {
      if (s === targetId) return true;
      if (!seen.has(s)) {
        seen.add(s);
        stack.push(s);
      }
    }
  }
  return false;
}

/** BFS depth of every reachable node from start_node (execution order proxy). */
function depthsFromStart(start: string | undefined, nodes: GraphNodes): Record<string, number> {
  const depth: Record<string, number> = {};
  if (!start || !nodes[start]) return depth;
  depth[start] = 0;
  const queue = [start];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const s of nodeSuccessors(nodes[id])) {
      if (nodes[s] && depth[s] === undefined) {
        depth[s] = depth[id] + 1;
        queue.push(s);
      }
    }
  }
  return depth;
}

/** Fill in each branch rule's `node_id` (the feature node that produces the rule's field) in place.
 *  Runs for ANY node that owns branches (branch nodes, and feature/webhook nodes whose branches the
 *  runtime evaluates after they complete). Only feature nodes that actually run before the branch —
 *  the ones that reach it, plus the branch's own feature node when a feature node carries the
 *  branches — are eligible; a same-feature node on a downstream or alternate path is never picked.
 *  Leaves explicit `node_id`, `field@node_id` rules, else-branches, and non-feature fields
 *  (session/webhook/kyb/unknown) untouched. Returns the same graph. */
export function resolveBranchRuleNodeIds(graph: unknown): unknown {
  if (!graph || typeof graph !== "object") return graph;
  const g = graph as { start_node?: string; nodes?: GraphNodes };
  const nodes = g.nodes;
  if (!nodes || typeof nodes !== "object") return graph;

  const featureNodes: Array<[string, string]> = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (node?.node_type === "feature" && typeof node.feature === "string") {
      featureNodes.push([id, node.feature]);
    }
  }

  const depth = depthsFromStart(g.start_node, nodes);

  for (const [ownerId, node] of Object.entries(nodes)) {
    if (!Array.isArray(node?.branches)) continue;

    const producersByFeature: Record<string, string[]> = {};
    for (const [featureNodeId, feature] of featureNodes) {
      if (featureNodeId !== ownerId && canReach(nodes, featureNodeId, ownerId)) {
        (producersByFeature[feature] ??= []).push(featureNodeId);
      }
    }
    if (node.node_type === "feature" && typeof node.feature === "string") {
      (producersByFeature[node.feature] ??= []).push(ownerId);
    }

    for (const branch of node.branches as Array<{ rules?: unknown }>) {
      const rules = Array.isArray(branch?.rules) ? branch.rules : [];
      for (const rule of rules as Array<Record<string, unknown>>) {
        if (!rule || typeof rule !== "object" || rule.node_id) continue;
        const field = String(rule.field ?? "");
        if (!field || field.includes("@")) continue;
        const feature = FIELD_PREFIX_TO_FEATURE[field.split(".")[0]];
        if (!feature) continue;
        const candidates = producersByFeature[feature];
        if (!candidates || candidates.length === 0) continue;
        rule.node_id = candidates.reduce((best, current) =>
          (depth[current] ?? -1) > (depth[best] ?? -1) ? current : best,
        );
      }
    }
  }
  return graph;
}

// KYC vs KYB feature segregation. A KYB (business) workflow verifies a COMPANY, a KYC workflow
// verifies a PERSON — the two cannot be mixed in one graph. These mirror the backend's
// KYBFeatureChoices catalog exactly (applications/serializers/workflow_graph.py); keep them in sync.
// KYB_ONLY = features that only make sense for a business; KYB_COMPATIBLE = everything a KYB graph
// may contain (the KYB-only features + the shared ones that work for either). Any feature outside
// KYB_COMPATIBLE is person/KYC-only (OCR, LIVENESS, FACE_MATCH, NFC, PROOF_OF_ADDRESS, …).
const KYB_ONLY_FEATURES = new Set(["KYB_REGISTRY", "KYB_DOCUMENTS", "KYB_KEY_PEOPLE"]);
const KYB_COMPATIBLE_FEATURES = new Set([
  "KYB_REGISTRY", "KYB_DOCUMENTS", "KYB_KEY_PEOPLE",
  "AML", "QUESTIONNAIRE", "PHONE_VERIFICATION", "EMAIL_VERIFICATION", "IP_ANALYSIS",
  "DOCUMENT_AI",
]);

/** Throw a clear error if a graph mixes KYB (business) features with person/KYC-only features.
 *  Catches both directions — a KYB feature dropped into a KYC flow AND a KYC feature dropped into a
 *  KYB flow. Mirrors the backend rule so the agent gets immediate, actionable feedback instead of an
 *  opaque server rejection. A pure-KYC graph (no KYB feature) is never touched. */
export function assertKycKybSegregation(graph: unknown): void {
  if (!graph || typeof graph !== "object") return;
  const nodes = (graph as { nodes?: GraphNodes }).nodes;
  if (!nodes || typeof nodes !== "object") return;

  const features = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node?.node_type === "feature" && typeof node.feature === "string") {
      features.add(node.feature.toUpperCase());
    }
  }

  const hasKybFeature = [...features].some((f) => KYB_ONLY_FEATURES.has(f));
  if (!hasKybFeature) return;

  const personOnly = [...features].filter((f) => !KYB_COMPATIBLE_FEATURES.has(f)).sort();
  if (personOnly.length === 0) return;

  const shared = [...KYB_COMPATIBLE_FEATURES].filter((f) => !KYB_ONLY_FEATURES.has(f)).sort();
  throw new Error(
    `A business (KYB) workflow cannot also run person/KYC-only features: ${personOnly.join(", ")}. ` +
      `A workflow that uses KYB features (${[...KYB_ONLY_FEATURES].sort().join(", ")}) may only ` +
      `combine them with ${shared.join(", ")}. To verify the people behind the company (UBOs, ` +
      `officers, shareholders), build a SEPARATE KYC workflow and reference it from the KYB Key ` +
      `People node via kyb_ubo_verification_workflow / kyb_officer_verification_workflow / ` +
      `kyb_shareholder_verification_workflow.`,
  );
}

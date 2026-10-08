import { getSessionDecision } from "./sessions";
import { getWorkflowGraph } from "./workflow-graph";
import { requestContext } from "../config";
import { type Node, leverFor, statusRuleLever } from "./session-explain-levers";

// A session's decision payload already carries the trace of its own outcome: every
// warning's `log_type` IS the action the backend took for it (error → Declined,
// warning → In Review, information → none), and a triggered status rule is logged as
// CUSTOM_STATUS_RULE_TRIGGERED with the field, operator, configured and actual values.
// The workflow graph names each node's feature and holds its config, so the key that
// governs a cause — and its current value — come from the record too. This module folds
// both into a few hundred bytes the model narrates line by line — never images,
// extracted fields or the full payload.

const SEVERITY: Record<string, number> = {
  Declined: 3,
  "In Review": 2,
  Approved: 1,
};
// Only these outcomes come from the checks. Expired, Abandoned, Not Started, In
// Progress, Resub Requested… are the session's lifecycle: nothing in the logs
// "explains" them and nothing should be reported as missing.
const DECIDED = new Set(["Approved", "Declined", "In Review"]);
const EFFECT_BY_LOG_TYPE: Record<string, string> = {
  error: "Declined",
  warning: "In Review",
};
// Scores and modes only: the subject's estimated age, like every extracted field, stays out.
const METRIC_KEYS = [
  "score",
  "total_hits",
  "face_quality",
  "face_luminance",
  "match_type",
  "method",
  "verification_method",
];
// What a warning's additional_data may carry into the trace. The backend stores the personal
// data behind a log there (date of birth, document number, raw MRZ, IP, device fingerprint);
// only measurements and reasons pass.
const VALUE_KEYS = new Set([
  "score",
  "threshold",
  "review_threshold",
  "decline_threshold",
  "similarity",
  "quality",
  "luminance",
  "attempts",
  "max_attempts",
  "expiration_reason",
  "max_age_months",
  "skip_reason",
  "reason",
  "code",
]);
// A triggered rule's actual value is quoted only when the field it reads is a code, not an identity.
const RULE_KEYS = ["field", "operator", "rule_value", "target_status", "score"];
const CODE_FIELDS = new Set([
  "issuing_state",
  "nationality",
  "country",
  "document_type",
  "document_subtype",
  "status",
  "verification_method",
  "assurance",
  "match_type",
  "risk_level",
  "total_hits",
]);
type Warning = Record<string, any>;

const pick = (
  data: Record<string, any> | null,
  keys: Iterable<string>,
): Record<string, any> | null =>
  data
    ? Object.fromEntries(
        [...keys]
          .filter((key) => data[key] !== undefined)
          .map((key) => [key, data[key]]),
      )
    : null;

/** The rule with its actual value when the field is a code (issuing_state…), redacted otherwise. */
function ruleDetail(
  data: Record<string, any> | null,
): Record<string, any> | null {
  const rule = pick(data, RULE_KEYS);
  const leaf = String(data?.field ?? "").split(/[.@]/)[1] ?? "";

  return (
    rule && {
      ...rule,
      actual_value: CODE_FIELDS.has(leaf) ? data!.actual_value : "[redacted]",
    }
  );
}

function cause(warning: Warning, node: Node): Record<string, any> {
  const { risk, log_type, short_description, additional_data } = warning;
  const isRule = risk === "CUSTOM_STATUS_RULE_TRIGGERED";
  const detail = isRule
    ? { rule: ruleDetail(additional_data ?? null) }
    : { value: pick(additional_data ?? null, VALUE_KEYS) };
  const lever = isRule ? statusRuleLever(node) : leverFor(risk, node);

  return {
    risk,
    effect: EFFECT_BY_LOG_TYPE[log_type],
    description: short_description,
    ...detail,
    lever,
  };
}

const metrics = (block: Record<string, any>): Record<string, any> =>
  Object.fromEntries(
    METRIC_KEYS.filter(
      (key) => block[key] !== undefined && block[key] !== null,
    ).map((key) => [key, block[key]]),
  );

function featureEntry(
  [key, block]: [string, Record<string, any>],
  nodes: Record<string, Node>,
): Record<string, any> {
  const warnings: Warning[] = Array.isArray(block.warnings)
    ? block.warnings
    : [];
  const node = nodes[block.node_id];
  const effective = warnings.filter(
    (warning) => EFFECT_BY_LOG_TYPE[warning.log_type],
  );

  return {
    feature: node?.feature ?? warnings[0]?.feature ?? key,
    node_id: block.node_id ?? null,
    status: block.status ?? null,
    metrics: metrics(block),
    causes: effective.map((warning) => cause(warning, node)),
    informational: warnings
      .filter((warning) => !EFFECT_BY_LOG_TYPE[warning.log_type])
      .map((warning) => warning.risk),
  };
}

/** The per-feature result blocks: every top-level array whose items carry a status and warnings. */
function featureBlocks(
  payload: Record<string, any>,
): [string, Record<string, any>][] {
  const isBlock = (item: unknown) =>
    !!item &&
    typeof item === "object" &&
    "status" in (item as object) &&
    "warnings" in (item as object);

  return Object.entries(payload)
    .filter(([, items]) => Array.isArray(items))
    .flatMap(([key, items]) =>
      (items as unknown[])
        .filter(isBlock)
        .map((block) => [key, block] as [string, Record<string, any>]),
    );
}

/** The feature whose status IS the automatic outcome — none for an approval (every check
 *  passed) and none when no feature carries it (a terminal status node, a reviewer's verdict). */
const decidedBy = (
  features: Record<string, any>[],
  automatic: string,
): string | null => {
  const worst = features.reduce<Record<string, any> | null>(
    (acc, entry) =>
      (SEVERITY[entry.status] ?? 0) > (SEVERITY[acc?.status] ?? 0)
        ? entry
        : acc,
    null,
  );

  return automatic !== "Approved" && worst?.status === automatic
    ? worst.feature
    : null;
};

const header = (
  payload: Record<string, any>,
  graph: Record<string, any> | null,
) => ({
  session_id: payload.session_id ?? null,
  session_number: payload.session_number ?? null,
  status: payload.status ?? null,
  status_override: payload.status_override ?? null,
  workflow: { id: payload.workflow_id ?? null, graph_read: !!graph },
});

export function buildDecisionTrace(
  payload: Record<string, any>,
  graph: Record<string, any> | null = null,
): Record<string, any> {
  const nodes: Record<string, Node> = graph?.nodes ?? {};
  const features = featureBlocks(payload).map((block) =>
    featureEntry(block, nodes),
  );
  const automatic = payload.status_override?.automatic_status ?? payload.status;
  const explained = features.some((entry) => entry.causes.length > 0);
  const decided = DECIDED.has(automatic);

  return {
    ...header(payload, graph),
    decided_by: decidedBy(features, automatic),
    features,
    lifecycle_status: !DECIDED.has(payload.status),
    unexplained: decided && automatic !== "Approved" && !explained,
  };
}

/** The graph is the second read; a session whose workflow is gone still gets its trace. */
const graphOf = (workflowId: unknown): Promise<Record<string, any> | null> => {
  const { organizationId, applicationId } = requestContext.getStore() ?? {};
  const scope =
    organizationId && applicationId
      ? { organization_id: organizationId, application_id: applicationId }
      : {};

  return typeof workflowId === "string" && workflowId
    ? getWorkflowGraph(workflowId, scope, true)
        .then((res) => res?.graph ?? null)
        .catch(() => null)
    : Promise.resolve(null);
};

export async function explainSessionDecision(sessionId: string): Promise<any> {
  const payload = await getSessionDecision(sessionId);

  return buildDecisionTrace(payload, await graphOf(payload?.workflow_id));
}

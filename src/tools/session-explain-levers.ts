import { configKeys, WORKFLOW_FEATURES } from "../feature-config-schema";

// Which workflow config key governs a warning, and what it is set to right now. The
// graph names each node's feature (the contract's own feature name) and carries its
// config; the contract lists the keys. Nothing here is a hand-kept map from risk to key
// except THRESHOLD_LEVERS, whose keys the test checks against the contract.

const STOP_TOKENS = new Set([
  "possible",
  "detected",
  "suspected",
  "during",
  "not",
  "with",
  "provided",
  "from",
  "for",
  "application",
]);

/** Score-driven risks decide on thresholds, not on an `*_action` key, and their names do
 *  not spell those keys — the one mapping the contract cannot give us. Every key listed
 *  here must exist in the contract (see test/session-explain.test.mjs). */
export const THRESHOLD_LEVERS: Record<string, string[]> = {
  LOW_LIVENESS_SCORE: [
    "face_liveness_score_review_threshold",
    "face_liveness_score_decline_threshold",
  ],
  LOW_FACE_QUALITY: [
    "face_quality_review_threshold",
    "face_quality_decline_threshold",
  ],
  LOW_FACE_LUMINANCE: [
    "face_luminance_min_threshold",
    "face_luminance_min_action",
  ],
  HIGH_FACE_LUMINANCE: [
    "face_luminance_max_threshold",
    "face_luminance_max_action",
  ],
  LOW_FACE_MATCH_SIMILARITY: [
    "face_match_score_review_threshold",
    "face_match_score_decline_threshold",
  ],
  SCREEN_CAPTURE_DETECTED: [
    "document_liveness_screen_replay_review_threshold",
    "document_liveness_screen_replay_decline_threshold",
  ],
  PRINTED_COPY_DETECTED: [
    "document_liveness_printed_copy_review_threshold",
    "document_liveness_printed_copy_decline_threshold",
  ],
  PORTRAIT_MANIPULATION_DETECTED: [
    "document_liveness_portrait_replace_review_threshold",
    "document_liveness_portrait_replace_decline_threshold",
  ],
};

export type Node =
  { feature?: string; config?: Record<string, any> } | undefined;
export type Lever = {
  keys: string[];
  kind: "threshold" | "status_rule" | "action";
  match: "exact" | "by-name";
  current: Record<string, any>;
} | null;

/** The contract keys to search: the node's own feature when the graph names it, else all. */
const searchFeatures = (node: Node): string[] =>
  node?.feature && WORKFLOW_FEATURES.includes(node.feature)
    ? [node.feature]
    : WORKFLOW_FEATURES;

const knownKeys = (node: Node): Set<string> =>
  new Set(searchFeatures(node).flatMap(configKeys));

// Leading tokens a config key spends on naming its feature ("face_liveness_…",
// "document_ai_…"): a risk name never repeats them, so they are stripped before the
// two token sets are compared. Everything else must match exactly — a subset match
// sent FACE_FACE_COVERED to face_match_eyes_covered_action.
const FEATURE_VOCABULARY = new Set([
  "face",
  "liveness",
  "match",
  "document",
  "ai",
  "kyb",
  "bank",
  "poa",
  "phone",
  "email",
  "ip",
  "ocr",
  "id",
  "verification",
  "aml",
  "nfc",
  "database",
  "validation",
]);

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((token) => b.includes(token));

const withoutFeaturePrefix = (tokens: string[]): string[] => {
  const first = tokens.findIndex((token) => !FEATURE_VOCABULARY.has(token));

  return first < 0 ? [] : tokens.slice(first);
};

/** `DUPLICATED_FACE_NAME_MISMATCH` → the `*_action` key spelling exactly its tokens
 *  (feature prefix aside). Only inside the node's own feature: without the graph the
 *  same tokens match another feature's key (COUNTRY_MISMATCH → bank_country_mismatch). */
function actionKeyByName(risk: string, node: Node): string[] {
  const tokens = [
    ...new Set(
      risk
        .toLowerCase()
        .split("_")
        .filter((token) => !STOP_TOKENS.has(token)),
    ),
  ];
  const scoped = node?.feature && WORKFLOW_FEATURES.includes(node.feature);
  const matches = scoped
    ? configKeys(node!.feature!).filter((key) => {
        const keyTokens = key.replace(/_action$/, "").split("_");
        const unique = (list: string[]) => [...new Set(list)];

        return (
          key.endsWith("_action") &&
          (sameSet(unique(keyTokens), tokens) ||
            sameSet(unique(withoutFeaturePrefix(keyTokens)), tokens))
        );
      })
    : [];

  return matches.sort((a, b) => a.length - b.length).slice(0, 1);
}

const currentValues = (keys: string[], node: Node): Record<string, any> =>
  Object.fromEntries(
    keys
      .filter((key) => node?.config?.[key] !== undefined)
      .map((key) => [key, node!.config![key]]),
  );

export const statusRuleLever = (node: Node): Lever => ({
  keys: ["status_rules"],
  kind: "status_rule",
  match: "exact",
  current: currentValues(["status_rules"], node),
});

export function leverFor(risk: string, node: Node): Lever {
  const known = knownKeys(node);
  const thresholds = (THRESHOLD_LEVERS[risk] ?? []).filter((key) =>
    known.has(key),
  );
  const found = thresholds.length
    ? { keys: thresholds, kind: "threshold" as const, match: "exact" as const }
    : {
        keys: actionKeyByName(risk, node),
        kind: "action" as const,
        match: "by-name" as const,
      };

  return found.keys.length
    ? { ...found, current: currentValues(found.keys, node) }
    : null;
}

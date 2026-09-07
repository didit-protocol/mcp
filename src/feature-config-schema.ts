// The feature-config contract, as published by the backend.
//
// `schema/feature-config-schema.json` is a byte-for-byte copy of
// `service-didit-verification/src/applications/config/feature_config_schema.json`,
// which that repo generates from `FEATURE_CONFIG_SERIALIZERS` - the serializers
// that actually validate a workflow save. Nothing here is hand-written: this
// module only RENDERS the artifact into the prose our tool schemas advertise.
//
// It exists because the alternative failed. The workflow tool descriptions used
// to carry a hand-maintained schema note, and DATABASE_VALIDATION never made it
// in: an agent asked for "a Database Validation workflow for Brazil" produced a
// node with no countries selected, the API accepted the config and threw the
// unknown keys away, and nothing anywhere went red (DID-1576). Every key an
// agent can set now comes from the artifact, and `test/feature-config-contract.test.mjs`
// fails if a single one stops being advertised.

import schema from "./schema/feature-config-schema.json";

export interface FeatureConfigField {
  type: string;
  required: boolean;
  nullable: boolean;
  description?: string;
  shape?: string;
  example?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  items?: FeatureConfigField & { fields?: Record<string, FeatureConfigField> };
  fields?: Record<string, FeatureConfigField>;
}

export interface FeatureConfigEntry {
  serializer: string;
  description: string;
  notes?: string;
  fields: Record<string, FeatureConfigField>;
}

export interface FeatureConfigSchema {
  schema_version: number;
  source: string;
  checksum: string;
  value_kinds: Record<string, string[]>;
  features: Record<string, FeatureConfigEntry>;
}

export const FEATURE_CONFIG_SCHEMA = schema as unknown as FeatureConfigSchema;

/** What the nightly drift check compares against the deployed backend. */
export const FEATURE_CONFIG_CHECKSUM = FEATURE_CONFIG_SCHEMA.checksum;

/** Every feature a workflow node may run, from the contract - never a literal. */
export const WORKFLOW_FEATURES: string[] = Object.keys(FEATURE_CONFIG_SCHEMA.features).sort();

/** The config keys one feature accepts. */
export function configKeys(feature: string): string[] {
  const entry = FEATURE_CONFIG_SCHEMA.features[feature];
  return entry ? Object.keys(entry.fields).sort() : [];
}

/** Every `FEATURE.key` pair in the contract - the set the contract test walks. */
export function allConfigKeys(): string[] {
  return WORKFLOW_FEATURES.flatMap((feature) => configKeys(feature).map((key) => `${feature}.${key}`));
}

// `status_rules` is on every feature and is documented once, on the graph
// schema itself, rather than repeated sixteen times.
const UNIVERSAL_KEYS = new Set(["status_rules"]);

function isInteresting(field: FeatureConfigField): boolean {
  // A key an agent cannot infer from its name: a JSON blob with a shape, or a
  // value with a closed vocabulary. Numeric thresholds and booleans read fine
  // from the name plus their bounds.
  return Boolean(field.shape) || Boolean(field.enum);
}

/**
 * A closed vocabulary, in one canonical order.
 *
 * The artifact preserves each serializer's own declaration order, so the same
 * three verdicts arrive as both DECLINE|REVIEW|NO_ACTION and
 * NO_ACTION|REVIEW|DECLINE. Rendering them apart would list one vocabulary
 * twice and read as two different contracts.
 */
function canonicalVocabulary(values: string[]): string {
  const sorted = [...values].sort();
  for (const known of Object.values(FEATURE_CONFIG_SCHEMA.value_kinds)) {
    if (known.length === values.length && [...known].sort().every((v, i) => v === sorted[i])) {
      return known.map((v) => `'${v}'`).join("|");
    }
  }
  return sorted.map((v) => `'${v}'`).join("|");
}

function renderConstraint(field: FeatureConfigField): string {
  if (field.shape) return field.shape;
  if (field.enum) return canonicalVocabulary(field.enum);
  const bounds: string[] = [];
  if (field.minimum !== undefined) bounds.push(`>=${field.minimum}`);
  if (field.maximum !== undefined) bounds.push(`<=${field.maximum}`);
  return bounds.length ? `${field.type} ${bounds.join(" ")}` : field.type;
}

/**
 * One feature's keys, in full but compressed.
 *
 * Every key is listed - a key an agent cannot see is a key it cannot set, which
 * is the whole of DID-1576 - but the repetition is squeezed out: shaped JSON
 * blobs get their shape and an example, keys sharing a closed vocabulary are
 * grouped under it once, and plain numeric/flag keys are listed with their
 * bounds. Meaning-prose stays in the artifact and is one
 * `didit_workflow_get_feature_config_schema` call away.
 */
export function renderFeatureDetail(feature: string): string {
  const entry = FEATURE_CONFIG_SCHEMA.features[feature];
  if (!entry) return "";

  const shaped: string[] = [];
  const byVocabulary = new Map<string, string[]>();
  const plain: string[] = [];

  for (const [key, field] of Object.entries(entry.fields).sort(([a], [b]) => a.localeCompare(b))) {
    if (UNIVERSAL_KEYS.has(key)) continue;
    if (field.shape) {
      const example = field.example !== undefined ? ` e.g. ${JSON.stringify(field.example)}` : "";
      shaped.push(`${key}: ${field.shape}${example}`);
    } else if (field.enum) {
      const vocabulary = canonicalVocabulary(field.enum);
      const group = byVocabulary.get(vocabulary) ?? [];
      group.push(key);
      byVocabulary.set(vocabulary, group);
    } else {
      plain.push(`${key} (${renderConstraint(field)})`);
    }
  }

  const parts: string[] = [];
  for (const shape of shaped) parts.push(shape);
  for (const [vocabulary, keys] of byVocabulary) parts.push(`${vocabulary} — ${keys.join(", ")}`);
  if (plain.length) parts.push(plain.join(", "));

  const header = entry.notes ? `${feature} — ${entry.notes}` : feature;
  return parts.length ? `${header}\n  • ${parts.join("\n  • ")}` : `${header}\n  • (no config keys)`;
}

/**
 * The generated block the workflow tool descriptions embed. Covers EVERY key of
 * EVERY feature; the artifact's per-key prose is a tool call away.
 */
export function renderToolSchemaReference(): string {
  const body = WORKFLOW_FEATURES.map(renderFeatureDetail).join("\n");
  return (
    `FEATURE CONFIG KEYS — generated from the backend serializers (contract ${FEATURE_CONFIG_CHECKSUM}); ` +
    `a key that is not here is not in the contract and the API will drop it silently. ` +
    `Every feature additionally accepts status_rules. Call didit_workflow_get_feature_config_schema ` +
    `for a feature's full types, defaults and per-key meaning.\n${body}`
  );
}

/**
 * The compact variant carried by the SIMPLE workflow tools (`features[].config`).
 *
 * Those tools build a linear graph and are the wrong place for a full config
 * reference, so this names every feature and spells out only the keys whose
 * value is a JSON shape no agent can invent - the rest is one
 * `didit_workflow_get_feature_config_schema` call away.
 */
export function renderFeatureItemReference(): string {
  const shaped = WORKFLOW_FEATURES.flatMap((feature) =>
    Object.entries(FEATURE_CONFIG_SCHEMA.features[feature].fields)
      .filter(([, field]) => Boolean(field.shape))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => {
        const example = field.example !== undefined ? ` e.g. ${JSON.stringify(field.example)}` : "";
        return `${feature}.${key}: ${field.shape}${example}`;
      }),
  );
  return (
    `Feature-specific settings, generated from the backend serializers (contract ${FEATURE_CONFIG_CHECKSUM}); ` +
    `a key outside the contract is dropped silently by the API. Features: ${WORKFLOW_FEATURES.join(", ")}. ` +
    `Call didit_workflow_get_feature_config_schema for a feature's full key list, types and meaning. ` +
    `The keys whose value cannot be guessed:\n  • ${shaped.join("\n  • ")}`
  );
}

/** The per-feature reference the README carries, generated so the two cannot disagree. */
export function renderMarkdownReference(): string {
  const lines: string[] = [];
  lines.push(`<!-- BEGIN GENERATED FEATURE CONFIG REFERENCE -->`);
  lines.push("");
  lines.push(
    `_Generated from \`schema/feature-config-schema.json\` (contract \`${FEATURE_CONFIG_CHECKSUM}\`, ` +
      `schema version ${FEATURE_CONFIG_SCHEMA.schema_version}), which is a copy of the artifact ` +
      `\`service-didit-verification\` generates from its feature-config serializers. Do not edit by hand — ` +
      `run \`npm run schema:readme\`._`,
  );
  lines.push("");
  for (const feature of WORKFLOW_FEATURES) {
    const entry = FEATURE_CONFIG_SCHEMA.features[feature];
    lines.push(`### ${feature}`);
    lines.push("");
    if (entry.description) lines.push(entry.description);
    if (entry.notes) lines.push(`> ${entry.notes}`);
    if (entry.description || entry.notes) lines.push("");
    lines.push("| Key | Type | Accepts | Meaning |");
    lines.push("| --- | --- | --- | --- |");
    for (const [key, field] of Object.entries(entry.fields).sort(([a], [b]) => a.localeCompare(b))) {
      const accepts = isInteresting(field) ? renderConstraint(field) : renderConstraint(field);
      lines.push(
        `| \`${key}\` | ${field.type}${field.nullable ? " \\| null" : ""} | ${escapeCell(accepts)} | ` +
          `${escapeCell(field.description ?? "")} |`,
      );
    }
    lines.push("");
  }
  lines.push(`<!-- END GENERATED FEATURE CONFIG REFERENCE -->`);
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

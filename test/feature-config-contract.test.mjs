// The contract test: every feature-config key the backend accepts is advertised
// by the workflow tools, and nothing that is not in the contract is invented.
//
// This is the test that would have caught an internal issue. `DATABASE_VALIDATION` reached
// production with its config keys documented in the backend and nowhere else, so
// an agent asked for a Brazilian database check produced a node with no countries
// and the API dropped the keys in silence. Nothing failed. Now something does.
//
// It fails in both directions on purpose:
//   • backend adds/renames a key -> the refreshed artifact carries a key the
//     advertised schemas do not mention -> red.
//   • someone hand-edits a key into a tool description -> the artifact does not
//     know it -> red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FEATURE_CONFIG_CHECKSUM,
  FEATURE_CONFIG_SCHEMA,
  WORKFLOW_FEATURES,
  allConfigKeys,
  configKeys,
  renderMarkdownReference,
} from "../dist/feature-config-schema.js";

const REFRESH =
  "Refresh schema/feature-config-schema.json from " +
  "service-didit-verification/src/applications/config/feature_config_schema.json " +
  "(regenerate it there first with scripts/generate_feature_config_schema.py).";

/** The tools whose schemas describe a feature `config` object. */
const CONFIG_CARRYING_TOOLS = [
  "didit_workflow_create",
  "didit_workflow_validate_graph",
  "didit_workflow_set_graph",
  "didit_workflow_preview_graph",
];

/** Tools that must advertise EVERY key, not just the unguessable ones. */
const FULL_REFERENCE_TOOLS = [
  "didit_workflow_validate_graph",
  "didit_workflow_set_graph",
];

async function listAdvertisedTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return tools;
}

const toolText = (tool) => JSON.stringify(tool);

test("the shipped artifact is the backend's, unaltered and self-consistent", () => {
  const raw = readFileSync(
    fileURLToPath(new URL("../src/schema/feature-config-schema.json", import.meta.url)),
    "utf8",
  );
  const onDisk = JSON.parse(raw);
  assert.deepEqual(onDisk, FEATURE_CONFIG_SCHEMA, "the compiled copy drifted from src/schema/.");
  assert.ok(FEATURE_CONFIG_CHECKSUM.startsWith("sha256:"), "the contract carries no checksum.");
  assert.equal(FEATURE_CONFIG_SCHEMA.schema_version, 1, "artifact layout changed; update the readers.");
  assert.ok(WORKFLOW_FEATURES.length >= 16, `only ${WORKFLOW_FEATURES.length} features in the contract. ${REFRESH}`);
});

test("every feature in the contract is offered by the workflow tools", async () => {
  const tools = await listAdvertisedTools();
  for (const name of CONFIG_CARRYING_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) continue; // preview_graph is gated in some catalogs
    const text = toolText(tool);
    for (const feature of WORKFLOW_FEATURES) {
      assert.ok(text.includes(feature), `${name} never mentions the feature ${feature}. ${REFRESH}`);
    }
  }
});

test("settings-only workflow update does not advertise feature replacement", async () => {
  const tool = (await listAdvertisedTools()).find(t => t.name === "didit_workflow_update");
  assert.equal(tool.inputSchema.properties.features, undefined);
  assert.match(tool.description, /SETTINGS only/);
  assert.match(tool.description, /didit_workflow_edit_graph/);
});

test("every config key in the contract is advertised by the graph tools", async () => {
  const tools = await listAdvertisedTools();
  for (const name of FULL_REFERENCE_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is not advertised at all.`);
    const text = toolText(tool);
    const missing = allConfigKeys().filter((qualified) => {
      const key = qualified.slice(qualified.indexOf(".") + 1);
      return !text.includes(key);
    });
    // Cap the listing: when the generated block is removed wholesale every key
    // is missing, and a 240-key assertion message buries the point.
    const shown = missing.slice(0, 15).join(", ");
    const rest = missing.length > 15 ? ` (+${missing.length - 15} more)` : "";
    assert.deepEqual(
      missing,
      [],
      `${name} does not advertise ${missing.length} feature-config key(s), so no agent can ` +
        `set them: ${shown}${rest}. ${REFRESH}`,
    );
  }
});

test("status_rules is advertised once, not repeated on all sixteen features", async () => {
  // Every feature accepts it, so the generated block states it once at the top
  // instead of sixteen times. The key-coverage test above passes on that single
  // mention; this pins it so the mention cannot quietly disappear and leave the
  // coverage test passing on a substring match somewhere else.
  const tools = await listAdvertisedTools();
  for (const name of FULL_REFERENCE_TOOLS) {
    const description = tools.find((t) => t.name === name).inputSchema.properties.graph.description;
    const mentions = description.split("status_rules").length - 1;
    assert.equal(mentions, 1, `${name} mentions status_rules ${mentions} times; expected exactly one.`);
  }
});

test("DATABASE_VALIDATION is documented to the depth DOCUMENT_AI always had", async () => {
  // The concrete regression. Both features must carry their shaped keys with an
  // actual shape - not just a name in a list.
  const tools = await listAdvertisedTools();
  const setGraph = tools.find((t) => t.name === "didit_workflow_set_graph");
  const text = toolText(setGraph);

  for (const key of configKeys("DATABASE_VALIDATION")) {
    assert.ok(text.includes(key), `didit_workflow_set_graph never mentions ${key}. ${REFRESH}`);
  }
  // The shape, not merely the key name: "countries" alone is what produced a node
  // that ran nothing.
  assert.ok(text.includes("services"), "the DATABASE_VALIDATION country->services shape is not advertised.");
  for (const source of ["document_ai", "questionnaire", "expected_data"]) {
    assert.ok(text.includes(source), `field_sources source '${source}' is not advertised.`);
  }
  // And the comparison feature is still whole.
  for (const key of configKeys("DOCUMENT_AI")) {
    assert.ok(text.includes(key), `didit_workflow_set_graph never mentions ${key}. ${REFRESH}`);
  }
});

test("GEOLOCATION advertises the Location node's keys with their shapes and vocabularies", async () => {
  // The keys the console's Location node edits (position source, areas, anonymizers,
  // travel tolerance, presets, refusal path). Pinned by name so a contract refresh
  // that loses one fails here, not in a customer's workflow.
  const locationKeys = [
    "geolocation_areas",
    "geolocation_blocked_area_action",
    "geolocation_consecutive_mismatch_action",
    "geolocation_consecutive_mismatch_count",
    "geolocation_document_distance_basis",
    "geolocation_emulator_action",
    "geolocation_low_accuracy_behavior",
    "geolocation_position_source",
    "geolocation_preset",
    "geolocation_proxy_action",
    "geolocation_refusal_path",
    "geolocation_tor_action",
    "geolocation_travel_max_days",
    "geolocation_travel_tolerance_enabled",
    "geolocation_travel_usual_area_km",
    "geolocation_vpn_action",
  ];
  const contractKeys = configKeys("GEOLOCATION");
  for (const key of locationKeys) {
    assert.ok(contractKeys.includes(key), `GEOLOCATION has no ${key} in the contract. ${REFRESH}`);
  }

  const fields = FEATURE_CONFIG_SCHEMA.features.GEOLOCATION.fields;
  const tools = await listAdvertisedTools();
  for (const name of FULL_REFERENCE_TOOLS) {
    const description = tools.find((t) => t.name === name).inputSchema.properties.graph.description;
    for (const key of locationKeys) {
      assert.ok(description.includes(key), `${name} never mentions ${key}. ${REFRESH}`);
    }
    // The area list's shape, not just its name: an agent needs every `kind` to draw one.
    assert.ok(description.includes(fields.geolocation_areas.shape), `${name} does not advertise the geolocation_areas shape.`);
    for (const key of [
      "geolocation_position_source",
      "geolocation_refusal_path",
      "geolocation_low_accuracy_behavior",
      "geolocation_document_distance_basis",
      "geolocation_preset",
    ]) {
      for (const value of fields[key].enum) {
        assert.ok(description.includes(`'${value}'`), `${name} does not offer '${value}' for ${key}.`);
      }
    }
  }
});

test("BANK_VERIFICATION advertises the per-country methods, their order and the account check settings", async () => {
  // The Bank node offers bank sign-in and the account check per country, in an
  // order. The step's default order and a country's own `methods` are
  // both JSON an agent cannot guess, so every tool that carries a config must
  // show their shapes, not just the key names. The account check's own settings
  // (BV-BE3) are plain scalars: the contract and the full reference must name them.
  const methodKeys = [
    "bank_method_order",
    "bank_countries",
    "bank_account_check_accept_close_match",
    "bank_account_check_max_attempts",
  ];
  const contractKeys = configKeys("BANK_VERIFICATION");
  for (const key of methodKeys) {
    assert.ok(contractKeys.includes(key), `BANK_VERIFICATION has no ${key} in the contract. ${REFRESH}`);
  }

  const fields = FEATURE_CONFIG_SCHEMA.features.BANK_VERIFICATION.fields;
  assert.deepEqual(fields.bank_method_order.items.enum, ["open_banking", "account_lookup"]);
  assert.ok(fields.bank_countries.shape.includes('"methods"?'), `bank_countries has no per-country methods. ${REFRESH}`);
  assert.equal(fields.bank_account_check_max_attempts.type, "integer");

  const tools = await listAdvertisedTools();
  for (const name of CONFIG_CARRYING_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) continue; // preview_graph is gated in some catalogs
    const text = toolText(tool);
    for (const key of ["bank_method_order", "bank_countries"]) {
      assert.ok(text.includes(JSON.stringify(fields[key].shape).slice(1, -1)), `${name} does not advertise the ${key} shape.`);
    }
  }
  for (const name of FULL_REFERENCE_TOOLS) {
    const description = tools.find((t) => t.name === name).inputSchema.properties.graph.description;
    for (const key of methodKeys) {
      assert.ok(description.includes(key), `${name} never mentions ${key}. ${REFRESH}`);
    }
  }
});

test("the advertised feature enum comes from the contract, not from a literal", async () => {
  const tools = await listAdvertisedTools();
  const create = tools.find((t) => t.name === "didit_workflow_create");
  const featureEnum = create.inputSchema.properties.features.items.properties.feature.enum;
  assert.deepEqual(
    [...featureEnum].sort(),
    [...WORKFLOW_FEATURES].sort(),
    `didit_workflow_create offers a different feature set than the contract. ${REFRESH}`,
  );
});

test("didit_workflow_get_feature_config_schema answers from the shipped contract", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const all = await client.callTool({ name: "didit_workflow_get_feature_config_schema", arguments: {} });
  const allBody = JSON.parse(all.content[0].text);
  assert.equal(allBody.checksum, FEATURE_CONFIG_CHECKSUM);
  assert.deepEqual(Object.keys(allBody.features).sort(), [...WORKFLOW_FEATURES].sort());

  const one = await client.callTool({
    name: "didit_workflow_get_feature_config_schema",
    arguments: { feature: "DATABASE_VALIDATION" },
  });
  const oneBody = JSON.parse(one.content[0].text);
  assert.deepEqual(Object.keys(oneBody.features), ["DATABASE_VALIDATION"]);
  const fields = oneBody.features.DATABASE_VALIDATION.fields;
  assert.ok(fields.database_validation_countries.shape.includes("services"));
  assert.ok(fields.database_validation_countries.description.length > 0);
  // The tool must work without any API call - it is what an agent reaches for
  // before an application even exists.
  assert.equal(typeof globalThis.__diditFetchCalled, "undefined");
});

test("an unknown feature is rejected with the list of real ones", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const res = await client.callTool({
    name: "didit_workflow_get_feature_config_schema",
    arguments: { feature: "DATABASE_VALIDATIONS" },
  });
  const text = res.content[0].text;
  assert.match(text, /Unknown feature/);
  assert.match(text, /DATABASE_VALIDATION/);
});

test("the README's config reference is the generated one", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const begin = "<!-- BEGIN GENERATED FEATURE CONFIG REFERENCE -->";
  const end = "<!-- END GENERATED FEATURE CONFIG REFERENCE -->";
  const from = readme.indexOf(begin);
  const to = readme.indexOf(end);
  assert.ok(from !== -1 && to !== -1, "README.md is missing the generated feature-config reference block.");
  assert.equal(
    readme.slice(from, to + end.length),
    renderMarkdownReference(),
    "README.md's feature-config reference is stale. Run `npm run schema:readme` and commit it.",
  );
});

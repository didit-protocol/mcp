// The KYB registry catalog tool (DID-1571 / DID-2389 / DID-2565).
//
// `kyb_registry_countries_config` is validated by the backend against the public
// pricing catalog: a tier the country's registries do not offer is rejected on
// save, and monitoring only applies where the registry provider sells a watch.
// An agent can only get that right if the catalog is one tool call away - and
// small enough to read: the summary must stay compact, the per-country table
// only travels on request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FEATURE_CONFIG_SCHEMA } from "../dist/feature-config-schema.js";
import { getKybRegistryCatalog, KYB_REGISTRY_MANUAL_ENTRY_PRICE_USD } from "../dist/tools/workflow-graph.js";

const TOOL = "didit_workflow_get_kyb_registry_catalog";

const country = (basic, shareholders, ubo, monitoring, name) => ({
  name,
  validated: true,
  tiers: {
    basic: { available: basic, price_usd: "2.00" },
    shareholders: { available: shareholders, price_usd: "4.00" },
    ubo: { available: ubo, price_usd: "5.00" },
  },
  monitoring: { available: monitoring, price_usd: "2.00" },
});

const CATALOG = {
  ES: country(true, true, true, true, "Spain"),
  DE: country(true, true, true, false, "Germany"),
  CU: country(true, false, false, false, "Cuba"),
  NG: country(false, false, false, false, "Nigeria"),
};

function withFetch(body, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

async function listAdvertisedTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "catalog-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return tools;
}

test("the KYB registry catalog tool is advertised, unscoped, narrowed by ISO-2 countries", async () => {
  const tools = await listAdvertisedTools();
  const tool = tools.find((t) => t.name === TOOL);
  assert.ok(tool, `${TOOL} must be advertised`);
  assert.equal(tool.inputSchema.required, undefined, "the pricing endpoint is public: no workflow_id, no org/app");
  assert.equal(tool.inputSchema.properties.countries.type, "array");
  for (const word of ["ISO-2", "basic", "shareholders", "ubo", "monitoring", "kyb_registry_countries_config", "by hand"]) {
    assert.ok(tool.description.includes(word), `description must explain "${word}"`);
  }
});

test("without countries it answers a compact summary with the exception lists", async () => {
  await withFetch(CATALOG, async (calls) => {
    const result = await getKybRegistryCatalog();
    assert.match(calls[0], /\/organization\/kyb-registry-pricing\/$/);
    assert.equal(result.countries_total, 4);
    assert.deepEqual(result.no_registry, ["NG"]);
    assert.deepEqual(result.lite_only, ["CU"]);
    assert.equal(result.tiers.basic.name, "Lite");
    assert.equal(result.tiers.ubo.available_in, 2);
    assert.deepEqual(result.tiers.shareholders.price_usd, ["4.00"]);
    assert.equal(result.monitoring.available_in, 1);
    assert.deepEqual(result.monitoring.price_usd_per_company_per_year, ["2.00"]);
    assert.equal(result.manual_entry_price_usd, KYB_REGISTRY_MANUAL_ENTRY_PRICE_USD);
    assert.equal(result.countries, undefined, "the per-country table only travels on request");
  });
});

test("prices are listed as amounts, not as text, and monitoring reads unavailable when nobody sells it", async () => {
  const banded = {
    ...CATALOG,
    US: { ...country(true, true, true, false, "United States"), tiers: { ...CATALOG.ES.tiers, ubo: { available: true, price_usd: "10.00" } } },
  };
  for (const row of Object.values(banded)) row.monitoring = { available: false, price_usd: "2.00" };
  await withFetch(banded, async () => {
    const result = await getKybRegistryCatalog();
    assert.deepEqual(result.tiers.ubo.price_usd, ["5.00", "10.00"]);
    assert.equal(result.monitoring.available_in, 0);
    assert.deepEqual(result.monitoring.price_usd_per_company_per_year, []);
  });
});

test("with countries it returns the exact rows, normalised like the backend, and names the unknown codes", async () => {
  await withFetch(CATALOG, async () => {
    const result = await getKybRegistryCatalog([" es", "NG", "ESP", "es_md", "DE-BE"]);
    assert.deepEqual(Object.keys(result.countries), ["ES", "NG", "DE"]);
    assert.equal(result.countries.ES.tiers.ubo.available, true);
    assert.equal(result.countries.NG.tiers.basic.available, false);
    assert.deepEqual(result.unknown_countries, ["ESP"]);
    assert.match(result.unknown_hint, /alpha-2/);
    assert.equal(result.tier_names.ubo, "UBOs");
    assert.equal(result.filtered, true);
  });
});

test("a single code sent as a bare string is one country, not the summary and not a crash", async () => {
  await withFetch(CATALOG, async () => {
    const result = await getKybRegistryCatalog("de");
    assert.deepEqual(Object.keys(result.countries), ["DE"]);
    const summary = await getKybRegistryCatalog(42);
    assert.equal(summary.countries_total, 4, "a non-string, non-array filter is ignored");
  });
});

test("a body that is not the catalog is an error, never an empty catalog", async () => {
  await withFetch({ raw: "<html>maintenance</html>" }, async () => {
    await assert.rejects(getKybRegistryCatalog(), /could not be read/);
  });
});

test("the manual-entry fee the tool quotes is the one the contract prints", () => {
  const description = FEATURE_CONFIG_SCHEMA.features.KYB_REGISTRY.fields.kyb_registry_countries_config.description;
  assert.match(description, new RegExp(`USD ${KYB_REGISTRY_MANUAL_ENTRY_PRICE_USD.replace(".", "\\.")} per company`));
});

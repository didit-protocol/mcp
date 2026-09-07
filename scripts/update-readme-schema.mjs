#!/usr/bin/env node
// Rewrite the generated feature-config reference block in README.md.
//
//   npm run schema:readme          # write it
//   npm run schema:readme -- --check   # fail if stale
//
// The README's per-feature config tables are rendered from
// schema/feature-config-schema.json, so the docs and the tool schemas cannot
// disagree: both come from the same artifact, and
// test/feature-config-contract.test.mjs fails when this block goes stale.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMarkdownReference } from "../dist/feature-config-schema.js";

const BEGIN = "<!-- BEGIN GENERATED FEATURE CONFIG REFERENCE -->";
const END = "<!-- END GENERATED FEATURE CONFIG REFERENCE -->";

const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
const readme = readFileSync(readmePath, "utf8");
const generated = renderMarkdownReference();

const from = readme.indexOf(BEGIN);
const to = readme.indexOf(END);
if (from === -1 || to === -1) {
  console.error(
    `README.md has no generated block. Add these two markers where the reference belongs:\n  ${BEGIN}\n  ${END}`,
  );
  process.exit(2);
}

const next = readme.slice(0, from) + generated + readme.slice(to + END.length);

if (process.argv.includes("--check")) {
  if (next === readme) {
    console.log("README feature-config reference is up to date.");
    process.exit(0);
  }
  console.error("README.md's feature-config reference is stale. Run `npm run schema:readme` and commit it.");
  process.exit(1);
}

writeFileSync(readmePath, next);
console.log("README feature-config reference regenerated.");

#!/usr/bin/env node
// Compare two feature-config contracts and describe the difference.
//
//   node scripts/compare-feature-config.mjs <shipped.json> <reference.json> [--label "development"]
//
// Exit 0 when the two agree, 1 when they drift, 2 when a file is unreadable.
// Prints a markdown summary on drift - per feature, which keys the reference has
// that we do not and vice versa - so the nightly drift issue says what changed
// instead of just that something did.
//
// This lives in a script rather than inline in the workflow so it can be run by
// hand against a downloaded artifact, and so the comparison is the same code in
// both legs of the check.

import { readFileSync } from "node:fs";

function load(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`Could not read a contract from ${path}: ${error.message}`);
    process.exit(2);
  }
}

const [shippedPath, referencePath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const labelIndex = process.argv.indexOf("--label");
const label = labelIndex === -1 ? "reference" : process.argv[labelIndex + 1];

if (!shippedPath || !referencePath) {
  console.error("usage: compare-feature-config.mjs <shipped.json> <reference.json> [--label NAME]");
  process.exit(2);
}

const shipped = load(shippedPath);
const reference = load(referencePath);

if (shipped.checksum === reference.checksum) {
  console.log(`Contracts agree (${shipped.checksum}).`);
  process.exit(0);
}

const lines = [
  `### Feature-config drift vs \`${label}\``,
  "",
  `- MCP ships \`${shipped.checksum}\``,
  `- ${label} is on \`${reference.checksum}\``,
  "",
];

const features = [...new Set([...Object.keys(shipped.features ?? {}), ...Object.keys(reference.features ?? {})])].sort();
let described = 0;
for (const feature of features) {
  const ours = new Set(Object.keys(shipped.features?.[feature]?.fields ?? {}));
  const theirs = new Set(Object.keys(reference.features?.[feature]?.fields ?? {}));
  const added = [...theirs].filter((k) => !ours.has(k)).sort();
  const removed = [...ours].filter((k) => !theirs.has(k)).sort();
  if (!added.length && !removed.length) continue;
  described += 1;
  lines.push(
    `- **${feature}** — ${label} added: ${added.length ? added.map((k) => `\`${k}\``).join(", ") : "none"}; ` +
      `${label} removed: ${removed.length ? removed.map((k) => `\`${k}\``).join(", ") : "none"}`,
  );
}

if (described === 0) {
  // Same keys, different contents: a shape, an enum or a description changed.
  // Still drift - the tool schemas are advertising the old meaning.
  lines.push("- No key was added or removed; a type, enum, shape or description changed.");
}

console.log(lines.join("\n"));
process.exit(1);

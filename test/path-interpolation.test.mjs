import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

// Guard source path templates as well as runtime examples. New interpolations must
// pass through the existing encoder, including IDs read back from an API response.
test("relative URL templates encode identifiers before interpolation", () => {
  const files = sourceFiles(root);
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2020 });
  const checker = program.getTypeChecker();
  const failures = [];

  function enclosingFunction(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent)) return parent.name?.text;
    }
  }

  function safe(expression, file, seen = new Set()) {
    if (ts.isCallExpression(expression)) {
      const name = expression.expression.getText(file);
      if (name === "pathSegment") return true;
      // Existing one-line encoders must still delegate to pathSegment.
      if (["sid", "cid", "ruleUuid"].includes(name)) {
        const declaration = checker.getSymbolAtLocation(expression.expression)?.valueDeclaration;
        return declaration && ts.isVariableDeclaration(declaration) &&
          ts.isArrowFunction(declaration.initializer) &&
          ts.isCallExpression(declaration.initializer.body) &&
          declaration.initializer.body.expression.getText(file) === "pathSegment";
      }
      return false;
    }
    if (ts.isTemplateExpression(expression)) return expression.templateSpans.every((span) => safe(span.expression, file, new Set(seen)));
    if (!ts.isIdentifier(expression)) return false;
    const name = expression.text;
    const path = relative(root, file.fileName);
    // These parameters compose already-built resource paths, not identifier slots.
    if (name === "resource" && (
      (path === "config.ts" && ["orgAppPath", "orgPath"].includes(enclosingFunction(expression))) ||
      (path === "tools/members.ts" && enclosingFunction(expression) === "authPath")
    )) return true;
    // Network sections and subject resources are fixed runtime-allowlisted values.
    if (path === "tools/networks.ts" && (
      (name === "section" && enclosingFunction(expression) === "getNetwork") ||
      (name === "resource" && enclosingFunction(expression) === "getNetworkMembership")
    )) return true;
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer || seen.has(declaration)) return false;
    if (!(declaration.parent.flags & ts.NodeFlags.Const)) return false;
    seen.add(declaration);
    return safe(declaration.initializer, file, seen);
  }

  for (const fileName of files) {
    const file = program.getSourceFile(fileName);
    function visit(node) {
      if (ts.isTemplateExpression(node) && (
        node.head.text.startsWith("/") ||
        (ts.isCallExpression(node.parent) && ["apiRequest", "orgAppPath", "orgPath"].includes(node.parent.expression.getText(file)) && node.parent.arguments[0] === node)
      )) {
        for (const span of node.templateSpans) {
          if (!safe(span.expression, file)) {
            const { line } = file.getLineAndCharacterOfPosition(span.expression.getStart(file));
            failures.push(`${relative(dirname(root), fileName)}:${line + 1}: ${span.expression.getText(file)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  assert.deepEqual(failures, [], "URL identifiers must use pathSegment (or a checked encoder alias)");
});

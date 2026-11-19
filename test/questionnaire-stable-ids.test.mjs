import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUESTIONNAIRE_TOOLS,
  buildQuestionnaireGraph,
  createQuestionnaire,
  getQuestionnaire,
  updateQuestionnaire,
} from "../dist/tools/questionnaires.js";
import { requestContext } from "../dist/config.js";
import { DiditError } from "../dist/security.js";

// the create/update tools accepted `required_if`, `branches` and a per-question
// `id`, answered success, and the customer found none of them stored. Two different causes,
// both measured on the real backend (sandbox application, 2026-11-19):
//  - the graph builder derived positional node keys (q1, q2, …), so a supplied id was lost;
//  - the console resource KEEPS a well-formed `required_if` ({rules:[{field,operator,value}]}),
//    `branches` ([{id, rules, goto}]) and `repeatable_config`, but an UPDATE carrying a
//    malformed `required_if` (no `rules`) stores `{}` and answers success.
// So a supplied id is the stable question key, a well-formed conditional field is posted as
// sent, and a malformed one is refused before any request with the shape that is stored. A
// blanket refusal would have taken away branching, conditional questions and REPEATABLE_GROUP
// (which cannot be created without `repeatable_config`), all of which work.

const CTX = { accessToken: "t-1", organizationId: "org-1", applicationId: "app-1" };

function tool(name) {
  const found = QUESTIONNAIRE_TOOLS.find((entry) => entry.def.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
}

function interceptFetch(t, respond) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), body: JSON.parse(init.body ?? "{}") });
    return Response.json(respond ? respond(calls.at(-1).body) : { questionnaire_id: "q-1" }, { status: 201 });
  });
  return calls;
}

async function refused(t, name, args, field, hint) {
  const calls = interceptFetch(t);
  await assert.rejects(requestContext.run(CTX, () => tool(name).run(args)), (error) => {
    assert.ok(error instanceof DiditError);
    assert.equal(error.shape.code, "bad_request");
    assert.equal(error.shape.field, field);
    assert.match(error.shape.hint, /Nothing was written/);
    assert.match(error.shape.hint, hint);
    return true;
  });
  assert.equal(calls.length, 0, "nothing is written when the field is refused");
}

const CUIT = { element_type: "SHORT_TEXT", id: "acme-ar-cuit", title: "CUIT (Argentina)" };
const CPF = { element_type: "SHORT_TEXT", id: "acme-br-cpf", title: "CPF (Brazil)" };

test("a supplied question id is the graph node key, so the stored answer keeps it", () => {
  const graph = buildQuestionnaireGraph([CUIT, CPF], ["en"]);

  assert.equal(graph.start_node, "acme-ar-cuit");
  assert.deepEqual(Object.keys(graph.nodes), ["acme-ar-cuit", "acme-br-cpf"]);
  assert.equal(graph.nodes["acme-ar-cuit"].next, "acme-br-cpf");
  assert.equal(graph.nodes["acme-br-cpf"].next, null);
  // The id is the key, not a second copy of it inside the node.
  assert.equal(graph.nodes["acme-ar-cuit"].id, undefined);
});

test("create posts the supplied ids as node keys, hyphens intact", async (t) => {
  const calls = interceptFetch(t);
  await requestContext.run(CTX, () =>
    createQuestionnaire({ title: "Acme onboarding", form_elements: [CUIT, CPF], status: "draft" }),
  );

  assert.deepEqual(Object.keys(calls[0].body.graph.nodes), ["acme-ar-cuit", "acme-br-cpf"]);
});

const TYPE = {
  element_type: "SINGLE_CHOICE",
  id: "tipo_cliente",
  title: "Customer type",
  choices: [{ value: "persona" }, { value: "empresa" }],
};
const WHEN_COMPANY = { rules: [{ field: "tipo_cliente", operator: "equals", value: "empresa" }] };

// The exact shapes the customer's agent sent in production: no `rules`, so the update stored {}.
for (const [label, required_if] of [
  ["{field, operator, value}", { field: "country", operator: "equals", value: "AR" }],
  ["{node, question, equals}", { node: "q1", question: "Country", equals: "AR" }],
  ["a rule without a field", { rules: [{ operator: "equals", value: "AR" }] }],
]) {
  for (const name of ["didit_questionnaire_create", "didit_questionnaire_update"]) {
    test(`${name} refuses a required_if written as ${label} instead of saving an empty object`, async (t) => {
      const args = {
        ...(name.endsWith("update") ? { questionnaire_id: "q-1" } : { title: "Acme onboarding" }),
        form_elements: [TYPE, { ...CUIT, required_if }],
      };
      await refused(t, name, args, "form_elements[1].required_if", /required_if as \{ rules: \[\{ field/);
    });
  }
}

test("a well-formed required_if is posted as sent, on create and on update", async (t) => {
  const calls = interceptFetch(t);
  const form_elements = [TYPE, { ...CUIT, required_if: WHEN_COMPANY }];
  await requestContext.run(CTX, () => tool("didit_questionnaire_create").run({ title: "Acme onboarding", form_elements }));
  await requestContext.run(CTX, () => tool("didit_questionnaire_update").run({ questionnaire_id: "q-1", form_elements }));

  for (const call of calls) assert.deepEqual(call.body.graph.nodes["acme-ar-cuit"].required_if, WHEN_COMPANY);
  assert.equal(calls.length, 2);
});

test("well-formed branches are posted as sent and can jump to a question by its stable id", async (t) => {
  const calls = interceptFetch(t);
  const branches = [{ id: "company", rules: WHEN_COMPANY.rules, goto: "acme-br-cpf" }];
  await requestContext.run(CTX, () =>
    tool("didit_questionnaire_create").run({ title: "Acme onboarding", form_elements: [{ ...TYPE, branches }, CUIT, CPF] }),
  );

  const nodes = calls[0].body.graph.nodes;
  assert.deepEqual(nodes.tipo_cliente.branches, branches);
  assert.equal(nodes.tipo_cliente.next, "acme-ar-cuit", "the order still decides the default next question");
});

for (const [label, branches, field] of [
  ["a free-text condition", [{ when: "country=AR" }], "form_elements[0].branches[0]"],
  ["no rules", [{ id: "b1", goto: "acme-ar-cuit" }], "form_elements[0].branches[0]"],
  ["no goto", [{ id: "b1", rules: WHEN_COMPANY.rules }], "form_elements[0].branches[0]"],
  ["a rule without a field", [{ id: "b1", rules: [{ operator: "equals", value: "x" }], goto: "acme-ar-cuit" }], "form_elements[0].branches[0]"],
  ["an object instead of a list", { id: "b1" }, "form_elements[0].branches"],
]) {
  for (const name of ["didit_questionnaire_create", "didit_questionnaire_update"]) {
    test(`${name} refuses branches written with ${label}`, async (t) => {
      const args = {
        ...(name.endsWith("update") ? { questionnaire_id: "q-1" } : { title: "Acme onboarding" }),
        form_elements: [{ ...TYPE, branches }, CUIT],
      };
      await refused(t, name, args, field, /branches as \[\{ id/);
    });
  }
}

test("an otherwise path (no rules) that ends the questionnaire (goto null) is posted as sent", async (t) => {
  const calls = interceptFetch(t);
  const branches = [
    { id: "company", rules: WHEN_COMPANY.rules, goto: "acme-br-cpf" },
    { id: "otherwise", rules: [], goto: null },
  ];
  await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-1", form_elements: [{ ...TYPE, branches }, CUIT, CPF] }),
  );

  assert.deepEqual(calls[0].body.graph.nodes.tipo_cliente.branches, branches);
});

test("required_if null (clear the condition) and an empty rules list are posted as sent", async (t) => {
  const calls = interceptFetch(t);
  await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({
      questionnaire_id: "q-1",
      form_elements: [TYPE, { ...CUIT, required_if: null }, { ...CPF, required_if: { rules: [] } }],
    }),
  );

  assert.equal(calls[0].body.graph.nodes["acme-ar-cuit"].required_if, null);
  assert.deepEqual(calls[0].body.graph.nodes["acme-br-cpf"].required_if, { rules: [] });
});

test("questions whose ids look like locale codes are all read back, each with its own title", async (t) => {
  // `ar` and `br` as question ids made the map of questions look like a translation map.
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      questionnaire_id: "q-1",
      title: { en: "Tax ids", es: "Identificadores" },
      graph: {
        start_node: "ar",
        nodes: {
          ar: { element_type: "SHORT_TEXT", title: { en: "CUIT", es: "CUIT (es)" }, next: "br" },
          br: { element_type: "SHORT_TEXT", title: { en: "CPF", es: "CPF (es)" }, next: null },
        },
      },
    }),
  );
  const result = await requestContext.run(CTX, () => getQuestionnaire("q-1"));

  assert.deepEqual(Object.keys(result.graph.nodes), ["ar", "br"]);
  assert.deepEqual(result.graph.nodes.br.title, { en: "CPF" });
  assert.deepEqual(result.title, { en: "Tax ids" });
  assert.equal(result.graph.start_node, "ar");
});

test("a REPEATABLE_GROUP keeps its repeatable_config: the backend refuses the group without it", async (t) => {
  const calls = interceptFetch(t);
  const repeatable_config = { min_items: 1, max_items: 3, fields: [{ element_type: "SHORT_TEXT", title: { en: "Name" } }] };
  await requestContext.run(CTX, () =>
    tool("didit_questionnaire_create").run({
      title: "Owners",
      form_elements: [{ element_type: "REPEATABLE_GROUP", id: "owners", title: "Owners", repeatable_config }],
    }),
  );

  assert.deepEqual(calls[0].body.graph.nodes.owners.repeatable_config, repeatable_config);
});

test("a supplied next is refused: the order of the questions decides it", async (t) => {
  await refused(
    t,
    "didit_questionnaire_create",
    { title: "Acme onboarding", form_elements: [{ ...CUIT, next: "acme-br-cpf" }, CPF] },
    "form_elements[0].next",
    /branches/,
  );
});

test("a conditional field the backend answers without is reported, never passed off as saved", async (t) => {
  // What production did on update before the shape was checked: success, with required_if: {}.
  interceptFetch(t, (body) => ({
    questionnaire_id: "q-1",
    graph: { ...body.graph, nodes: Object.fromEntries(Object.entries(body.graph.nodes).map(([key, node]) => [key, { ...node, required_if: {} }])) },
  }));
  const result = await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-1", form_elements: [TYPE, { ...CUIT, required_if: WHEN_COMPANY }] }),
  );

  assert.match(result.warning, /NOT stored: acme-ar-cuit\.required_if/);
});

test("a write stored as sent carries no warning", async (t) => {
  interceptFetch(t, (body) => ({ questionnaire_id: "q-1", graph: body.graph }));
  const result = await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-1", form_elements: [TYPE, { ...CUIT, required_if: WHEN_COMPANY }] }),
  );

  assert.equal(result.warning, undefined);
});

test("the advertised form_elements schema states the shapes that are stored", () => {
  const description = tool("didit_questionnaire_create").def.inputSchema.properties.form_elements.description;

  assert.match(description, /required_if: \{rules:/);
  assert.match(description, /branches: \[\{id,rules/);
  assert.doesNotMatch(description, /Advanced Mode/);
});

test("the advertised form_elements schema documents the stable question id", () => {
  const element = tool("didit_questionnaire_create").def.inputSchema.properties.form_elements.items;

  assert.equal(element.properties.id?.type, "string");
  assert.match(element.properties.id.description, /stable/i);
});

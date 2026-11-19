import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONNAIRE_TOOLS, updateQuestionnaire } from "../dist/tools/questionnaires.js";
import { requestContext } from "../dist/config.js";
import { DiditError } from "../dist/security.js";

// an internal issue, the three gaps the review of #312 left open:
//  1. didit_questionnaire_get returns every stored question with its `next`, and the write tools
//     refused any element carrying `next` at all — a read could not be sent back, even unchanged,
//     although the value was exactly the one the order implies.
//  2. an update replaces the whole question list, so a question sent without its `id` comes back
//     under a positional q1/q2 key: the stored answer key, and the `required_if` rules and the
//     `branches[].goto` jumps that named it, then refer to nothing.
//  3. the write tools posted a `goto` or a rule `field` naming an id that is not in the request
//     without checking it first.
// Measured on the console resource (sandbox application 18d95cf2…/c256dafa…, 2026-11-19):
//  - it stores exactly the `next` the order implies, so accepting a matching one changes nothing;
//  - it refuses a dangling reference itself — "Node 'q1', branch at index 0: 'goto' references
//    non-existent node 'acme-br-rfc'" and "'field' references non-existent node" for a rule — on
//    create and on update, so a rule may only name a question of the same questionnaire;
//  - an update that sends no ids at all and has no rule or jump naming them is answered 200 and
//    the questions come back as q1, q2, q3: the silent rename.
// The tests below fix the contract: a matching `next` is accepted, a disagreeing one is refused
// naming the implied id, and a reference to an id outside the request is refused here with the
// element, the field and the ids the request does have, instead of failing at the backend. For the
// rename, the guard walks the stored order from `start_node` and refuses when a stored key this
// update would not write is not exactly q<place+1> at its place: `q99` first and `q3` second are
// not positional, and a node the walk does not reach has no place. An update that sends an id on
// every question goes through without a stored read.

const CTX = { accessToken: "t-1", organizationId: "org-1", applicationId: "app-1" };

function tool(name) {
  const found = QUESTIONNAIRE_TOOLS.find((entry) => entry.def.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
}

function interceptFetch(t, respond) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const request = { url: new URL(String(url)), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(request);
    return Response.json(respond ? respond(request) : { questionnaire_id: "q-1" }, { status: init.method === "PATCH" ? 200 : 201 });
  });
  return calls;
}

// What didit_questionnaire_get answers for a questionnaire whose questions carry their own ids,
// a required_if and a branch: every node with its `next`, in `start_node` order.
const STORED = {
  questionnaire_id: "q-1",
  title: { en: "Acme KYB" },
  languages: ["en"],
  default_language: "en",
  graph: {
    start_node: "tipo_cliente",
    nodes: {
      tipo_cliente: {
        element_type: "SINGLE_CHOICE",
        title: { en: "Customer type" },
        is_required: true,
        choices: [
          { value: "persona", label: { en: "persona" } },
          { value: "empresa", label: { en: "empresa" } },
        ],
        branches: [{ id: "company", rules: [{ field: "tipo_cliente", operator: "equals", value: "empresa" }], goto: "acme-br-cpf" }],
        next: "acme-ar-cuit",
      },
      "acme-ar-cuit": {
        element_type: "SHORT_TEXT",
        title: { en: "CUIT (Argentina)" },
        is_required: true,
        required_if: { rules: [{ field: "tipo_cliente", operator: "equals", value: "empresa" }] },
        next: "acme-br-cpf",
      },
      "acme-br-cpf": {
        element_type: "SHORT_TEXT",
        title: { en: "CPF (Brazil)" },
        is_required: false,
        next: null,
      },
    },
  },
};

/** The questions exactly as the read returns them: node key -> `id`, node -> the rest, in order. */
function asSentBack(result) {
  const { start_node, nodes } = result.graph;
  const order = [];
  for (let key = start_node; key; key = nodes[key].next) order.push(key);
  return order.map((key) => ({ id: key, ...nodes[key] }));
}

function readThenWrite(t) {
  return interceptFetch(t, (request) => (request.method === "PATCH" ? { ...STORED, graph: request.body.graph } : STORED));
}

test("a questionnaire read with didit_questionnaire_get is sent back with one title changed", async (t) => {
  const calls = readThenWrite(t);
  const read = await requestContext.run(CTX, () => tool("didit_questionnaire_get").run({ questionnaire_id: "q-1" }));
  const form_elements = asSentBack(read);
  form_elements[0].title = { en: "Customer kind" };

  const result = await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-1", form_elements }),
  );

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "one request carries the update");
  assert.equal(result.warning, undefined);
  assert.deepEqual(
    writes[0].body.graph,
    {
      ...STORED.graph,
      nodes: { ...STORED.graph.nodes, tipo_cliente: { ...STORED.graph.nodes.tipo_cliente, title: { en: "Customer kind" } } },
    },
    "the stored graph is written back unchanged apart from the one title",
  );
});

test("an update that sends no ids at all is refused when it would rename a stored id", async (t) => {
  const calls = interceptFetch(t, (request) => (request.method === "GET" ? STORED : { questionnaire_id: "q-1" }));
  await assert.rejects(
    requestContext.run(CTX, () =>
      updateQuestionnaire("q-1", { form_elements: [{ element_type: "SHORT_TEXT" }] }),
    ),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.code, "bad_request");
      assert.equal(error.shape.field, "form_elements");
      const said = `${error.shape.message} ${error.shape.hint}`;
      assert.match(said, /tipo_cliente/);
      assert.match(said, /acme-ar-cuit/);
      assert.match(said, /didit_questionnaire_get/);
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the stored ids are read");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "nothing is written");
});

test("an update that sends no ids passes when the stored ids are the positional ones", async (t) => {
  const calls = interceptFetch(t, (request) =>
    request.method === "GET"
      ? { questionnaire_id: "q-1", graph: { start_node: "q1", nodes: { q1: { element_type: "SHORT_TEXT", next: null } } } }
      : { questionnaire_id: "q-1" },
  );
  await requestContext.run(CTX, () =>
    updateQuestionnaire("q-1", { form_elements: [{ element_type: "SHORT_TEXT" }] }),
  );
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

/** A stored questionnaire whose questions have exactly these node ids, in this order. */
function storedWith(ids) {
  return {
    questionnaire_id: "q-1",
    graph: {
      start_node: ids[0],
      nodes: Object.fromEntries(ids.map((id, index) => [id, { element_type: "SHORT_TEXT", next: ids[index + 1] ?? null }])),
    },
  };
}

const IDLESS = { element_type: "SHORT_TEXT" };

// The rename guard asks one question: would this update stop writing a stored key, and is that key
// positional at its place in the stored order (exactly q<index+1>)? Looking positional is not
// enough: q99 first and q3 second are refused. An update that carries ids on some questions and
// none on others is checked too, while every question sending its id keeps no stored key and so
// needs no read.
test("an update with ids on some questions is refused when the questions without ids would lose a stored id", async (t) => {
  const calls = interceptFetch(t, (request) => (request.method === "GET" ? storedWith(["income", "employer", "notes"]) : { questionnaire_id: "q-1" }));
  await assert.rejects(
    requestContext.run(CTX, () =>
      updateQuestionnaire("q-1", {
        form_elements: [{ id: "income", ...IDLESS }, IDLESS, IDLESS],
      }),
    ),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.code, "bad_request");
      assert.equal(error.shape.field, "form_elements");
      const said = `${error.shape.message} ${error.shape.hint}`;
      assert.match(said, /"employer"/, "the stored id that would be lost is named");
      assert.match(said, /"notes"/);
      assert.doesNotMatch(said, /"income"/, "the id this update does send is not reported as lost");
      assert.match(said, /Nothing was written/);
      assert.match(said, /Send the stored questions again with their ids/, "one way out: send the stored ids again");
      assert.match(said, /give it an id of its own/, "the other way out: give the new question its own id");
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the stored ids are read once");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "nothing is written");
});

test("removing questions from a questionnaire whose stored ids are positional is allowed", async (t) => {
  const calls = interceptFetch(t, (request) => (request.method === "GET" ? storedWith(["q1", "q2", "q3"]) : { questionnaire_id: "q-1" }));
  await requestContext.run(CTX, () => updateQuestionnaire("q-1", { form_elements: [IDLESS] }));

  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the stored ids are read");
  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "the deletion is written");
  assert.deepEqual(Object.keys(writes[0].body.graph.nodes), ["q1"], "one positional question is kept");
});

// The rename rule is defined on the stored order (start_node, then each next) and on position: a
// stored key is positional only when it is exactly q<index+1> at that place. A key that merely
// looks positional — q99 first, q3 second — is not, and neither is a node the walk does not reach.
test("a key q99 in first place is not positional: an id-less update is refused and names it", async (t) => {
  const calls = interceptFetch(t, (request) => (request.method === "GET" ? storedWith(["q99"]) : { questionnaire_id: "q-1" }));
  await assert.rejects(
    requestContext.run(CTX, () => updateQuestionnaire("q-1", { form_elements: [IDLESS] })),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.code, "bad_request");
      assert.equal(error.shape.field, "form_elements");
      const said = `${error.shape.message} ${error.shape.hint}`;
      assert.match(said, /"q99"/, "the stored key that would be renamed is named");
      assert.match(said, /Nothing was written/);
      assert.match(said, /give it an id of its own/, "the way out for a new question");
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the stored order is read once");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "nothing is written");
});

test("a key q3 in second place is not positional: an id-less update is refused and names q3", async (t) => {
  const calls = interceptFetch(t, (request) => (request.method === "GET" ? storedWith(["q1", "q3"]) : { questionnaire_id: "q-1" }));
  await assert.rejects(
    requestContext.run(CTX, () => updateQuestionnaire("q-1", { form_elements: [IDLESS, IDLESS] })),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.code, "bad_request");
      const said = `${error.shape.message} ${error.shape.hint}`;
      assert.match(said, /"q3"/, "q3 would become q2 and is named");
      assert.doesNotMatch(said, /"q1"/, "the positional q1 this update does produce is not reported");
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the stored order is read once");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "nothing is written");
});

test("removing the positional tail after a kept id is allowed", async (t) => {
  const calls = interceptFetch(t, (request) => (request.method === "GET" ? storedWith(["q1", "q2", "q3"]) : { questionnaire_id: "q-1" }));
  await requestContext.run(CTX, () =>
    updateQuestionnaire("q-1", { form_elements: [{ id: "q1", ...IDLESS }, IDLESS] }),
  );

  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the stored order is read once");
  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "q3 was positional at its place, so its removal is allowed");
  assert.deepEqual(Object.keys(writes[0].body.graph.nodes), ["q1", "q2"]);
});

test("a stored custom key between positional ones is not positional: refused and named", async (t) => {
  const calls = interceptFetch(t, (request) => (request.method === "GET" ? storedWith(["q1", "income", "q3"]) : { questionnaire_id: "q-1" }));
  await assert.rejects(
    requestContext.run(CTX, () => updateQuestionnaire("q-1", { form_elements: [IDLESS, IDLESS, IDLESS] })),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.code, "bad_request");
      const said = `${error.shape.message} ${error.shape.hint}`;
      assert.match(said, /"income"/, "the custom key at position 2 is named");
      assert.doesNotMatch(said, /"q1"/);
      assert.doesNotMatch(said, /"q3"/, "q3 stays positional at its place");
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the stored order is read once");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "nothing is written");
});

test("a stored node the walk does not reach has no place: an id-less update is refused and names it", async (t) => {
  const calls = interceptFetch(t, (request) =>
    request.method === "GET"
      ? {
          questionnaire_id: "q-1",
          graph: {
            start_node: "q1",
            nodes: {
              q1: { element_type: "SHORT_TEXT", next: null },
              q2: { element_type: "SHORT_TEXT", next: null },
            },
          },
        }
      : { questionnaire_id: "q-1" },
  );
  await assert.rejects(
    requestContext.run(CTX, () => updateQuestionnaire("q-1", { form_elements: [IDLESS] })),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.code, "bad_request");
      const said = `${error.shape.message} ${error.shape.hint}`;
      assert.match(said, /"q2"/, "the unreachable stored key is named");
      assert.match(said, /Nothing was written/);
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the stored order is read once");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "nothing is written");
});

test("an update that sends the id of every question it keeps needs no read", async (t) => {
  const calls = interceptFetch(t, () => ({ questionnaire_id: "q-1" }));
  await requestContext.run(CTX, () =>
    updateQuestionnaire("q-1", { form_elements: [{ id: "income", ...IDLESS }] }),
  );

  assert.equal(calls.filter((call) => call.method === "GET").length, 0, "a deletion with every id given is not checked");
  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].body.graph.nodes), ["income"]);
});

test("a new question that carries its own id is added without a read", async (t) => {
  const calls = interceptFetch(t, () => ({ questionnaire_id: "q-1" }));
  await requestContext.run(CTX, () =>
    updateQuestionnaire("q-1", { form_elements: [{ id: "income", ...IDLESS }, { id: "phone", ...IDLESS }] }),
  );

  assert.equal(calls.filter((call) => call.method === "GET").length, 0, "no stored read when every question carries its id");
  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].body.graph.nodes), ["income", "phone"]);
});

test("a next that disagrees with the order is refused, naming the id the order implies", async (t) => {
  const calls = interceptFetch(t);
  await assert.rejects(
    requestContext.run(CTX, () =>
      updateQuestionnaire("q-1", {
        form_elements: [
          { id: "tipo_cliente", element_type: "SINGLE_CHOICE", choices: [{ value: "persona" }], next: "acme-br-cpf" },
          { id: "acme-ar-cuit", element_type: "SHORT_TEXT" },
          { id: "acme-br-cpf", element_type: "SHORT_TEXT" },
        ],
      }),
    ),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.code, "bad_request");
      assert.equal(error.shape.field, "form_elements[0].next");
      assert.match(`${error.shape.message} ${error.shape.hint}`, /acme-ar-cuit/);
      return true;
    },
  );
  assert.equal(calls.length, 0, "nothing is written when `next` disagrees");
});

test("a next on the last question is refused as null, the value the order implies", async (t) => {
  const calls = interceptFetch(t);
  await assert.rejects(
    requestContext.run(CTX, () =>
      updateQuestionnaire("q-1", {
        form_elements: [
          { id: "tipo_cliente", element_type: "SHORT_TEXT" },
          { id: "acme-ar-cuit", element_type: "SHORT_TEXT", next: "tipo_cliente" },
        ],
      }),
    ),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.field, "form_elements[1].next");
      assert.match(`${error.shape.message} ${error.shape.hint}`, /null/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("a branch goto naming a question that is not in the request is refused before any request", async (t) => {
  const calls = interceptFetch(t);
  await assert.rejects(
    requestContext.run(CTX, () =>
      updateQuestionnaire("q-1", {
        form_elements: [
          { id: "tipo_cliente", element_type: "SINGLE_CHOICE", choices: [{ value: "persona" }], branches: [{ id: "company", rules: [], goto: "acme-br-rfc" }] },
          { id: "acme-ar-cuit", element_type: "SHORT_TEXT" },
        ],
      }),
    ),
    (error) => {
      assert.ok(error instanceof DiditError);
      assert.equal(error.shape.field, "form_elements[0].branches[0].goto");
      const said = `${error.shape.message} ${error.shape.hint}`;
      assert.match(said, /acme-br-rfc/, "the unknown id is named");
      assert.match(said, /tipo_cliente/, "the ids the request does have are listed");
      assert.match(said, /acme-ar-cuit/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

for (const [caseName, element, where] of [
  ["required_if", { id: "acme-ar-cuit", element_type: "SHORT_TEXT", required_if: { rules: [{ field: "acme-br-rfc", operator: "equals", value: "x" }] } }, "form_elements[1].required_if.rules[0].field"],
  ["branches", { id: "acme-ar-cuit", element_type: "SHORT_TEXT", branches: [{ id: "company", rules: [{ field: "acme-br-rfc", operator: "equals", value: "x" }], goto: null }] }, "form_elements[1].branches[0].rules[0].field"],
]) {
  test(`a ${caseName} rule naming a question that is not in the request is refused before any request`, async (t) => {
    const calls = interceptFetch(t);
    await assert.rejects(
      requestContext.run(CTX, () =>
        updateQuestionnaire("q-1", {
          form_elements: [{ id: "tipo_cliente", element_type: "SINGLE_CHOICE", choices: [{ value: "persona" }] }, element],
        }),
      ),
      (error) => {
        assert.ok(error instanceof DiditError);
        assert.equal(error.shape.field, where);
        const said = `${error.shape.message} ${error.shape.hint}`;
        assert.match(said, /acme-br-rfc/, "the unknown id is named");
        assert.match(said, /tipo_cliente/, "the ids the request does have are listed");
        return true;
      },
    );
    assert.equal(calls.length, 0, "nothing is written when a rule names an unknown question");
  });
}

test("goto null and an empty rules list still pass", async (t) => {
  const calls = interceptFetch(t);
  // No `next` here: this test guards the references (goto null, rules: []) on their own.
  const form_elements = asSentBack(STORED).map((element) => {
    const { next: _next, ...rest } = element;
    return element.id === "tipo_cliente" ? { ...rest, branches: [...rest.branches, { id: "otherwise", rules: [], goto: null }] } : rest;
  });
  await requestContext.run(CTX, () => tool("didit_questionnaire_update").run({ questionnaire_id: "q-1", form_elements }));

  const branches = calls.find((call) => call.method === "PATCH").body.graph.nodes.tipo_cliente.branches;
  assert.deepEqual(branches.at(-1), { id: "otherwise", rules: [], goto: null });
});

test("the update tool says a question's id must be sent again, or it becomes a positional key", () => {
  const update = tool("didit_questionnaire_update").def;
  const formElements = update.inputSchema.properties.form_elements;

  assert.match(update.description, /didit_questionnaire_get/, "points at the read that returns the ids");
  assert.match(formElements.description, /didit_questionnaire_get/);
  assert.match(formElements.description, /id/, "the list description warns about the ids");
  assert.match(formElements.items.properties.id.description, /q1|positional/);
  assert.match(formElements.items.properties.id.description, /update/i);
});

// The rename guard's read must never decide whether a permitted update happens. A custom role can
// hold write:questionnaires without read:questionnaires, and the update tool declares only the
// write. When the guard needs the stored ids and the read is refused (403) or fails (5xx), the
// PATCH is not sent unchecked: the update is refused with its own reason and the way out that
// needs no read at all. An update that sends an id on every question still makes no read, so a
// write-only connection can always update by sending ids.
function interceptReadFailure(t, status) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const request = { url: new URL(String(url)), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(request);
    if (request.method === "GET") {
      return Response.json({ detail: "upstream refusal text that must not reach the caller" }, { status });
    }
    return Response.json({ questionnaire_id: "q-1" }, { status: 200 });
  });
  return calls;
}

function assertUnreadableRefusal(error, reason) {
  assert.ok(error instanceof DiditError);
  assert.equal(error.shape.code, "bad_request");
  assert.equal(error.shape.field, "form_elements");
  const said = `${error.shape.message} ${error.shape.hint}`;
  assert.match(said, /Nothing was written/);
  assert.match(said, /without an id/, "the cause: a question of the update has no id");
  assert.match(said, /the stored ids/, "the cause: the stored ids had to be read");
  assert.match(said, new RegExp(reason), `the reason is named: ${reason}`);
  assert.match(said, /q1, q2/, "the way out that needs no read is named");
  assert.doesNotMatch(said, /upstream refusal text/, "the upstream body is not echoed");
  return true;
}

test("a stored read refused for lack of permission refuses an id-less update instead of writing it unchecked", async (t) => {
  const calls = interceptReadFailure(t, 403);
  await assert.rejects(
    requestContext.run(CTX, () =>
      updateQuestionnaire("q-1", { form_elements: [{ id: "income", ...IDLESS }, IDLESS] }),
    ),
    (error) => assertUnreadableRefusal(error, "no read permission"),
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 1, "the guard tried the read");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "nothing is written");
});

test("a write-only connection updates by sending every id, with no read at all", async (t) => {
  const calls = interceptReadFailure(t, 403);
  await requestContext.run(CTX, () =>
    updateQuestionnaire("q-1", { form_elements: [{ id: "income", ...IDLESS }, { id: "phone", ...IDLESS }] }),
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 0, "no stored read when every question carries its id");
  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "the allowed update is written");
  assert.deepEqual(Object.keys(writes[0].body.graph.nodes), ["income", "phone"]);
});

test("a stored read that fails refuses an id-less update instead of writing it unchecked", async (t) => {
  const calls = interceptReadFailure(t, 500);
  await assert.rejects(
    requestContext.run(CTX, () => updateQuestionnaire("q-1", { form_elements: [IDLESS] })),
    (error) => assertUnreadableRefusal(error, "the read failed"),
  );
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "nothing is written");
});

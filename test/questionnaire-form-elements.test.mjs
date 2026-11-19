import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONNAIRE_TOOLS, getQuestionnaire, updateQuestionnaire } from "../dist/tools/questionnaires.js";
import { requestContext } from "../dist/config.js";

// an internal issue, measured on production on 19 Nov 2026 (a test Owner account's own sandbox
// application, a three-question draft with one branch and one condition):
//  - didit_questionnaire_get returned `graph` and `sections[].items`, but no `form_elements`,
//    which is the only shape didit_questionnaire_update accepts;
//  - `sections[].items` was in a different order from the questionnaire (has_company, comments,
//    company-name — the branch target before the next question), because the backend builds it
//    breadth-first: `_get_ordered_elements` enqueues a branch's `goto` before the node's `next`;
//  - an update built from that order, without `next`, was accepted and reordered the stored
//    questionnaire in silence;
//  - didit_questionnaire_delete is described as "Delete a questionnaire." while the backend
//    deletes only a draft version and refuses the only version of a questionnaire.
// The fixture below is that questionnaire exactly as stored.

const CTX = { accessToken: "t-1", organizationId: "org-1", applicationId: "app-1" };

function tool(name) {
  const found = QUESTIONNAIRE_TOOLS.find((entry) => entry.def.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
}

// start_node has_company -> company-name -> comments. has_company branches to comments when the
// answer is "no", so the branch target (comments) comes before the next question in the backend's
// section list.
const STORED = {
  questionnaire_id: "q-1",
  title: { en: "Acme KYB" },
  status: "draft",
  languages: ["en"],
  default_language: "en",
  graph: {
    start_node: "has_company",
    nodes: {
      has_company: {
        element_type: "SINGLE_CHOICE",
        title: { en: "Do you have a company?" },
        is_required: true,
        choices: [
          { value: "yes", label: { en: "Yes" } },
          { value: "no", label: { en: "No" } },
        ],
        branches: [
          { id: "b_no", logic: "and", rules: [{ field: "has_company", operator: "equals", value: "no" }], goto: "comments" },
        ],
        next: "company-name",
      },
      "company-name": {
        element_type: "SHORT_TEXT",
        title: { en: "Company name" },
        is_required: false,
        required_if: { logic: "and", rules: [{ field: "has_company", operator: "equals", value: "yes" }] },
        next: "comments",
      },
      comments: {
        element_type: "LONG_TEXT",
        title: { en: "Comments" },
        is_required: false,
        next: null,
      },
    },
  },
  sections: [
    {
      title: {},
      description: {},
      items: [{ value: "has_company" }, { value: "comments" }, { value: "company-name" }],
    },
  ],
};

/** The questions exactly as stored, in the order a respondent meets them: id + every stored field. */
const WALKED = ["has_company", "company-name", "comments"].map((key) => ({ id: key, ...STORED.graph.nodes[key] }));

// A graph whose branch targets are NOT on the start_node -> next chain: source_type jumps to
// final_question, and its two branches go to employer_name and business_name instead. This is the
// shape the service keeps for an internal issue (trust branching), and one ordered list cannot express its
// `next` pointers. Every stored question must still come back.
const BRANCHING = {
  questionnaire_id: "q-2",
  title: { en: "Branching KYB" },
  status: "draft",
  languages: ["en"],
  default_language: "en",
  graph: {
    start_node: "source_type",
    nodes: {
      source_type: {
        element_type: "SINGLE_CHOICE",
        title: { en: "Where does the money come from?" },
        is_required: true,
        choices: [
          { value: "employer", label: { en: "Employer" } },
          { value: "business", label: { en: "Business" } },
        ],
        branches: [
          { id: "b_emp", logic: "and", rules: [{ field: "source_type", operator: "equals", value: "employer" }], goto: "employer_name" },
          { id: "b_biz", logic: "and", rules: [{ field: "source_type", operator: "equals", value: "business" }], goto: "business_name" },
        ],
        next: "final_question",
      },
      employer_name: { element_type: "SHORT_TEXT", title: { en: "Employer name" }, is_required: true, next: null },
      business_name: { element_type: "SHORT_TEXT", title: { en: "Business name" }, is_required: true, next: null },
      final_question: { element_type: "LONG_TEXT", title: { en: "Anything else?" }, is_required: false, next: null },
    },
  },
  sections: [{ items: [{ value: "source_type" }, { value: "final_question" }] }],
};

// A multilingual questionnaire: a title carries English and Spanish. The display read summarizes
// graph/sections to one locale, but form_elements must keep both so the read-back does not drop es.
const MULTILINGUAL = structuredClone(STORED);
MULTILINGUAL.languages = ["en", "es"];
MULTILINGUAL.default_language = "es";
MULTILINGUAL.graph.nodes["company-name"].title = { en: "Company name", es: "Nombre de la empresa" };

/** A fake console resource: GET answers the stored questionnaire, PATCH stores the graph it is
 * given and answers it back, so a second read shows what the write did. */
function fakeBackend(t, initial = STORED) {
  const calls = [];
  let stored = initial;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const method = init.method ?? "GET";
    const request = { url: new URL(String(url)), method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(request);
    if (method === "PATCH") {
      stored = {
        ...stored,
        graph: request.body.graph,
        ...("languages" in request.body && { languages: request.body.languages }),
        ...("default_language" in request.body && { default_language: request.body.default_language }),
      };
    }
    return Response.json(stored, { status: method === "PATCH" ? 200 : 201 });
  });
  return calls;
}

function read() {
  return requestContext.run(CTX, () => tool("didit_questionnaire_get").run({ questionnaire_id: "q-1" }));
}

test("didit_questionnaire_get returns form_elements: every stored question in walk order", async (t) => {
  const calls = fakeBackend(t);
  const result = await read();

  assert.equal(calls.length, 1, "one read");
  assert.ok(Array.isArray(result.form_elements), "the get answer carries form_elements");
  assert.deepEqual(result.form_elements, WALKED, "the questions, in start_node/next order, with every stored field");
  assert.deepEqual(
    result.form_elements.map((element) => element.id),
    ["has_company", "company-name", "comments"],
    "the walk order, not the section order",
  );
  assert.deepEqual(
    result.sections[0].items.map((item) => item.value),
    ["has_company", "comments", "company-name"],
    "sections keep the backend's display grouping, which is not the question order",
  );
  // The conditional fields an update accepts travel with the question, not lost to the graph walk.
  assert.deepEqual(result.form_elements[0].branches, STORED.graph.nodes.has_company.branches);
  assert.deepEqual(result.form_elements[1].required_if, STORED.graph.nodes["company-name"].required_if);
  assert.equal(result.form_elements[0].next, "company-name");
  assert.equal(result.form_elements.at(-1).next, null);
});

test("a questionnaire read and sent back unchanged round-trips: the stored graph is not reordered", async (t) => {
  const calls = fakeBackend(t);
  const first = await read();

  const result = await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-1", form_elements: first.form_elements }),
  );
  assert.equal(result.warnings, undefined, "sending the read back unchanged is not a reorder");

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "one request carries the update");
  assert.deepEqual(writes[0].body.graph, STORED.graph, "the stored graph is written back unchanged");

  const second = await read();
  assert.deepEqual(second.form_elements, first.form_elements, "reading again returns the same questions in the same order");
});

test("an update that reorders the stored questions without `next` is accepted and warns", async (t) => {
  const calls = fakeBackend(t);
  const form_elements = firstReadOrder(["has_company", "comments", "company-name"]);

  const result = await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-1", form_elements }),
  );

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "a reorder is a legitimate edit: it is written, not refused");
  assert.deepEqual(
    Object.keys(writes[0].body.graph.nodes),
    ["has_company", "comments", "company-name"],
    "the new order is what is written",
  );
  assert.ok(Array.isArray(result.warnings) && result.warnings.length === 1, "one warning names the reorder");
  assert.match(result.warnings[0], /order of 3 questions changed/i);
  for (const id of ["has_company", "comments", "company-name"]) {
    assert.match(result.warnings[0], new RegExp(id), `the warning names ${id}`);
  }
});

test("an update that keeps the stored order and sends no `next` is not warned about", async (t) => {
  fakeBackend(t);
  const form_elements = firstReadOrder(["has_company", "company-name", "comments"]);

  const result = await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-1", form_elements }),
  );

  assert.equal(result.warnings, undefined, "the same order is not a reorder");
});

/** The stored questions (ids and fields, no `next`) in the given order, as a caller rebuilding the
 * list from what didit_questionnaire_get used to return would send it. */
function firstReadOrder(order) {
  return order.map((key) => {
    const { next: _next, ...rest } = STORED.graph.nodes[key];
    return { id: key, ...rest };
  });
}

test("a graph whose branches leave the main path still returns every stored question, and says not to send that list back", async (t) => {
  fakeBackend(t, BRANCHING);
  const result = await read();

  assert.deepEqual(
    result.form_elements.map((element) => element.id),
    ["source_type", "employer_name", "business_name", "final_question"],
    "all four stored questions, branch targets after the question that branches to them",
  );
  assert.equal(result.form_elements.length, Object.keys(BRANCHING.graph.nodes).length, "no stored question is omitted");
  assert.equal(result.form_elements[0].next, "final_question", "each element keeps its stored next");
  assert.equal(result.form_elements_round_trip, false, "one ordered list cannot express this graph");
  assert.match(result.form_elements_note, /cannot be sent back/i);
  assert.match(result.form_elements_note, /Advanced Mode/, "it names the way to edit this shape");
  assert.match(result.hint, /Advanced Mode/, "the hint repeats the note");
});

test("an update without `next` on a branched graph warns that it writes one chain", async (t) => {
  fakeBackend(t, BRANCHING);
  const form_elements = Object.keys(BRANCHING.graph.nodes).map((key) => {
    const { next: _next, ...rest } = BRANCHING.graph.nodes[key];
    return { id: key, ...rest };
  });

  const result = await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-2", form_elements }),
  );

  assert.ok(Array.isArray(result.warnings) && result.warnings.length === 1, "the flatten is not silent");
  assert.match(result.warnings[0], /branches leave the main path/i);
  assert.match(result.warnings[0], /one chain/i);
});

test("a multilingual read is sent back unchanged: form_elements keeps every locale and the update keeps the stored languages", async (t) => {
  const calls = fakeBackend(t, MULTILINGUAL);
  const first = await read();

  assert.deepEqual(first.form_elements[1].title, { en: "Company name", es: "Nombre de la empresa" }, "form_elements keeps every locale");
  assert.deepEqual(first.graph.nodes["company-name"].title, { en: "Company name" }, "the display graph is still summarized");

  const result = await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-2", form_elements: first.form_elements }),
  );
  assert.equal(result.warnings, undefined);

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "one request carries the update");
  assert.equal("languages" in writes[0].body, false, "an update that names no languages leaves the stored ones alone");
  assert.equal("default_language" in writes[0].body, false, "and leaves the stored default language alone");
  assert.deepEqual(writes[0].body.graph.nodes["company-name"].title, { en: "Company name", es: "Nombre de la empresa" });

  const second = await read();
  assert.deepEqual(second.form_elements, first.form_elements, "reading again returns every locale and the same order");
  assert.deepEqual(second.languages, ["en", "es"], "the stored languages are unchanged");
  assert.equal(second.default_language, "es", "the stored default language is unchanged");
});

test("an update that names no languages writes a plain-string title in the stored ones", async (t) => {
  const calls = fakeBackend(t, MULTILINGUAL);
  const form_elements = firstReadOrder(["has_company", "company-name", "comments"]).map((element) =>
    element.id === "company-name" ? { ...element, title: "Company name" } : element,
  );

  await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-2", form_elements }),
  );

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1);
  assert.equal("languages" in writes[0].body, false, "the PATCH still names no languages, so the stored set stays");
  assert.deepEqual(
    writes[0].body.graph.nodes["company-name"].title,
    { en: "Company name", es: "Company name" },
    "the plain string carries every stored locale, so the backend does not refuse it",
  );

  const after = await read();
  assert.deepEqual(after.languages, ["en", "es"], "the questionnaire keeps both languages");
  assert.equal(after.default_language, "es", "and its default language");
});

test("an update that narrows `languages` without `default_language` puts the default in the new list", async (t) => {
  const calls = fakeBackend(t, MULTILINGUAL);
  const form_elements = firstReadOrder(["has_company", "company-name", "comments"]);

  await requestContext.run(CTX, () =>
    tool("didit_questionnaire_update").run({ questionnaire_id: "q-2", languages: ["en"], form_elements }),
  );

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(writes[0].body.languages, ["en"]);
  assert.equal(writes[0].body.default_language, "en", "the stored default would otherwise be left outside the new list");

  const after = await read();
  assert.deepEqual(after.languages, ["en"]);
  assert.equal(after.default_language, "en");
});

test("the get, update and delete tools say what a caller can send back and what delete removes", async (t) => {
  fakeBackend(t);
  const result = await read();
  const get = tool("didit_questionnaire_get").def;
  const update = tool("didit_questionnaire_update").def;
  const del = tool("didit_questionnaire_delete").def;

  assert.match(get.description, /form_elements/, "get names the list to send back");
  assert.match(get.description, /send (it|the whole list) back/i, "get says to send the list back");
  assert.match(get.description, /sections/, "get mentions sections");
  assert.match(get.description, /display|grouped/i, "get says sections are a display grouping");
  assert.match(get.description, /not the (question )?order/i, "get says sections are not the question order");
  assert.match(result.hint, /form_elements/, "the hint points at form_elements");

  assert.match(update.description, /form_elements/);
  assert.match(update.description, /send (it|the whole list) back/i, "update says to send the read's list back");

  assert.match(del.description, /draft version/i, "delete says it deletes a draft version");
  assert.match(del.description, /published/i, "delete says published versions cannot be deleted");
  assert.match(del.description, /only version/i, "delete says the only version cannot be deleted");
  assert.match(del.description, /deactivat|inactive|leave it|instead/i, "delete says what to do instead");

  const languages = update.inputSchema.properties.languages.description;
  assert.match(languages, /create without it uses/i, "`languages` says what create does without it");
  assert.match(languages, /update without it keeps the stored/i, "and that an update keeps the stored ones");
  assert.doesNotMatch(languages, /Defaults to/i, "it no longer claims a default an update does not apply");
  assert.match(get.inputSchema.properties.include_translations.description, /form_elements/, "include_translations names what keeps every locale");
});

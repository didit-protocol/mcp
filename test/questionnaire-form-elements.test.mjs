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
function fakeBackend(t, initial = STORED, options = {}) {
  const calls = [];
  let stored = initial;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const method = init.method ?? "GET";
    const request = { url: new URL(String(url)), method, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(request);
    if (method === "GET" && options.forbidReads) {
      return Response.json({ detail: "You do not have permission to perform this action." }, { status: 403 });
    }
    if (method === "PATCH") {
      // The real backend checks every translatable field against the languages the PATCH would
      // leave stored (its own, or the request's) and refuses a graph that lacks one.
      if (options.refuseMissingTranslations) {
        const languages = Array.isArray(request.body.languages) ? request.body.languages : stored.languages;
        const missing = languages.filter((language) =>
          Object.values(request.body.graph?.nodes ?? {}).some(
            (node) => !(node?.title && typeof node.title === "object" && node.title[language]),
          ),
        );
        if (missing.length) {
          return Response.json([`missing translations for: ${missing.join(", ")}`], { status: 400 });
        }
      }
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

// since an internal issue an update that names no `languages` keeps the stored ones. A title,
// placeholder, description or choice label sent as a plain string is then written as that same
// text in every stored language, and the answer says nothing about it. A respondent in the other
// language reads the wrong text, and translation-completeness views count it as translated.
// The example below is the issue's: a questionnaire stored in English and Spanish, one question
// whose title is sent as "What is your occupation?".
const OCCUPATION = {
  questionnaire_id: "q-3",
  title: { en: "Acme onboarding" },
  status: "draft",
  languages: ["en", "es"],
  default_language: "en",
  graph: {
    start_node: "occupation",
    nodes: {
      occupation: {
        element_type: "SHORT_TEXT",
        title: { en: "Occupation", es: "Ocupación" },
        is_required: false,
        next: null,
      },
    },
  },
  sections: [{ items: [{ value: "occupation" }] }],
};

// The same question with every translatable field filled in both languages, for the no-warning
// case: a caller that sends objects carrying every stored language is translating, not broadcasting.
const OCCUPATION_TRANSLATED = structuredClone(OCCUPATION);
OCCUPATION_TRANSLATED.questionnaire_id = "q-4";
OCCUPATION_TRANSLATED.graph.nodes.occupation = {
  element_type: "SINGLE_CHOICE",
  title: { en: "Occupation", es: "Ocupación" },
  placeholder: { en: "Pick one", es: "Elige uno" },
  choices: [
    { value: "employed", label: { en: "Employed", es: "Empleado" } },
    { value: "student", label: { en: "Student", es: "Estudiante" } },
  ],
  is_required: false,
  next: null,
};

function update(id, data) {
  return requestContext.run(CTX, () => tool("didit_questionnaire_update").run({ questionnaire_id: id, ...data }));
}

test("an update that writes a plain-string title into every stored language warns and names the field and languages", async (t) => {
  const calls = fakeBackend(t, OCCUPATION);

  const result = await update("q-3", {
    form_elements: [{ id: "occupation", element_type: "SHORT_TEXT", title: "What is your occupation?" }],
  });

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "the update is written");
  assert.deepEqual(
    writes[0].body.graph.nodes.occupation.title,
    { en: "What is your occupation?", es: "What is your occupation?" },
    "the plain string is stored as the same text in both languages",
  );

  assert.ok(Array.isArray(result.warnings) && result.warnings.length === 1, "the answer carries one warning for the broadcast");
  assert.match(result.warnings[0], /occupation\.title/, "the warning names the question and field");
  assert.match(result.warnings[0], /\ben, es\b/, "the warning names the languages it was written in");
  assert.match(result.warnings[0], /same text/i, "the warning says the text is the same in every language");
  assert.match(result.warnings[0], /Send \{ "en": \.\.\., "es": \.\.\. \} to translate it\./, "the warning says how to send a translation");

  const after = await requestContext.run(CTX, () =>
    tool("didit_questionnaire_get").run({ questionnaire_id: "q-3" }),
  );
  assert.deepEqual(
    after.form_elements[0].title,
    { en: "What is your occupation?", es: "What is your occupation?" },
    "the Spanish respondent now reads the English title",
  );
});

test("a broadcast over several fields is one grouped warning, naming each field once", async (t) => {
  fakeBackend(t, OCCUPATION_TRANSLATED);

  const result = await update("q-4", {
    form_elements: [
      {
        id: "occupation",
        element_type: "SINGLE_CHOICE",
        title: "What is your occupation?",
        placeholder: "Your job",
        choices: [
          { value: "employed", label: "Employed" },
          { value: "student", label: { en: "Student", es: "Estudiante" } },
        ],
      },
    ],
  });

  assert.ok(Array.isArray(result.warnings) && result.warnings.length === 1, "one grouped warning, not one per field");
  for (const field of ["occupation.title", "occupation.placeholder", "occupation.choices[0].label"]) {
    assert.match(result.warnings[0], new RegExp(field.replace(/[.[\]]/g, "\\$&")), `the warning names ${field}`);
  }
  assert.match(result.warnings[0], /\ben, es\b/);
  assert.match(result.warnings[0], /to translate/i);
});

test("an update that writes a plain string into a questionnaire stored in one language is not warned about", async (t) => {
  fakeBackend(t);
  const form_elements = firstReadOrder(["has_company", "company-name", "comments"]).map((element) =>
    element.id === "company-name" ? { ...element, title: "Legal name" } : element,
  );

  const result = await update("q-1", { form_elements });

  assert.equal(result.warnings, undefined, "there is no other language to translate into");
});

test("an update that sends every translatable field as an object with every stored language is not warned about", async (t) => {
  fakeBackend(t, OCCUPATION_TRANSLATED);

  const result = await update("q-4", {
    form_elements: [
      {
        id: "occupation",
        element_type: "SINGLE_CHOICE",
        title: { en: "Occupation", es: "Ocupación" },
        placeholder: { en: "Pick one", es: "Elige uno" },
        choices: [
          { value: "employed", label: { en: "Employed", es: "Empleado" } },
          { value: "student", label: { en: "Student", es: "Estudiante" } },
        ],
      },
    ],
  });

  assert.equal(result.warnings, undefined, "the caller sent a translation, not a broadcast");
});

test("a plain string equal to the text stored in every language is not warned about", async (t) => {
  const sameEverywhere = structuredClone(OCCUPATION);
  sameEverywhere.questionnaire_id = "q-5";
  sameEverywhere.graph.nodes.occupation.title = { en: "Occupation", es: "Occupation" };
  fakeBackend(t, sameEverywhere);

  const result = await update("q-5", {
    form_elements: [{ id: "occupation", element_type: "SHORT_TEXT", title: "Occupation" }],
  });

  assert.equal(result.warnings, undefined, "an unchanged read-back of a questionnaire with the same text everywhere is not a new broadcast");
});

test("a connection that may write but not read still updates a one-language questionnaire, without the warning", async (t) => {
  // No read is needed to know this questionnaire's only language, so the swallowed 403 costs
  // nothing. A multilingual one is a different case: the test below.
  const calls = fakeBackend(t, STORED, { forbidReads: true });

  const result = await update("q-1", {
    form_elements: [{ id: "comments", element_type: "LONG_TEXT", title: "Comments" }],
  });

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "the write is not refused because the read was");
  assert.deepEqual(
    writes[0].body.graph.nodes.comments.title,
    { en: "Comments" },
    "the update goes out with the languages it could build without a read",
  );
  assert.equal(result.warnings, undefined, "with no read there is no warning to give");
});

test("a write-only connection sending a plain string to a multilingual questionnaire is refused with the missing locale", async (t) => {
  // Without a read the tool cannot know the stored languages, so it sends the English-only graph
  // and names no `languages`; the backend refuses and names the locale. It must not reset the
  // questionnaire to English (v5.1.75's `languages: ["en"]`) to make the write pass.
  const calls = fakeBackend(t, OCCUPATION, { forbidReads: true, refuseMissingTranslations: true });

  await assert.rejects(
    () =>
      update("q-3", {
        form_elements: [{ id: "occupation", element_type: "SHORT_TEXT", title: "What is your occupation?" }],
      }),
    (error) => {
      assert.match(error.message, /missing translations for: es/, "the refusal reaches the caller and names the missing locale");
      return true;
    },
  );

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.equal(writes.length, 1, "the update is attempted exactly once");
  assert.equal("languages" in writes[0].body, false, "the tool cannot know the stored languages, so the PATCH names none");
  assert.ok(
    !calls.some((call) => JSON.stringify(call.body?.languages) === '["en"]'),
    "no request resets the questionnaire to English",
  );
});

// The broadcast is a property of the write, not of leaving `languages` out: an update that names
// the stored languages explicitly still copies a plain string into each of them, so it is reported
// the same way. (Review of revision 0fe4a51, finding 1.)
test("an update that names several languages explicitly and writes a plain string warns about it too", async (t) => {
  const calls = fakeBackend(t, OCCUPATION);

  const result = await update("q-3", {
    languages: ["en", "es"],
    form_elements: [{ id: "occupation", element_type: "SHORT_TEXT", title: "Job" }],
  });

  const writes = calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(writes[0].body.languages, ["en", "es"], "the update keeps both languages");
  assert.deepEqual(
    writes[0].body.graph.nodes.occupation.title,
    { en: "Job", es: "Job" },
    "the plain string is still stored as the same text in both languages",
  );
  assert.ok(Array.isArray(result.warnings) && result.warnings.length === 1, "the answer carries the warning");
  assert.match(result.warnings[0], /occupation\.title/);
  assert.match(result.warnings[0], /\ben, es\b/);
});

test("an update that names several languages explicitly but changes no text is not warned about", async (t) => {
  const sameEverywhere = structuredClone(OCCUPATION);
  sameEverywhere.questionnaire_id = "q-6";
  sameEverywhere.graph.nodes.occupation.title = { en: "Occupation", es: "Occupation" };
  fakeBackend(t, sameEverywhere);

  const result = await update("q-6", {
    languages: ["en", "es"],
    form_elements: [{ id: "occupation", element_type: "SHORT_TEXT", title: "Occupation" }],
  });

  assert.equal(result.warnings, undefined, "the text already stands in both languages");
});

test("an update that names one language writes no broadcast", async (t) => {
  fakeBackend(t, OCCUPATION);

  const result = await update("q-3", {
    languages: ["en"],
    form_elements: [{ id: "occupation", element_type: "SHORT_TEXT", title: "Occupation" }],
  });

  assert.equal(result.warnings, undefined, "one language is not a broadcast");
});

// A choice is identified by its value, not by its position: reordering choices (or inserting one
// before them) must not report labels that are already the same text in every language.
// (Review of revision 0fe4a51, finding 2.)
const OCCUPATION_SAME_LABELS = structuredClone(OCCUPATION);
OCCUPATION_SAME_LABELS.questionnaire_id = "q-7";
OCCUPATION_SAME_LABELS.graph.nodes.occupation = {
  element_type: "SINGLE_CHOICE",
  title: { en: "Occupation", es: "Ocupación" },
  choices: [
    { value: "employed", label: { en: "Employed", es: "Employed" } },
    { value: "student", label: { en: "Student", es: "Student" } },
  ],
  is_required: false,
  next: null,
};

test("reordering choices whose labels are the same in every language is not warned about", async (t) => {
  fakeBackend(t, OCCUPATION_SAME_LABELS);

  const result = await update("q-7", {
    form_elements: [
      {
        id: "occupation",
        element_type: "SINGLE_CHOICE",
        title: { en: "Occupation", es: "Ocupación" },
        choices: [
          { value: "student", label: "Student" },
          { value: "employed", label: "Employed" },
        ],
      },
    ],
  });

  assert.equal(result.warnings, undefined, "each label already stands in every language, whatever the position");
});

test("inserting a choice before unchanged ones warns about the new choice only", async (t) => {
  fakeBackend(t, OCCUPATION_SAME_LABELS);

  const result = await update("q-7", {
    form_elements: [
      {
        id: "occupation",
        element_type: "SINGLE_CHOICE",
        title: { en: "Occupation", es: "Ocupación" },
        choices: [
          { value: "retired", label: "Retired" },
          { value: "employed", label: "Employed" },
          { value: "student", label: "Student" },
        ],
      },
    ],
  });

  assert.ok(Array.isArray(result.warnings) && result.warnings.length === 1, "one grouped warning");
  assert.match(result.warnings[0], /occupation\.choices\[0\]\.label/, "the new choice is named");
  assert.doesNotMatch(result.warnings[0], /choices\[[12]\]/, "the choices that moved are not");
});

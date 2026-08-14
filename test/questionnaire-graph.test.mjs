import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuestionnaireGraph, createQuestionnaire } from "../dist/tools/questionnaires.js";
import { requestContext } from "../dist/config.js";

// The backend stores a questionnaire as a GRAPH ({start_node, nodes}) and rejects the flat
// form_elements array this tool used to POST ("graph: This field is required" — every
// copilot-created questionnaire failed on it). The tool still takes an ordered question
// list, so these pin the assembly that turns one into the other.

const API = "https://verification.didit.me/v3";
const PATH = `${API}/organization/org-1/application/app-1/questionnaires/`;

/** Capture the wire payload instead of calling the real API. */
function captureBody() {
  const sent = {};
  globalThis.fetch = async (url, init) => {
    sent.url = String(url);
    sent.body = JSON.parse(init.body);
    return new Response(JSON.stringify({ uuid: "q-1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  return sent;
}

const QUESTIONS = [
  { element_type: "SHORT_TEXT", title: "What is your full name?", is_required: true },
  {
    element_type: "SINGLE_CHOICE",
    title: "Are you a politically exposed person (PEP)?",
    is_required: true,
    choices: [{ value: "Yes" }, { value: "No" }],
  },
];

test("questions become a linear graph: positional ids, each pointing at the next", () => {
  const graph = buildQuestionnaireGraph(QUESTIONS, ["en"]);

  assert.equal(graph.start_node, "q1");
  assert.deepEqual(Object.keys(graph.nodes), ["q1", "q2"]);
  assert.equal(graph.nodes.q1.next, "q2");
  assert.equal(graph.nodes.q2.next, null);
});

test("a plain-string title is broadcast to every language — the backend demands all of them", () => {
  const graph = buildQuestionnaireGraph(QUESTIONS, ["en", "es"]);

  assert.deepEqual(graph.nodes.q1.title, {
    en: "What is your full name?",
    es: "What is your full name?",
  });
});

test("a title already keyed by locale is left alone", () => {
  const graph = buildQuestionnaireGraph([{ element_type: "SHORT_TEXT", title: { en: "Name" } }], [
    "en",
  ]);

  assert.deepEqual(graph.nodes.q1.title, { en: "Name" });
});

test("a choice gets both halves the backend requires: a value and a translated label", () => {
  const graph = buildQuestionnaireGraph(QUESTIONS, ["en"]);

  assert.deepEqual(graph.nodes.q2.choices, [
    { value: "Yes", label: { en: "Yes" } },
    { value: "No", label: { en: "No" } },
  ]);
});

test("a label-only choice keeps its label and gains a value", () => {
  const graph = buildQuestionnaireGraph(
    [{ element_type: "DROPDOWN", choices: [{ label: "Spain" }] }],
    ["en"],
  );

  assert.deepEqual(graph.nodes.q1.choices, [{ value: "Spain", label: { en: "Spain" } }]);
});

test("is_required defaults to false rather than being left undefined", () => {
  const graph = buildQuestionnaireGraph([{ element_type: "SHORT_TEXT", title: "Name" }], ["en"]);

  assert.equal(graph.nodes.q1.is_required, false);
});

test("create posts the graph plus the language fields, never form_elements", async () => {
  const sent = captureBody();
  await requestContext.run({ accessToken: "t-1", organizationId: "org-1", applicationId: "app-1" }, () =>
    createQuestionnaire({ title: "Crypto onboarding", form_elements: QUESTIONS, status: "draft" }),
  );

  assert.equal(sent.url, PATH);
  assert.equal(sent.body.form_elements, undefined);
  assert.equal(sent.body.title, "Crypto onboarding");
  assert.equal(sent.body.status, "draft");
  assert.deepEqual(sent.body.languages, ["en"]);
  assert.equal(sent.body.default_language, "en");
  assert.equal(sent.body.graph.start_node, "q1");
});

test("the org/app selectors route the call and never leak into the payload", async () => {
  // The dispatcher lifts them into the request context (that is what scopes the path);
  // they arrive in the tool args too, and the body is no place for them.
  const sent = captureBody();
  await requestContext.run({ accessToken: "t-2", organizationId: "org-1", applicationId: "app-1" }, () =>
    createQuestionnaire({
      organization_id: "org-1",
      application_id: "app-1",
      title: "Scoped",
      form_elements: QUESTIONS,
    }),
  );

  assert.equal(sent.body.organization_id, undefined);
  assert.equal(sent.body.application_id, undefined);
});

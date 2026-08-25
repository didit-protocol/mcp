import { test } from "node:test";
import assert from "node:assert/strict";
import { appendQuestionnaireChoices } from "../dist/tools/questionnaires.js";
import { requestContext } from "../dist/config.js";

// A choice list longer than ~100 options cannot travel in one create/update call — the model
// emits the call token by token and the step's output budget cuts it off mid-JSON, so a
// 1000-option question silently kept only its first ~100 answers. Batches now arrive through
// didit_questionnaire_append_choices; these pin the append semantics: read-modify-write of the
// stored graph, dedup by value (a retried batch must not duplicate), and a compact result.

const CTX = { accessToken: "t-1", organizationId: "org-1", applicationId: "app-1" };

function storedQuestionnaire(choices) {
  return {
    uuid: "q-1",
    languages: ["en"],
    default_language: "en",
    graph: {
      start_node: "q1",
      nodes: {
        q1: {
          element_type: "SINGLE_CHOICE",
          title: { en: "Pick one" },
          is_required: true,
          choices,
          next: null,
        },
      },
    },
  };
}

/** GET returns the stored questionnaire; a PATCH (if any) is captured. */
function stubApi(stored) {
  const sent = {};
  globalThis.fetch = async (url, init) => {
    if (!init?.method || init.method === "GET") {
      return new Response(JSON.stringify(stored), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    sent.method = init.method;
    sent.url = String(url);
    sent.body = JSON.parse(init.body);
    return new Response(JSON.stringify({ uuid: "q-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return sent;
}

test("a batch is appended after the stored choices and PATCHed as a draft-pinned graph", async () => {
  const stored = storedQuestionnaire([{ value: "A", label: { en: "A" } }]);
  const sent = stubApi(stored);
  const result = await requestContext.run(CTX, () =>
    appendQuestionnaireChoices("q-1", { choices: [{ value: "B" }, { value: "C" }] }),
  );

  assert.equal(sent.method, "PATCH");
  // A PATCH that omits status PUBLISHES a draft, and a published questionnaire rejects
  // every further edit — an intermediate batch must pin the draft state explicitly.
  assert.equal(sent.body.status, "draft");
  assert.deepEqual(
    sent.body.graph.nodes.q1.choices.map((choice) => choice.value),
    ["A", "B", "C"],
  );
  assert.deepEqual(sent.body.graph.nodes.q1.choices[1].label, { en: "B" });
  assert.deepEqual(result, {
    questionnaire_id: "q-1",
    node_id: "q1",
    appended: 2,
    skipped_existing: 0,
    total_choices: 3,
    status: "draft",
  });
});

test("publish:true on the final batch lets the PATCH publish (no draft pin)", async () => {
  const sent = stubApi(storedQuestionnaire([{ value: "A", label: { en: "A" } }]));
  const result = await requestContext.run(CTX, () =>
    appendQuestionnaireChoices("q-1", { choices: [{ value: "B" }], publish: true }),
  );

  assert.equal(sent.method, "PATCH");
  assert.equal(sent.body.status, undefined);
  assert.equal(result.status, "published");
});

test("publish:true with an all-duplicate batch still writes, so the publish happens", async () => {
  const sent = stubApi(storedQuestionnaire([{ value: "A", label: { en: "A" } }]));
  const result = await requestContext.run(CTX, () =>
    appendQuestionnaireChoices("q-1", { choices: [{ value: "A" }], publish: true }),
  );

  assert.equal(sent.method, "PATCH");
  assert.equal(result.appended, 0);
  assert.equal(result.total_choices, 1);
});

test("a retried batch is skipped by value instead of duplicating, without a write", async () => {
  const stored = storedQuestionnaire([
    { value: "A", label: { en: "A" } },
    { value: "B", label: { en: "B" } },
  ]);
  const sent = stubApi(stored);
  const result = await requestContext.run(CTX, () =>
    appendQuestionnaireChoices("q-1", { choices: [{ value: "A" }, { value: "B" }] }),
  );

  assert.equal(sent.method, undefined);
  assert.equal(result.appended, 0);
  assert.equal(result.skipped_existing, 2);
  assert.equal(result.total_choices, 2);
});

test("with a single choice-bearing question, node_id may be omitted", async () => {
  stubApi(storedQuestionnaire([]));
  const result = await requestContext.run(CTX, () =>
    appendQuestionnaireChoices("q-1", { choices: [{ value: "A" }] }),
  );

  assert.equal(result.node_id, "q1");
  assert.equal(result.total_choices, 1);
});

test("an explicit node_id must name a choice-bearing question", async () => {
  const stored = storedQuestionnaire([]);
  stored.graph.start_node = "intro";
  stored.graph.nodes.intro = { element_type: "SECTION_HEADER", next: "q1" };
  const sent = stubApi(stored);

  await assert.rejects(
    requestContext.run(CTX, () =>
      appendQuestionnaireChoices("q-1", { node_id: "intro", choices: [{ value: "A" }] }),
    ),
    /question nodes with choices: \[q1\]/,
  );
  assert.equal(sent.method, undefined);
});

test("with several choice-bearing questions, an omitted node_id names the candidates", async () => {
  const stored = storedQuestionnaire([]);
  stored.graph.nodes.q2 = { element_type: "DROPDOWN", choices: [], next: null };
  stubApi(stored);

  await assert.rejects(
    requestContext.run(CTX, () => appendQuestionnaireChoices("q-1", { choices: [{ value: "A" }] })),
    /\[q1, q2\]/,
  );
});

test("labels are broadcast to every declared language, like the create path does", async () => {
  const stored = storedQuestionnaire([]);
  stored.languages = ["en", "es"];
  const sent = stubApi(stored);
  await requestContext.run(CTX, () =>
    appendQuestionnaireChoices("q-1", { choices: [{ value: "Yes" }] }),
  );

  assert.deepEqual(sent.body.graph.nodes.q1.choices[0].label, { en: "Yes", es: "Yes" });
});

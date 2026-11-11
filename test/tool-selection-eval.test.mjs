import { test as runTest } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

// The tool-selection eval (evals/tool-selection) costs money to run, so it is not part of CI.
// What CI can hold for free is that the eval still measures THIS server: every tool a case
// names exists where the case is asked, so a rename or a merge shows up here instead of as a
// silent row of misses in the next paid run. The second half runs the grading loop with a
// scripted model against the real server, so "context first, then the tool" and "search, then
// call" are graded the way the runner claims.

// The eval lives outside src/ and test/. A copy of the tests without it (the public mirror) has
// nothing to check, so every test here is skipped there.
const runner = new URL("../evals/tool-selection/run.mjs", import.meta.url);
const present = existsSync(runner);
const test = (name, fn) => runTest(name, { skip: present ? false : "the eval is not part of this checkout" }, fn);

const { CASES, LOOKUPS, MAX_STEPS, NAVIGATION_TOOLS, acceptableFor, argumentIssues, budgetOf, casesFor, chatWith, openCatalog, run, runCase, summarize } = present
  ? await import(runner.href)
  : {};

const usage = { input: 1000, output: 20, cached: 0, cost: 0.001 };
const calling = (...calls) => ({
  message: { content: "", tool_calls: calls.map(([name, args], index) => ({ id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args ?? {}) } })) },
  usage,
});
const saying = (text) => ({ message: { content: text }, usage });

/** A model that answers from a script, and keeps what it was sent. */
function scripted(...answers) {
  const seen = [];
  const chat = async (request) => {
    seen.push(structuredClone(request.messages));

    return answers[Math.min(seen.length - 1, answers.length - 1)];
  };

  return { chat, seen };
}

const kase = (id) => CASES.find((candidate) => candidate.id === id);

test("every case is well formed", () => {
  const ids = CASES.map((candidate) => candidate.id);
  assert.equal(new Set(ids).size, ids.length, "case ids are unique");
  for (const candidate of CASES) {
    assert.ok(candidate.ask.trim().length > 10, `${candidate.id} asks something`);
    assert.ok(Array.isArray(candidate.accept) && candidate.accept.length > 0, `${candidate.id} accepts at least one tool`);
    const both = (candidate.ok ?? []).filter((tool) => candidate.accept.includes(tool));
    assert.deepEqual(both, [], `${candidate.id} lists a tool as both right and merely acceptable`);
    assert.ok(candidate.catalog === undefined || candidate.catalog === "local", `${candidate.id} names a catalog the runner has`);
    for (const entity of candidate.entities ?? []) assert.ok(entity in LOOKUPS, `${candidate.id} names an entity the runner has lookups for: ${entity}`);
    // A lookup the entity rule already allows is not repeated by hand.
    const lookups = (candidate.entities ?? []).flatMap((entity) => LOOKUPS[entity]);
    assert.deepEqual((candidate.ok ?? []).filter((tool) => lookups.includes(tool)), [], `${candidate.id}`);
  }
  assert.ok(casesFor("all").length >= 60, "enough hosted cases for a percentage to mean something");
  assert.ok(casesFor("local").length >= 5);
  assert.deepEqual(casesFor("core"), casesFor("all"), "every hosted catalog is asked the same cases");
});

test("every tool a case names exists on the server the case is asked on", async () => {
  for (const name of ["all", "local"]) {
    const catalog = await openCatalog(name);
    try {
      const missing = casesFor(name).flatMap((candidate) =>
        [...candidate.accept, ...acceptableFor(candidate)].filter((tool) => !catalog.names.has(tool)).map((tool) => `${candidate.id}: ${tool}`),
      );
      assert.deepEqual(missing, [], `the ${name} catalog no longer has these tools: update evals/tool-selection/cases.json`);
      if (name === "all") {
        // The discovery tools belong to a narrowed catalog; everything else that is navigation must exist.
        const navigation = [...NAVIGATION_TOOLS].filter((tool) => !tool.startsWith("didit_tool_"));
        assert.deepEqual(navigation.filter((tool) => !catalog.names.has(tool)), []);
      }
    } finally {
      await catalog.close();
    }
  }
});

test("a case is graded on the first tool that does something, after finding the way for real", async () => {
  const catalog = await openCatalog("all");
  try {
    const direct = await runCase({ catalog, kase: kase("session-pdf"), chat: scripted(calling(["didit_session_generate_pdf", { session_id: "s" }])).chat });
    assert.deepEqual([direct.outcome, direct.tool, direct.steps, direct.via], ["right", "didit_session_generate_pdf", 1, null]);

    // Context first: the tool really runs, and the model sees the organization and both applications.
    const model = scripted(calling(["didit_context_get"]), calling(["didit_session_search", { search: "john.smith@example.com" }]));
    const afterContext = await runCase({ catalog, kase: kase("session-find-email"), chat: model.chat });
    assert.deepEqual([afterContext.outcome, afterContext.tool, afterContext.steps], ["right", "didit_session_search", 2]);
    const toolResult = model.seen[1].find((message) => message.role === "tool").content;
    assert.match(toolResult, /Acme Trading/);
    assert.match(toolResult, /"mode": ?"sandbox"/);
    assert.equal(afterContext.first_input_tokens, 1000);
    assert.equal(afterContext.input_tokens, 2000);

    // Several calls in one turn: the navigation call is passed over, the next one is graded.
    const together = await runCase({ catalog, kase: kase("org-balance"), chat: scripted(calling(["didit_context_get"], ["didit_org_get_balance"])).chat });
    assert.deepEqual([together.outcome, together.steps], ["right", 1]);

    // A navigation tool is graded when it is the answer.
    const context = await runCase({ catalog, kase: kase("org-context"), chat: scripted(calling(["didit_context_get"])).chat });
    assert.deepEqual([context.outcome, context.tool], ["right", "didit_context_get"]);

    const wrong = await runCase({ catalog, kase: kase("session-pdf"), chat: scripted(calling(["didit_report_export"])).chat });
    assert.deepEqual([wrong.outcome, wrong.tool], ["wrong", "didit_report_export"]);

    const detour = await runCase({ catalog, kase: kase("session-webhook-resend"), chat: scripted(calling(["didit_session_webhooks"])).chat });
    assert.equal(detour.outcome, "acceptable");

    // Reading the thing the request names is acceptable, never right; a tool that is right stays right.
    const lookedUp = await runCase({ catalog, kase: kase("workflow-publish"), chat: scripted(calling(["didit_workflow_search", { workflow_id: "w" }])).chat });
    assert.deepEqual([lookedUp.outcome, lookedUp.tool], ["acceptable", "didit_workflow_search"]);
    assert.equal(acceptableFor(kase("session-why-declined")).has("didit_session_get_decision"), false, "it is one of the right answers there");
    const reading = await runCase({ catalog, kase: kase("session-why-declined"), chat: scripted(calling(["didit_session_get_decision", { session_id: "s" }])).chat });
    assert.equal(reading.outcome, "right");

    const talk = await runCase({ catalog, kase: kase("session-pdf"), chat: scripted(saying("Which session do you mean?")).chat });
    assert.deepEqual([talk.outcome, talk.tool, talk.said], ["no_call", null, "Which session do you mean?"]);

    const lost = await runCase({ catalog, kase: kase("session-pdf"), chat: scripted(calling(["didit_context_get"])).chat });
    assert.deepEqual([lost.outcome, lost.steps], ["no_decision", MAX_STEPS]);
  } finally {
    await catalog.close();
  }
});

test("on the short catalog a tool reached through search and call is graded as that tool", async () => {
  const catalog = await openCatalog("core");
  try {
    assert.ok(!catalog.names.has("didit_session_generate_pdf"), "the tool under test is not listed by the short catalog");
    assert.ok(catalog.names.has("didit_tool_search"));
    const model = scripted(
      calling(["didit_tool_search", { query: "download the verification PDF" }]),
      calling(["didit_tool_call_write", { name: "didit_session_generate_pdf", arguments: { session_id: "s" } }]),
    );
    const row = await runCase({ catalog, kase: kase("session-pdf"), chat: model.chat });
    assert.deepEqual([row.outcome, row.tool, row.via, row.steps], ["right", "didit_session_generate_pdf", "didit_tool_call_write", 2]);
    // The search ran against the real catalog: its answer is where the model learned the name.
    assert.match(model.seen[1].find((message) => message.role === "tool").content, /didit_session_generate_pdf/);

    // Describing a tool through the read proxy is still finding the way, not the answer.
    const viaProxy = scripted(
      calling(["didit_tool_call_read", { name: "didit_org_list" }]),
      calling(["didit_tool_call_read", { name: "didit_org_list_members" }]),
    );
    const members = await runCase({ catalog, kase: kase("org-members"), chat: viaProxy.chat });
    assert.deepEqual([members.outcome, members.tool, members.steps], ["right", "didit_org_list_members", 2]);
    assert.match(viaProxy.seen[1].find((message) => message.role === "tool").content, /Acme Trading/);
  } finally {
    await catalog.close();
  }
});

test("the arguments of a graded call are checked for what was left out and for ids nobody gave", async () => {
  const LIVE = "a1b2c3d4-0000-4000-8000-000000000001";
  assert.deepEqual(argumentIssues(["session_id"], { session_id: "s" }), []);
  assert.deepEqual(argumentIssues(["session_id", "new_status"], { session_id: "" }), ["missing session_id, new_status"]);
  assert.deepEqual(argumentIssues([], { application_id: LIVE }), []);
  assert.deepEqual(argumentIssues([], { organization_id: "org_123", application_id: "my-app" }), ["invented organization_id", "invented application_id"]);

  const all = await openCatalog("all");
  const core = await openCatalog("core");
  try {
    const complete = await runCase({ catalog: all, kase: kase("session-pdf"), chat: scripted(calling(["didit_session_generate_pdf", { session_id: "s", application_id: LIVE }])).chat });
    assert.deepEqual([complete.arg_keys, complete.arg_issues], [["application_id", "session_id"], []]);

    const careless = await runCase({ catalog: all, kase: kase("session-pdf"), chat: scripted(calling(["didit_session_generate_pdf", { application_id: "app-1" }])).chat });
    assert.deepEqual(careless.arg_issues, ["missing session_id", "invented application_id"]);

    // Through the proxy the arguments are the ones the real tool gets, checked against ITS
    // requirements, which the short catalog does not list.
    assert.ok(!core.names.has("didit_session_generate_pdf"));
    const proxied = await runCase({ catalog: core, kase: kase("session-pdf"), chat: scripted(calling(["didit_tool_call_write", { name: "didit_session_generate_pdf", arguments: {} }])).chat });
    assert.deepEqual([proxied.outcome, proxied.arg_keys, proxied.arg_issues], ["right", [], ["missing session_id"]]);
  } finally {
    await all.close();
    await core.close();
  }
});

test("the spend cap holds with several requests in flight", async () => {
  // Admission counts what is still in flight, at the cost of the dearest request seen so far.
  const budget = budgetOf(1);
  budget.admit()(0.4); // the first request, alone: 0.40 spent, and 0.40 is now what a request may cost
  const second = budget.admit();
  assert.equal(typeof second, "function", "0.40 spent and 0.40 for this one fit in 1.00");
  assert.equal(budget.admit(), undefined, "0.40 spent, 0.40 in flight and 0.40 more would pass 1.00");
  second(0.1);
  assert.equal(budget.spent, 0.5);
  budget.admit()(0.4);
  assert.equal(budget.admit(), undefined, "0.90 spent leaves no room for a 0.40 request");
  assert.ok(budget.spent <= 1);

  // Through a whole run: every case costs 0.30, four at a time, with 1.00 to spend.
  const chatFor = () => async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));

    return { ...calling(["didit_session_generate_pdf", { session_id: "s" }]), usage: { input: 1000, output: 10, cached: 0, cost: 0.3 } };
  };
  const result = await run({ models: ["m"], catalogs: ["core"], repeat: 1, concurrency: 4, budget: 1, only: undefined, chatFor });
  assert.ok(result.spent <= 1, `spent ${result.spent}`);
  const measured = result.rows.filter((row) => row.outcome !== "skipped_budget");
  assert.equal(measured.length, 3, "three cases of 0.30 fit, a fourth could not be started");
  assert.equal(result.rows.length, casesFor("core").length, "every case has a row, measured or not");
});

test("the first request is held to the cap too: what a request can cost is known before it is sent", async () => {
  // The bound a request brings is reserved, whatever was seen before.
  const budget = budgetOf(1);
  assert.equal(budget.admit(1.5), undefined, "a first request that can cost 1.50 does not fit in 1.00");
  const fits = budget.admit(0.6);
  assert.equal(budget.admit(0.6), undefined, "0.60 in flight and 0.60 more would pass 1.00");
  fits(0.05); // it cost far less than it could have: the difference is free again
  assert.equal(typeof budget.admit(0.6), "function");

  // A run whose every request could pass the cap sends nothing at all.
  let sent = 0;
  const dear = async () => {
    sent += 1;

    return saying("never asked");
  };
  dear.maxCost = async () => 2;
  const nothing = await run({ models: ["m"], catalogs: ["core"], repeat: 1, concurrency: 4, budget: 1, only: undefined, chatFor: () => dear });
  assert.equal(sent, 0);
  assert.equal(nothing.spent, 0);
  assert.ok(nothing.rows.every((row) => row.outcome === "skipped_budget"));

  // The bound comes from the size of the request and the price the endpoint publishes.
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));

    return new Response(JSON.stringify({ data: [{ id: "vendor/model", pricing: { prompt: "0.000002", completion: "0.00001" } }] }), { status: 200 });
  };
  const request = { messages: [{ role: "user", content: "x".repeat(1000) }], tools: [] };
  const bytes = Buffer.byteLength(JSON.stringify(request));
  const priced = chatWith({ baseUrl: "https://priced.test/v1", apiKey: "k", model: "vendor/model", fetchImpl });
  // 2 USD per million input tokens at two bytes a token and 1.25 for a cache write, plus 3,000 output tokens at 10 USD.
  assert.equal(await priced.maxCost(request), (Math.ceil(bytes / 2) * 2 * 1.25 + 3000 * 10) / 1e6);
  await priced.maxCost(request);
  assert.deepEqual(asked, ["https://priced.test/v1/models"], "the prices are read once");
  // A model the endpoint does not price is bounded with the assumed prices, never with zero.
  const unpriced = chatWith({ baseUrl: "https://priced.test/v1", apiKey: "k", model: "vendor/other", fetchImpl });
  assert.ok((await unpriced.maxCost(request)) > (await priced.maxCost(request)));

  // An endpoint that publishes prices but does not say what a request cost: the request is
  // settled at the published prices it was admitted with, not at the assumed ones.
  const silent = async (url) =>
    String(url).endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: "vendor/dear", pricing: { prompt: "0.00002", completion: "0.0001" } }] }), { status: 200 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), { status: 200 });
  const dearModel = chatWith({ baseUrl: "https://silent.test/v1", apiKey: "k", model: "vendor/dear", fetchImpl: silent });
  const answer = await dearModel(request);
  // 20 USD per million input tokens (with the cache-write factor) and 100 per million output tokens.
  assert.equal(answer.usage.cost, (1000 * 20 * 1.25 + 100 * 100) / 1e6);
  assert.ok(answer.usage.cost <= (await dearModel.maxCost(request)), "what is settled never passes what was reserved");
  // When the endpoint does say what the request cost, that is what is settled.
  const telling = async (url) =>
    String(url).endsWith("/models")
      ? new Response(JSON.stringify({ data: [] }), { status: 200 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.0042 } }), { status: 200 });
  assert.equal((await chatWith({ baseUrl: "https://telling.test/v1", apiKey: "k", model: "vendor/any", fetchImpl: telling })(request)).usage.cost, 0.0042);
});

test("a custom selection of toolsets is one catalog, however many toolsets it names", async () => {
  const catalog = await openCatalog("toolsets=core+cases");
  try {
    assert.ok(catalog.names.has("didit_case_create"), "the cases toolset is loaded");
    assert.ok(catalog.names.has("didit_context_get"), "next to the core one");
    assert.ok(!catalog.names.has("didit_webhook_delete"), "and nothing else is");
  } finally {
    await catalog.close();
  }
});

test("the summary states the rate, the misses and which of two overlapping tools was picked", () => {
  const row = (outcome, extra = {}) => ({ catalog: "all", model: "m", run: 1, steps: 1, first_input_tokens: 80000, input_tokens: 80000, cached_tokens: 0, output_tokens: 10, cost: 0.01, outcome, ...extra });
  const text = summarize({
    rows: [
      row("right", { case: "session-find-email", tool: "didit_session_search", arg_issues: ["invented application_id"] }),
      row("right", { case: "session-declined-week", tool: "didit_session_list", arg_issues: [] }),
      row("wrong", { case: "session-pdf", tool: "didit_report_export" }),
      row("no_call", { case: "org-balance", tool: null, said: "Which organization?" }),
      { catalog: "all", model: "m", case: "analytics", run: 1, outcome: "error", error: "m: too many tools" },
    ],
  });
  assert.match(text, /\| all \| m \| 4 \| 50% \| 50% \| 1 \| 1 \| 0 \| 1 \| 1\.0 \| 80,000 \| \$0\.04 \|/);
  assert.match(text, /session-find-email -> didit_session_search: invented application_id/);
  assert.match(text, /all \/ m \/ error: 1 cases \(m: too many tools\)/);
  assert.match(text, /session-pdf -> didit_report_export \(wanted didit_session_generate_pdf\)/);
  assert.match(text, /org-balance -> no tool call: "Which organization\?"/);
  assert.match(text, /all \/ sessions list\/search: didit_session_list x1, didit_session_search x1/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDecisionTrace,
  explainSessionDecision,
} from "../dist/tools/session-explain.js";
import { THRESHOLD_LEVERS } from "../dist/tools/session-explain-levers.js";
import { allConfigKeys } from "../dist/feature-config-schema.js";
import { requestContext } from "../dist/config.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";
import { createServer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";
const SESSION = "0c1a3b0e-7c1d-4a2e-9d51-2f8f5c3a1b0d";

const warning = (feature, risk, log_type, additional_data = null) => ({
  feature,
  risk,
  log_type,
  additional_data,
  short_description: `${risk} short`,
  long_description: `${risk} long`,
  node_id: "node-1",
});

// A decision the way GET /session/{id}/decision/ shapes it: result arrays per feature,
// each item with its own status, raw scores and the warnings the backend logged.
const decision = (overrides = {}) => ({
  session_id: SESSION,
  session_number: 10751,
  status: "Declined",
  status_override: null,
  workflow_id: "stable-1",
  features: ["OCR", "LIVENESS"],
  reviews: [{ new_status: "Declined", previous_status: "In Review" }],
  id_verifications: [
    {
      status: "Approved",
      node_id: "ocr-1",
      first_name: "Ada",
      full_front_image: "https://s3/front.jpg",
      warnings: [
        warning(
          "ID_VERIFICATION",
          "DOCUMENT_BACK_SIDE_NOT_AVAILABLE",
          "information",
        ),
      ],
    },
  ],
  liveness_checks: [
    {
      status: "Declined",
      node_id: "liveness-1",
      score: 0.71,
      method: "PASSIVE",
      warnings: [
        warning("LIVENESS", "LOW_LIVENESS_SCORE", "error", { score: 0.71 }),
      ],
    },
  ],
  ...overrides,
});

// The workflow graph as didit_workflow_get_graph returns it with include_config: the
// node's `feature` is the contract's feature name and `config` holds the live values.
const graph = {
  start_node: "ocr-1",
  nodes: {
    "ocr-1": {
      node_type: "feature",
      feature: "OCR",
      config: {
        status_rules: [
          {
            field: "kyc.issuing_state",
            operator: "not_in",
            value: ["ESP", "PRT"],
            status: "In Review",
          },
        ],
      },
    },
    "liveness-1": {
      node_type: "feature",
      feature: "LIVENESS",
      config: {
        face_liveness_score_review_threshold: 0.8,
        face_liveness_score_decline_threshold: 0.75,
        face_liveness_duplicated_face_name_mismatch_action: "REVIEW",
      },
    },
  },
};

test("declined by a liveness threshold: the trace names the node's feature, the raw score, the threshold keys and their current values", () => {
  const trace = buildDecisionTrace(decision(), graph);

  assert.equal(trace.status, "Declined");
  assert.equal(trace.decided_by, "LIVENESS");
  assert.equal(trace.unexplained, false);
  assert.deepEqual(trace.workflow, { id: "stable-1", graph_read: true });
  const liveness = trace.features.find((f) => f.feature === "LIVENESS");
  assert.deepEqual(liveness.metrics, { score: 0.71, method: "PASSIVE" });
  assert.equal(liveness.causes.length, 1);
  assert.equal(liveness.causes[0].effect, "Declined");
  assert.deepEqual(liveness.causes[0].lever, {
    keys: [
      "face_liveness_score_review_threshold",
      "face_liveness_score_decline_threshold",
    ],
    kind: "threshold",
    match: "exact",
    current: {
      face_liveness_score_review_threshold: 0.8,
      face_liveness_score_decline_threshold: 0.75,
    },
  });
  // Informational warnings are listed, never presented as causes.
  const ocr = trace.features.find((f) => f.feature === "OCR");
  assert.deepEqual(ocr.causes, []);
  assert.deepEqual(ocr.informational, ["DOCUMENT_BACK_SIDE_NOT_AVAILABLE"]);
});

test("without a graph the feature is the one the warnings carry, threshold levers still resolve, by-name ones do not", () => {
  const trace = buildDecisionTrace(decision(), null);
  const liveness = trace.features.find((f) => f.feature === "LIVENESS");
  const byName = buildDecisionTrace(
    decision({
      status: "In Review",
      liveness_checks: [
        {
          status: "In Review",
          node_id: "liveness-1",
          warnings: [warning("LIVENESS", "MULTIPLE_FACES_DETECTED", "warning")],
        },
      ],
    }),
    null,
  );

  assert.deepEqual(trace.workflow, { id: "stable-1", graph_read: false });
  assert.equal(
    trace.features.find((f) => f.feature === "ID_VERIFICATION").status,
    "Approved",
  );
  assert.deepEqual(liveness.causes[0].lever.keys, [
    "face_liveness_score_review_threshold",
    "face_liveness_score_decline_threshold",
  ]);
  assert.deepEqual(liveness.causes[0].lever.current, {});
  // COUNTRY_MISMATCH would otherwise land on bank_country_mismatch_action: no feature, no by-name lever.
  assert.equal(
    byName.features.find((f) => f.feature === "LIVENESS").causes[0].lever,
    null,
  );
});

test("by-name levers need the exact tokens: a subset match named the wrong key", () => {
  const risks = [
    "FACE_FACE_COVERED",
    "MULTIPLE_FACES_DETECTED",
    "VIRTUAL_CAMERA_DETECTED",
    "NAME_NOT_DETECTED",
    "AGE_NOT_DETECTED",
  ];
  const trace = buildDecisionTrace(
    decision({
      status: "In Review",
      liveness_checks: [
        {
          status: "In Review",
          node_id: "liveness-1",
          warnings: risks.map((risk) => warning("LIVENESS", risk, "warning")),
        },
      ],
    }),
    graph,
  );
  const levers = Object.fromEntries(
    trace.features
      .find((f) => f.feature === "LIVENESS")
      .causes.map((c) => [c.risk, c.lever?.keys ?? null]),
  );

  assert.deepEqual(levers, {
    FACE_FACE_COVERED: null,
    MULTIPLE_FACES_DETECTED: ["face_liveness_multiple_faces_action"],
    VIRTUAL_CAMERA_DETECTED: ["virtual_camera_action"],
    NAME_NOT_DETECTED: null,
    AGE_NOT_DETECTED: null,
  });
});

test("a warning's additional_data reaches the trace only through its measurement keys; a rule's actual value only for code fields", () => {
  const dob = {
    field: "kyc.date_of_birth",
    operator: "less_than",
    rule_value: "2008-01-01",
    actual_value: "2010-05-04",
    target_status: "Declined",
  };
  const trace = buildDecisionTrace(
    decision({
      liveness_checks: [
        {
          status: "Declined",
          node_id: "liveness-1",
          score: 0.71,
          age_estimation: 17,
          warnings: [
            warning("LIVENESS", "LOW_LIVENESS_SCORE", "error", {
              score: 0.71,
              mrz: "P<ESP…",
              ip: "10.0.0.1",
            }),
          ],
        },
      ],
      id_verifications: [
        {
          status: "Declined",
          node_id: "ocr-1",
          warnings: [
            warning(
              "ID_VERIFICATION",
              "CUSTOM_STATUS_RULE_TRIGGERED",
              "error",
              dob,
            ),
          ],
        },
      ],
    }),
    graph,
  );
  const text = JSON.stringify(trace);
  const liveness = trace.features.find((f) => f.feature === "LIVENESS");
  const ocr = trace.features.find((f) => f.feature === "OCR");

  assert.deepEqual(liveness.causes[0].value, { score: 0.71 });
  assert.deepEqual(liveness.metrics, { score: 0.71 });
  assert.equal(ocr.causes[0].rule.actual_value, "[redacted]");
  assert.equal(ocr.causes[0].rule.field, "kyc.date_of_birth");
  assert.doesNotMatch(text, /2010-05-04|P<ESP|10\.0\.0\.1|age_estimation|17/);
});

test("the trace carries no images, extracted fields or audit rows", () => {
  const text = JSON.stringify(buildDecisionTrace(decision(), graph));

  assert.doesNotMatch(text, /s3\/front|Ada|previous_status|full_front_image/);
  assert.ok(text.length < 2048, `trace is ${text.length} bytes`);
});

test("in review by a status rule: the rule's field, operator, configured and actual values come through, with the node's status_rules as the lever", () => {
  const rule = {
    field: "kyc.issuing_state",
    operator: "not_in",
    rule_value: ["ESP", "PRT"],
    actual_value: "FRA",
    target_status: "In Review",
  };
  const trace = buildDecisionTrace(
    decision({
      status: "In Review",
      liveness_checks: [
        {
          status: "Approved",
          node_id: "liveness-1",
          score: 0.98,
          warnings: [],
        },
      ],
      id_verifications: [
        {
          status: "In Review",
          node_id: "ocr-1",
          warnings: [
            warning(
              "ID_VERIFICATION",
              "CUSTOM_STATUS_RULE_TRIGGERED",
              "warning",
              rule,
            ),
          ],
        },
      ],
    }),
    graph,
  );
  const ocr = trace.features.find((f) => f.feature === "OCR");

  assert.equal(trace.decided_by, "OCR");
  assert.deepEqual(ocr.causes[0].rule, rule);
  assert.equal(ocr.causes[0].effect, "In Review");
  assert.deepEqual(ocr.causes[0].lever, {
    keys: ["status_rules"],
    kind: "status_rule",
    match: "exact",
    current: { status_rules: graph.nodes["ocr-1"].config.status_rules },
  });
});

test("a reviewer override is surfaced next to the automatic verdict, whose chain is still the one explained", () => {
  const status_override = {
    overridden_at: "2026-09-16T10:00:00Z",
    automatic_status: "Declined",
  };
  const trace = buildDecisionTrace(
    decision({ status: "Approved", status_override }),
    graph,
  );
  const reviewerDeclined = buildDecisionTrace(
    decision({
      status: "Declined",
      status_override: {
        overridden_at: "2026-09-16T10:00:00Z",
        automatic_status: "Approved",
      },
      liveness_checks: [
        {
          status: "Approved",
          node_id: "liveness-1",
          score: 0.98,
          warnings: [],
        },
      ],
    }),
    graph,
  );

  assert.equal(trace.status, "Approved");
  assert.deepEqual(trace.status_override, status_override);
  assert.equal(trace.decided_by, "LIVENESS");
  assert.equal(trace.unexplained, false);
  // Checks approved, a reviewer declined: nothing in the logs decided it and nothing is missing.
  assert.equal(reviewerDeclined.decided_by, null);
  assert.equal(reviewerDeclined.unexplained, false);
});

test("decided_by is null when no feature carries the outcome (a terminal status node declined an all-approved session)", () => {
  const trace = buildDecisionTrace(
    decision({
      liveness_checks: [
        {
          status: "Approved",
          node_id: "liveness-1",
          score: 0.98,
          warnings: [],
        },
      ],
    }),
    graph,
  );

  assert.equal(trace.status, "Declined");
  assert.equal(trace.decided_by, null);
  assert.equal(trace.unexplained, true);
});

test("an action risk resolves to the config key spelling its tokens, by name, only if that key exists, with its current value", () => {
  const trace = buildDecisionTrace(
    decision({
      status: "In Review",
      liveness_checks: [
        {
          status: "In Review",
          node_id: "liveness-1",
          score: 0.97,
          warnings: [
            warning("LIVENESS", "DUPLICATED_FACE_NAME_MISMATCH", "warning"),
            warning("LIVENESS", "SOME_RISK_NOBODY_CONFIGURES", "warning"),
          ],
        },
      ],
    }),
    graph,
  );
  const [named, unknown] = trace.features.find(
    (f) => f.feature === "LIVENESS",
  ).causes;

  assert.deepEqual(named.lever, {
    keys: ["face_liveness_duplicated_face_name_mismatch_action"],
    kind: "action",
    match: "by-name",
    current: { face_liveness_duplicated_face_name_mismatch_action: "REVIEW" },
  });
  assert.equal(unknown.lever, null);
});

test("a non-approved session whose logs carry no effective warning is reported as unexplained, not invented", () => {
  const trace = buildDecisionTrace(
    decision({
      status: "In Review",
      liveness_checks: [
        {
          status: "In Review",
          node_id: "liveness-1",
          warnings: [
            warning("LIVENESS", "AGE_NOT_DETECTED", "information", null),
          ],
        },
      ],
    }),
    graph,
  );

  assert.equal(trace.unexplained, true);
  assert.deepEqual(
    trace.features.find((f) => f.feature === "LIVENESS").causes,
    [],
  );
});

test("a lifecycle status (expired, abandoned…) is neither explained nor unexplained: nothing decided it", () => {
  const trace = buildDecisionTrace(
    decision({
      status: "Expired",
      liveness_checks: [],
      id_verifications: [
        { status: "Not Finished", node_id: "ocr-1", warnings: [] },
      ],
    }),
    graph,
  );

  assert.equal(trace.lifecycle_status, true);
  assert.equal(trace.unexplained, false);
  assert.equal(buildDecisionTrace(decision(), graph).lifecycle_status, false);
});

test("every threshold lever names a key that exists in the feature-config contract", () => {
  const known = new Set(allConfigKeys().map((pair) => pair.split(".")[1]));
  const missing = Object.entries(THRESHOLD_LEVERS).flatMap(([risk, keys]) =>
    keys.filter((key) => !known.has(key)).map((key) => `${risk} → ${key}`),
  );

  assert.deepEqual(missing, []);
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const stubFetch = (routes, calls) => {
  globalThis.fetch = async (url) => {
    const path = String(url).split("?")[0];
    calls.push(path);

    return routes[path]
      ? json(routes[path])
      : json({ detail: "Not found." }, 404);
  };
};

test("with the console's org/app in the request context the graph is read directly, without org discovery", async () => {
  const calls = [];
  stubFetch(
    {
      [`${API}/session/${SESSION}/decision/`]: decision(),
      [`${API}/organization/org-1/application/app-1/verification-settings/stable-1/`]:
        { uuid: "v-1", workflow_id: "stable-1", response_attributes: null },
      [`${API}/organization/org-1/application/app-1/verification-settings/v-1/workflow-graph/`]:
        { graph },
    },
    calls,
  );
  const trace = await requestContext.run(
    {
      accessToken: "tok-explain-0",
      organizationId: "org-1",
      applicationId: "app-1",
    },
    () => explainSessionDecision(SESSION),
  );

  assert.ok(
    !calls.some((path) => path.includes("/organizations/me")),
    "no discovery",
  );
  assert.deepEqual(trace.workflow, { id: "stable-1", graph_read: true });
});

test("explainSessionDecision reads the decision, then the workflow's graph, and folds both", async () => {
  const calls = [];
  stubFetch(
    {
      [`${API}/session/${SESSION}/decision/`]: decision(),
      [`${AUTH}/organizations/me/`]: [{ uuid: "org-1", name: "Org One" }],
      [`${AUTH}/organizations/me/org-1/applications/`]: [
        { uuid: "app-1", name: "App" },
      ],
      [`${API}/organization/org-1/application/app-1/verification-settings/`]: {
        results: [
          { uuid: "v-1", workflow_id: "stable-1", workflow_label: "KYC" },
        ],
      },
      [`${API}/organization/org-1/application/app-1/verification-settings/v-1/`]:
        { uuid: "v-1", response_attributes: null },
      [`${API}/organization/org-1/application/app-1/verification-settings/v-1/workflow-graph/`]:
        { graph },
    },
    calls,
  );
  const trace = await requestContext.run({ accessToken: "tok-explain-1" }, () =>
    explainSessionDecision(SESSION),
  );

  assert.equal(calls[0], `${API}/session/${SESSION}/decision/`);
  assert.ok(
    calls.some((path) => path.endsWith("/v-1/workflow-graph/")),
    "graph read",
  );
  assert.deepEqual(trace.workflow, { id: "stable-1", graph_read: true });
  assert.equal(
    trace.features.find((f) => f.feature === "LIVENESS").causes[0].lever.current
      .face_liveness_score_review_threshold,
    0.8,
  );
});

test("a session whose workflow cannot be read still gets its trace, without current values", async () => {
  const calls = [];
  stubFetch({ [`${API}/session/${SESSION}/decision/`]: decision() }, calls);
  const trace = await requestContext.run({ accessToken: "tok-explain-2" }, () =>
    explainSessionDecision(SESSION),
  );

  assert.deepEqual(trace.workflow, { id: "stable-1", graph_read: false });
  assert.equal(trace.decided_by, "LIVENESS");
});

test("the tool is registered as a read-only session tool", async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client(
    { name: "session-explain-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tool = (await client.listTools()).tools.find(
    (t) => t.name === "didit_session_explain_decision",
  );
  await client.close();
  await server.close();

  assert.ok(tool, "tool listed");
  assert.deepEqual(tool.inputSchema.required, ["session_id"]);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(
    TOOL_PERMISSIONS.didit_session_explain_decision,
    "read:sessions",
  );
});

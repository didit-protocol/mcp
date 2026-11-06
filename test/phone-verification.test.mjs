import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { requestContext } from "../dist/config.js";
import { DiditError } from "../dist/security.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";
import { applicationApiKey, applicationApiKeyHeaders } from "../dist/app-api-key.js";
import { phoneCheck, phoneSend } from "../dist/tools/standalone.js";

// The phone OTP tools are the one standalone pair the console does NOT proxy: there is no
// /organization/{org}/application/{app}/apis/phone/{send,check}/ route (both answer 404 on
// staging and production), so they call the public product APIs at {API}/phone/{send,check}/
// with the application's api-key. Each body below carries the exact field set and literal
// strings of the backend code that returns it (file:line cited); ids, timestamps and the key
// itself are placeholders.

delete process.env.DIDIT_ACCESS_TOKEN;

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";
const ORG = "1f0e6b7a-4c2d-4e11-9a3b-8d5f2c6e0a10";
const APP = "2b7d9c4e-6a1f-4b83-8c2d-9e0f1a2b3c40";
const TOKEN = "tok-user";
// A placeholder, never a live credential: the stub below terminates every request.
const API_KEY = "recorded-application-api-key";
const PHONE = "+14155552671";

// The console application read (declared without a trailing slash), then the owner/admin
// membership read it falls back to.
const CONSOLE_KEY_URL = `${AUTH}/organizations/${ORG}/applications/${APP}`;
const ME_KEY_URL = `${AUTH}/organizations/me/${ORG}/applications/${APP}/`;

// GET /organizations/{org}/applications/{app} (service-didit-auth ApplicationModelSerializer;
// key order asserted by tests/organizations/views/test_application.py:231-253).
const CONSOLE_APPLICATION = {
  uuid: APP,
  permissions: ["read:sessions"],
  name: "Recorded application",
  client_id: "recorded-client-id",
  client_secret: API_KEY,
  website_url: "",
  redirect_uris: [],
  client_secret_updated_at: null,
  client_secret_last_used_at: null,
  previous_client_secret_expires_at: null,
  client_secret_prefix: "",
  client_secret_last4: "",
  created_at: "2026-02-11T09:14:22.318000Z",
  terms_url: "",
  privacy_url: "",
  products: ["phone_verification"],
  description: null,
  logo: null,
  is_app_already_setup: true,
  default_scopes: [],
  mode: "live",
};

// The same read for a role without create:sessions, or a console browser session on a live
// application while LIVE_PRIMARY_SECRET_REVEAL_ONLY is on (serializers/applications.py:100-111).
const CONSOLE_APPLICATION_KEY_HIDDEN = { ...CONSOLE_APPLICATION, client_secret: "" };

// GET /organizations/me/{org}/applications/{app}/ (organizations/views/me.py:65-98, where
// api_key is the client's primary secret).
const ME_APPLICATION = {
  uuid: APP,
  name: "Recorded application",
  client_id: "recorded-client-id",
  api_key: API_KEY,
  website_url: "",
  redirect_uris: [],
  terms_url: "",
  privacy_url: "",
  description: null,
  created_at: "2026-02-11T09:14:22.318000Z",
  products: ["phone_verification"],
};

// has_privileges refusals on the console read, and the hardcoded role check on the
// membership read (me.py:286-287).
const CONSOLE_FORBIDDEN = { detail: "You do not have permission to perform this action." };
const ME_FORBIDDEN = { detail: "Only organization owners and admins can manage applications." };

// The console read for an MCP sign-in whose consented scopes leave out didit:management, the
// scope that grants the `applications` resource (core/permissions.py:312, mcp_scopes.py:50-58).
const CONSOLE_SCOPE_REFUSED = { detail: "This token's scope does not permit this action." };

// POST /phone/send/ 200 (apis/views/phone.py:294-303).
const SEND_SUCCESS = {
  request_id: "6c1d0f2a-3b48-4c57-9d21-7e8f9a0b1c23",
  status: "Success",
  reason: null,
  risk_factors: [],
  vendor_data: "customer-42",
  metadata: { plan: "recorded" },
};

// The same response for a send while an earlier code is still pending (is_retry, phone.py:154-227).
const SEND_RETRY = { ...SEND_SUCCESS, request_id: "7d2e1a3b-4c59-4d68-8e32-8f9a0b1c2d34", status: "Retry" };

// POST /phone/send/ 200 when the number was refused (phone.py:224-228, 277-288).
const SEND_BLOCKED = {
  ...SEND_SUCCESS,
  request_id: "8e3f2b4c-5d6a-4e79-9f43-9a0b1c2d3e45",
  status: "Blocked",
  reason: "suspicious",
  risk_factors: ["disposable_number"],
};

// POST /phone/send/ on a sandbox application: the mock carries no risk_factors
// (core/sandbox/mock_router.py:355-363).
const SEND_SANDBOX = {
  request_id: "1c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  status: "Success",
  reason: null,
  vendor_data: null,
  metadata: null,
};

// POST /phone/check/ on a sandbox application: the mock approves whatever code was sent
// (core/sandbox/mock_router.py:366-383, wired in at phone.py:326-330).
const CHECK_SANDBOX = {
  request_id: "2d5e6f70-8b9c-4dae-9f10-2b3c4d5e6f70",
  status: "Approved",
  message: "The verification code is correct.",
  phone: {
    status: "Approved",
    phone_number: PHONE,
    country_code: null,
    carrier_name: "Sandbox Mobile",
    line_type: "mobile",
    flags: [],
  },
  vendor_data: null,
  metadata: null,
  created_at: "2026-10-16T15:03:27.204000+00:00",
};

// POST /phone/check/ 200 approved (phone.py:459-476; `phone` from PhoneV2Serializer,
// phone/serializers/phone.py:121-148, carrier from CarrierSerializer :42-47, lifecycle :190-300).
const CHECK_APPROVED = {
  request_id: "6c1d0f2a-3b48-4c57-9d21-7e8f9a0b1c23",
  status: "Approved",
  message: "The verification code is correct.",
  phone: {
    status: "Approved",
    phone_number_prefix: "+1",
    phone_number: "4155552671",
    full_number: PHONE,
    country_code: "US",
    country_name: "United States",
    carrier: { name: "Recorded Carrier", type: "mobile" },
    is_disposable: false,
    is_virtual: false,
    verification_method: "whatsapp",
    verification_attempts: 1,
    verified_at: "2026-10-16T14:58:03.412000Z",
    warnings: [],
    lifecycle: [
      {
        type: "PHONE_VERIFICATION_MESSAGE_SENT",
        timestamp: "2026-10-16T14:57:41.118000Z",
        details: { status: "Success", reason: null, channel: "whatsapp", actual_channel: "whatsapp" },
        fee: 0.0687,
      },
      {
        type: "VALID_CODE_ENTERED",
        timestamp: "2026-10-16T14:58:03.401000Z",
        details: { code_tried: "483920", status: "Approved" },
        fee: 0,
      },
      { type: "PHONE_VERIFICATION_APPROVED", timestamp: "2026-10-16T14:58:03.412000Z", details: null, fee: 0 },
    ],
    matches: [],
  },
  vendor_data: "customer-42",
  metadata: { plan: "recorded" },
  created_at: "2026-10-16T14:58:03.420000Z",
};

// POST /phone/check/ 200, wrong code with attempts left (phone.py:426-442).
const CHECK_FAILED = {
  request_id: "9a2b3c4d-5e6f-4a70-8b91-c2d3e4f5a607",
  status: "Failed",
  message: "The verification code is incorrect. Attempts remaining: 2",
  phone: null,
  vendor_data: "customer-42",
  metadata: null,
  created_at: "2026-10-16T15:01:44.551000Z",
};

// POST /phone/check/ 200 for a number with no pending code (phone.py:403-417). This is the
// call the issue accepts as live proof for the check tool: it delivers nothing and bills nothing.
const CHECK_EXPIRED_OR_NOT_FOUND = {
  request_id: "0b3c4d5e-6f70-4b81-9c02-d3e4f5a6b718",
  status: "Expired or Not Found",
  message: "No pending phone verification found in the last 5 minutes.",
  vendor_data: null,
  metadata: null,
  created_at: "2026-10-16T15:02:11.907000Z",
};

// POST /phone/send/ 429 (phone.py:264-275, phone/utils/rate_limit.py:1-8).
const SEND_RATE_LIMITED = {
  detail: "Too many verification attempts. Please try again later.",
  code: "PHONE_RATE_LIMITED",
};

// POST /phone/send/ 403 on a short balance (phone.py:144-148).
const SEND_NO_BALANCE = { error: "You don't have enough credits to perform this request." };

// POST /phone/send/ 403 on a live application before the organization's first top-up
// (phone.py:115-119, applications/models/organization.py:121-125).
const SEND_TOP_UP_REQUIRED = {
  detail:
    "To protect against abuse, phone verification is disabled until your organization's first top-up. " +
    "You can still test it for free on a sandbox application.",
};

const scope = {
  accessToken: TOKEN,
  organizationId: ORG,
  applicationId: APP,
  toolName: "didit_verify_phone_send",
};
const inScope = (run) => requestContext.run(scope, run);

/**
 * One recording fetch stub per test. Routes are keyed by origin+pathname and hold
 * `{ body, status }`; anything unrouted 404s, so an unexpected path is a visible failure.
 * `setRoutes` swaps the table without installing a second mock on the same method.
 */
function stubFetch(t, initial = {}) {
  const calls = [];
  let routes = { ...initial };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const route = routes[`${parsed.origin}${parsed.pathname}`];
    if (route === undefined) return Response.json({ detail: "Not found." }, { status: 404 });
    return Response.json(route.body, { status: route.status ?? 200 });
  });
  return {
    calls,
    setRoutes(next) {
      routes = { ...next };
    },
  };
}

/** The console application read every phone call makes first, overridable per test. */
const keyRoute = (body = CONSOLE_APPLICATION, status = 200) => ({ [CONSOLE_KEY_URL]: { body, status } });

/** The console read refused, and the owner/admin membership read answering `body`. */
const fallbackKeyRoutes = (body = ME_APPLICATION, status = 200) => ({
  [CONSOLE_KEY_URL]: { body: CONSOLE_FORBIDDEN, status: 403 },
  [ME_KEY_URL]: { body, status },
});

const sendRoutes = (body = SEND_SUCCESS, status = 200, keys = keyRoute()) => ({
  ...keys,
  [`${API}/phone/send/`]: { body, status },
});

const checkRoutes = (body = CHECK_APPROVED, status = 200, keys = keyRoute()) => ({
  ...keys,
  [`${API}/phone/check/`]: { body, status },
});

const textOf = (res) => res.content.map((c) => c.text).join("\n");

/** Capture the JSON audit lines written to stderr while `fn` runs (audit-log.test.mjs pattern). */
async function captureAuditLines(fn) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

async function withClient({ authInfo, hosted = true } = {}, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ hosted });
  await server.connect(serverTransport);
  if (authInfo) {
    const onmessage = serverTransport.onmessage?.bind(serverTransport);
    serverTransport.onmessage = (msg, extra) => onmessage?.(msg, { ...extra, authInfo });
  }
  const client = new Client({ name: "phone-verification-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** Run with MCP_PERMISSION_MODE set (permissions.test.mjs pattern). */
async function withMode(mode, fn) {
  const previous = process.env.MCP_PERMISSION_MODE;
  process.env.MCP_PERMISSION_MODE = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MCP_PERMISSION_MODE;
    else process.env.MCP_PERMISSION_MODE = previous;
  }
}

// A Developer: create:sessions without any owner/admin rights (organization_role.py:115-127).
const DEVELOPER = {
  token: TOKEN,
  clientId: "client-1",
  scopes: ["didit:verification", "didit:management", "read:applications", "read:sessions", "create:sessions"],
  extra: { sub: "user-1", organization_id: ORG },
};

// A Reader: reads applications and sessions, never creates them (organization_role.py:21-32).
const READER = {
  token: TOKEN,
  clientId: "client-1",
  scopes: ["didit:verification", "didit:management", "read:applications", "read:sessions", "list:sessions"],
  extra: { sub: "user-2", organization_id: ORG },
};

test("phone send posts to the public API with the application api-key, never the console proxy", async (t) => {
  const { calls } = stubFetch(t, sendRoutes());
  const result = await inScope(() =>
    phoneSend({ phone_number: PHONE, vendor_data: "customer-42", metadata: { plan: "recorded" } }),
  );

  assert.deepEqual(result, SEND_SUCCESS);
  assert.equal(calls.length, 2, "one application read, then the send");
  assert.equal(calls[0].url.href, CONSOLE_KEY_URL);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[1].url.href, `${API}/phone/send/`);
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), {
    phone_number: PHONE,
    vendor_data: "customer-42",
    metadata: { plan: "recorded" },
  });
  assert.equal(calls[1].headers["x-api-key"], API_KEY);
  assert.equal(calls[1].headers["Content-Type"], "application/json");
  assert.match(calls[1].headers["User-Agent"], /^didit-mcp-server\/\S+ tool\/didit_verify_phone_send$/);
  // The public API authenticates with the key alone: no user Bearer rides along.
  assert.equal(calls[1].headers.Authorization, undefined);
  for (const call of calls) {
    assert.ok(!call.url.pathname.includes("/apis/phone/"), `the dead console proxy was called: ${call.url.pathname}`);
    assert.ok(!call.url.pathname.includes("/organization/"), `an org-scoped path was called: ${call.url.pathname}`);
  }
});

test("phone check posts to the public API with the application api-key", async (t) => {
  const { calls } = stubFetch(t, checkRoutes());
  const result = await inScope(() => phoneCheck({ phone_number: PHONE, code: "483920" }));

  assert.deepEqual(result, CHECK_APPROVED);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.href, CONSOLE_KEY_URL);
  assert.equal(calls[1].url.href, `${API}/phone/check/`);
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), { phone_number: PHONE, code: "483920" });
  assert.equal(calls[1].headers["x-api-key"], API_KEY);
  assert.equal(calls[1].headers.Authorization, undefined);
});

test("every send and check outcome is returned unchanged", async (t) => {
  const { setRoutes } = stubFetch(t);
  const outcomes = [
    ["send Success", () => phoneSend({ phone_number: PHONE }), sendRoutes(SEND_SUCCESS), SEND_SUCCESS],
    ["send Retry", () => phoneSend({ phone_number: PHONE }), sendRoutes(SEND_RETRY), SEND_RETRY],
    ["send Blocked", () => phoneSend({ phone_number: PHONE }), sendRoutes(SEND_BLOCKED), SEND_BLOCKED],
    ["send on a sandbox application", () => phoneSend({ phone_number: PHONE }), sendRoutes(SEND_SANDBOX), SEND_SANDBOX],
    [
      "check Approved",
      () => phoneCheck({ phone_number: PHONE, code: "483920" }),
      checkRoutes(CHECK_APPROVED),
      CHECK_APPROVED,
    ],
    [
      "check Failed",
      () => phoneCheck({ phone_number: PHONE, code: "000000" }),
      checkRoutes(CHECK_FAILED),
      CHECK_FAILED,
    ],
    [
      "check Expired or Not Found",
      () => phoneCheck({ phone_number: PHONE, code: "000000" }),
      checkRoutes(CHECK_EXPIRED_OR_NOT_FOUND),
      CHECK_EXPIRED_OR_NOT_FOUND,
    ],
    [
      "check on a sandbox application",
      () => phoneCheck({ phone_number: PHONE, code: "000000" }),
      checkRoutes(CHECK_SANDBOX),
      CHECK_SANDBOX,
    ],
  ];
  for (const [name, run, routes, expected] of outcomes) {
    setRoutes(routes);
    assert.deepEqual(await inScope(run), expected, name);
  }
});

test("a throttled send, a short balance and a first top-up still due surface as structured errors", async (t) => {
  const { calls, setRoutes } = stubFetch(t);
  const failures = [
    ["rate_limited", sendRoutes(SEND_RATE_LIMITED, 429), /Too many verification attempts/],
    ["forbidden", sendRoutes(SEND_NO_BALANCE, 403), /enough credits/],
    ["forbidden", sendRoutes(SEND_TOP_UP_REQUIRED, 403), /first top-up\. You can still test it for free on a sandbox/],
  ];
  for (const [code, routes, message] of failures) {
    setRoutes(routes);
    calls.length = 0;
    await assert.rejects(
      inScope(() => phoneSend({ phone_number: PHONE })),
      (error) =>
        error instanceof DiditError && error.shape.code === code && message.test(error.shape.message),
      `${code} ${message}`,
    );
    assert.equal(calls.length, 2, "a refused send must not retry through the fallback read");
  }
});

test("the api-key is read per call and never cached in module state", async (t) => {
  const { calls } = stubFetch(t, { ...sendRoutes(), ...checkRoutes() });
  await inScope(() => phoneSend({ phone_number: PHONE }));
  await inScope(() => phoneCheck({ phone_number: PHONE, code: "483920" }));
  await inScope(() => phoneSend({ phone_number: PHONE }));

  assert.equal(
    calls.filter((call) => call.url.href === CONSOLE_KEY_URL).length,
    3,
    "each phone call reads the application again",
  );
  assert.equal(calls.length, 6);
});

test("a refused console read falls back to the owner/admin read (a local didit_account_login token)", async (t) => {
  const { calls } = stubFetch(t, sendRoutes(SEND_SUCCESS, 200, fallbackKeyRoutes()));
  const result = await inScope(() => phoneSend({ phone_number: PHONE }));

  assert.deepEqual(result, SEND_SUCCESS);
  assert.deepEqual(
    calls.map((call) => call.url.href),
    [CONSOLE_KEY_URL, ME_KEY_URL, `${API}/phone/send/`],
  );
  assert.equal(calls[1].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[2].headers["x-api-key"], API_KEY);
});

test("a caller neither read lets through is told which roles can, and no phone request is made", async (t) => {
  const { calls } = stubFetch(t, fallbackKeyRoutes(ME_FORBIDDEN, 403));
  await assert.rejects(inScope(() => phoneSend({ phone_number: PHONE })), (error) => {
    assert.ok(error instanceof DiditError);
    assert.equal(error.shape.code, "forbidden");
    assert.equal(error.shape.status, 403);
    assert.match(error.shape.message, /owners and admins/);
    assert.match(error.shape.hint, /create:sessions \(Owner, Admin or Developer\)/);
    assert.match(error.shape.hint, /organization owner or admin/);
    return true;
  });
  assert.deepEqual(
    calls.map((call) => call.url.href),
    [CONSOLE_KEY_URL, ME_KEY_URL],
  );
});

test("a sign-in refused for its scopes is told to add didit:management, and never falls back", async (t) => {
  // The owner/admin read checks the grant's organizations but not its scopes (me.py:263-276), so
  // falling back would hand an owner's verification-only sign-in the key it was not granted.
  const { calls } = stubFetch(t, {
    ...keyRoute(CONSOLE_SCOPE_REFUSED, 403),
    [ME_KEY_URL]: { body: ME_APPLICATION },
    [`${API}/phone/send/`]: { body: SEND_SUCCESS },
  });
  await assert.rejects(inScope(() => phoneSend({ phone_number: PHONE })), (error) => {
    assert.ok(error instanceof DiditError);
    assert.equal(error.shape.code, "missing_scope");
    assert.equal(error.shape.status, 403);
    assert.equal(error.shape.message, CONSOLE_SCOPE_REFUSED.detail);
    assert.match(error.shape.hint, /didit:management scope/);
    assert.ok(!/different role|Owner, Admin or Developer/.test(error.shape.hint), "a scope gap was blamed on the role");
    return true;
  });
  assert.deepEqual(
    calls.map((call) => call.url.href),
    [CONSOLE_KEY_URL],
  );
});

test("any other console read failure is reported as is, without the fallback read", async (t) => {
  const { calls } = stubFetch(t, keyRoute({ detail: "Not found." }, 404));
  await assert.rejects(
    inScope(() => phoneSend({ phone_number: PHONE })),
    (error) => error instanceof DiditError && error.shape.code === "not_found",
  );
  assert.deepEqual(
    calls.map((call) => call.url.href),
    [CONSOLE_KEY_URL],
  );
});

test("a hidden or missing key errors instead of calling the API with a blank one", async (t) => {
  const { calls, setRoutes } = stubFetch(t);
  const blanks = [
    ["console read without create:sessions", keyRoute(CONSOLE_APPLICATION_KEY_HIDDEN)],
    ["console read with a null key", keyRoute({ ...CONSOLE_APPLICATION, client_secret: null })],
    ["console read with no key field", keyRoute({})],
    ["owner/admin read with a hidden key", fallbackKeyRoutes({ ...ME_APPLICATION, api_key: "" })],
    ["owner/admin read with no key field", fallbackKeyRoutes({})],
  ];
  for (const [name, keys] of blanks) {
    setRoutes({ ...keys, [`${API}/phone/send/`]: { body: SEND_SUCCESS } });
    calls.length = 0;
    await assert.rejects(
      inScope(() => phoneSend({ phone_number: PHONE })),
      (error) => {
        assert.ok(error instanceof DiditError);
        assert.equal(error.shape.code, "missing_scope");
        assert.match(error.shape.hint, /create:sessions/);
        assert.match(error.shape.hint, /Didit MCP connector/);
        return true;
      },
      name,
    );
    assert.ok(
      calls.every((call) => !call.url.pathname.includes("/phone/")),
      `${name}: the phone API was called with no key`,
    );
  }
});

test("the api-key read guards both routing ids before any request", async (t) => {
  const { calls } = stubFetch(t, sendRoutes());
  for (const id of ["../unexpected-resource", ".", "..", "one/two", "id?query", "id#fragment"]) {
    for (const override of [{ organizationId: id }, { applicationId: id }]) {
      await assert.rejects(
        requestContext.run({ ...scope, ...override }, () => phoneSend({ phone_number: PHONE })),
        (error) => error instanceof DiditError && error.shape.code === "bad_request",
        JSON.stringify(override),
      );
    }
  }
  assert.equal(calls.length, 0);
});

test("applicationApiKeyHeaders carries the key and nothing else", async (t) => {
  stubFetch(t, keyRoute());
  assert.deepEqual(await inScope(() => applicationApiKeyHeaders()), {
    "Content-Type": "application/json",
    "x-api-key": API_KEY,
  });
  assert.equal(await inScope(() => applicationApiKey()), API_KEY);
});

test("the dispatcher reaches the public API for both tools and never leaks the key", async (t) => {
  const { calls } = stubFetch(t, {
    ...keyRoute(),
    [`${API}/phone/send/`]: { body: SEND_SUCCESS },
    [`${API}/phone/check/`]: { body: CHECK_EXPIRED_OR_NOT_FOUND },
  });

  const auditLines = await captureAuditLines(async () => {
    await withClient({ authInfo: DEVELOPER }, async (client) => {
      const sent = await client.callTool({
        name: "didit_verify_phone_send",
        arguments: { organization_id: ORG, application_id: APP, phone_number: PHONE },
      });
      assert.equal(sent.isError, undefined, textOf(sent));
      assert.deepEqual(JSON.parse(textOf(sent)), SEND_SUCCESS);

      const checked = await client.callTool({
        name: "didit_verify_phone_check",
        arguments: { organization_id: ORG, application_id: APP, phone_number: PHONE, code: "000000" },
      });
      assert.equal(checked.isError, undefined, textOf(checked));
      assert.deepEqual(JSON.parse(textOf(checked)), CHECK_EXPIRED_OR_NOT_FOUND);
    });
  });

  const phoneCalls = calls.filter((call) => call.url.pathname.startsWith("/v3/phone/"));
  assert.deepEqual(
    phoneCalls.map((call) => call.url.pathname),
    ["/v3/phone/send/", "/v3/phone/check/"],
  );
  for (const call of phoneCalls) assert.equal(call.headers["x-api-key"], API_KEY);
  // The routing ids select the application whose key is read; they never reach the phone body.
  for (const call of phoneCalls) {
    const body = JSON.parse(call.body);
    assert.equal(body.organization_id, undefined);
    assert.equal(body.application_id, undefined);
  }

  // The secret travels in one request header and appears nowhere a caller or the log reads.
  const logged = auditLines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  assert.equal(logged.length, 2, "one audit line per call");
  for (const line of auditLines) assert.ok(!line.includes(API_KEY), `the api-key reached the log: ${line}`);
  for (const record of logged) {
    assert.equal(record.event, "mcp.tool_call");
    assert.equal(record.outcome, "ok");
    assert.ok(!record.arg_keys.includes("api_key"));
    assert.ok(!JSON.stringify(record).includes(API_KEY));
  }
  assert.deepEqual(
    logged.map((record) => record.tool),
    ["didit_verify_phone_send", "didit_verify_phone_check"],
  );
});

test("a dispatcher error names the role gate without echoing the key or an internal path", async (t) => {
  const { calls } = stubFetch(t, fallbackKeyRoutes(ME_FORBIDDEN, 403));
  await withClient({ authInfo: DEVELOPER }, async (client) => {
    const res = await client.callTool({
      name: "didit_verify_phone_send",
      arguments: { organization_id: ORG, application_id: APP, phone_number: PHONE },
    });
    assert.equal(res.isError, true);
    const text = textOf(res);
    assert.match(text, /^Error \[forbidden\]: /);
    assert.match(text, /create:sessions/);
    assert.ok(!text.includes(API_KEY));
    assert.ok(!text.includes("/organizations/"), "the internal path must not leak");
  });
  assert.equal(calls.length, 2);
});

test("both phone tools need create:sessions, the permission that unlocks the key", () => {
  // The console application read blanks client_secret for a role without create:sessions
  // (service-didit-auth serializers/applications.py:100-111), and the owner/admin fallback
  // only serves roles that hold it, so no caller without it can run these tools.
  assert.equal(TOOL_PERMISSIONS.didit_verify_phone_send, "create:sessions");
  assert.equal(TOOL_PERMISSIONS.didit_verify_phone_check, "create:sessions");
});

test("enforce mode: a reader is refused before any request, a developer gets through", async (t) => {
  const { calls } = stubFetch(t, sendRoutes());

  const refused = await withMode("enforce", () =>
    withClient({ authInfo: READER }, (client) =>
      client.callTool({
        name: "didit_verify_phone_send",
        arguments: { organization_id: ORG, application_id: APP, phone_number: PHONE },
      }),
    ),
  );
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /^Error \[missing_scope\]/);
  assert.match(textOf(refused), /create:sessions/);
  assert.equal(calls.length, 0, "the refusal must happen before the key is read");

  const allowed = await withMode("enforce", () =>
    withClient({ authInfo: DEVELOPER }, (client) =>
      client.callTool({
        name: "didit_verify_phone_send",
        arguments: { organization_id: ORG, application_id: APP, phone_number: PHONE },
      }),
    ),
  );
  assert.equal(allowed.isError, undefined, textOf(allowed));
  assert.deepEqual(
    calls.map((call) => call.url.href),
    [CONSOLE_KEY_URL, `${API}/phone/send/`],
  );
});

test("the phone tool descriptions describe the endpoints that really exist", async () => {
  await withClient({ authInfo: DEVELOPER }, async (client) => {
    const tools = (await client.listTools()).tools;
    const send = tools.find((tool) => tool.name === "didit_verify_phone_send");
    const check = tools.find((tool) => tool.name === "didit_verify_phone_check");
    assert.ok(send && check);

    assert.match(send.description, /WhatsApp by default/);
    assert.match(send.description, /falling back to SMS/);
    assert.match(send.description, /valid for 5 minutes/);
    assert.match(send.description, /Success.*Retry.*Blocked/s);
    assert.match(send.description, /PHONE_RATE_LIMITED/);
    assert.match(send.description, /403 until the organization's first top-up/);
    assert.ok(!/via SMS\./.test(send.description), "the old SMS-only claim survived");

    assert.match(check.description, /Maximum 3 attempts/);
    assert.match(check.description, /expires 5 minutes/);
    assert.match(check.description, /Approved.*Failed.*Declined.*Expired or Not Found/s);
    assert.match(check.description, /sandbox application mocks the check and approves any code/);

    for (const tool of [send, check]) {
      assert.match(tool.description, /role needs create:sessions \(Owner, Admin or Developer/);
      assert.match(tool.description, /organization owner or admin with a local didit_account_login token/);
      assert.match(tool.description, /MCP sign-in needs the didit:management scope/);
    }

    assert.deepEqual(Object.keys(send.inputSchema.properties).sort(), [
      "application_id",
      "organization_id",
      "phone_number",
    ]);
    assert.deepEqual(send.inputSchema.required, ["phone_number"]);
    assert.deepEqual(check.inputSchema.required, ["phone_number", "code"]);
    assert.match(check.inputSchema.properties.code.description, /WhatsApp or SMS/);
  });
});

test("the local login the phone descriptions name is a tool the local server really lists", async () => {
  // Hosted servers hide the account tools (ACCOUNT_BOOTSTRAP_TOOLS), so check the local catalog.
  await withClient({ hosted: false }, async (client) => {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((tool) => tool.name === "didit_account_login"));
    const send = tools.find((tool) => tool.name === "didit_verify_phone_send");
    const named = send.description.match(/local (didit_[a-z_]+) token/);
    assert.ok(named, "the send description names its local login tool");
    assert.ok(tools.some((tool) => tool.name === named[1]), `${named[1]} is not a tool`);
  });
});

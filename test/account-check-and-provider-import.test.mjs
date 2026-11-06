import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../dist/config.js";
import { DiditError } from "../dist/security.js";
import { TOOL_PERMISSIONS } from "../dist/permissions.js";
import { accountCheck } from "../dist/tools/standalone.js";
import {
  createImport, listImportProviders, checkImportProvider, manageImport,
} from "../dist/tools/sessions.js";
import { argsDigest } from "../dist/audit-log.js";

delete process.env.DIDIT_ACCESS_TOKEN;

const AUTH = "https://apx.didit.me/auth/v2";
const API = "https://verification.didit.me/v3";
const ORG = "1f0e6b7a-4c2d-4e11-9a3b-8d5f2c6e0a10";
const APP = "2b7d9c4e-6a1f-4b83-8c2d-9e0f1a2b3c40";
const API_KEY = "recorded-application-api-key";
const PROVIDER_KEY = "provider-read-only-key-123456";
const scope = { accessToken: "tok-user", organizationId: ORG, applicationId: APP };
const inScope = (run) => requestContext.run(scope, run);

function stubFetch(t, routes) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const route = routes[`${parsed.origin}${parsed.pathname}`];
    if (route === undefined) return Response.json({ detail: "Not found." }, { status: 404 });
    return Response.json(route.body, { status: route.status ?? 200 });
  });
  return { calls };
}

const keyRoute = { [`${AUTH}/organizations/${ORG}/applications/${APP}`]: { body: { uuid: APP, client_secret: API_KEY } } };

const CHECK_BODY = {
  country: "NGA",
  account: { account_number: "0123456789", bank_code: "058" },
  holder: { full_name: "Ada Obi" },
  vendor_data: "payout-7",
  consent: true,
};

test("account check posts to the public API with the application key and sends the body untouched", async (t) => {
  const result = { result: "match", account: "******6789" };
  const { calls } = stubFetch(t, { ...keyRoute, [`${API}/bank/account-check/`]: { body: result } });
  assert.deepEqual(await inScope(() => accountCheck(CHECK_BODY)), result);
  const call = calls.at(-1);
  assert.equal(call.url.href, `${API}/bank/account-check/`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["x-api-key"], API_KEY);
  assert.equal(call.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(call.body), CHECK_BODY);
  assert.ok(!call.url.pathname.includes("/apis/"), "there is no console proxy for the account check");
});

test("account check keeps the consent refusal and the not-yet-available answer visible", async (t) => {
  const { calls } = stubFetch(t, {
    ...keyRoute,
    [`${API}/bank/account-check/`]: {
      status: 400,
      body: { detail: "Account checks in this country need the account holder's explicit consent.", code: "invalid_account_input", field: "consent", reason: "required" },
    },
  });
  const error = await inScope(() => accountCheck({ ...CHECK_BODY, consent: undefined })).then(() => null, (e) => e);
  assert.ok(error instanceof DiditError);
  assert.equal(error.shape.status, 400);
  assert.match(error.message, /consent/);
  assert.equal(JSON.parse(calls.at(-1).body).consent, undefined);
});

test("account check needs create:sessions", () => {
  assert.equal(TOOL_PERMISSIONS.didit_verify_account_check, "create:sessions");
});

test("a provider migration sends credentials to Didit only, and the result never carries them", async (t) => {
  const created = { uuid: "job-1", status: "READY", provider: "sumsub", credentials: { token: PROVIDER_KEY } };
  const { calls } = stubFetch(t, { [`${API}/session/imports/`]: { body: created, status: 201 } });
  const args = {
    source_file_url: "https://files.example.com/ids.csv",
    source: "provider", provider: "sumsub", dry_run: true,
    credentials: { app_token: PROVIDER_KEY, secret_key: "s3cret-value" },
    status_mapping: { Pending: "In Review" },
  };
  const result = await inScope(() => createImport(args));
  assert.equal(result.uuid, "job-1");
  assert.ok(!JSON.stringify(result).includes(PROVIDER_KEY));
  assert.equal("credentials" in result, false);
  assert.deepEqual(JSON.parse(calls[0].body).credentials, args.credentials);
  assert.equal(JSON.parse(calls[0].body).dry_run, true);
  // the audit digest is a hash: it never contains a value
  assert.ok(!argsDigest(args).includes(PROVIDER_KEY));
});

test("a provider error body that echoes the key is redacted before the agent sees it", async (t) => {
  stubFetch(t, { [`${API}/session/imports/`]: { status: 400, body: { code: "invalid_credentials", detail: "The key was refused.", credentials: PROVIDER_KEY } } });
  const error = await inScope(() => createImport({ source: "provider", provider: "sumsub", credentials: { token: PROVIDER_KEY }, source_file_url: "https://files.example.com/x.csv" })).then(() => null, (e) => e);
  assert.ok(error instanceof DiditError);
  assert.ok(!JSON.stringify(error.shape).includes(PROVIDER_KEY));
  assert.ok(!error.message.includes(PROVIDER_KEY));
});

test("provider migration input is validated before any request", async (t) => {
  const { calls } = stubFetch(t, {});
  const base = { source_file_url: "https://files.example.com/x.csv" };
  await assert.rejects(inScope(() => createImport({ ...base, source: "provider" })), /provider is required/);
  await assert.rejects(inScope(() => createImport({ ...base, source: "provider", provider: "sumsub", credentials: "key" })), /credentials must be an object/);
  await assert.rejects(inScope(() => createImport({ ...base, provider: "sumsub", credentials: { token: 1 } })), /credentials must be an object/);
  await assert.rejects(inScope(() => checkImportProvider({ provider: "sumsub", credentials: ["x"] })), /credentials must be an object/);
  await assert.rejects(inScope(() => manageImport("job-1", "delete")), /action must be one of/);
  await assert.rejects(inScope(() => manageImport("../job", "start")), DiditError);
  assert.equal(calls.length, 0);
});

test("providers, provider check and import actions hit the documented routes", async (t) => {
  const { calls } = stubFetch(t, {
    [`${API}/session/imports/providers/`]: { body: [{ id: "sumsub", credential_fields: ["app_token"] }] },
    [`${API}/session/imports/providers/check/`]: { body: { ok: true, credentials: { x: PROVIDER_KEY } } },
    [`${API}/session/imports/job-1/start/`]: { body: { uuid: "job-1", status: "PENDING" } },
    [`${API}/session/imports/job-1/pause/`]: { body: { uuid: "job-1", status: "PAUSED" } },
    [`${API}/session/imports/job-1/retry/`]: { body: { uuid: "job-2" }, status: 201 },
  });
  assert.equal((await inScope(() => listImportProviders()))[0].id, "sumsub");
  const checked = await inScope(() => checkImportProvider({ provider: "sumsub", credentials: { app_token: PROVIDER_KEY } }));
  assert.deepEqual(checked, { ok: true });
  assert.deepEqual(JSON.parse(calls[1].body), { provider: "sumsub", credentials: { app_token: PROVIDER_KEY } });

  await inScope(() => manageImport("job-1", "start", { status_mapping: { Pending: "In Review" }, face_templates: false }));
  assert.deepEqual(JSON.parse(calls[2].body), { status_mapping: { Pending: "In Review" }, face_templates: false });
  await inScope(() => manageImport("job-1", "pause", { credentials: { app_token: PROVIDER_KEY } }));
  assert.deepEqual(JSON.parse(calls[3].body), {}, "an action that takes no body never forwards one");
  const retried = await inScope(() => manageImport("job-1", "retry", { credentials: { app_token: PROVIDER_KEY } }));
  assert.equal(retried.uuid, "job-2");
  assert.deepEqual(JSON.parse(calls[4].body), { credentials: { app_token: PROVIDER_KEY } });
  assert.deepEqual(calls.map((c) => c.url.pathname), [
    "/v3/session/imports/providers/", "/v3/session/imports/providers/check/",
    "/v3/session/imports/job-1/start/", "/v3/session/imports/job-1/pause/", "/v3/session/imports/job-1/retry/",
  ]);
});

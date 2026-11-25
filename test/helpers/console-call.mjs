// Runs one registered tool as a signed-in person in one application, against recorded answers.
import { requestContext } from "../../dist/config.js";
import { DiditError } from "../../dist/security.js";
import { REGISTERED_TOOLS } from "../../dist/tools/registered.js";

export const API = "https://verification.didit.me/v3";
export const AUTH = "https://apx.didit.me/auth/v2";
export const ORG = "1f0e6b7a-4c2d-4e11-9a3b-8d5f2c6e0a10";
export const APP = "2b7d9c4e-6a1f-4b83-8c2d-9e0f1a2b3c40";
export const SESSION = "0c1a3b0e-7c1d-4a2e-9d51-2f8f5c3a1b0d";
export const OA = `/organization/${ORG}/application/${APP}`;

/** `answer(call)` returns the body, or { status, body }. Returns the recorded calls. */
export function backend(t, answer = () => ({})) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const parsed = new URL(String(url));
    const call = {
      method: init.method ?? "GET",
      path: String(url).startsWith(API) ? parsed.pathname.replace("/v3", "") : `${parsed.origin}${parsed.pathname}`,
      query: Object.fromEntries(parsed.searchParams),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: init.headers ?? {},
    };
    calls.push(call);
    const answered = (await answer(call)) ?? {};
    const status = typeof answered.status === "number" && "body" in answered ? answered.status : 200;

    return Response.json("body" in answered ? answered.body : answered, { status });
  });

  return calls;
}

export const person = (run) =>
  requestContext.run({ accessToken: "person.token", organizationId: ORG, applicationId: APP }, run);

/** Async, so a refusal before the request rejects like a failed call. */
export const call = async (name, args = {}) => person(() => REGISTERED_TOOLS.get(name).run(args));

/** The request of a recorded call, without its headers. */
export const request = ({ method, path, query, body }) => ({ method, path, query, body });

export const refusal = (expected) => (error) =>
  error instanceof DiditError && Object.entries(expected).every(([key, value]) => (value instanceof RegExp ? value.test(error.shape[key]) : error.shape[key] === value));

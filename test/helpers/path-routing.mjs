import { test } from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../../dist/config.js";
import { DiditError } from "../../dist/security.js";

export const scope = { organizationId: "synthetic-org", applicationId: "synthetic-app", accessToken: "synthetic-token" };

export function inScope(run) {
  return requestContext.run(scope, run);
}

// No backend or network transport: every request terminates in this recording stub.
export function interceptFetch(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), ...init });
    return Response.json({ uuid: "synthetic-workflow", status: "draft" });
  });
  return calls;
}

export function testRoutingHandlers(handlers) {
  for (const [name, run, hasScopeFallback] of handlers) {
    test(`${name}: rejects routing syntax before fetch`, async (t) => {
      const calls = interceptFetch(t);
      for (const id of ["../unexpected-resource", ".", "..", "one/two", "id?query", "id#fragment", ""]) {
        if (id === "" && hasScopeFallback) continue;
        await assert.rejects(inScope(() => run(id)), (error) => error instanceof DiditError && error.shape.code === "bad_request", id);
      }
      assert.equal(calls.length, 0);
    });
  }
}

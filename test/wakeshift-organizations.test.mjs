import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { handleBackendEvent, sessionStatusUpdatedBody, sessionWebhookDeliveryBody, sign, signingKey } from "../dist/backend-events.js";
import {
  MEMBERSHIP_MAX_ENTRIES,
  MEMBERSHIP_TTL_MS,
  createWakeshiftAccess,
  createWatchable,
  describeOrganizations,
  organizationAllowed,
  organizationOf,
  wakeshiftOrganizations,
} from "../dist/wakeshift-organizations.js";

/**
 * WAKESHIFT_ORGANIZATIONS (src/wakeshift-organizations.ts): the roll-out's list. For an
 * organization that is not on it the server is the server it is with Wakeshift off, and nothing
 * about it is emitted. No network and no SDK: these are the decisions http.ts makes with it.
 */

const LISTED = "0b6d1f7e-4a53-4c1e-9f0a-6c2f3d4e5a61";
const OTHER = "9e8d7c6b-5a49-4382-8170-6f5e4d3c2b1a";
const KEY = signingKey("whsec_" + randomBytes(32).toString("base64"));
const signed = (body, id = "evt_org") => {
  const timestamp = Math.floor(Date.now() / 1000);
  return { id, timestamp: String(timestamp), signature: sign(KEY, id, timestamp, body) };
};

const STATUS = {
  event_id: "11111111-2222-4333-8444-555555555555",
  session_id: "0c1a3b0e-7c1d-4a2e-9d51-2f8f5c3a1b0d",
  application_id: "app-1",
  status: "Approved",
  updated_at: "2026-11-10T19:00:00Z",
};

test("unset or a list naming * is every organization; a list is that list; set and empty is none", () => {
  assert.deepEqual(wakeshiftOrganizations(undefined), { all: true });
  assert.deepEqual(wakeshiftOrganizations("*"), { all: true });
  assert.deepEqual(wakeshiftOrganizations(`${LISTED}, *`), { all: true });

  const list = wakeshiftOrganizations(` ${LISTED.toUpperCase()} ,, ${OTHER} `);
  assert.equal(list.all, false);
  assert.deepEqual([...list.ids].sort(), [LISTED, OTHER].sort());

  for (const none of ["", "   ", " , "]) {
    const parsed = wakeshiftOrganizations(none);
    assert.equal(parsed.all, false, `"${none}" is a list`);
    assert.equal(parsed.ids.size, 0, `"${none}" names nobody`);
  }
});

test("with a list, only a listed organization is allowed; an unknown one never is", () => {
  const list = wakeshiftOrganizations(LISTED);
  assert.equal(organizationAllowed(list, LISTED), true);
  assert.equal(organizationAllowed(list, ` ${LISTED.toUpperCase()} `), true, "an ID is matched whatever its case");
  assert.equal(organizationAllowed(list, OTHER), false);
  for (const unknown of [undefined, null, "", 42, {}, [LISTED]]) {
    assert.equal(organizationAllowed(list, unknown), false, `${JSON.stringify(unknown)} is not on the list`);
  }
  assert.equal(organizationAllowed(wakeshiftOrganizations(""), LISTED), false, "an empty list allows nobody");

  const everyone = wakeshiftOrganizations(undefined);
  assert.equal(organizationAllowed(everyone, OTHER), true);
  assert.equal(organizationAllowed(everyone, undefined), true, "with no list nothing needs to be known");
});

test("a connection's organization is the one its token names, and a sign-in tied to none has none", () => {
  assert.equal(organizationOf({ extra: { sub: "user-1", organization_id: LISTED } }), LISTED);
  assert.equal(organizationOf({ extra: { sub: "user-1" } }), undefined);
  assert.equal(organizationOf({ extra: { organization_id: "  " } }), undefined);
  assert.equal(organizationOf({ extra: { organization_id: 7 } }), undefined);
  assert.equal(organizationOf(undefined), undefined);
});

/** A membership lookup that counts its calls and answers from a table by token. */
function lookup(table) {
  const asked = [];
  const fn = async (token) => {
    asked.push(token);
    const answer = table[token];
    if (answer instanceof Error) throw answer;
    return answer ?? [];
  };
  return { fn, asked };
}

test("with no list every connection is offered wakes, and nobody's memberships are read", async () => {
  const { fn, asked } = lookup({});
  const offered = createWakeshiftAccess(wakeshiftOrganizations(undefined), fn);
  assert.equal(await offered({ token: "tok.ada.sig", extra: { sub: "ada" } }), true);
  assert.equal(await offered(undefined), true);
  assert.deepEqual(asked, []);
});

test("a token that names an organization is decided by it alone: an API key always is", async () => {
  const { fn, asked } = lookup({ "sk_live_key": [LISTED] });
  const offered = createWakeshiftAccess(wakeshiftOrganizations(LISTED), fn);
  assert.equal(await offered({ token: "sk_live_key", extra: { organization_id: LISTED, sub: "app-1" } }), true);
  // Named and not listed: no, whatever else the person might belong to.
  assert.equal(await offered({ token: "sk_live_key", extra: { organization_id: OTHER, sub: "app-2" } }), false);
  assert.deepEqual(asked, [], "the token already said which organization");
});

test("a sign-in that names no organization is offered wakes when the person belongs to a listed one", async () => {
  const { fn, asked } = lookup({ "tok.ada.sig": [OTHER, LISTED.toUpperCase()], "tok.bob.sig": [OTHER], "tok.eve.sig": [] });
  const offered = createWakeshiftAccess(wakeshiftOrganizations(LISTED), fn);
  assert.equal(await offered({ token: "tok.ada.sig", extra: { sub: "ada" } }), true);
  assert.equal(await offered({ token: "tok.bob.sig", extra: { sub: "bob" } }), false);
  assert.equal(await offered({ token: "tok.eve.sig", extra: { sub: "eve" } }), false);
  assert.equal(await offered({ extra: { sub: "nobody" } }), false, "no token, nothing to ask with");
  assert.equal(await offered(undefined), false);
  assert.deepEqual(asked, ["tok.ada.sig", "tok.bob.sig", "tok.eve.sig"]);
});

test("a person's answer is remembered for ten minutes, yes or no, then asked again", async () => {
  const table = { "tok.ada.sig": [LISTED], "tok.bob.sig": [OTHER] };
  const { fn, asked } = lookup(table);
  let clock = 1_000_000;
  const offered = createWakeshiftAccess(wakeshiftOrganizations(LISTED), fn, () => clock);
  const ada = { token: "tok.ada.sig", extra: { sub: "ada" } };
  const bob = { token: "tok.bob.sig", extra: { sub: "bob" } };

  assert.deepEqual([await offered(ada), await offered(bob), await offered(ada), await offered(bob)], [true, false, true, false]);
  assert.deepEqual(asked, ["tok.ada.sig", "tok.bob.sig"], "each person asked once");

  // Bob joins the listed organization: seen once his answer has aged out, not before.
  table["tok.bob.sig"] = [OTHER, LISTED];
  clock += MEMBERSHIP_TTL_MS - 1;
  assert.equal(await offered(bob), false);
  clock += 2;
  assert.equal(await offered(bob), true);
  assert.equal(asked.filter((t) => t === "tok.bob.sig").length, 2);
});

test("a lookup that fails answers no and is not remembered: the next request asks again", async () => {
  const table = { "tok.ada.sig": new Error("auth service unreachable") };
  const { fn, asked } = lookup(table);
  const offered = createWakeshiftAccess(wakeshiftOrganizations(LISTED), fn);
  const ada = { token: "tok.ada.sig", extra: { sub: "ada" } };
  assert.equal(await offered(ada), false);
  table["tok.ada.sig"] = [LISTED];
  assert.equal(await offered(ada), true);
  assert.equal(asked.length, 2);
});

test("what is remembered is bounded: the oldest answer goes when the table is full", async () => {
  const { fn, asked } = lookup({});
  const offered = createWakeshiftAccess(wakeshiftOrganizations(LISTED), fn);
  for (let i = 0; i <= MEMBERSHIP_MAX_ENTRIES; i += 1) await offered({ token: `tok.${i}.sig`, extra: {} });
  assert.equal(asked.length, MEMBERSHIP_MAX_ENTRIES + 1);
  // The newest is remembered; the very first was pushed out and is asked again.
  await offered({ token: `tok.${MEMBERSHIP_MAX_ENTRIES}.sig`, extra: {} });
  assert.equal(asked.length, MEMBERSHIP_MAX_ENTRIES + 1);
  await offered({ token: "tok.0.sig", extra: {} });
  assert.equal(asked.length, MEMBERSHIP_MAX_ENTRIES + 2);
});

test("a call may watch when it acts in a listed organization, and nobody's memberships are read for it", async () => {
  let reads = 0;
  const memberships = async () => ((reads += 1), [LISTED]);
  const list = wakeshiftOrganizations(LISTED);
  assert.equal(await createWatchable(list, () => LISTED, memberships)(), true);
  assert.equal(await createWatchable(list, () => OTHER, memberships)(), false);
  assert.equal(await createWatchable(wakeshiftOrganizations(undefined), () => undefined, memberships)(), true, "no list");
  assert.equal(reads, 0);
});

test("a call that resolved no organization may watch only when every organization of the person is listed", async () => {
  // A person with several organizations watching a session by its ID: it belongs to one of them.
  const list = wakeshiftOrganizations(`${LISTED},${OTHER}`);
  const acting = () => undefined;
  assert.equal(await createWatchable(list, acting, async () => [LISTED, OTHER.toUpperCase()])(), true);
  assert.equal(await createWatchable(wakeshiftOrganizations(LISTED), acting, async () => [LISTED, OTHER])(), false, "one of theirs is not listed");
  assert.equal(await createWatchable(wakeshiftOrganizations(LISTED), acting, async () => [])(), false, "no organization at all");
  assert.equal(
    await createWatchable(wakeshiftOrganizations(LISTED), acting, async () => {
      throw new Error("auth service unreachable");
    })(),
    false,
    "a read that fails answers no",
  );
});

test("a notification about a listed organization is emitted, and the organization never reaches the emit", async () => {
  const list = wakeshiftOrganizations(LISTED);
  const accepts = (organizationId) => organizationAllowed(list, organizationId);
  const emitted = [];
  const emit = async (b) => emitted.push(b);

  const body = JSON.stringify({ ...STATUS, organization_id: LISTED });
  assert.equal((await handleBackendEvent(KEY, signed(body), body, sessionStatusUpdatedBody, emit, accepts)).status, 204);
  assert.deepEqual(emitted, [STATUS], "emitted as the body without its organization");

  // The delivery emit forwards its whole body (wakeshift.ts): the organization must already be gone.
  const delivery = {
    delivery_id: "d-1",
    session_id: STATUS.session_id,
    webhook_type: "status.updated",
    destination_host: "hooks.example.com",
    response_status: 200,
    attempted_at: "2026-11-10T19:00:01Z",
  };
  const deliveryBody = JSON.stringify({ ...delivery, organization_id: LISTED });
  assert.equal((await handleBackendEvent(KEY, signed(deliveryBody), deliveryBody, sessionWebhookDeliveryBody, emit, accepts)).status, 204);
  assert.deepEqual(emitted[1], delivery);
  assert.equal(JSON.stringify(emitted).includes(LISTED), false, "nothing emitted names the organization");
});

test("a notification about another organization, or naming none, is answered 204 and never emitted", async () => {
  const list = wakeshiftOrganizations(LISTED);
  const accepts = (organizationId) => organizationAllowed(list, organizationId);
  let emits = 0;
  const emit = async () => void (emits += 1);

  const other = JSON.stringify({ ...STATUS, organization_id: OTHER });
  assert.deepEqual(await handleBackendEvent(KEY, signed(other), other, sessionStatusUpdatedBody, emit, accepts), { status: 204 });

  const unnamed = JSON.stringify(STATUS);
  assert.deepEqual(await handleBackendEvent(KEY, signed(unnamed), unnamed, sessionStatusUpdatedBody, emit, accepts), { status: 204 });
  assert.equal(emits, 0, "with a list, what cannot be placed is not forwarded");

  // The signature is still checked first: an unsigned notification is refused, never silently dropped.
  const forged = await handleBackendEvent(KEY, { ...signed(other), signature: "v1,AAAA" }, other, sessionStatusUpdatedBody, emit, accepts);
  assert.equal(forged.status, 401);
});

test("with no list the handler is unchanged: a body naming no organization is emitted, and a named one is stripped", async () => {
  const emitted = [];
  const emit = async (b) => emitted.push(b);
  const unnamed = JSON.stringify(STATUS);
  assert.equal((await handleBackendEvent(KEY, signed(unnamed), unnamed, sessionStatusUpdatedBody, emit)).status, 204);
  const named = JSON.stringify({ ...STATUS, organization_id: OTHER });
  assert.equal((await handleBackendEvent(KEY, signed(named), named, sessionStatusUpdatedBody, emit)).status, 204);
  assert.deepEqual(emitted, [STATUS, STATUS]);
});

test("an organization_id that is not a short string is refused with its name, like any other field", async () => {
  let emits = 0;
  const emit = async () => void (emits += 1);
  for (const organization_id of [42, "", "x".repeat(201), { id: LISTED }]) {
    const body = JSON.stringify({ ...STATUS, organization_id });
    const refused = await handleBackendEvent(KEY, signed(body), body, sessionStatusUpdatedBody, emit);
    assert.equal(refused.status, 400, JSON.stringify(organization_id));
    assert.deepEqual(refused.body.fields, ["organization_id"]);
  }
  const both = JSON.stringify({ session_id: STATUS.session_id, organization_id: 42 });
  const refused = await handleBackendEvent(KEY, signed(both), both, sessionStatusUpdatedBody, emit);
  assert.deepEqual(refused.body.fields.sort(), ["application_id", "event_id", "organization_id", "status", "updated_at"]);
  assert.equal(emits, 0);
});

test("the startup line says how many organizations, never which", () => {
  assert.equal(describeOrganizations(wakeshiftOrganizations(undefined)), "every organization");
  assert.equal(describeOrganizations(wakeshiftOrganizations(LISTED)), "1 organization");
  assert.equal(describeOrganizations(wakeshiftOrganizations(`${LISTED},${OTHER}`)), "2 organizations");
  assert.equal(describeOrganizations(wakeshiftOrganizations("")), "0 organizations");
  assert.equal(describeOrganizations(wakeshiftOrganizations(`${LISTED},${OTHER}`)).includes(LISTED), false);
});

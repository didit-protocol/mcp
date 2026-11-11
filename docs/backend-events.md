# Backend events: telling the MCP server what changed

Agents using this MCP server can ask to be woken when something in Didit changes,
instead of polling: a verification session's status, a session going to manual
review, a webhook delivery, an import job finishing, a transaction's status. The
server wakes them through [Wakeshift](https://wakeshift.ai), which wakes Claude
Code, Codex, ChatGPT, Cursor and other agents in the conversation that asked.

The server has no other way to learn that something changed: it doesn't poll
Didit's API. The **Didit backend** reports each change to the MCP server with a
signed HTTP request, and the server wakes the conversations watching it at once.
Until the backend does, leave this off: the watch tools are offered only when
it's configured.

This guide is for whoever implements the backend side. It's written so you can
hand it to a coding agent in the backend's repository as is.

## What agents get

| Tool | What it watches | Event |
| --- | --- | --- |
| `didit_session_create` | the session it creates | `session.status.updated` |
| `didit_session_watch` (new) | an existing session, after reading it with the caller's credential | `session.status.updated` |
| `didit_session_watch_reviews` (new) | one application's sessions going to In Review, after listing its sessions with the caller's credential | `session.in_review` |
| `didit_session_webhooks` | the session's webhook deliveries, for an hour, when called without `wait_seconds` (with it, the call waits as before and watches nothing) | `session.webhook_delivery.logged` |
| `didit_session_create_import`, `didit_session_manage_import` (start, resume, retry) | the import job, until it finishes | `session_import.finished` |
| `didit_transaction_create` | the transaction it submits | `transaction.status.updated` |
| `didit_transaction_watch_reviews` (new) | one application's transactions going to IN_REVIEW, after listing its transactions with the caller's credential | `transaction.in_review` |

Every event carries IDs, statuses, counts and times only. The agent reads the
details with the existing tools (`didit_session_get_decision`,
`didit_session_get_import`, `didit_transaction_get`…) under its own credential,
so Wakeshift never sees personal data, decisions, documents or webhook payloads.

A watch also delivers the latest change reported shortly before it (two minutes
for the watch tools, which read first; ten minutes for `didit_session_create`,
`didit_session_webhooks` and `didit_transaction_create`; an hour
for imports), so a change reported between a tool's call and its subscribe still
wakes the agent.

### Toolsets, read-only mode and API keys

- **Toolsets.** The watch tools belong to the toolsets of the tools they extend,
  by their names: `didit_session_watch` and `didit_session_watch_reviews` to
  `sessions`, `didit_transaction_watch_reviews` to `transactions`. They aren't
  in `core`, which keeps Didit's list as it is: its `didit_session_create` and
  `didit_session_webhooks` already watch what they start and read, and the
  watch tools are one `didit_tool_search` away. A tool that subscribes takes
  Wakeshift's arguments and says what it wakes for in every selection that
  lists it, and `didit_tool_call_read` and `didit_tool_call_write` take them
  too, so a tool run through them subscribes like a direct call.
- **Read-only mode.** The watch tools are reads: they read Didit to check
  access and change no Didit data (a watch is the conversation's own and ends
  on its own). So `read_only=true` lists them and `didit_tool_call_read` runs
  them, and `didit_session_webhooks` keeps watching deliveries. Every tool that
  writes stays refused, so nothing that creates a session, an import or a
  transaction subscribes there. Wakeshift's own `list_subscriptions` and
  `unsubscribe_events`, which act only on the conversation's own watches, are
  listed too.
- **Role permissions.** Each watch tool needs the role permission of the read
  it makes: `read:sessions` for `didit_session_watch`, `list:sessions` and
  `list:transactions` for the review-queue watches. In `enforce` mode a role
  without it isn't offered the tool and can't run it.
- **API key connections.** A connection with an application API key acts as
  that one application. Its access checks go out with its own key as
  `x-api-key`, and it can watch only its application. Wakeshift knows it by an
  opaque hash of the application and the key's ID, never the key: each key is
  its own subscriber, and a person's sign-in is another.

## What the backend sends

Four notifications, each a `POST` to the MCP server with a small JSON body:

| Route | When |
| --- | --- |
| `/internal/events/session-status-updated` | A verification session's status changes. |
| `/internal/events/session-webhook-delivery` | A webhook delivery attempt for a session is logged. |
| `/internal/events/session-import-finished` | An import job finishes. |
| `/internal/events/transaction-status-updated` | A monitored transaction is created with its verdict, or its status changes. |

Every request looks like this:

```http
POST /internal/events/session-status-updated
Content-Type: application/json
webhook-id: <unique ID for this notification>
webhook-timestamp: <Unix time in seconds>
webhook-signature: v1,<signature>

{ ...the body below... }
```

**Send each notification for every change, whether or not anyone is watching**,
for every application, live and sandbox. The backend can't know who is
watching, and Wakeshift delivers only to conversations subscribed to that
session, job, transaction or application. Send them alongside the customer
webhooks you already fire (`status.updated`, `transaction.created`,
`transaction.status.updated`), whether or not the application has a webhook
destination configured.

**Never put personal data in a body**: no names, emails, phone numbers,
`vendor_data`, `metadata`, decisions, documents, or webhook payloads and
headers. The bodies below are the whole contract; the server drops fields it
doesn't know.

### Session status: `/internal/events/session-status-updated`

Send it every time a verification session's status changes: wherever the
backend fires `status.updated` to customers, and for changes made in the
console, by the API, by a reviewer, by the Investigator, by `simulate`, or by
expiry.

```json
{
  "event_id": "d0d5b8a2-0d4e-4c6b-9b0f-3a1f9e6c2b11",
  "session_id": "0c1a3b0e-7c1d-4a2e-9d51-2f8f5c3a1b0d",
  "application_id": "2b7d9c4e-6a1f-4b83-8c2d-9e0f1a2b3c40",
  "status": "In Review",
  "updated_at": "2026-11-10T19:00:00Z"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `event_id` | string | The `event_id` of the matching `status.updated` webhook. If no customer webhook goes out for this change, any ID unique to this change. The same on every retry. |
| `session_id` | string | The session's ID, as `didit_session_create` returns it and `didit_session_get_decision` takes it. |
| `application_id` | string | The application the session belongs to. |
| `status` | string | The new status, exactly as the API returns it: `Not Started`, `In Progress`, `In Review`, `Approved`, `Declined`, `Expired`, `Abandoned`, `Kyc Expired`, `Resubmitted`, `Awaiting User`. |
| `updated_at` | string | When the status changed, ISO 8601 in UTC. |

Send every status, `Not Started` and `In Progress` included. The server decides
what wakes agents: a session's watchers wake only for a final status
(`Approved`, `Declined`, `Expired`, `Abandoned`, `Kyc Expired`), since the
others mean the decision is still to come. `In Review` wakes only the
application's review-queue watchers.

### Webhook delivery: `/internal/events/session-webhook-delivery`

Send it every time the backend logs a webhook delivery attempt for a session:
each row `GET /session/{id}/webhooks/` returns, including retries and resends.

```json
{
  "delivery_id": "5a3e0c2b-1d4f-4c6a-8b7e-9f0a1b2c3d4e",
  "session_id": "0c1a3b0e-7c1d-4a2e-9d51-2f8f5c3a1b0d",
  "webhook_type": "status.updated",
  "destination_host": "api.acme.com",
  "response_status": 401,
  "attempted_at": "2026-11-10T19:00:01Z"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `delivery_id` | string | The delivery log row's `uuid` (the `webhook_id` that `didit_session_webhook_resend` takes). |
| `session_id` | string | The session the delivery was for. |
| `webhook_type` | string | The delivered webhook's `webhook_type`, such as `status.updated` or `data.updated`. |
| `destination_host` | string | The **host** of the destination URL (and its port, if any): `api.acme.com`. Never the full URL, which can carry a customer's token in its path or query. |
| `response_status` | integer or `null` | The HTTP status the destination answered. `null` when no response came back (a timeout, a refused connection, a TLS error). |
| `attempted_at` | string | When the attempt was made, ISO 8601 in UTC. |

Never send the request body, the signing headers or the response body.

### Import finished: `/internal/events/session-import-finished`

Send it once when an import job (`/session/imports/`) reaches one of these
statuses:

- `READY`, when a **dry run** finishes;
- `COMPLETED`, `FAILED` or `CANCELLED`.

```json
{
  "import_id": "9f2b6c1e-3d4a-4b5c-8e7f-0a1b2c3d4e5f",
  "status": "COMPLETED",
  "import_type": "user_verification",
  "total_rows": 1200,
  "processed_rows": 1200,
  "created_count": 1180,
  "updated_count": 0,
  "skipped_count": 12,
  "failed_count": 8,
  "finished_at": "2026-11-10T19:05:00Z"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `import_id` | string | The job's `uuid`, as `didit_session_create_import` returns it and `didit_session_get_import` takes it. |
| `status` | string | `READY`, `COMPLETED`, `FAILED` or `CANCELLED`. Anything else is refused with `400`. |
| `import_type` | string | `user_verification`, `business_verification`, `status_rules` or `transactions`. |
| `total_rows`, `processed_rows`, `created_count`, `updated_count`, `skipped_count`, `failed_count` | integer or `null` | The job's counts when it finished, as `GET /session/imports/{id}/` returns them. `null` for one the job doesn't have. |
| `finished_at` | string | When it reached this status (`completed_at`, or `updated_at`), ISO 8601 in UTC. |

Never send `last_error`, row errors, file names or provider details: the agent
reads them with `didit_session_get_import` and `didit_session_get_import_errors`.

A job that finishes its dry run and is then started sends twice: `READY`, then
its final status. The server tells them apart, so an agent waiting on the real
import isn't woken by the dry run.

### Transaction status: `/internal/events/transaction-status-updated`

Send it when a monitored transaction is created with its first verdict, and
every time its status changes after that: wherever the backend fires
`transaction.created` and `transaction.status.updated` to customers. Unlike
those webhooks, send it for sandbox applications too.

```json
{
  "event_id": "4c3b2a19-8f7e-4d6c-9b5a-1e2d3c4b5a69",
  "transaction_id": "7e0d9c8b-6a5f-4e3d-8c2b-1a0f9e8d7c6b",
  "txn_id": "order-12345",
  "application_id": "2b7d9c4e-6a1f-4b83-8c2d-9e0f1a2b3c40",
  "status": "IN_REVIEW",
  "updated_at": "2026-11-10T19:00:00Z"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `event_id` | string | The `event_id` of the matching `transaction.created` or `transaction.status.updated` webhook; otherwise any ID unique to this change. The same on every retry. |
| `transaction_id` | string | Didit's ID for the transaction (as in the webhooks). |
| `txn_id` | string | The customer's own transaction ID: the `transaction_id` that `didit_transaction_create` was called with. Agents' watches are keyed by this and `application_id`. |
| `application_id` | string | The application the transaction belongs to. |
| `status` | string | The new status, as the API returns it: `APPROVED`, `IN_REVIEW`, `DECLINED`, `AWAITING_USER`… |
| `updated_at` | string | When it changed, ISO 8601 in UTC. |

A transaction's watchers wake only for a final status (`APPROVED`, `DECLINED`,
`CANCELLED`). `IN_REVIEW` wakes only the application's flagged-transaction
watchers.

### Limits

Each ID is at most 200 characters, each timestamp at most 64, and the body at
most 16 KB. Statuses are letters, spaces, `_` and `-`, at most 64 characters.

## Signing

Requests are signed with [Standard Webhooks](https://www.standardwebhooks.com/),
which has libraries for most languages (`standardwebhooks` on npm and PyPI, and
others listed on its site). The shared secret is `DIDIT_EVENTS_SECRET`, which
has the form `whsec_` followed by base64 (at least 24 bytes; 32 is typical).

If you sign by hand:

1. `webhook-id`: an ID unique to this notification. Reuse it on retries.
2. `webhook-timestamp`: the current Unix time, in seconds.
3. The signed content is `<webhook-id>.<webhook-timestamp>.<body>`, where
   `<body>` is the exact bytes you send.
4. The key is the base64 after `whsec_`, decoded.
5. `webhook-signature` is `v1,` followed by the base64 HMAC-SHA256 of the signed
   content with that key.

The server refuses a timestamp more than 5 minutes from its own clock. During a
secret rotation, send several signatures separated by spaces
(`v1,<new> v1,<old>`); one valid signature is enough.

Node, with the `standardwebhooks` package:

```ts
import { randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";

const wh = new Webhook(process.env.DIDIT_EVENTS_SECRET!);

/** route: "session-status-updated", "session-webhook-delivery", "session-import-finished" or "transaction-status-updated". */
export async function notifyMcp(route: string, payload: Record<string, unknown>, id: string = randomUUID()) {
  const body = JSON.stringify(payload);
  const timestamp = new Date();
  const res = await fetch(`${process.env.MCP_SERVER_URL}/internal/events/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": wh.sign(id, timestamp, body),
    },
    body,
  });
  if (res.status === 404) return; // Wakeshift is off on that server: drop it
  if (res.status !== 204) throw new Error(`MCP notification ${route} failed: ${res.status}`);
}

// For example, where status.updated is fired:
await notifyMcp("session-status-updated", {
  event_id: webhookEvent.event_id,
  session_id: session.id,
  application_id: session.applicationId,
  status: session.status,
  updated_at: new Date().toISOString(),
}, webhookEvent.event_id);
```

Python, with the `standardwebhooks` package:

```python
import json
import os
import uuid
from datetime import datetime, timezone

import httpx
from standardwebhooks import Webhook

wh = Webhook(os.environ["DIDIT_EVENTS_SECRET"])


def notify_mcp(route: str, payload: dict, notification_id: str | None = None) -> None:
    """route: session-status-updated, session-webhook-delivery, session-import-finished or transaction-status-updated."""
    notification_id = notification_id or str(uuid.uuid4())
    body = json.dumps(payload, separators=(",", ":"))
    now = datetime.now(timezone.utc)
    res = httpx.post(
        f"{os.environ['MCP_SERVER_URL']}/internal/events/{route}",
        content=body,
        headers={
            "content-type": "application/json",
            "webhook-id": notification_id,
            "webhook-timestamp": str(int(now.timestamp())),
            "webhook-signature": wh.sign(notification_id, now, body),
        },
        timeout=10,
    )
    if res.status_code == 404:
        return  # Wakeshift is off on that server: drop it
    if res.status_code != 204:
        raise RuntimeError(f"MCP notification {route} failed: {res.status_code}")


# For example, where an import job finishes:
notify_mcp("session-import-finished", {
    "import_id": str(job.uuid),
    "status": job.status,  # READY (dry run), COMPLETED, FAILED or CANCELLED
    "import_type": job.import_type,
    "total_rows": job.total_rows,
    "processed_rows": job.processed_rows,
    "created_count": job.created_count,
    "updated_count": job.updated_count,
    "skipped_count": job.skipped_count,
    "failed_count": job.failed_count,
    "finished_at": (job.completed_at or job.updated_at).astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
}, f"import-{job.uuid}-{job.status}")
```

## Responses and retries

| Status | Meaning | Retry? |
| --- | --- | --- |
| `204` | Done: emitted, already emitted for this change, or a status that wakes nobody. | No |
| `400` | The body isn't valid JSON, or a field is missing or the wrong type. The response's `fields` lists which. | No: fix the sender |
| `401` | Missing, invalid or stale signature. | No: check the secret and the clock |
| `404` | The route is off: the server has no `DIDIT_EVENTS_SECRET` or no `WAKESHIFT_KEY`. | No: drop it |
| `413` | The body is over 16 KB. | No |
| `502` | Wakeshift couldn't be reached or refused the emit. | Yes, with backoff |
| Other 5xx, timeout | The server is down or restarting. | Yes, with backoff |

Retrying is always safe. Each event's ID comes from the body (`event_id`; the
delivery's `delivery_id`; the job's `import_id` and `status`), so Wakeshift
delivers a change once, however many times it's reported, for a day after the
first report. Send the same body on a retry; one whose body changed (a
recomputed timestamp, say) counts as already sent.

**Retry with backoff for up to an hour.** A `502` means Wakeshift couldn't take
the emit (an outage, a deploy): the agent that's waiting is woken once a retry
gets through, and that's the only way it learns of a change it missed, since it
isn't polling. A few attempts over an hour (for example after 30 s, 2, 5, 15
and 40 minutes) cover a short outage. Please document the retry policy you
choose (the attempts, the window, and which answers count as failed), so the
server's operators know what they can rely on.

Send notifications off the request path that made the change (a queue, a
Celery task, an `on_commit` hook), so a slow or failed notification never
delays or fails a verification, an import or a transaction. Send after the
change is committed, so an agent that reads it right away sees it.

Any instance of the MCP server can take any notification: nothing is kept in
memory, so no session affinity is needed.

## Configuring the MCP server

| Variable | Value |
| --- | --- |
| `WAKESHIFT_KEY` | The Wakeshift app key (`wst_…`), from the Wakeshift console. |
| `DIDIT_EVENTS_SECRET` | The shared signing secret, `whsec_…`. |

With both `WAKESHIFT_KEY` and `DIDIT_EVENTS_SECRET` set, on the HTTP transport,
the server mounts the routes, offers the three watch tools on `/mcp` and
`/mcp/payments` (whatever `toolsets` a connection selects, read-only or not, with
OAuth or an API key), and lets the tools above subscribe. With either
missing, Wakeshift is off: no routes (`404`), no new tools, every tool, description and prompt as before, and nothing is sent to Wakeshift. The ChatGPT catalog
(`/mcp/chatgpt`) and the stdio server never offer it.

Generate a secret with, for example:

```sh
node -e "console.log('whsec_' + require('crypto').randomBytes(32).toString('base64'))"
```

Give the same value to the backend. A malformed secret stops the server at
startup with an error, rather than refusing every request.

The Wakeshift SDK needs Node 22.12 or later (the Dockerfile's 22.23.4 is fine).
It's loaded only when Wakeshift is on.

## Exposure

The routes take no Didit credentials and aren't behind the MCP server's OAuth:
the signature is their only check. Keep the secret out of logs and code. If
the server sits behind a gateway or load balancer, you can also allow
`/internal/events/*` only from the backend's network; the rest of the server
doesn't need these routes.

A valid request makes the server emit an event for the session, job,
transaction or application it names. Only conversations that subscribed
through the tools above receive it, and each of those tools first checked, with
the caller's own credential, that the caller can read what it watches:

- `didit_session_watch` reads the session's decision (it returns only the
  status);
- `didit_session_webhooks` reads the session's delivery log;
- `didit_session_watch_reviews` and `didit_transaction_watch_reviews` list the
  application's sessions or transactions;
- the create tools subscribe only after the creation succeeded.

On an API key connection that credential is the key, sent as `x-api-key`, and
the application is the key's own.

A watch isn't checked again if the person later loses access. It carries no
personal data, ends on its own (7 days without a change for statuses and review
queues, an hour for deliveries, the first finish for imports), and reading the
details still goes through their credential.

## Rollout

1. Merge and deploy the MCP server without the new variables. Nothing changes.
2. Build the four notifications in the backend, behind a setting with the MCP
   server's URL and the secret. Treat `404` as "off" and drop it.
3. In staging, set `WAKESHIFT_KEY` (from a separate Wakeshift app for testing)
   and `DIDIT_EVENTS_SECRET` on the MCP server, and the same secret in the
   backend. Check each route with the local test below,
   then with a real agent: create a sandbox session with `sandbox_scenario`
   `approve` and see it wake.
4. In production, turn the backend's notifications on first (they get `404`
   until step 5), then set the variables on the MCP server. A change the
   backend doesn't report wakes nobody, so the tools should go live only once
   every change is reported.

## Trying it locally

With the server running with both variables set, on port 3000 here:

```sh
node --input-type=module -e '
import { createHmac, randomUUID } from "node:crypto";
const key = Buffer.from(process.env.DIDIT_EVENTS_SECRET.slice(6), "base64");
const body = JSON.stringify({ event_id: randomUUID(), session_id: process.argv[1], application_id: process.argv[2], status: "Approved", updated_at: new Date().toISOString() });
const id = randomUUID(), ts = Math.floor(Date.now() / 1000);
const sig = "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
const res = await fetch("http://localhost:3000/internal/events/session-status-updated", { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sig }, body });
console.log(res.status, await res.text());
' <session_id> <application_id>
```

`204` means the event was emitted. An agent that created or watches that
session wakes within seconds.

The repository's tests cover the same path end to end against a Wakeshift core
you run: `WAKESHIFT_E2E_HARNESS=/path/to/harness.json npm test`, where the file
holds `{ "core": "<core URL>", "key": "<app key>" }`.

## Open questions for Didit

The design follows the API as this repository and the public docs describe it.
Please confirm or correct:

1. **KYB sessions.** `status.updated` carries `business_session_id` for KYB.
   Which ID do `didit_session_create` and `didit_session_get_decision` use for a
   KYB session? `session_id` in the body must be that one.
2. **Import `READY`.** Is `READY` reached only when a dry run finishes, or also
   by other jobs (an uploaded file waiting for `start`)? Send `READY` only for a
   finished dry run.
3. **Transaction IDs.** Is `didit_transaction_create`'s `transaction_id` always
   the webhook's `txn_id`, unique within an application? And which ID does
   `didit_transaction_get` take? (A tool to watch an existing transaction by ID
   is left out until this is settled.)
4. **The decision's `status`.** `didit_session_watch` returns the decision's
   top-level `status` as the session's current status. Is that the field?
5. **Cases.** There's no case webhook today, so cases (opened, assigned,
   escalated) aren't covered. If the backend can report case changes, the same
   pattern adds a `case.updated` event and a `didit_case_watch` tool.
6. **Read-only.** The watch tools count as reads, so `read_only=true` offers
   them (they change no Didit data). If read-only should also mean "no new
   wakes", say so: they would then be left out there, and
   `didit_session_webhooks` would stop watching on read-only connections.
7. **`core`.** The watch tools aren't in `core`. If telemetry shows agents
   polling `didit_session_get_decision` on short catalogs, `didit_session_watch`
   is the one to add.
8. **API keys.** Each key is its own Wakeshift subscriber. If the application
   should be one subscriber across its keys instead (so one key can list and end
   another's watches), the identity changes to the application alone.

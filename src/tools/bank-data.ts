import { apiRequest } from "../config";
import { applicationApiKeyHeaders } from "../app-api-key";
import { ORG_APP_PROPS } from "../orgapp";
import { DiditError, pathSegment } from "../security";
import type { RegisteredTool } from "./registry";

// Bank data and Bank Link: the public `/v3/bank/` API of service-didit-verification, built against the
// OpenAPI document `mintlify-docs/openapi-25.json` (tag "Bank Data"; every operation below is in it, and the
// `x-didit-sdk` method names give the resource and verb of each tool name). Every operation is authenticated
// with the application's `x-api-key` (never the caller's user Bearer), exactly like the `didit_verify_*` tools.
//
// Names are `didit_bank_<resource>_<verb>` and every write ends in a suffix the Copilot gates with an approval card
// (`_create`, `_delete`; didit-ai-assistant `src/mastra/tools/destructive.ts`): a POST that starts something is
// the creation of a resource (a sync, a renewal link, a revocation, a link cancellation, a simulation), so no
// verb such as refresh, renew, revoke or stop (which that list would let run unasked) is a tool name.
//
// Two things the tool text has to get right, because it is the agent's only documentation:
//
//   - deletion versus revocation: deleting is immediate and irreversible, revoking stops access and the stored
//     data stays readable until the application's retention setting ends;
//   - the error body: this API answers `{code, message, request_id, field, next_action, retry_after}` instead
//     of the DRF `{detail}` shape, so the code an agent branches on is the body's own `code`
//     (bank_data_access_denied, cursor_expired, ...), not "forbidden" or "conflict".
//
// Amounts are decimal strings in the API and stay strings here: nothing in this file parses one.
//
// What a relayed error says never names who serves a bank: the API's own message is relayed only for a code of its
// public registry (HINTS below), whose messages are Didit's fixed text; any other body (a gateway page, a code this
// server does not know) is replaced by a generic line, so no text of a third party reaches an agent.

/** A 404 without the API's machine code: the route is absent in this environment, or the id is wrong. */
const NOT_FOUND_HINT =
  "No record answered. Check the id with the list tool for its collection. If the id is right, this application's Bank data is not " +
  "open in this environment (a live application answers 404 until live banks open), which is not a missing record: do not retry it.";

/** What an error code means for the next call. The message itself comes from the API, unchanged. */
const HINTS: Readonly<Record<string, string>> = {
  ongoing_access_not_available: "Use access one_time, or a bank that offers ongoing access (didit_bank_institution_list access=ongoing).",
  segment_not_available: "That bank does not serve this segment through Bank Link: pick another segment or another institution.",
  window_not_available: "The bank cannot deliver that history window: ask for fewer days (history_days) or a newer history_from.",
  history_window_ambiguous: "Send history_from or history_days, not both, and call again.",
  redirect_url_not_registered: "Register this redirect_url in the application settings, or send one that is registered.",
  link_origin_not_allowed: "This origin is not among the application's allowed domains: add it there or embed the link with an allowed origin.",
  bank_data_access_denied:
    "The application's API key does not carry Bank data access, or, for raw data of a live application, the application " +
    "setting \"Bank data in the API\" is off: change it in the console (API keys, or the Bank settings) and call again.",
  connection_not_active: "This connection is not active (deleted, revoked or not yet completed): read it with didit_bank_connection_get, and create a new link if a person must connect again.",
  one_time_connection: "A one-time connection is read once and ends by itself: it cannot be refreshed or renewed. Create a new link with access ongoing if the data must stay current.",
  consent_expired: "The person's consent ended: renew it with didit_bank_renewal_create, or create a new link once the renewal window has passed.",
  renewal_not_needed: "The consent has more than 30 days left: renew it closer to consent.expires_at (consent.renew_by).",
  renewal_window_expired: "The window to renew this connection has passed: create a new link for the person.",
  access_removed: "The person no longer shares this account: it will not sync again unless they connect it again.",
  refresh_limit_reached:
    "The bank's limit on fetches without the person present is used up: wait the seconds in retry_after (or Retry-After) and read sync.budgets before retrying.",
  cursor_expired: "The cursor is older than the 90 day change log: read the change feed again with no cursor; that read is a new snapshot, so replace your copy instead of adding to it.",
  page_expired: "The page token expired after an hour: restart the read from its original query.",
  invalid_cursor: "The cursor or page token is not valid: restart the read with no cursor or page_token.",
  page_token_mismatch: "That page token belongs to a different read: restart with the same filters and no page_token.",
  contract_rate_missing: "The contract has no bank data rate for this country: contact support before creating the link.",
  insufficient_credits: "The balance cannot cover the quoted price: top up in the console, then create the link again.",
  rate_limited: "Too many requests: wait the seconds in retry_after (or Retry-After), then call again.",
  not_found:
    "No such record in this application: check the id, and list its parent collection first. If the id is right, this application's Bank data may not be open in this environment (a live application answers 404 until live banks open).",
  invalid_request: "Fix the field the API names and call again.",
};

interface BankRequest {
  method?: string;
  json?: unknown;
  params?: Record<string, unknown>;
}

/**
 * One Bank data call. The bank error body carries its own machine code, which is what an agent has to
 * branch on, so it replaces the HTTP-status code ("forbidden", "conflict") the API layer sets; the
 * body's message, field and retry_after (filled from the `Retry-After` header or the body, config.ts)
 * pass through untouched, and the hint says what the code means for the next call.
 */
async function bankRequest(path: string, opts: BankRequest = {}): Promise<any> {
  const headers = await applicationApiKeyHeaders();
  try {
    return await apiRequest(path, { method: opts.method, json: opts.json, params: opts.params, headers });
  } catch (error) {
    if (!(error instanceof DiditError)) throw error;
    const { backend_code: code, ...shape } = error.shape;
    if (!code || !(code in HINTS)) {
      // Not a code of the Bank data registry: keep the status mapping, say nothing the body said.
      const generic = `The Bank data API refused the call${shape.status ? ` (HTTP ${shape.status})` : ""}.`;
      const hint = shape.status === 404 && path.startsWith("/bank/") ? NOT_FOUND_HINT : shape.hint;
      throw new DiditError({ ...shape, message: generic, hint });
    }
    throw new DiditError({ ...shape, code, hint: HINTS[code] ?? shape.hint });
  }
}

/** An empty or whitespace-only string, or null, is "not sent": models fill every declared optional. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** The arguments that carry a value: a blank optional is dropped instead of being sent as one. */
function withoutBlanks(args: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => !isBlank(value)));
}

/** The named arguments that are present, for a query string. */
function pick(args: Record<string, any>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => !isBlank(args[key])).map((key) => [key, args[key]]));
}

/**
 * A write that creates something a person is sent to, or can cost money (a link that is charged as quoted when it
 * completes), is refused until the caller says the person agreed: the same gate as `didit_org_create_api_key`.
 */
function requireConfirm(args: Record<string, any>, what: string): void {
  if (args.confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: `${what} creates a link for a person and, on a live application, is charged as quoted when it completes. Re-call with confirm:true once the person agreed.`,
      field: "confirm",
      hint: "Say which application the link is for and what the quote is, then pass confirm:true.",
    });
  }
}

/** A whole number inside the range the API documents, refused before any request leaves. */
function assertInRange(value: unknown, field: string, min: number, max: number): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must be a whole number from ${min} to ${max} (received ${JSON.stringify(value)}).`,
      field,
      hint: `Send ${field} as a number between ${min} and ${max}.`,
    });
  }
}

/** A history window is one of history_days or history_from: the pair is a documented 400. */
function assertOneHistoryWindow(args: Record<string, any>): void {
  if (args.history_days !== undefined && args.history_from !== undefined) {
    throw new DiditError({
      code: "bad_request",
      message: "Send history_from or history_days, not both: the API refuses the pair with 400 history_window_ambiguous.",
      field: "history_from",
      hint: "Choose one history window and create the link again.",
    });
  }
}

const ID = (description: string) => ({ type: "string", description });
const LIMIT = { type: "integer", minimum: 1, maximum: 500, description: "Page size, default 100." };
const CURSOR = { type: "string", description: "next_cursor of the previous page." };

export const BANK_DATA_TOOLS: readonly RegisteredTool[] = [
  // ── Links ────────────────────────────────────────────────────────────────────────────────────
  {
    def: {
      name: "didit_bank_link_create",
      description:
        "Create a Bank Link: the flow in which a person connects a bank. A completed link yields a connection. Send the person to url (the API key never goes to a browser); confirm the outcome yourself with didit_bank_link_get or the bank.link.completed webhook, then wait for sync.initial_status succeeded or partial before reading data. mode connect (default) makes a connection; renew with connection_id reuses its settings. access one_time (default) reads once and the connection ends by itself; ongoing keeps access until the consent ends or someone stops it. The response carries id, url, expires_at and quote: the quote is pinned to the link and charged as quoted when the person completes it, and a link nobody completes is free. client_token is for the embedded flow, which is not released yet: open the url. GUIDE FOR EVERY didit_bank_* TOOL: connection, then accounts, balances and transactions; didit_bank_transaction_feed_list keeps a copy current; didit_bank_sync_create reads the bank again, didit_bank_renewal_create renews the consent, didit_bank_revocation_create stops access, didit_bank_connection_delete deletes the connection and its data. Bank data is available for sandbox applications (the Didit Test Bank, nothing charged; didit_bank_link_simulation_create and didit_bank_connection_simulation_create move a flow without a person); a live application's calls answer 404 until live access is announced. The application's API key must carry Bank data access or the API answers 403 bank_data_access_denied, and raw data of a live application also needs the setting \"Bank data in the API\". Amounts are decimal strings. Every refusal carries a code field; the hint says what to do. Errors here: 400 ongoing_access_not_available, segment_not_available, window_not_available, history_window_ambiguous, redirect_url_not_registered or invalid_request; 402 insufficient_credits; 403 link_origin_not_allowed or contract_rate_missing.",
      inputSchema: {
        type: "object" as const,
        required: ["confirm"],
        properties: {
          ...ORG_APP_PROPS,
          confirm: { type: "boolean", description: "REQUIRED, must be true: the link is charged as quoted when a person completes it on a live application. Only after the person agreed." },
          mode: { type: "string", enum: ["connect", "renew"], description: "connect (default) or renew (needs connection_id)." },
          connection_id: ID("The connection to renew. Only with mode renew."),
          access: { type: "string", enum: ["one_time", "ongoing"], description: "one_time (default) reads once; ongoing keeps access open until the consent ends and charges the monthly price." },
          country: { type: "string", description: "ISO 3166-1 alpha-3. Without it the person picks among the countries your application enabled." },
          institution_id: ID("A bank from didit_bank_institution_list to preselect; skips the picker."),
          segment: { type: "string", enum: ["personal", "business", "any"], description: "Filters the picker and the login. Default any." },
          data: { type: "array", items: { type: "string", enum: ["accounts", "balances", "transactions"] }, description: "What to read. accounts is always included. Default [\"accounts\"]." },
          history_days: { type: "integer", minimum: 1, maximum: 365, description: "Days of transaction history, 1 to 365, default 90. Not with history_from." },
          history_from: { type: "string", description: "YYYY-MM-DD start of the history instead of history_days; older than 365 days answers 400 window_not_available." },
          extended_history: { type: "string", enum: ["standard", "allow_extra_auth"], description: "allow_extra_auth lets a bank that asks for one more confirmation release older history." },
          consent_days: { type: "integer", minimum: 1, maximum: 32767, description: "Ongoing only: days of consent to ask for. Default the longest the bank allows. With one_time it answers 400 invalid_request." },
          ownership: {
            type: "object",
            description:
              "Optional comparison of the account holder: compare (none default, person or business), match (any_holder default or all_holders; representatives never count), then for person reference_identity {full_name, date_of_birth YYYY-MM-DD, address, phone, email} or session_id (a completed Didit session), for business business {legal_name, registration_id} or business_session_id. Send one source, not both.",
          },
          end_user: {
            type: "object",
            description: "The person or company that connects the account.",
            properties: { reference: ID("Your own id: searchable with end_user_reference and used to recognise a repeat connection."), email: ID("Verified address, when the bank route needs one for the person's access page.") },
          },
          redirect_url: ID("Where the browser goes at the end; must match a redirect URL registered in the application settings."),
          allowed_origins: { type: "array", items: { type: "string" }, description: "HTTPS origins allowed to embed the link; default the application's allowed domains." },
          language: ID("Language code; default the browser language."),
          vendor_data: ID("Your own reference, returned on the link and the connection."),
          expires_in: { type: "integer", minimum: 300, maximum: 86400, description: "Seconds the link lives, 300 to 86400. Default 3600." },
          duplicates: { type: "string", enum: ["reuse", "allow"], description: "reuse (default) renews the existing connection when the accounts are already shared; allow creates a second one." },
          allow_one_time_fallback: { type: "boolean", description: "With ongoing: lets the person continue with a one-time read at a bank that cannot keep access open (cost in quote.fallback_lines)." },
          accept_reduced_grant: { type: "boolean", description: "Complete and charge only the granted scopes when less is granted than asked; otherwise the link ends failed with reduced_grant." },
          sandbox: {
            type: "object",
            description: "Sandbox applications only: persona (personal_basic, business_multi, long_history, pending, sparse_fields, no_ongoing) and switches (partial_grant, renewal_other_login, expired_cursor, webhook_twice, midnight_booking, blocked_popup, bank_app_return). Ignored in live.",
          },
        },
      },
    },
    access: "write",
    permission: "write:bank-data",
    run: (args) => {
      // A blank optional (history_from: "", connection_id: "") counts as absent: the dispatcher drops those
      // for read tools and models fill every declared optional, but a write body would carry the blank.
      requireConfirm(args, "A Bank Link");
      const { confirm: _confirm, ...body } = withoutBlanks(args);
      assertOneHistoryWindow(body);
      assertInRange(body.history_days, "history_days", 1, 365);
      assertInRange(body.consent_days, "consent_days", 1, 32767);
      assertInRange(body.expires_in, "expires_in", 300, 86400);
      return bankRequest("/bank/links/", { method: "POST", json: body });
    },
  },
  {
    def: {
      name: "didit_bank_link_get",
      description:
        "The status of a Bank Link and, once completed, its connection_id. Authoritative: call it from your server after the browser reports success. Statuses: created, opened, connecting, completed, cancelled, expired, failed; a failed link reads 200 with status failed and an error object. url and client_token come back only at creation. See didit_bank_link_create for the flow. Errors: 404 not_found.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, link_id: ID("REQUIRED. The link id.") }, required: ["link_id"] },
    },
    access: "read",
    permission: "read:bank-data",
    run: ({ link_id }) => bankRequest(`/bank/links/${pathSegment(link_id, "link_id", { opaque: true })}/`),
  },
  {
    def: {
      name: "didit_bank_link_cancellation_create",
      description:
        "Cancel a Bank Link that has not completed: its url stops working. Safe to repeat; a completed link keeps its connection. A cancelled link is free. See didit_bank_link_create for the flow. Errors: 404 not_found.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, link_id: ID("REQUIRED. The link id.") }, required: ["link_id"] },
    },
    access: "write",
    permission: "write:bank-data",
    run: ({ link_id }) => bankRequest(`/bank/links/${pathSegment(link_id, "link_id", { opaque: true })}/cancel/`, { method: "POST" }),
  },

  // ── Connections ──────────────────────────────────────────────────────────────────────────────
  {
    def: {
      name: "didit_bank_connection_list",
      description:
        "List this application's bank connections, newest first, with cursor pagination. Statuses: pending, active, renewal_required, paused, revoked, deleted, failed. sync.budgets here shows only budgets that exist; didit_bank_connection_get opens today's. See didit_bank_link_create for the flow. Errors: 400 invalid_cursor.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          status: { type: "string", enum: ["pending", "active", "renewal_required", "paused", "revoked", "deleted", "failed"], description: "Only this status." },
          access: { type: "string", enum: ["one_time", "ongoing"], description: "Only this access mode." },
          institution_id: ID("Only this bank."),
          country: { type: "string", description: "ISO 3166-1 alpha-3 country." },
          vendor_data: ID("Only this vendor_data."),
          end_user_reference: ID("Only this end_user.reference."),
          consent_expires_before: ID("Consent ends before this ISO 8601 time."),
          created_after: ID("Created after this ISO 8601 time."),
          limit: LIMIT,
          cursor: CURSOR,
        },
      },
    },
    access: "read",
    permission: "list:bank-data",
    run: (args) => {
      assertInRange(args.limit, "limit", 1, 500);
      return bankRequest("/bank/connections/", { params: pick(args, ["status", "access", "institution_id", "country", "vendor_data", "end_user_reference", "consent_expires_before", "created_after", "limit", "cursor"]) });
    },
  },
  {
    def: {
      name: "didit_bank_connection_get",
      description:
        "One bank connection with its consent, sync state and a summary of each account. A one-time connection ends by itself once collected (status revoked, status_reason collection_complete) and stays readable. A deleted connection reads as a minimal record with no bank data. See didit_bank_link_create for the flow. Errors: 404 not_found.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, connection_id: ID("REQUIRED. The connection id.") }, required: ["connection_id"] },
    },
    access: "read",
    permission: "read:bank-data",
    run: ({ connection_id }) => bankRequest(`/bank/connections/${pathSegment(connection_id, "connection_id", { opaque: true })}/`),
  },
  {
    def: {
      name: "didit_bank_connection_delete",
      description:
        "Delete a connection: stops access at the bank and deletes its accounts, balances, transactions, sync history, consent records and ownership results. Deletion is immediate and irreversible: when the call returns the data is deleted, and sync, accounts, balances, transactions and the change feed answer 409 connection_not_active. Answers 202 with the connection id and its erasure record. Not affected: your other connections, charges already made, and data you already downloaded, which is your own copy. Repeating the call is safe. To stop access without deleting, use didit_bank_revocation_create. Errors: 404 not_found.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, connection_id: ID("REQUIRED. The connection id.") }, required: ["connection_id"] },
    },
    access: "destructive",
    permission: "delete:bank-data",
    run: ({ connection_id }) => bankRequest(`/bank/connections/${pathSegment(connection_id, "connection_id", { opaque: true })}/`, { method: "DELETE" }),
  },
  {
    def: {
      name: "didit_bank_sync_create",
      description:
        "Sync now: read the bank for new data. Answers 202 with sync_id (a sync already running returns its sync_id). wait:true holds the call up to 25 seconds and answers 200 with the finished sync; otherwise read it with didit_bank_sync_get or the bank.sync.completed webhook. It is included in the connection's monthly price and never bills extra; the bank's own limit is in sync.budgets and, when used up, the answer is 429 refresh_limit_reached with Retry-After. A one-time connection cannot be synced. Errors: 409 connection_not_active, consent_expired (renew or create a new link) or one_time_connection; 404 not_found; 429 refresh_limit_reached.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          connection_id: ID("REQUIRED. The connection id."),
          wait: { type: "boolean", description: "Hold up to 25 seconds for the finished sync." },
        },
        required: ["connection_id"],
      },
    },
    access: "write",
    permission: "write:bank-data",
    run: ({ connection_id, wait }) =>
      bankRequest(`/bank/connections/${pathSegment(connection_id, "connection_id", { opaque: true })}/refresh/`, {
        method: "POST",
        json: isBlank(wait) ? {} : { wait },
      }),
  },
  {
    def: {
      name: "didit_bank_renewal_create",
      description:
        "Create a renew link for an ongoing connection (didit_bank_link_create with mode renew): the connection id and account ids stay the same. Send the person to the returned url; a link nobody completes is free. With more than 30 days of consent left it answers 409 renewal_not_needed; after consent.renewable_until, 409 renewal_window_expired and the person connects again with a new link; a one-time connection answers 409 one_time_connection. Errors: 400 redirect_url_not_registered; 402 insufficient_credits; 403 bank_data_access_denied, link_origin_not_allowed or contract_rate_missing; 404 not_found; 409 renewal_not_needed, renewal_window_expired, connection_not_active or one_time_connection.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          connection_id: ID("REQUIRED. The connection to renew."),
          confirm: { type: "boolean", description: "REQUIRED. Must be true: this creates a link that is charged as quoted when a person completes it on a live application. Only after the person agreed." },
          redirect_url: ID("Where the browser goes at the end. Must exactly match a registered redirect URL."),
          allowed_origins: { type: "array", items: { type: "string" }, description: "HTTPS origins allowed to embed this link." },
          language: ID("Optional language code."),
          expires_in: { type: "integer", minimum: 300, maximum: 86400, description: "Lifetime of the link in seconds, 300 to 86400. Default 3600." },
        },
        required: ["connection_id", "confirm"],
      },
    },
    access: "write",
    permission: "write:bank-data",
    run: (args) => {
      requireConfirm(args, "A renew link");
      const body = pick(args, ["redirect_url", "allowed_origins", "language", "expires_in"]);
      assertInRange(body.expires_in, "expires_in", 300, 86400);
      return bankRequest(`/bank/connections/${pathSegment(args.connection_id, "connection_id", { opaque: true })}/renew/`, {
        method: "POST",
        json: body,
      });
    },
  },
  {
    def: {
      name: "didit_bank_revocation_create",
      description:
        "Stop access to the bank for a connection. Fetches stop at once: consent.status reads revocation_pending, then revoked once the bank confirms, or revocation_failed while the call is repeated automatically. Revoking does not delete anything: the stored accounts, balances and transactions stay readable until consent.retain_until, the application's retention setting, and nothing is charged. To delete them now use didit_bank_connection_delete. Repeating the call returns the current state. Errors: 404 not_found.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, connection_id: ID("REQUIRED. The connection id.") }, required: ["connection_id"] },
    },
    access: "write",
    permission: "write:bank-data",
    run: ({ connection_id }) =>
      bankRequest(`/bank/connections/${pathSegment(connection_id, "connection_id", { opaque: true })}/revoke/`, { method: "POST" }),
  },

  // ── Sync run ────────────────────────────────────────────────────────────────────────────────
  {
    def: {
      name: "didit_bank_sync_get",
      description:
        "One sync run of a connection with its results per account and resource: the sync_id didit_bank_sync_create answered with, or one the automatic schedule ran. A read never bills. Errors: 404 not_found (connection or sync run); 409 connection_not_active.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, connection_id: ID("REQUIRED. The connection id."), sync_id: ID("REQUIRED. The sync run id.") },
        required: ["connection_id", "sync_id"],
      },
    },
    access: "read",
    permission: "read:bank-data",
    run: ({ connection_id, sync_id }) =>
      bankRequest(
        `/bank/connections/${pathSegment(connection_id, "connection_id", { opaque: true })}/sync-runs/${pathSegment(sync_id, "sync_id", { opaque: true })}/`,
      ),
  },

  // ── Accounts, balances and transactions ─────────────────────────────────────────────────────
  {
    def: {
      name: "didit_bank_account_list",
      description:
        "List every account of a connection with its full identifiers and holders and each account's own sync state (last_synced_at, status). Needs the application setting \"Bank data in the API\" in a live application. Errors: 400 invalid_cursor; 403 bank_data_access_denied (permission or setting missing); 404 not_found; 409 connection_not_active.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, connection_id: ID("REQUIRED. The connection id."), limit: LIMIT, cursor: CURSOR },
        required: ["connection_id"],
      },
    },
    access: "read",
    permission: "list:bank-data",
    run: (args) => {
      assertInRange(args.limit, "limit", 1, 500);
      return bankRequest(`/bank/connections/${pathSegment(args.connection_id, "connection_id", { opaque: true })}/accounts/`, {
        params: pick(args, ["limit", "cursor"]),
      });
    },
  },
  {
    def: {
      name: "didit_bank_balance_list",
      description:
        "The typed balances of one account with their reference dates (booked, available, expected), replaced at each sync. Amounts are decimal strings in the account's currency: keep them as strings. Errors: 404 not_found; 409 access_removed or connection_not_active.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, account_id: ID("REQUIRED. The account id.") }, required: ["account_id"] },
    },
    access: "read",
    permission: "read:bank-data",
    run: ({ account_id }) => bankRequest(`/bank/accounts/${pathSegment(account_id, "account_id", { opaque: true })}/balances/`),
  },
  {
    def: {
      name: "didit_bank_transaction_list",
      description:
        "A date-range read of one account's transactions, newest effective_date first, up to 500 a page. Amounts are decimal strings: keep them as strings, never floating point. date_from and date_to are inclusive calendar dates in the bank's own time zone, applied to effective_date; by default the whole stored history, booked and pending. page_token continues a read for one hour (an expired token answers 410 page_expired: restart). To keep a copy current use didit_bank_transaction_feed_list. Errors: 400 invalid_request or invalid_cursor; 404 not_found; 409 access_removed or connection_not_active; 410 page_expired.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          account_id: ID("REQUIRED. The account id."),
          date_from: ID("YYYY-MM-DD, inclusive."),
          date_to: ID("YYYY-MM-DD, inclusive; no upper bound when left out."),
          status: { type: "string", enum: ["booked", "pending"], description: "Default both." },
          limit: LIMIT,
          page_token: ID("next_page_token of the previous page (one hour)."),
        },
        required: ["account_id"],
      },
    },
    access: "read",
    permission: "read:bank-data",
    run: (args) => {
      assertInRange(args.limit, "limit", 1, 500);
      return bankRequest(`/bank/accounts/${pathSegment(args.account_id, "account_id", { opaque: true })}/transactions/`, {
        params: pick(args, ["date_from", "date_to", "status", "limit", "page_token"]),
      });
    },
  },
  {
    def: {
      name: "didit_bank_transaction_feed_list",
      description:
        "The change feed of a connection's transactions since a cursor: added, modified and removed (with a reason), across all accounts. Read with no cursor first: that snapshot returns every current transaction once as added with reset true, so replace your copy. Apply modified as an upsert by id and ignore a removed id you do not have. Page with page_token while has_more is true and store next_cursor only after a response with has_more false. The log replays for 90 days: an older cursor answers 410 cursor_expired, so restart from an empty cursor. An account the person stopped sharing arrives as removed with reason access_removed. Amounts are decimal strings. bank.data.updated says when to read. Errors: 400 invalid_cursor or page_token_mismatch; 404 not_found; 409 connection_not_active; 410 cursor_expired or page_expired.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          connection_id: ID("REQUIRED. The connection id."),
          cursor: ID("The next_cursor you stored. Empty or omitted starts from the beginning (a snapshot)."),
          limit: LIMIT,
          page_token: ID("Continues the same read while has_more is true."),
        },
        required: ["connection_id"],
      },
    },
    access: "read",
    permission: "read:bank-data",
    run: (args) => {
      assertInRange(args.limit, "limit", 1, 500);
      return bankRequest(`/bank/connections/${pathSegment(args.connection_id, "connection_id", { opaque: true })}/transactions/sync/`, {
        params: pick(args, ["cursor", "limit", "page_token"]),
      });
    },
  },

  // ── Coverage and institutions ───────────────────────────────────────────────────────────────
  {
    def: {
      name: "didit_bank_institution_list",
      description:
        "List banks per country with their capabilities: segments, access modes (one_time, and ongoing only where available), the longest consent and deepest history, pending transactions, how the person signs in. A value never observed is null. Use it to choose a bank and get the institution_id a link can preselect. Errors: 400 invalid_request or invalid_cursor.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          country: { type: "string", description: "Only banks in this ISO 3166-1 alpha-3 country, for example ESP." },
          segment: { type: "string", enum: ["personal", "business"], description: "Only banks that serve this segment." },
          access: { type: "string", enum: ["one_time", "ongoing"], description: "Only banks that offer this access mode." },
          q: ID("Search by name."),
          limit: LIMIT,
          cursor: CURSOR,
        },
      },
    },
    access: "read",
    permission: "list:bank-data",
    run: (args) => {
      assertInRange(args.limit, "limit", 1, 500);
      return bankRequest("/bank/institutions/", { params: pick(args, ["country", "segment", "access", "q", "limit", "cursor"]) });
    },
  },
  {
    def: {
      name: "didit_bank_coverage_get",
      description:
        "One entry per country: whether bank sign-in and the account check are available, whether ongoing access is (and how many banks offer it), the longest consent and deepest history any bank allows, and whether business accounts are supported. Use it to decide which countries to offer; didit_bank_institution_list gives single banks.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    access: "read",
    permission: "read:bank-data",
    run: () => bankRequest("/bank/coverage/"),
  },

  // ── Reads the first draft left out, and the two sandbox operations ───────────────────────────
  {
    def: {
      name: "didit_bank_sync_list",
      description:
        "List what each sync of a connection did, newest first, per account and resource. didit_bank_sync_get reads one. Errors: 404 not_found; 409 connection_not_active.",
      inputSchema: {
        type: "object" as const,
        properties: { ...ORG_APP_PROPS, connection_id: ID("REQUIRED. The connection id."), limit: LIMIT, cursor: CURSOR },
        required: ["connection_id"],
      },
    },
    access: "read",
    permission: "list:bank-data",
    run: (args) => {
      assertInRange(args.limit, "limit", 1, 500);
      return bankRequest(`/bank/connections/${pathSegment(args.connection_id, "connection_id", { opaque: true })}/sync-runs/`, {
        params: pick(args, ["limit", "cursor"]),
      });
    },
  },
  {
    def: {
      name: "didit_bank_account_get",
      description:
        "One account with full identifiers, holders, sync state and history_coverage (what the bank delivered of the history you asked for). sync.last_synced_at is when the data was fetched from the bank. Errors: 404 not_found; 409 connection_not_active.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, account_id: ID("REQUIRED. The account id.") }, required: ["account_id"] },
    },
    access: "read",
    permission: "read:bank-data",
    run: ({ account_id }) => bankRequest(`/bank/accounts/${pathSegment(account_id, "account_id", { opaque: true })}/`),
  },
  {
    def: {
      name: "didit_bank_institution_get",
      description:
        "One bank with its capabilities, by the id didit_bank_institution_list gives. A value never observed is null. Errors: 404 not_found.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, institution_id: ID("REQUIRED. The bank's id.") }, required: ["institution_id"] },
    },
    access: "read",
    permission: "read:bank-data",
    run: ({ institution_id }) => bankRequest(`/bank/institutions/${pathSegment(institution_id, "institution_id", { opaque: true })}/`),
  },
  {
    def: {
      name: "didit_bank_link_simulation_create",
      description:
        "Sandbox applications only: finish a Bank Link in one call as if the person had gone through the Didit Test Bank: persona picks the test customer, outcome how the link ends. The real completion runs (connection, accounts, first sync, bank.* webhooks). A link no longer open comes back unchanged. Nothing is charged. Errors: 400 invalid_request; 404 not_found (also for a live application).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          link_id: ID("REQUIRED. The link id."),
          persona: { type: "string", enum: ["personal_basic", "business_multi", "long_history", "pending", "sparse_fields", "no_ongoing"], description: "The Test Bank customer who signs in. Default personal_basic." },
          outcome: { type: "string", enum: ["completed", "cancelled", "failed", "duplicate_conflict", "reduced_grant", "renewal_login_mismatch"], description: "How the link ends. Default completed." },
          error_code: { type: "string", enum: ["duplicate_conflict", "renewal_login_mismatch", "reduced_grant", "corporate_approval_not_supported", "ongoing_access_not_available", "bank_unavailable", "bank_cancelled", "consent_declined", "read_limit"], description: "The failure the link records. Only with outcome failed (default bank_unavailable)." },
        },
        required: ["link_id"],
      },
    },
    access: "write",
    permission: "write:bank-data",
    run: (args) =>
      bankRequest(`/bank/links/${pathSegment(args.link_id, "link_id", { opaque: true })}/simulate/`, {
        method: "POST",
        json: pick(args, ["persona", "outcome", "error_code"]),
      }),
  },
  {
    def: {
      name: "didit_bank_connection_simulation_create",
      description:
        "Sandbox applications only: move a connection through time with the real sync engine and webhooks. action picks what happens (see its values); pending_posted needs the pending test customer, consent_expiring takes days 14, 7 or 1, new_transactions takes count. Answers the connection. Nothing is charged. Errors: 400 invalid_request (days or count with another action); 404 not_found; 409 connection_not_active.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          connection_id: ID("REQUIRED. The connection id."),
          action: {
            type: "string",
            enum: ["new_transactions", "pending_posted", "booking_correction", "consent_expiring", "consent_expired", "revoked_by_user", "revoked_by_bank", "sync_failed", "sync_recovered", "webhook_twice", "midnight_booking", "budget_used", "budget_reset"],
            description: "REQUIRED. What happens.",
          },
          days: { type: "integer", enum: [14, 7, 1], description: "Only with consent_expiring: days until the consent ends. Default 7." },
          count: { type: "integer", minimum: 1, maximum: 500, description: "Only with new_transactions: how many booked transactions the bank adds. Default 3." },
        },
        required: ["connection_id", "action"],
      },
    },
    access: "write",
    permission: "write:bank-data",
    run: (args) => {
      assertInRange(args.count, "count", 1, 500);
      return bankRequest(`/bank/connections/${pathSegment(args.connection_id, "connection_id", { opaque: true })}/simulate/`, {
        method: "POST",
        json: pick(args, ["action", "days", "count"]),
      });
    },
  },
];

# Didit MCP Server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [Didit](https://didit.me) — bring KYC, KYB, AML screening, transaction monitoring, biometrics, and full workspace operations to Claude, Cursor, VS Code, Windsurf, Zed, and any MCP client.

- **140+ tools** across sessions, workflows, vendor users/businesses, transactions, networks, the standalone verification APIs, lists, cases, reports, webhooks, and billing.
- **Auth is "Log in with Didit" (OAuth 2.1 + PKCE)** — the MCP acts as the signed-in **user** with their role's permissions. There is **no API-key mode**: every tool calls the user-scoped console endpoints, which only accept a Bearer token.
- Tools call Didit REST endpoints. Session PDF generation returns a temporary download URL for the original PDF.

> Full documentation: **https://docs.didit.me/integration/mcp/overview**

## Session PDF downloads

`didit_session_generate_pdf` returns `download_url`, `expires_at` (UTC), and
`expires_in` (300 seconds). Fetch the URL without an Authorization header to save
the original Didit PDF. The server checks PDF access before issuing the link and
fetches the original report again at download time using the same user and organization.
It does not reconstruct the report from session data. If the session changes between
issuance and download, the download reflects the current report. Revoked or expired
user access can invalidate a link before its five-minute expiry.

Deployments must set `MCP_PDF_DOWNLOAD_KEY` to 32 cryptographically random bytes
encoded as 64 hexadecimal characters, shared across all replicas, and set
`MCP_RESOURCE_URI` to the public HTTPS MCP endpoint. Route
`/downloads/session-report.pdf` to this HTTP server. The authenticated-encryption
key protects the credentials embedded in the session-scoped link; rotating it
invalidates outstanding links. Treat links as secrets and redact the `token` query
parameter in proxy/access logs. Responses use `Cache-Control: no-store`.

Stdio deployments need a reachable HTTP deployment with the same key, API base URL,
and `MCP_RESOURCE_URI`; stdio alone cannot serve download links. Missing key
configuration produces an actionable tool error instead of inline PDF data.

## Quick start

### Hosted (recommended)

No install, no API key — point your client at the hosted URL and sign in via the browser:

```
https://mcp.didit.me/mcp
```

**Claude Code**

```bash
claude mcp add --transport http didit https://mcp.didit.me/mcp
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{ "mcpServers": { "didit": { "url": "https://mcp.didit.me/mcp" } } }
```

**Windsurf / Zed** (via the `mcp-remote` bridge)

```json
{ "mcpServers": { "didit": { "command": "npx", "args": ["-y", "mcp-remote@latest", "https://mcp.didit.me/mcp"] } } }
```

See [per-client setup](https://docs.didit.me/integration/mcp/installation) for Claude Desktop and VS Code.

## Authentication

The MCP is an OAuth 2.1 **resource server**; the Didit console (`business.didit.me`) is the **authorization server**. On first connect your client opens a browser, you **Log in with Didit** and approve the scopes, and the MCP then acts as **you** — across every organization you belong to, with your role's permissions. Tokens are short-lived and refreshed automatically.

Scopes: `didit:management` (workspace operations), `didit:verification` (running checks) and `didit:staff` (Didit staff accounts only; the authorization server never issues it to anyone else). Your console **role** is enforced server-side on every call.

> **There is no API-key mode.** Every tool targets the user-scoped console endpoints (`/organization/{org}/application/{app}/…`), which authorize a Bearer token with per-role privileges and reject `x-api-key`. (For raw REST access with an application API key — e.g. creating sessions from your backend — use the [REST API](https://docs.didit.me) directly, not this server.)

See [Authentication](https://docs.didit.me/integration/mcp/authentication).

## Tools

140+ tools, grouped by area. The full catalogue with read/write/destructive markers is in [`docs/TOOLS.md`](docs/TOOLS.md) and at [docs.didit.me](https://docs.didit.me/integration/mcp/tools). Highlights:

- **Discovery & cross-app:** `didit_context_get`, `didit_session_search`, `didit_transaction_search`, `didit_vendor_user_search`, `didit_analytics` — aggregate across every org/app in one call.
- **Sessions:** create, list, get decision, update status, reviews, bulk import, webhook delivery log + resend (`didit_session_webhooks` waits for a sandbox session's webhook so an integration can be verified end to end).
- **Verification APIs:** `didit_verify_id`, `didit_verify_aml`, `didit_verify_face_match`, `didit_verify_kyb_search`, …
- **Workflows (incl. branching graphs):** `didit_workflow_search`, `didit_workflow_get_graph`, `didit_workflow_edit_graph` — build conditional/branching workflows (fuzzy-match conditions, Document-AI steps) by sending small ops; large feature configs are kept server-side, never resent. `didit_workflow_get_id_verification_methods_catalog` and `didit_workflow_get_kyb_registry_catalog` answer the server-driven questions a config write depends on (which countries offer non-doc lookup / wallets, which KYB data tiers and monitoring a country's registries sell).
- **Compliance:** transaction monitoring, custom and preset rule management with backtesting, lists/blocklist/allowlist, cases, reports, audit logs, alerts.
- **Workspace:** questionnaires, webhooks, members, billing, branding.

### File inputs

Tools that consume files (face upload, ID/PoA/liveness/face/age verification, branding) accept the file in one of two forms:

- **`*_path`** — an absolute path on the machine running the MCP server. Only works for local/stdio runs (e.g. Claude Code with a local server), where your files and the server share a filesystem.
- **`*_base64`** — the file content inline, as raw base64 or a `data:` URL. Use this against the hosted endpoint; it is how the Didit Console Copilot passes chat attachments (its agent resolves attachment references like `att_1` into base64 before the call reaches the MCP).

Both forms enforce the same 15MB cap and magic-bytes allow-list (png/jpg/jpeg/webp/gif/bmp/ico/pdf). The hosted transport's JSON body limit is 25MB (`MCP_JSON_BODY_LIMIT`).

## Run it yourself

The hosted server above is the easy path — no install. To self-host, clone this repo and run it with **Docker** or Node. It authenticates the user the same way (OAuth, or a user Bearer token for headless runs); there is no API-key mode.

```bash
git clone https://github.com/didit-protocol/mcp.git && cd mcp

# Docker (recommended) — serves /mcp and /healthz on port 3000
docker build -t didit-mcp . && docker run -p 3000:3000 --env-file .env didit-mcp

# …or with Node
npm install && npm run build
node dist/http.js                                          # hosted HTTP/OAuth
DIDIT_ACCESS_TOKEN=<user-access-token> node dist/index.js  # stdio (headless)
```

All Didit base URLs and OAuth endpoints are environment variables with public defaults (`verification.didit.me`, `apx.didit.me`, `business.didit.me`) — override them for a private deployment. See [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`.env.example`](.env.example) for the full reference.

## Workflow feature configuration

Every workflow feature node takes a `config` object. The tables below are the complete
contract - what `didit_workflow_create`, `didit_workflow_update`, `didit_workflow_validate_graph`,
`didit_workflow_set_graph` and `didit_workflow_edit_graph` accept, and what the API stores.
A key that is not listed here is not part of the contract and is dropped silently on save.

`didit_workflow_get_feature_config_schema` returns the same data as JSON at runtime.

<!-- BEGIN GENERATED FEATURE CONFIG REFERENCE -->

_Generated from `schema/feature-config-schema.json` (contract `sha256:a2c413a50107faf3ea47fa187089a930ac17d3d04893e24176f494a58470e982`, schema version 1), which is a copy of the artifact `service-didit-verification` generates from its feature-config serializers. Do not edit by hand — run `npm run schema:readme`._

### AGE_ESTIMATION

Configuration for Age Estimation feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `borderline_maximum_age_threshold` | integer \| null | integer >=1 <=100 |  |
| `borderline_minimum_age_threshold` | integer \| null | integer >=1 <=100 |  |
| `enable_id_verification_fallback` | boolean \| null | boolean |  |
| `external_capture_device_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when an external capture device is detected. |
| `face_audio_recording_enabled` | boolean \| null | boolean | Record the microphone during the selfie capture, so a reviewer can hear the session. Off by default. |
| `face_liveness_duplicated_face_document_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a duplicate face is found on a user verified with a different date of birth. Another document of the same person (a passport after an identity card, a renewal, a document of a second country) is not flagged. |
| `face_liveness_duplicated_face_name_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a duplicate face is found under a different name. |
| `face_liveness_flash_mode` | string \| null | string |  |
| `face_liveness_max_attempts` | integer \| null | integer >=1 <=3 |  |
| `face_liveness_method` | string \| null | 'ACTIVE_3D'\|'FLASHING'\|'PASSIVE' |  |
| `face_liveness_multiple_faces_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when more than one face is present in the capture. |
| `face_liveness_possible_duplicated_face_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this face matches a previously seen user. |
| `face_liveness_score_decline_threshold` | number \| null | number |  |
| `face_liveness_score_review_threshold` | number \| null | number |  |
| `face_liveness_uncertain_retry_enabled` | boolean \| null | boolean | Native SDK active liveness only. On, a capture whose liveness score falls strictly between face_liveness_score_decline_threshold and face_liveness_score_review_threshold is never decided, whichever verdict the engine attached to it: the person is told the result was unclear and asked to capture again, every time, outside the face_liveness_max_attempts budget (which still applies to captures the engine could not score). Off by default; the web flow ignores it. |
| `face_liveness_video_anomaly_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the stored liveness recording contains a repeated moving sequence consistent with a looped video feed, measured server-side from the video itself, independently of the liveness score. It deliberately does NOT flag a frozen or near-motionless capture: frame statistics cannot separate an injected still from a genuine one (a subject holding still, or a flash that clips the exposure), so acting on that would decline real users. A frozen or pre-recorded injected feed is instead defeated by strict flash liveness (set face_liveness_flash_mode to "1" for strict), which binds the capture to a per-session colour-sequence challenge a recording cannot reproduce. Defaults to NO_ACTION (evidence is recorded, the verdict is unchanged). |
| `face_luminance_max_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is brighter than `face_luminance_max_threshold`. |
| `face_luminance_max_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_luminance_min_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is darker than `face_luminance_min_threshold`. |
| `face_luminance_min_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_privacy_mode_enabled` | boolean \| null | boolean |  |
| `face_quality_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_quality_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_search_enabled` | boolean \| null | boolean | Run the 1:N Face Search on the selfie: match it against previously verified users, the face blocklist and allowlist, and store its biometric template for later matching. On by default. Off skips the search, keeps no face template, and leaves the duplicate-face actions with nothing to act on. |
| `frame_injection_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when injected video frames are detected. |
| `minimum_age_threshold` | integer \| null | integer >=1 <=100 |  |
| `screen_capture_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is a photo of a screen. |
| `status_rules` | array | array |  |
| `virtual_camera_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a virtual camera feed is detected. |

### AML

Configuration for AML feature (used for both KYC AML and KYB Company AML).

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `aml_country_weight` | integer \| null | integer >=0 <=100 |  |
| `aml_dob_weight` | integer \| null | integer >=0 <=100 |  |
| `aml_entity_type` | string \| null | 'company'\|'person' | Whether this node screens a `person` or a `company`. Defaults to `person` on a person (KYC) workflow and to `company` on a business (KYB) workflow. Set it to `company` to screen the business named in an uploaded document (via `aml_field_sources`) without a KYB Registry step - the provider searches company records instead of people, and the match score is scored as a company. |
| `aml_field_sources` | json \| null | {"full_name"\|"date_of_birth"\|"nationality"\|"document_number": {"source": "document_ai"\|"questionnaire"\|"expected_data", "key": "<docai field key>\|<questionnaire node id>\|expected_details.<expected_details field>\|metadata.<key>"}} | Where this node reads the entity it screens, when the workflow has no ID Verification or KYB Registry step to supply it - a Document AI workflow over non-standardised documents (a tax certificate, an acta constitutiva). Same contract as `database_validation_field_sources`: `source` names the producer and `key` names the value inside it - a Document AI field key for `document_ai`, a questionnaire node id for `questionnaire`, and `expected_details.<field>` or `metadata.<key>` for `expected_data`. The map's KEY is one of the four AML screening inputs: `full_name`, `date_of_birth`, `nationality`, `document_number` - read for a company as legal name, incorporation date, country and registration number. A Document AI field already keyed as one of those four maps automatically and is deliberately not persisted, so renaming it never freezes a stale mapping. An explicit mapping wins over both the auto-map and the ID document, and a mapping that resolves to nothing at runtime leaves the input empty rather than falling back. With no ID Verification and no KYB Registry upstream, `full_name` must be fillable or the graph is rejected on save: there is no search without a name. |
| `aml_incomplete_data_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the screening ran on less than a full identity (name, date of birth and country). `REVIEW` is the default and the historical behaviour; `NO_ACTION` proceeds on reduced data for a workflow that knowingly holds only a name. The screening still runs either way, and the partial-data log is still recorded - this only decides what it does to the status. |
| `aml_match_score_threshold` | integer \| null | integer >=0 <=100 |  |
| `aml_name_weight` | integer \| null | integer >=0 <=100 |  |
| `aml_score_approve_threshold` | integer \| null | integer >=0 <=100 |  |
| `aml_score_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `case_blueprint` | uuid \| null | uuid | Which case blueprint the automatically-created case is built from. Only meaningful with `create_cases_on_hit`; the account default is used when unset. |
| `create_cases_on_hit` | boolean \| null | boolean | Open a case automatically when the screening returns a hit, instead of leaving the hit to be triaged from the session. Off by default. |
| `fallback_to_native` | boolean \| null | boolean |  |
| `is_aml_ongoing_monitoring_enabled` | boolean \| null | boolean | Keep screening the PERSON after the session is approved, raising a new hit when they later appear on a watchlist. Off by default. |
| `kyb_company_aml_country_weight` | integer \| null | integer >=0 <=100 |  |
| `kyb_company_aml_dob_weight` | integer \| null | integer >=0 <=100 |  |
| `kyb_company_aml_match_score_threshold` | integer \| null | integer >=0 <=100 |  |
| `kyb_company_aml_name_weight` | integer \| null | integer >=0 <=100 |  |
| `kyb_enable_ongoing_monitoring` | boolean \| null | boolean | The same, for the COMPANY on a KYB workflow. The two switches are independent. |
| `kyb_score_approve_threshold` | integer \| null | integer >=0 <=100 |  |
| `kyb_score_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `provider_key` | string \| null | string |  |
| `status_rules` | array | array |  |

### BANK_VERIFICATION

Configuration for Bank Verification feature.
> Bank Verification confirms who owns a bank account against an identity ANOTHER step established - it is not identity proof on its own. Put ID Verification, Database Validation or a questionnaire before it; first in a graph it has nothing to compare against and can only return `unknown`. The node is opt-in and runs nothing while `bank_countries` is empty.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `bank_account_selection` | string \| null | 'auto'\|'user' | Whether the user picks which of the connected accounts is verified (`user`) or the first eligible one is taken (`auto`). |
| `bank_allow_skip` | boolean \| null | boolean | Let the user skip the step instead of connecting a bank. A skip is then decided by `bank_skipped_action`. |
| `bank_attempts_exhausted_action` | string \| null | 'REVIEW'\|'DECLINE' | Verdict when the user spent `bank_max_attempts` without a successful connection. |
| `bank_business_account_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the institution types the holder as a business rather than a person. |
| `bank_connection_timeout_minutes` | integer \| null | integer >=5 <=60 | How long a started connection stays open before the attempt is abandoned, 5 to 60 minutes. |
| `bank_consent_expired_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the bank consent lapses after the step was already decided. Only meaningful with `bank_refresh_enabled`. |
| `bank_countries` | json \| null | {"<ISO3>": {"enabled": true\|false, "institutions": ["<institution_id>", ...] \| "all"}} | Which countries a user may connect a bank in - a WHITELIST, so an empty map means the node offers nothing and runs nothing. `institutions` narrows the picker to specific provider institution ids; `"all"` offers every identity-capable bank in the country. Coverage belongs to the route the node selected in `provider_key`: a country the native route or the connected marketplace provider cannot establish account ownership in is REFUSED on save rather than dropped, because connecting to a bank that returns no holder identity spends an attempt and a charge to end at `not_verifiable`. |
| `bank_country_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the institution's country differs from the expected/document country. |
| `bank_currency_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the account currency is not in `bank_expected_currencies`. |
| `bank_eligible_account_types` | array \| null | array | Which account types the user may pick. Credit cards, loans and investment accounts are never eligible - they do not establish ownership of a payment account. Defaults to current/checking. |
| `bank_expected_currencies` | array \| null | array | ISO 4217 currencies the account is expected to be in. Empty means any; a mismatch is reported through `bank_currency_mismatch_action`. |
| `bank_field_sources` | json \| null | {"full_name"\|"first_name"\|"last_name"\|"address": {"source": "document_ai"\|"questionnaire"\|"expected_data", "key": "<docai field key>\|<questionnaire node id>\|expected_details.<expected_details field>\|metadata.<key>"}} | Where to read a reference-identity field when no earlier step in the graph can fill it. The map's KEY is one of `full_name`, `first_name`, `last_name`, `address`; `source` names the producer and `key` names the value inside it - a Document AI field key for `document_ai`, a questionnaire node id for `questionnaire`, and `expected_details.<field>` or `metadata.<key>` for `expected_data`. An `expected_details.<field>` VALUE may only name a field the session-create payload actually carries - `address`, `country`, `date_of_birth`, `first_name`, `gender`, `id_country`, `identification_number`, `ip_address`, `last_name`, `nationality` or `poa_country`. A malformed entry is refused on save, not dropped. |
| `bank_joint_account_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the account has more than one holder. |
| `bank_low_balance_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the available balance is below `bank_min_balance`. Needs the `balances` scope. |
| `bank_max_attempts` | integer \| null | integer >=1 <=5 | How many connection attempts the user gets, 1 to 5. Spending them all without a successful connection is `bank_attempts_exhausted_action`. |
| `bank_min_balance` | number \| null | number >=0 | Minimum available balance, in the account's own currency. Below it `bank_low_balance_action` fires. Needs the `balances` scope and the save is refused without it. 0 is a real cutoff - it triggers the action for an overdrawn account - but the action defaults to `NO_ACTION`, so the verdict is unchanged unless another action is configured. This is not the same as leaving the key out. |
| `bank_name_match_threshold` | integer \| null | integer >=50 <=100 | At or above this score the holder name is a match. 50 to 100, defaults to 85. |
| `bank_no_match_action` | string \| null | 'REVIEW'\|'DECLINE' | Verdict when the account holder is demonstrably not the verified person (best name score below `bank_partial_match_floor`). |
| `bank_not_verifiable_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the institution connected but returned no holder identity to compare. |
| `bank_partial_match_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the holder name lands between `bank_partial_match_floor` and `bank_name_match_threshold`. Never approves by default. |
| `bank_partial_match_floor` | integer \| null | integer >=0 <=99 | Below this score the holder name is a no-match. 0 to 99, defaults to 70. The band between the floor and the threshold is the partial match, so the floor must be strictly below `bank_name_match_threshold` or the save is refused. An explicit null means "use the default" here too, which is why a threshold of 50 with no floor is refused: it is checked against the default floor of 70. |
| `bank_reference_identity` | string \| null | 'auto'\|'database_validation'\|'expected_details'\|'kyc'\|'questionnaire' | Which earlier step supplies the identity the account holder is compared against: `kyc` (ID Verification), `database_validation`, `expected_details` (the session-create payload), `questionnaire`, or `auto` to use whichever one the workflow produced. The step that actually supplied it is recorded on the result as `reference_identity_source`. |
| `bank_reference_identity_missing_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when no earlier step produced an identity to compare the holder against, so ownership can only be `unknown`. |
| `bank_refresh_enabled` | boolean \| null | boolean | Re-fetch the account's financial data after the step has already been decided, for as long as the bank consent lasts. Needs at least one of the `balances`, `transactions` or `income` scopes and the save is refused without one. A consent that lapses afterwards is `bank_consent_expired_action`. |
| `bank_require_address_match` | boolean \| null | boolean | Also require the holder's address to match. A name that reached the threshold but whose address scores below it drops to a partial match. An institution that returns no address waives the requirement; a session with no address of its own to compare against does not, and lands on a partial match. Off by default. |
| `bank_require_oauth_only` | boolean \| null | boolean | Offer only institutions reachable over OAuth / app-to-app, never a provider's legacy credential-capture surface. Where open banking already makes OAuth the only route, this changes nothing. |
| `bank_scopes` | json \| null | {"ownership": true, "identifiers": true\|false, "balances": true\|false, "transactions": true\|false, "income": true\|false} | What the user is asked to consent to sharing. `ownership` is what the product verifies and cannot be turned off. `identifiers` unmasks the IBAN / account number; `balances`, `transactions` and `income` read real financial data, are each billed separately, and are refused on save unless the application carries the `bank_financial_data` entitlement. A scope that is off is never requested from the provider, so the bank never shows it on its consent screen. |
| `bank_show_match_result_to_user` | boolean \| null | boolean | Show the ownership result to the user inside the verification flow. Off means it is recorded on the session but never shown to them. |
| `bank_skipped_action` | string \| null | 'REVIEW'\|'DECLINE' | Verdict when the user skipped the step. Only reachable with `bank_allow_skip`. |
| `bank_store_full_identifiers` | boolean \| null | boolean | Store the account identifiers unmasked rather than masked. Needs the `identifiers` scope and the save is refused without it. Even then the unmasked form is only served to a caller holding the bank-verification read permission. |
| `bank_store_raw_owner_data` | boolean \| null | boolean | Keep the holder details the institution returned next to the ownership evidence. Off means only the comparison itself is retained: scores, match method and reason codes. |
| `bank_transactions_history_days` | integer \| null | integer >=30 <=365 | How far back transaction history is read, 30 to 365 days, defaulting to 90. Needs the `transactions` scope and the save is refused without it. |
| `bank_unknown_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the evidence could not be fetched after retries - a transient failure. |
| `bank_unsupported_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the user's bank is not supported and the node does not allow skipping. |
| `bank_use_provider_score` | boolean \| null | boolean | Also read the institution's own holder-name score, and let it decide when it is higher than Didit's or when Didit had no holder name to score at all. A result decided that way reports `provider_only` as its match method, and a connection that returned no such score records a `provider_score_unavailable` warning. On by default. |
| `fallback_to_native` | boolean \| null | boolean | Whether a marketplace connection that cannot be established falls back to Didit's native route. Off by default: a silent fallback would spend your Didit balance on a session you expected to run on your own provider contract. A fallback connection is recorded as `credential_source = native` and billed at the native price. |
| `provider_key` | string \| null | string | Which route runs the step. Empty (the default) is Didit's native Bank Verification, a provider-independent product Didit routes to the regional open-banking vendor that serves the user's country and institution, on Didit's contracts and billing. A value names a MARKETPLACE provider whose own credentials this application has connected - the session then runs, is billed and is revoked on your provider account, and Didit charges only the marketplace platform fee. A provider that is not connected is refused on save. |
| `status_rules` | array | array |  |

### DATABASE_VALIDATION

Configuration for Database Validation feature.
> The node is opt-in and does nothing while `database_validation_countries` is empty - the editor blocks publishing in that state and the compliance check reports it as a gap. Place it after the step that produces its inputs (usually OCR), and use `database_validation_field_sources` only for inputs no upstream step can fill.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `database_validation_countries` | json \| null | {"<ISO3>": {"services": ["<service_id>", ...]}} | The databases to check, per country - this node runs NOTHING until at least one country carries at least one service id. Service ids come from the country's live catalog (e.g. `bra_cpf` for BRA); ids that do not belong to the named country, and countries with no live service, are dropped on save. The legacy `{"<ISO3>": "one_by_one"\|"two_by_two"\|"not_enabled"}` shape is still accepted and auto-expanded to that country's live services. |
| `database_validation_field_sources` | json \| null | {"<db_validation_input_field>": {"source": "document_ai"\|"questionnaire"\|"expected_data", "key": "<docai field key>\|<questionnaire node id>\|expected_details.<expected_details field>\|metadata.<key>"}} | Where to read a database input that no earlier step in the graph can fill. `source` names the producer and `key` names the value inside it: a Document AI field key for `document_ai`, a questionnaire node id for `questionnaire`, and `expected_details.<field>` or `metadata.<key>` for `expected_data`. The two halves speak different vocabularies: the map's KEY is a Database Validation input field (`tax_id`, `document_number`, ...), while an `expected_details.<field>` VALUE may only name a field the session-create payload actually carries - `address`, `country`, `date_of_birth`, `first_name`, `gender`, `id_country`, `identification_number`, `ip_address`, `last_name`, `nationality` or `poa_country`. Anything else under `expected_details.` is rejected on save; `metadata.<key>` takes any non-empty whitespace-free customer key. Exact-key matches against an upstream step resolve automatically and are deliberately not persisted, so renaming a Document AI field never freezes a stale mapping into the config. A malformed entry is dropped on save rather than rejected, which un-satisfies its service and drops it from the selection. |
| `database_validation_no_match_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the database returns no match at all. |
| `database_validation_not_applicable_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when no selected database covers the holder's country or document. |
| `database_validation_partial_match_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the database matches some, but not all, of the submitted fields. |
| `status_rules` | array | array |  |

### DOCUMENT_AI

Configuration for the Document AI feature.
> At most 3 documents per node, field keys unique within a document, and at most one field per document may set `is_full_name` (it is optional - a document may mark none).

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `document_ai_document_tampering_action` | string \| null | 'REVIEW'\|'DECLINE' | Verdict when the document looks tampered with. |
| `document_ai_documents` | array | array |  |
| `document_ai_max_attempts_exceeded_action` | string \| null | 'REVIEW'\|'DECLINE' | Verdict when the user runs out of `document_ai_max_retry_attempts`. |
| `document_ai_max_retry_attempts` | integer \| null | integer >=2 <=5 |  |
| `document_ai_missing_required_fields_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a field marked `required` could not be extracted. |
| `document_ai_name_match_score_threshold` | integer \| null | integer >=0 <=100 |  |
| `document_ai_name_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the field flagged `is_full_name` disagrees with the verified identity's full name, scored against `document_ai_name_match_score_threshold`. |
| `document_ai_unreadable_document_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the uploaded document cannot be read at all. |
| `document_ai_unsupported_file_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the uploaded file type is not supported. |
| `status_rules` | array | array |  |

### EMAIL_VERIFICATION

Configuration for Email Verification feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `breached_email_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the address appears in a known credential breach. |
| `cross_org_fraud_email_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this address was flagged as fraudulent by another organization in the network. |
| `disposable_email_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the address belongs to a disposable-mail provider. |
| `duplicated_email_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the address was already verified for this application. |
| `email_alphanumeric_code` | boolean \| null | boolean |  |
| `email_code_size` | integer \| null | integer >=4 <=8 |  |
| `email_enrichment_enabled` | boolean \| null | boolean |  |
| `email_intelligence_score_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the enrichment score is worse than `email_intelligence_score_threshold`. |
| `email_intelligence_score_threshold` | integer \| null | integer >=0 <=100 |  |
| `email_max_check_attempts` | integer \| null | integer >=1 <=5 |  |
| `email_max_retries` | integer \| null | integer >=1 <=5 |  |
| `email_no_social_presence_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the social footprint check (`email_social_enabled`) finds the address registered on none of the platforms it covers. |
| `email_social_enabled` | boolean \| null | boolean |  |
| `frequent_email_breach_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the address appears in many breaches. |
| `only_corporate_emails_allowed` | boolean \| null | boolean |  |
| `recent_email_breach_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the address appears in a recent breach. |
| `status_rules` | array | array |  |

### FACE_MATCH

Configuration for Face Match feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `face_match_eyes_covered_action` | string | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when calibrated evidence says the eyes region is covered in the selfie. NO_ACTION records evidence without changing Face Match; REVIEW sends Face Match to review; DECLINE declines it. The signal remains shadow-only until the region reports calibrated=true. |
| `face_match_face_covered_action` | string | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when calibrated evidence says the face region is covered in the selfie. NO_ACTION records evidence without changing Face Match; REVIEW sends Face Match to review; DECLINE declines it. The signal remains shadow-only until the region reports calibrated=true. |
| `face_match_max_attempts` | integer \| null | integer >=1 <=3 |  |
| `face_match_mouth_covered_action` | string | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when calibrated evidence says the mouth region is covered in the selfie. NO_ACTION records evidence without changing Face Match; REVIEW sends Face Match to review; DECLINE declines it. The signal remains shadow-only until the region reports calibrated=true. |
| `face_match_not_computed_action` | string \| null | 'REVIEW'\|'DECLINE' | Verdict when no face-match score could be produced (missing portrait or selfie). |
| `face_match_score_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_match_score_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `status_rules` | array | array |  |

### GEOLOCATION

Configuration for the Precise Location (GEOLOCATION) feature. Every threshold is bounded here rather than in the client: the browser and the native SDKs are told what to collect by the step data this config produces, and a value the server would refuse must never reach a user as a request their device cannot satisfy. The action keys all default to Review rather than Decline. A denied permission, a wide radius or a stale fix is not evidence of fraud, and a default that declined them would make the step a conversion trap.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `geolocation_accuracy_mode` | string \| null | 'approximate_allowed'\|'precise' |  |
| `geolocation_allow_qr_handoff` | boolean \| null | boolean |  |
| `geolocation_allow_skip` | boolean \| null | boolean |  |
| `geolocation_approximate_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the user granted an approximate location while `geolocation_accuracy_mode` asks for a precise one. |
| `geolocation_deep_link_enabled` | boolean \| null | boolean |  |
| `geolocation_document_distance_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the device position is further from the document address than `geolocation_document_distance_km`. The address is geocoded coarsely, so this is a weak signal. |
| `geolocation_document_distance_km` | integer \| null | integer >=0 |  |
| `geolocation_document_distance_unit` | string \| null | 'imperial'\|'metric' | The unit the console shows `geolocation_document_distance_km` in. Display only: the stored value is always kilometres and no rule depends on it. |
| `geolocation_geofence_undetermined_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the position cannot be placed inside or outside the fence because its accuracy circle reaches the boundary. Uncertainty is never reported as being outside. |
| `geolocation_geofencing_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the device position, and its whole uncertainty circle, falls outside `geolocation_geofencing_by_country`. |
| `geolocation_geofencing_by_country` | json \| null | {"<ISO3>": {"allowed": true\|false, "states"?: {"<ISO 3166-2 code>": {"allowed": true\|false}} \| null}} | Country and region allow/deny rules for the device's own position, applied only while `is_geolocation_geofencing_enabled` is true. Same shape as IP Analysis's `ip_geofencing_by_country`, except that `states` keys are ISO 3166-2 codes (`US-NJ`), not state names, because the position is resolved to a subdivision rather than to a provider's city label. A country that is not listed is allowed. Saving a region rule for a country with no published ISO 3166-2 boundaries is rejected rather than silently ignored. |
| `geolocation_integrity_missing_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a native client submitted a position with no device-attestation token. Defaults to No action; web clients are recorded as unsupported rather than missing, because no browser can attest. |
| `geolocation_ip_distance_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the device position and the session's IP location are further apart than `geolocation_ip_distance_km`, after both uncertainty radii are subtracted. |
| `geolocation_ip_distance_km` | integer \| null | integer >=0 |  |
| `geolocation_ip_distance_unit` | string \| null | 'imperial'\|'metric' | The unit the console shows `geolocation_ip_distance_km` in. Display only: the stored value is always kilometres and no rule depends on it. |
| `geolocation_low_accuracy_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when no attempt established the required precision: the best position has an uncertainty radius wider than `geolocation_max_accuracy_radius_m`, or it reported no radius at all. A position without a radius is never counted as meeting the limit. |
| `geolocation_max_accuracy_radius_m` | integer \| null | integer |  |
| `geolocation_max_accuracy_radius_unit` | string \| null | 'imperial'\|'metric' | The unit the console shows `geolocation_max_accuracy_radius_m` in. Display only: the stored value is always metres, no rule depends on it, and the step data only forwards it so a client can show the same unit. |
| `geolocation_max_age_seconds` | integer \| null | integer |  |
| `geolocation_max_attempts` | integer \| null | integer |  |
| `geolocation_mock_location_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the operating system reported the position as simulated rather than measured (Android mock provider, iOS simulated-by-software). |
| `geolocation_permission_denied_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the user declined or dismissed the location prompt on every allowed attempt. Defaults to Review: a refusal is a choice, not a fraud signal. |
| `geolocation_stale_fix_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the position was measured more than `geolocation_max_age_seconds` before the server received it. |
| `geolocation_timeout_seconds` | integer \| null | integer |  |
| `geolocation_unavailable_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when no position could be obtained - location services off or restricted, the positioning system returned nothing, the attempt timed out, the user skipped the step, or the client is too old to support it. |
| `is_geolocation_geofencing_enabled` | boolean \| null | boolean |  |
| `status_rules` | array | array |  |

### IP_ANALYSIS

Configuration for Device & IP Analysis feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `automation_detected_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the session looks driven by automation rather than a person. |
| `cross_org_fraud_device_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this device was flagged as fraudulent by another organization in the network. |
| `cross_org_fraud_ip_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this IP was flagged as fraudulent by another organization in the network. |
| `device_app_tampered_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the host application binary looks tampered with. |
| `device_blocklist_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the device is on the organization's block list. |
| `device_debugger_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a debugger is attached to the host application. |
| `device_emulator_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the device is an emulator rather than real hardware. |
| `device_hooking_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when runtime hooking or instrumentation is detected. |
| `device_integrity_missing_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when no platform device-integrity attestation was returned. |
| `device_rooted_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the device is rooted or jailbroken. |
| `duplicated_device_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this device was already used by another verified user. |
| `duplicated_ip_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this IP was already used by another verified user. |
| `expected_ip_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the IP disagrees with the expected IP sent on the session. |
| `ip_geofencing_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the connecting IP's country is not allowed by `ip_geofencing_by_country`. |
| `ip_geofencing_by_country` | json \| null | {"<ISO3>": {"allowed": true\|false, "states"?: {"<state_code>": {"allowed": true\|false}} \| null}} | Country allow/deny rules for the connecting IP address, applied only while `is_ip_geofencing_enabled` is true. `allowed` is required and must be a real boolean; `states` is optional and null when the country needs no per-state rule. Countries that are not valid ISO3 are dropped on save. |
| `ip_location_not_determined_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when no IP address identifying the end user was recorded, so the session has no IP location at all: country, city, ISP, coordinates and time zone are unavailable, and `ip_geofencing_by_country`, the document-country comparison and the VPN/data-centre checks cannot run. Defaults to `No Action`, which keeps the `IP_LOCATION_NOT_DETERMINED` warning visible on the session without changing its verdict; set `Review` or `Decline` if an unlocated session must not pass. |
| `ip_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the IP country disagrees with the document's issuing country. |
| `is_ip_geofencing_enabled` | boolean \| null | boolean |  |
| `multiple_devices_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the session was driven from more than one device. |
| `recovered_device_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the device reports a recovered or restored state. |
| `status_rules` | array | array |  |
| `vpn_detection_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the connection comes through a VPN, proxy or Tor exit. |

### KYB_DOCUMENTS

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `kyb_document_age_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a document is older than its configured freshness window. |
| `kyb_document_critical_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a document contradicts the registry on a critical company detail. |
| `kyb_document_max_attempts_exceeded_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the user runs out of `kyb_document_max_retry_attempts`. |
| `kyb_document_max_retry_attempts` | integer \| null | integer >=1 <=5 |  |
| `kyb_document_non_critical_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a document contradicts the registry on a minor detail. |
| `kyb_document_subtype_config` | json \| null | {"<KYB_DOCUMENT_GROUP\|KYB_DOCUMENT_SUBTYPE>": {"enabled": true\|false, "max_age_days": <0-3650>\|-1\|null}} | Per-group or per-subtype switch and freshness window. Keys must be a known KYB document group or subtype code. `max_age_days` is null for the default window, -1 for unlimited, or an integer 0-3650; anything else is rejected. |
| `kyb_document_tampering_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a company document looks tampered with. |
| `kyb_required_document_groups` | json \| null | ["<KYB_DOCUMENT_GROUP>", ...] | The company paperwork to collect, as a list of document-GROUP codes - each group is satisfied by any one of the document types it covers. The KYB Documents feature refuses to save with an empty list: a node that requires nothing is the same as not having the node. |
| `status_rules` | array | array |  |

### KYB_KEY_PEOPLE

> The workflow ids here point at separate KYC workflows: a KYB graph verifies the company, and the people behind it are verified by the linked person workflows.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `kyb_corporate_ubo_verification_workflow` | uuid \| null | uuid |  |
| `kyb_key_people_company_fields` | json \| null | [{"key": "<field key>", "label": "<label>", "type": "text"\|"number"\|"date"\|"phone"\|"email", "required": true\|false, "custom": true\|false}] | Which company details are collected for a CORPORATE key person. Same list-of-descriptors shape and same rules as `kyb_key_people_person_fields`. |
| `kyb_key_people_document_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a key person's document disagrees with the details declared for them. |
| `kyb_key_people_ownership_required` | boolean \| null | boolean |  |
| `kyb_key_people_person_fields` | json \| null | [{"key": "<field key>", "label": "<label>", "type": "text"\|"number"\|"date"\|"phone"\|"email", "required": true\|false, "custom": true\|false}] | Which personal details are collected for an individual key person, as an ORDERED LIST of field descriptors (not a map). `key` is required and non-empty; `type` must be one of text, number, date, phone or email; `custom` marks a field the customer added rather than one of the built-ins. |
| `kyb_key_people_prefill_from_registry` | boolean \| null | boolean | Pre-fill the key-people list from the company registry result, so the customer confirms and corrects rather than typing every officer and shareholder in. |
| `kyb_notify_parties_by_email` | boolean \| null | boolean |  |
| `kyb_officer_verification_workflow` | uuid \| null | uuid |  |
| `kyb_reject_if_ubo_rejected` | boolean \| null | boolean |  |
| `kyb_require_corporate_ubo_kyb` | boolean \| null | boolean |  |
| `kyb_require_officer_kyc` | boolean \| null | boolean |  |
| `kyb_require_ubo_kyc` | boolean \| null | boolean |  |
| `kyb_reuse_verified_individuals` | boolean \| null | boolean |  |
| `kyb_role_config` | json \| null | {"<role_key>": {"enabled"?: true\|false, "require_kyc"?: true\|false, "verification_workflow"?: "<workflow uuid>"\|null, "allow_skip"?: true\|false}} | Per-role rules for the people behind the company. Role keys come from the existing config - never invent one. A role with `require_kyc: true` MUST also carry a `verification_workflow` (the uuid of a separate KYC workflow) or the save is rejected. A list of `{"role": ..., ...}` entries is accepted as an alternative to the map. |
| `kyb_shareholder_ownership_threshold` | integer \| null | integer >=0 <=100 |  |
| `kyb_shareholder_verification_workflow` | uuid \| null | uuid |  |
| `kyb_ubo_ownership_threshold` | integer \| null | integer >=0 <=100 |  |
| `kyb_ubo_verification_workflow` | uuid \| null | uuid |  |
| `kyb_wait_for_all_ubos` | boolean \| null | boolean |  |
| `status_rules` | array | array |  |

### KYB_REGISTRY

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `kyb_accepted_countries` | json \| null | ["<ISO2>", ...] | Which company-registry countries the business may be incorporated in, as a list of ISO-2 codes (note: ISO-2 here, unlike the ISO-3 used by the OCR and IP allow-lists). An empty list or null accepts every supported registry. |
| `kyb_manual_company_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the company could not be found in a registry and was entered by hand. |
| `kyb_registry_countries_config` | json \| null | {"<ISO2>": {"enabled": true\|false, "tier": "basic"\|"shareholders"\|"ubo"}} | Per-country registry routing configuration. Each enabled country selects the data tier charged when a company is selected. Only tiers marked available by the pricing endpoint can be enabled. At least one country must be enabled: a registry check that searches nowhere is rejected. Manual company entry does not use this configuration and is billed at its own flat fee of USD 0.75 per company. |
| `kyb_registry_fields_config` | json \| null | {"<registry_field>": {"enabled"?: true\|false, "required"?: true\|false}} | Per-registry-field overrides controlling which company details are collected and which of them are mandatory. Field keys come from the backend's configurable-field catalog (registration_number, incorporation_date, legal_address, vat_number, alternative_names, tax_number, company_type, legal_entity_identifier, location_of_registration, nature_of_business, registered_capital_amount, registered_capital_currency, website, email, phone, ...); an unknown key, or any sub-key other than `enabled` / `required`, is rejected. |
| `kyb_registry_monitoring_enabled` | boolean \| null | boolean | Keep the COMPANY's registry record under continuous monitoring after a Shareholders or UBO result: changes of status, officers, ownership or address move the session back to review and fire a webhook. Only where the registry provider offers monitoring; USD 2.00 per company per year, cancellable at any time. Off by default. |
| `kyb_vat_invalid_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the VAT number is rejected by the tax authority. |
| `kyb_vat_unverified_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the VAT number could not be checked at all. |
| `status_rules` | array | array |  |

### LIVENESS

Configuration for Liveness feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `cross_org_fraud_face_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Deprecated and no longer applied. It treated a face as if it carried a fraud verdict. Use `cross_org_identity_claim_pattern_action`. |
| `cross_org_identity_claim_pattern_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when other organizations in the network recorded identity-claim events for this same person in which the claimed identity did not match. Review or no action only - a decline set here is downgraded to review. |
| `external_capture_device_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when an external capture device is detected. |
| `face_audio_recording_enabled` | boolean \| null | boolean | Record the microphone during the selfie capture, so a reviewer can hear the session. Off by default. |
| `face_liveness_duplicated_face_document_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a duplicate face is found on a user verified with a different date of birth. Another document of the same person (a passport after an identity card, a renewal, a document of a second country) is not flagged. |
| `face_liveness_duplicated_face_name_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a duplicate face is found under a different name. |
| `face_liveness_flash_mode` | string \| null | string |  |
| `face_liveness_max_attempts` | integer \| null | integer >=1 <=3 |  |
| `face_liveness_method` | string \| null | 'ACTIVE_3D'\|'FLASHING'\|'PASSIVE' |  |
| `face_liveness_mode` | string \| null | string |  |
| `face_liveness_multiple_faces_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when more than one face is present in the capture. |
| `face_liveness_possible_duplicated_face_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this face matches a previously seen user. |
| `face_liveness_score_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_liveness_score_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_liveness_uncertain_retry_enabled` | boolean \| null | boolean | Native SDK active liveness only. On, a capture whose liveness score falls strictly between face_liveness_score_decline_threshold and face_liveness_score_review_threshold is never decided, whichever verdict the engine attached to it: the person is told the result was unclear and asked to capture again, every time, outside the face_liveness_max_attempts budget (which still applies to captures the engine could not score). Off by default; the web flow ignores it. |
| `face_liveness_video_anomaly_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the stored liveness recording contains a repeated moving sequence consistent with a looped video feed, measured server-side from the video itself, independently of the liveness score. It deliberately does NOT flag a frozen or near-motionless capture: frame statistics cannot separate an injected still from a genuine one (a subject holding still, or a flash that clips the exposure), so acting on that would decline real users. A frozen or pre-recorded injected feed is instead defeated by strict flash liveness (set face_liveness_flash_mode to "1" for strict), which binds the capture to a per-session colour-sequence challenge a recording cannot reproduce. Defaults to NO_ACTION (evidence is recorded, the verdict is unchanged). |
| `face_luminance_max_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is brighter than `face_luminance_max_threshold`. |
| `face_luminance_max_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_luminance_min_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is darker than `face_luminance_min_threshold`. |
| `face_luminance_min_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_privacy_mode_enabled` | boolean \| null | boolean |  |
| `face_quality_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_quality_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_search_enabled` | boolean \| null | boolean | Run the 1:N Face Search on the selfie: match it against previously verified users, the face blocklist and allowlist, and store its biometric template for later matching. On by default. Off skips the search, keeps no face template, and leaves the duplicate-face actions with nothing to act on. |
| `frame_injection_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when injected video frames are detected. |
| `race_map_similarity_thresholds` | json | {"<race>": {"possible": 0-100, "high": 0-100}} | Per-demographic overrides of the face-similarity bands used against the allow-list and duplicate-face sets, so match rates stay even across groups. `possible` is the lower band (defaults to 62) and `high` the upper (68); a group with no entry uses those defaults. |
| `screen_capture_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is a photo of a screen. |
| `status_rules` | array | array |  |
| `virtual_camera_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a virtual camera feed is detected. |

### NFC

Configuration for NFC/ePassport feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `allow_nfc_skip` | boolean \| null | boolean |  |
| `skip_nfc_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the user skips the NFC chip read (only reachable with `allow_nfc_skip`). |
| `status_rules` | array | array |  |
| `trust_anchor_missing_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when chip data-group hashes are intact but the certificate chain cannot be verified because the issuing country's CSCA trust anchor is not loaded. |
| `unverified_chip_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the chip is read but its signature cannot be verified. |

### OCR

Configuration for OCR/ID Verification feature.
> Omitting `documents_allowed` stores the full country/document catalog, so the node accepts everything. Put OCR before any feature that reads identity data from the document (FACE_MATCH, NFC, DATABASE_VALIDATION).

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `age_restrictions_by_country` | json \| null | {"<ISO3>": {"minimum_age": 1-120, "maximum_age": 1-120\|null, "states"?: {"<STATE_CODE>": {"minimum_age": 1-120, "maximum_age": 1-120\|null}}}} | Per-country (and optionally per-state) age gate. `minimum_age` is required for every country listed; `maximum_age` may be null. |
| `critical_field_occlusion_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a critical printed field - an identity number, a name, the date of birth or the expiry date - was physically covered on the captured document. Defaults to REVIEW. |
| `cross_org_fraud_document_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this document was flagged as fraudulent by another organization in the network. |
| `document_audio_recording_enabled` | boolean \| null | boolean | Record the microphone during document capture, so a reviewer can hear the session. Off by default. |
| `document_blur_fields_by_country` | json \| null | {"<ISO3>": ["<blur_field_name>", ...]} | Fields to blur out of the stored document image, per country. Only fields the country's document layout supports are accepted. |
| `document_liveness_portrait_replace_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `document_liveness_portrait_replace_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `document_liveness_printed_copy_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `document_liveness_printed_copy_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `document_liveness_screen_replay_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `document_liveness_screen_replay_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `document_or_personal_number_format_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the document or personal number does not match the country's expected format. |
| `document_selfie_duplicated_face_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the document-capture selfie matches, or possibly matches, the face of a user already verified in this application. |
| `document_selfie_duplicated_face_document_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the document-capture selfie matches a user already verified with a different date of birth. Another document of the same person (a passport after an identity card, a renewal, a document of a second country) is not flagged. Can only escalate document_selfie_duplicated_face_action. |
| `document_selfie_duplicated_face_name_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the document-capture selfie matches a user already verified under a different name. Can only escalate document_selfie_duplicated_face_action. |
| `document_selfie_face_search_enabled` | boolean \| null | boolean | Run the 1:N Face Search on the selfie taken during document capture (needs is_document_selfie_portrait_match_enabled): match it against the face blocklist and previously verified users. The selfie is a probe only, its template is never stored. On by default. Off skips the search and leaves the document-selfie duplicate-face actions with nothing to act on; face_search_enabled off on the LIVENESS step skips it too, since that opt-out covers every selfie of the session. |
| `document_selfie_portrait_match_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `document_selfie_portrait_match_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `document_without_portrait_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the scanned document family carries no portrait on any side. Node-config only - there is no account-level setting; the runtime default is REVIEW. |
| `documents_allowed` | json \| null | {"<ISO3>": {"<DOC_CODE>": {"enabled": 0\|1, "sides"?: 1\|2, "subtypes"?: ["<SUBTYPE_CODE>", ...]}}} | Which identity documents are accepted, per issuing country. Omit the key entirely to accept the full catalog; an empty object means the same thing. At least one document must end up enabled or the save is rejected. |
| `duplicated_user_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the identity was already verified for this application. |
| `expected_details_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the extracted identity contradicts the `expected_details` sent with the session. |
| `expiration_date_not_detected_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when no expiry date could be read from the document. |
| `id_document_quality_threshold` | integer \| null | integer >=0 <=100 |  |
| `id_verification_max_retry_attempts` | integer \| null | integer >=2 <=5 |  |
| `id_verification_name_match_score_threshold` | integer \| null | integer >=0 <=100 |  |
| `image_capture_methods_allowed` | array \| null | ["CAMERA_SCAN" \| "UPLOAD", ...] | Capture methods the end user may use for the document photo. Declared as a list of free strings, so the vocabulary is not in the field itself: CAMERA_SCAN (live capture) and UPLOAD (pick an existing file). An empty list falls back to the account default. |
| `image_quality_too_low_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when overall document image quality is below the bar. |
| `image_too_blurry_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the captured document image is too blurry to trust. |
| `image_too_bright_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the captured document image is overexposed. |
| `image_too_dark_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the captured document image is underexposed. |
| `inconsistent_data_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the document's own fields contradict each other. |
| `invalid_code_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a document check digit or barcode fails validation. |
| `invalid_mrz_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the machine-readable zone is missing or inconsistent. |
| `invalid_validation_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a document authenticity validation fails. |
| `is_age_restrictions_enabled` | boolean \| null | boolean |  |
| `is_document_selfie_portrait_match_enabled` | boolean \| null | boolean |  |
| `is_image_capture_review_screen_enabled` | boolean \| null | boolean | Show the user a review screen after each document capture, letting them retake the photo before it is submitted. Off by default. |
| `is_ocr_id_verification_data_review_enabled` | boolean \| null | boolean | Let the user review and correct the extracted identity data before the step completes. Off by default. A correction is scored against `ocr_id_verification_data_review_critical_fields`, and a disagreement takes the critical or the minor action accordingly. The review still runs when the workflow includes NFC - a later chip read simply supersedes it. |
| `maximum_age` | integer \| null | integer >=1 <=120 |  |
| `maximum_age_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the holder is older than `maximum_age`. |
| `methods` | json \| null | {"<ISO3>": {"document": {"enabled": bool}, "id_lookup": {"enabled": bool, "source"?: "<source_id>"\|null, "max_attempts": 1-5, "skip_liveness_and_face_match": bool, "on_partial_match": "fallback_to_document"\|"decline", "on_no_match": "fallback_to_document"\|"decline", "on_provider_error": "fallback_to_document"\|"decline", "response_fields"?: ["<field_key>", ...]}, "wallet": {"enabled": bool, "providers": ["<wallet_id>", ...], "on_failure": "fallback_to_document"\|"decline"}}} | Which ID verification methods each country may use: document capture (today's behaviour), non-doc lookup against a government or other authoritative source, and digital identity wallets. Omit the key, or a country, or a method, and that country is document only. Every method must be available for the country in the capability catalog (GET workflow-graph/id-verification-methods-catalog/); wallets are an accept-list with no ordering. Each fallback is `fallback_to_document` or `decline`; `max_attempts` (1-5, default 1) counts only lookups the registry answered. Where the catalog lists several lookup `sources` for a country, `source` picks exactly one by id; omitted means the country's default (the first listed). |
| `minimum_age` | integer \| null | integer >=1 <=120 |  |
| `minimum_age_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the holder is younger than `minimum_age`. |
| `ocr_id_verification_data_review_critical_fields` | array \| null | ["first_name" \| "last_name" \| "date_of_birth" \| ...] | Which extracted identity fields count as critical when the user edits the OCR result, so a mismatch takes the critical action rather than the minor one. |
| `ocr_id_verification_data_review_critical_mismatch_action` | string \| null | 'REVIEW'\|'DECLINE' | Verdict when the user's edit disagrees with OCR on a critical field. |
| `ocr_id_verification_data_review_minor_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the user's edit disagrees with OCR on a non-critical field. |
| `status_rules` | array | array |  |
| `unparsed_address_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the document address could not be parsed into components. |

### PHONE_VERIFICATION

Configuration for Phone Verification feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `code_size` | integer \| null | integer >=4 <=8 |  |
| `cross_org_fraud_phone_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this number was flagged as fraudulent by another organization in the network. |
| `disposable_number_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the number belongs to a disposable-number provider. |
| `duplicated_phone_number_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the number was already verified for this application. |
| `fallback_to_native` | boolean \| null | boolean |  |
| `high_risk_phone_action` | string \| null | 'REVIEW'\|'DECLINE' | Verdict when the number carries a high risk signal. |
| `low_phone_trust_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the trust index is below `phone_trust_index_threshold`. |
| `phone_enrichment_enabled` | boolean \| null | boolean |  |
| `phone_intelligence_score_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the enrichment score is worse than `phone_intelligence_score_threshold`. |
| `phone_intelligence_score_threshold` | integer \| null | integer >=0 <=100 |  |
| `phone_max_check_attempts` | integer \| null | integer >=1 <=5 |  |
| `phone_max_retries` | integer \| null | integer >=1 <=5 |  |
| `phone_no_social_presence_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the social footprint check (`phone_social_enabled`) finds the number registered on none of the platforms it covers. |
| `phone_shared_device_mode` | boolean \| null | boolean |  |
| `phone_social_enabled` | boolean \| null | boolean |  |
| `phone_trust_index_threshold` | integer \| null | integer >=0 <=100 |  |
| `phone_type_risk_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the line type itself is considered risky. |
| `phone_verification_countries` | json \| null | {"<ISO2>": {"<channel: sms\|whatsapp\|telegram\|rcs\|viber\|zalo>": {"enabled": true\|false, "max_retries": <int>} \| true\|false}} | Which countries and delivery channels the one-time code may be sent through. It is a WHITELIST: a country absent from the map is not offered at all, and a channel absent from a listed country is skipped. `max_retries` overrides the node-level retry cap for that one channel. A bare boolean is the legacy form and still means enabled/disabled with the node-level cap. |
| `provider_key` | string \| null | string |  |
| `recent_port_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the number was ported to a new carrier recently. |
| `status_rules` | array | array |  |
| `voip_number_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the number is VoIP rather than a real subscriber line. |

### PROOF_OF_ADDRESS

Configuration for Proof of Address feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `poa_document_authenticity_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the document fails authenticity checks. |
| `poa_document_issues_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the document is damaged, cropped or otherwise unusable. |
| `poa_documents_allowed` | json \| null | {"<ISO3>": {"<DOC_CODE>": {"enabled": 0\|1, "sides"?: 1\|2, "subtypes"?: ["<SUBTYPE_CODE>", ...]}}} | Which proof-of-address documents are accepted, per issuing country. Same shape as OCR's `documents_allowed`; omit to accept the full catalog. |
| `poa_issue_date_not_detected_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when no issue date could be read from the document. |
| `poa_issuer_not_identified_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the issuing company or authority cannot be identified. |
| `poa_languages_allowed` | json \| null | {"<language_code>": 0\|1} | Languages the proof-of-address document may be written in, as a flag per language code. Omit to accept every supported language. |
| `poa_max_attempts_exceeded_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the user runs out of `poa_max_retry_attempts`. |
| `poa_max_retry_attempts` | integer \| null | integer >=2 <=5 |  |
| `poa_name_match_score_threshold` | integer \| null | integer >=0 <=100 |  |
| `poa_name_or_address_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the name or address on the document disagrees with the verified identity. |
| `poa_unparsable_or_invalid_address_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the address on the document cannot be parsed or is not a real address. |
| `poa_unsupported_document_type_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the uploaded document is not one of `poa_documents_allowed`. |
| `poa_unsupported_language_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the document language is not one of `poa_languages_allowed`. |
| `status_rules` | array | array |  |

### QUESTIONNAIRE

Configuration for Questionnaire feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `questionnaire_uuid` | uuid \| null | uuid |  |
| `review_questionnaire_manually` | boolean \| null | boolean |  |
| `status_rules` | array | array |  |

<!-- END GENERATED FEATURE CONFIG REFERENCE -->

## Contributing

The feature-config contract above is generated - never hand-write a config key into a tool description. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the regeneration workflow and the checks that enforce it.

Issues and PRs welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Run the hosted server at [`mcp.didit.me/mcp`](https://mcp.didit.me/mcp), or self-host from this repo (Docker / Node) — see [**Run it yourself**](#run-it-yourself).

## License

[MIT](LICENSE) © Didit Protocol

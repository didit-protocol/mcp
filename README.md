# Didit MCP Server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [Didit](https://didit.me) — bring KYC, KYB, AML screening, transaction monitoring, biometrics, and full workspace operations to Claude, Cursor, VS Code, Windsurf, Zed, and any MCP client.

- **130+ tools** across sessions, workflows, vendor users/businesses, transactions, the standalone verification APIs, lists, cases, reports, webhooks, and billing.
- **Auth is "Log in with Didit" (OAuth 2.1 + PKCE)** — the MCP acts as the signed-in **user** with their role's permissions. There is **no API-key mode**: every tool calls the user-scoped console endpoints, which only accept a Bearer token.
- Every tool calls a single Didit REST endpoint and returns the JSON verbatim.

> Full documentation: **https://docs.didit.me/integration/mcp/overview**

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

### Cursor plugin

This repository includes a Cursor plugin manifest at `.cursor-plugin/plugin.json`.
The plugin uses the hosted OAuth server configured in `.mcp.json`, the existing Didit rule in `rules/`, and the icon in `assets/`.
No local server, API key, or environment variables are required.
Sign in with your Didit account when Cursor requests authorization.
The connection uses your existing organization roles and permissions.

Example requests:

- "Show my Didit organizations and applications."
- "List my verification workflows."
- "Create a sandbox verification link using my selected workflow."
- "Show verification analytics for the last seven days."
- "List the webhooks configured for my application."

Tool results may contain customer and verification data from the workspace you authorize.
Only request information you are authorized to access and share with your AI client.
Review proposed changes before approving write or destructive actions.
Disconnect Didit in your client's MCP settings when you no longer need the connection.

See the [Privacy Policy](https://didit.me/terms/privacy-policy/) and [legal terms](https://didit.me/terms/).
For support, contact [hello@didit.me](mailto:hello@didit.me) or open a [GitHub issue](https://github.com/didit-protocol/mcp/issues).

The presence of this package does not imply marketplace approval.
Publishers can submit the public repository through [Cursor's publishing form](https://cursor.com/marketplace/publish).

## Authentication

The MCP is an OAuth 2.1 **resource server**; the Didit console (`business.didit.me`) is the **authorization server**. On first connect your client opens a browser, you **Log in with Didit** and approve the scopes, and the MCP then acts as **you** — across every organization you belong to, with your role's permissions. Tokens are short-lived and refreshed automatically.

Scopes: `didit:management` (workspace operations) and `didit:verification` (running checks). Your console **role** is enforced server-side on every call.

> **There is no API-key mode.** Every tool targets the user-scoped console endpoints (`/organization/{org}/application/{app}/…`), which authorize a Bearer token with per-role privileges and reject `x-api-key`. (For raw REST access with an application API key — e.g. creating sessions from your backend — use the [REST API](https://docs.didit.me) directly, not this server.)

See [Authentication](https://docs.didit.me/integration/mcp/authentication).

## Tools

130+ tools, grouped by area. The full catalogue with read/write/destructive markers is in [`docs/TOOLS.md`](docs/TOOLS.md) and at [docs.didit.me](https://docs.didit.me/integration/mcp/tools). Highlights:

- **Discovery & cross-app:** `didit_context_get`, `didit_session_search`, `didit_transaction_search`, `didit_vendor_user_search`, `didit_analytics` — aggregate across every org/app in one call.
- **Sessions:** create, list, get decision, update status, reviews, bulk import.
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

_Generated from `schema/feature-config-schema.json` (contract `sha256:200a66d7054aaf6cdddd94d7bd9c62050912862bf6e291908b667b20436ef4cd`, schema version 1), which is a copy of the artifact `service-didit-verification` generates from its feature-config serializers. Do not edit by hand — run `npm run schema:readme`._

### AGE_ESTIMATION

Configuration for Age Estimation feature.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `borderline_maximum_age_threshold` | integer \| null | integer >=1 <=100 |  |
| `borderline_minimum_age_threshold` | integer \| null | integer >=1 <=100 |  |
| `enable_id_verification_fallback` | boolean \| null | boolean |  |
| `external_capture_device_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when an external capture device is detected. |
| `face_audio_recording_enabled` | boolean \| null | boolean | Record the microphone during the selfie capture, so a reviewer can hear the session. Off by default. |
| `face_liveness_duplicated_face_name_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a duplicate face is found under a different name. |
| `face_liveness_flash_mode` | string \| null | string |  |
| `face_liveness_max_attempts` | integer \| null | integer >=1 <=3 |  |
| `face_liveness_method` | string \| null | 'ACTIVE_3D'\|'FLASHING'\|'PASSIVE' |  |
| `face_liveness_multiple_faces_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when more than one face is present in the capture. |
| `face_liveness_possible_duplicated_face_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this face matches a previously seen user. |
| `face_liveness_score_decline_threshold` | number \| null | number |  |
| `face_liveness_score_review_threshold` | number \| null | number |  |
| `face_luminance_max_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is brighter than `face_luminance_max_threshold`. |
| `face_luminance_max_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_luminance_min_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is darker than `face_luminance_min_threshold`. |
| `face_luminance_min_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_privacy_mode_enabled` | boolean \| null | boolean |  |
| `face_quality_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_quality_review_threshold` | integer \| null | integer >=0 <=100 |  |
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

### DATABASE_VALIDATION

Configuration for Database Validation feature.
> The node is opt-in and does nothing while `database_validation_countries` is empty - the editor blocks publishing in that state and the compliance check reports it as a gap. Place it after the step that produces its inputs (usually OCR), and use `database_validation_field_sources` only for inputs no upstream step can fill.

| Key | Type | Accepts | Meaning |
| --- | --- | --- | --- |
| `database_validation_countries` | json \| null | {"<ISO3>": {"services": ["<service_id>", ...]}} | The databases to check, per country - this node runs NOTHING until at least one country carries at least one service id. Service ids come from the country's live catalog (e.g. `bra_cpf` for BRA); ids that do not belong to the named country, and countries with no live service, are dropped on save. The legacy `{"<ISO3>": "one_by_one"\|"two_by_two"\|"not_enabled"}` shape is still accepted and auto-expanded to that country's live services. |
| `database_validation_field_sources` | json \| null | {"<db_validation_input_field>": {"source": "document_ai"\|"questionnaire"\|"expected_data", "key": "<docai field key>\|<questionnaire node id>\|expected_details.<field>\|metadata.<key>"}} | Where to read a database input that no earlier step in the graph can fill. `source` names the producer and `key` names the value inside it: a Document AI field key for `document_ai`, a questionnaire node id for `questionnaire`, and `expected_details.<field>` or `metadata.<key>` for `expected_data`. Exact-key matches against an upstream step resolve automatically and are deliberately not persisted, so renaming a Document AI field never freezes a stale mapping into the config. A malformed entry is dropped on save rather than rejected, which un-satisfies its service and drops it from the selection. |
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
| `face_liveness_duplicated_face_name_mismatch_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when a duplicate face is found under a different name. |
| `face_liveness_flash_mode` | string \| null | string |  |
| `face_liveness_max_attempts` | integer \| null | integer >=1 <=3 |  |
| `face_liveness_method` | string \| null | 'ACTIVE_3D'\|'FLASHING'\|'PASSIVE' |  |
| `face_liveness_mode` | string \| null | string |  |
| `face_liveness_multiple_faces_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when more than one face is present in the capture. |
| `face_liveness_possible_duplicated_face_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when this face matches a previously seen user. |
| `face_liveness_score_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_liveness_score_review_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_luminance_max_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is brighter than `face_luminance_max_threshold`. |
| `face_luminance_max_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_luminance_min_action` | string \| null | 'NO_ACTION'\|'REVIEW'\|'DECLINE' | Verdict when the selfie is darker than `face_luminance_min_threshold`. |
| `face_luminance_min_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_privacy_mode_enabled` | boolean \| null | boolean |  |
| `face_quality_decline_threshold` | integer \| null | integer >=0 <=100 |  |
| `face_quality_review_threshold` | integer \| null | integer >=0 <=100 |  |
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
| `methods` | json \| null | {"<ISO3>": {"document": {"enabled": bool}, "id_lookup": {"enabled": bool, "max_attempts": 1-5, "skip_liveness_and_face_match": bool, "on_partial_match": "fallback_to_document"\|"decline", "on_no_match": "fallback_to_document"\|"decline", "on_provider_error": "fallback_to_document"\|"decline", "response_fields"?: ["<field_key>", ...]}, "wallet": {"enabled": bool, "providers": ["<wallet_id>", ...], "on_failure": "fallback_to_document"\|"decline"}}} | Which ID verification methods each country may use: document capture (today's behaviour), non-doc lookup against a government or other authoritative source, and digital identity wallets. Omit the key, or a country, or a method, and that country is document only. Every method must be available for the country in the capability catalog (GET workflow-graph/id-verification-methods-catalog/); wallets are an accept-list with no ordering. Each fallback is `fallback_to_document` or `decline`; `max_attempts` (1-5, default 1) counts only lookups the registry answered. |
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
| `phone_shared_device_mode` | boolean \| null | boolean |  |
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

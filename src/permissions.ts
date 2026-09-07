// Per-tool permission pre-check.
//
// The backend is the authoritative enforcer: every console endpoint the tools call is
// decorated with `@has_privileges(["<action>:<resource>"])` and refuses with a 403 when
// the caller's organization role lacks it. The introspected token already carries the
// caller's `org_permissions` (they arrive in `AuthInfo.scopes`), so the same decision can
// be taken HERE, before the request leaves: the model gets a `missing_scope` error naming
// the permission instead of an opaque 403, and tools/list can hide what the caller could
// never run. Defense in depth, same pattern as `isPrivilegedCaller`.
//
// TOOL_PERMISSIONS mirrors the backend decorators tool by tool (the PR that introduced it
// lists the endpoint behind every entry) — including their quirks, because a permission the
// backend does not actually check would block legitimate users. `null` means "no
// pre-check": endpoints without a decorator, membership-scoped ones (`/organizations/me/`),
// and everything that is not org/app-scoped. Unknown tools are never checked either.
import { DiditError } from "./security";

export type PermissionMode = "shadow" | "enforce" | "off";

/** Only the backend's permission strings count; `scopes` also carries OAuth scopes and
 * claims, and a token with none of the former (stdio env token) is not a role we can judge. */
const PERMISSION_RE = /^(read|write|delete|list|create|approve):[a-z-]+$/;

export const TOOL_PERMISSIONS: Record<string, string | null> = {
  // ── Auth service (apx.didit.me): membership-scoped or bootstrap, no @has_privileges ──
  didit_account_login: null, // POST auth /programmatic/login/ — account bootstrap
  didit_account_register: null, // POST auth /programmatic/register/ — account bootstrap
  didit_account_resend_otp: null, // POST auth /programmatic/resend-otp/ — account bootstrap
  didit_account_verify_email: null, // POST auth /programmatic/verify-email/ — account bootstrap
  didit_context_get: null, // GET auth /organizations/me/ (+ applications) — membership-scoped
  didit_org_get_application: null, // GET auth /organizations/me/{org}/applications/{app}/ — hardcoded owner/admin check, no decorator
  didit_org_list: null, // GET auth /organizations/me/ — membership-scoped
  didit_org_list_applications: null, // GET auth /organizations/me/{org}/applications/ — hardcoded owner/admin check, no decorator
  didit_org_reveal_application_api_key: null, // same endpoint as didit_org_get_application
  didit_org_invite_member: null, // POST auth /organizations/{org}/members/ — route is GET-only as coded; the invite route (write:members) is /members/invite/
  didit_org_list_api_keys: "read:applications", // GET auth /organizations/{org}/applications/{app}/api-keys/ → application_api_keys.py:24
  didit_org_list_members: "list:members", // GET auth /organizations/{org}/members/ → member.py:141
  didit_org_list_roles: "list:roles", // GET auth /organizations/{org}/roles/ → roles.py:55
  didit_org_remove_member: "delete:members", // DELETE auth /organizations/{org}/members/{id}/ → member.py:109
  didit_org_update_member: "write:members", // PATCH auth /organizations/{org}/members/{id}/ → member.py:76
  // ── Billing ──
  didit_org_get_balance: "read:subscription", // GET /organization/{org}/top-up/ → stripe.py:498
  didit_org_top_up: null, // POST /organization/{org}/top-up/ — TopUpView has only GET/PUT as coded
  // ── Alerts, analytics, audit ──
  didit_alert_configure: "write:applications", // PATCH …/alerts/{type}/ → alerts.py:42
  didit_alert_list: "read:applications", // GET …/alerts/ → alerts.py:62
  didit_analytics: "read:analytics", // GET …/analytics/ → analytics.py:196
  didit_audit_log_list: null, // GET …/audit-logs/ — app-scoped route does not exist as coded (real one: /audit/{org}/audit-logs/, read:audit-logs)
  // ── Blocklist / allowlist ──
  didit_allowlist_add: "write:blocklist", // POST …/allowlist/add/ → allowlist.py:33
  didit_blocklist_add: "write:blocklist", // POST …/blocklist/add/ → blocklist.py:47
  didit_blocklist_get: "read:blocklist", // GET …/blocklist/ → blocklist.py:178
  didit_blocklist_remove: "write:blocklist", // POST …/blocklist/remove/ → blocklist.py:76
  // ── Branding ──
  didit_branding_get: "read:customization", // GET …/white-label-customization/ → white_label_customization.py:66
  didit_branding_update: "write:customization", // PATCH …/white-label-customization/ → white_label_customization.py:73
  // ── Cases ──
  didit_case_create: "write:cases", // POST …/cases/ → case_management.py:292
  didit_case_get: "read:cases", // GET …/cases/{id}/ → case_management.py:353
  didit_case_list: "list:cases", // GET …/cases/ → case_management.py:264
  didit_case_manage: "write:cases", // POST …/cases/{id}/{resolve|assign|reopen|escalate}/, PATCH …/cases/{id}/ → case_management.py
  didit_case_search: "list:cases", // GET /organization/{org}/cases/ → case_management.py:264
  didit_case_statistics: "list:cases", // GET …/cases/statistics/ → case_management.py:910
  // ── Compliance (POST endpoints gated by read:workflows on purpose) ──
  didit_compliance_check_workflow: "read:workflows", // POST …/compliance/workflow-check/ → compliance.py:246
  didit_compliance_generate_workflow: "read:workflows", // POST …/compliance/generate-workflow/ → compliance.py:165
  didit_compliance_interview_next: "read:workflows", // POST …/compliance/interview/next/ → compliance.py:317
  didit_compliance_profile_get: "read:workflows", // GET …/compliance/profile/ → compliance.py:70
  didit_compliance_profile_set: "write:workflows", // PUT …/compliance/profile/ → compliance.py:77
  didit_compliance_requirements: "read:workflows", // GET …/compliance/requirements/ → compliance.py:99
  // ── Lists ──
  didit_lists_create: "create:lists", // POST …/lists/ → lists.py:69
  didit_lists_delete: "delete:lists", // DELETE …/lists/{uuid}/ → lists.py:122
  didit_lists_entries_list: "read:lists", // GET …/lists/{uuid}/entries/ → lists.py:153
  didit_lists_entry_create: "create:lists", // POST …/lists/{uuid}/entries/ → lists.py:197
  didit_lists_entry_delete: "delete:lists", // DELETE …/lists/{uuid}/entries/{entry}/ → lists.py:233
  didit_lists_entry_upload_face: "create:lists", // POST …/lists/{uuid}/entries/face-upload/ → list_face_upload.py:126
  didit_lists_get: "read:lists", // GET …/lists/{uuid}/ → lists.py:110
  didit_lists_list: "read:lists", // GET …/lists/ → lists.py:40
  didit_lists_update: "write:lists", // PATCH …/lists/{uuid}/ → lists.py:114
  // ── Marketplace ──
  didit_marketplace_list_catalog: "read:integrations", // GET …/marketplace/catalog/ → marketplace/views.py:28
  didit_marketplace_list_connections: "read:integrations", // GET …/marketplace/connections/ → marketplace/views.py:39
  didit_marketplace_request_integration: "write:integrations", // POST …/marketplace/requests/ → marketplace/views.py:166
  // ── Networks ──
  didit_network_get: "read:networks", // GET …/networks/{id}/ → networks/views/console.py:742
  didit_network_list: "list:networks", // GET …/networks/ → networks/views/console.py:721
  didit_network_membership_get: "read:networks", // GET …/{entity}/{id}/networks/ → networks/views/console.py:889
  // ── Questionnaires (delete reuses write) ──
  didit_questionnaire_append_choices: "write:questionnaires", // PATCH …/questionnaires/{uuid}/ → questionnaire.py:208
  didit_questionnaire_create: "write:questionnaires", // POST …/questionnaires/ → questionnaire.py:149
  didit_questionnaire_delete: "write:questionnaires", // DELETE …/questionnaires/{uuid}/ → questionnaire.py:227
  didit_questionnaire_get: "read:questionnaires", // GET …/questionnaires/{uuid}/ → questionnaire.py:204
  didit_questionnaire_list: "read:questionnaires", // GET …/questionnaires/ → questionnaire.py:96
  didit_questionnaire_update: "write:questionnaires", // PATCH …/questionnaires/{uuid}/ → questionnaire.py:208
  // ── Reports (row-level access, @has_privileges([]) or per-kind) ──
  didit_report_export: null, // POST …/reports/{kind}/ — permission varies by kind (read:sessions|transactions|businesses|users)
  didit_report_get: null, // GET …/reports/{id}/ → reports.py:129, @has_privileges([]) + row-level check
  didit_report_get_download_url: null, // GET …/reports/{id}/download-url/ → reports.py:153, same
  didit_report_list: null, // GET …/reports/ → reports.py:100, same
  // ── Sessions ──
  didit_session_add_review: "write:sessions", // POST …/sessions/{id}/reviews/ → activity.py:97
  didit_session_batch_delete: "delete:sessions", // DELETE …/sessions/delete/ → application.py:529
  didit_session_create: null, // POST /session/ → session.py:152 — permission classes only, no decorator
  didit_session_create_import: null, // POST /session/imports/ → imports.py:77 — no decorator
  didit_session_delete: "delete:sessions", // DELETE /session/{id}/delete/ → session.py:1406
  didit_session_generate_pdf: "read:sessions", // GET /session/{id}/generate-pdf/ → pdf.py:86
  didit_session_get_decision: "read:sessions", // GET /session/{id}/decision/ → session.py:536
  didit_session_get_import: null, // GET /session/imports/{id}/ → imports.py:170 — no decorator
  didit_session_get_import_errors: null, // GET /session/imports/{id}/errors/ → imports.py:182 — no decorator
  didit_session_get_import_template: null, // GET /session/imports/template/ → imports.py:197 — no decorator
  didit_session_import_shared: null, // POST /session/import-shared/ → shared_session.py:78 — no decorator
  didit_session_list: "list:sessions", // GET …/sessions/ → application.py:123
  didit_session_list_reviews: "read:sessions", // GET …/sessions/{id}/reviews/ → activity.py:77
  didit_session_search: "list:sessions", // GET /organization/{org}/sessions/ → application.py:448
  didit_session_share: "write:sessions", // POST /session/{id}/share/ → shared_session.py:44
  didit_session_update_data: "write:sessions", // PATCH /session/{id}/update-data/ → session.py:1238
  didit_session_update_poa_data: "write:sessions", // PATCH /session/{id}/update-poa-data/ → session.py:1461
  didit_session_update_status: "write:sessions", // PATCH /session/{id}/update-status/ → session.py:1033
  // ── Transactions (reads are gated by list:transactions) ──
  didit_transaction_create: "create:transactions", // POST …/transactions/ → transactions.py:331
  didit_transaction_get: "list:transactions", // GET …/transactions/{id}/ → transactions.py:479
  didit_transaction_list: "list:transactions", // GET …/transactions/ → transactions.py:278
  didit_transaction_rule_backtest: "list:transactions", // POST …/transactions/rules/backtest/ → transactions.py:816
  didit_transaction_rule_create: "write:transactions", // POST …/transactions/rules/ → transactions.py:766
  didit_transaction_rule_delete: "write:transactions", // DELETE …/transactions/rules/{uuid}/ → transactions.py:801
  didit_transaction_rule_get: "list:transactions", // GET …/transactions/rules/{uuid}/ → transactions.py:785
  didit_transaction_rule_install: "write:transactions", // POST …/transactions/rules/install/ → transactions.py:914
  didit_transaction_rule_library_list: "list:transactions", // GET …/transactions/rules/library/ → transactions.py:895
  didit_transaction_rule_list: "list:transactions", // GET …/transactions/rules/ → transactions.py:754
  didit_transaction_rule_uninstall: "write:transactions", // DELETE …/transactions/rules/install/ → transactions.py:926
  didit_transaction_rule_update: "write:transactions", // PATCH …/transactions/rules/{uuid}/ → transactions.py:790
  didit_transaction_screen_wallet: "create:transactions", // POST …/transactions/screen-wallet/ → transactions.py:371
  didit_transaction_sdk_token: null, // POST /transactions/sdk-token/ → transactions_v3.py:130 — client-credential check only
  didit_transaction_search: "list:transactions", // GET /organization/{org}/transactions/ → transactions.py:278
  // ── Travel rule (client-credential checks only, no decorator) ──
  didit_travel_rule_add_wallet_address: null,
  didit_travel_rule_confirm_ownership: null,
  didit_travel_rule_create_widget_session: null,
  didit_travel_rule_delete_wallet_address: null,
  didit_travel_rule_get_settings: null,
  didit_travel_rule_list_wallet_addresses: null,
  didit_travel_rule_register_inbound: null,
  didit_travel_rule_search_vasps: null,
  didit_travel_rule_transfer_action: null,
  didit_travel_rule_update_settings: null,
  didit_travel_rule_update_wallet_address: null,
  // ── Vendor businesses (KYB) ──
  didit_vendor_business_create: "create:businesses", // POST …/vendor-businesses/ → vendor_business.py:154
  didit_vendor_business_delete: "delete:businesses", // DELETE …/vendor-businesses/delete/ → vendor_business.py:935
  didit_vendor_business_get: "read:businesses", // GET …/vendor-businesses/{vendor_data}/ → vendor_business.py:197
  didit_vendor_business_list: "list:businesses", // GET …/vendor-businesses/ → vendor_business.py:150
  didit_vendor_business_search: "list:businesses", // per-app fan-out over the list endpoint
  didit_vendor_business_update: null, // PATCH …/vendor-businesses/{vendor_data}/update/ — route does not exist as coded (only by-id/)
  didit_vendor_business_update_status: "write:businesses", // POST …/vendor-businesses/bulk-status/ → vendor_business.py:965
  // ── Vendor users ──
  didit_vendor_user_create: "create:users", // POST …/vendor-users/ → vendor_user.py:330
  didit_vendor_user_delete: "delete:users", // DELETE …/vendor-users/delete/ → vendor_user.py:1139
  didit_vendor_user_get: "read:users", // GET …/vendor-users/{vendor_data}/ → vendor_user.py:763
  didit_vendor_user_list: "list:users", // GET …/vendor-users/ → vendor_user.py:283
  didit_vendor_user_search: "list:users", // per-app fan-out over the list endpoint
  didit_vendor_user_update: "write:users", // PATCH …/vendor-users/{vendor_data}/update/ → vendor_user.py:1098
  didit_vendor_user_update_status: "write:users", // POST …/vendor-users/bulk-status/ → vendor_user.py:1169
  // ── Standalone verification APIs (proxy.py:36 gates every …/apis/* POST on create:sessions) ──
  didit_verify_age: "create:sessions",
  didit_verify_aml: "create:sessions",
  didit_verify_database: "create:sessions",
  didit_verify_email_check: null, // …/apis/email/check/ — route does not exist as coded (only /apis/email-risk/)
  didit_verify_email_send: null, // …/apis/email/send/ — route does not exist as coded
  didit_verify_face_match: "create:sessions",
  didit_verify_face_search: "create:sessions",
  didit_verify_id: "create:sessions",
  didit_verify_kyb_search: "create:sessions",
  didit_verify_kyb_select: "create:sessions",
  didit_verify_passive_liveness: "create:sessions",
  didit_verify_phone_check: null, // …/apis/phone/check/ — route does not exist as coded
  didit_verify_phone_send: null, // …/apis/phone/send/ — route does not exist as coded
  didit_verify_poa: "create:sessions",
  // ── Webhooks (delete reuses write) ──
  didit_webhook_create: "write:webhooks", // POST …/webhook/destinations/ → webhook_destinations.py:112
  didit_webhook_delete: "write:webhooks", // DELETE …/webhook/destinations/{uuid}/ → webhook_destinations.py:181
  didit_webhook_get: "read:webhooks", // GET …/webhook/destinations/{uuid}/ → webhook_destinations.py:151
  didit_webhook_list: "read:webhooks", // GET …/webhook/destinations/ → webhook_destinations.py:106
  didit_webhook_update: "write:webhooks", // PATCH …/webhook/destinations/{uuid}/ → webhook_destinations.py:160
  // ── Workflows (delete reuses write; graph helpers are read-gated POSTs) ──
  didit_workflow_build_graph: "read:workflows", // POST …/compliance/build-workflow/ → compliance.py:137
  didit_workflow_create: "write:workflows", // POST …/verification-settings/ → verification_settings.py:146
  didit_workflow_create_draft: "write:workflows", // POST …/verification-settings/{uuid}/create-draft/ → verification_settings.py:328
  didit_workflow_delete: "write:workflows", // DELETE …/verification-settings/{uuid}/ → verification_settings.py:224
  didit_workflow_edit_graph: "write:workflows", // PUT …/verification-settings/{uuid}/workflow-graph/ → workflow_graph.py:63
  didit_workflow_get: "read:workflows", // GET …/verification-settings/{uuid}/ → verification_settings.py:214
  didit_workflow_get_branch_fields: "read:workflows", // POST …/workflow-graph/branch-fields/ → workflow_graph.py:202
  didit_workflow_get_feature_config_schema: null, // no backend call — bundled artifact
  didit_workflow_get_field_definitions: "read:workflows", // GET …/workflow-graph/field-definitions/ → workflow_graph.py:451
  didit_workflow_get_id_verification_methods_catalog: "read:workflows", // GET …/workflow-graph/id-verification-methods-catalog/ → workflow_graph.py
  didit_workflow_get_kyb_registry_catalog: null, // GET /organization/kyb-registry-pricing/ → application.py KYBRegistryPricingView (anonymous, no privilege)
  didit_workflow_get_graph: "read:workflows", // GET …/verification-settings/{uuid}/workflow-graph/ → workflow_graph.py:44
  didit_workflow_list: "read:workflows", // GET …/verification-settings/ → verification_settings.py:74
  didit_workflow_publish: "write:workflows", // PATCH …/verification-settings/{uuid}/ → verification_settings.py:219
  didit_workflow_search: "read:workflows", // per-app fan-out over the list endpoint
  didit_workflow_set_graph: "write:workflows", // PUT …/verification-settings/{uuid}/workflow-graph/ → workflow_graph.py:63
  didit_workflow_update: "write:workflows", // PATCH …/verification-settings/{uuid}/ → verification_settings.py:219
  didit_workflow_validate_graph: "read:workflows", // POST …/workflow-graph/validate/ → workflow_graph.py:142
};

export type PermissionDecision = "allow" | "would_deny" | "deny";

export interface PermissionQuery {
  tool: string;
  /** `AuthInfo.scopes`: the introspected `org_permissions` plus OAuth scopes and claims. */
  scopes: readonly string[] | undefined;
  mode: PermissionMode;
  /** The organization the token's permissions describe (`AuthInfo.extra.organization_id`). */
  tokenOrg: string | undefined;
  /** The organization the call acts in (explicit `organization_id` argument, else the token's). */
  targetOrg: string | undefined;
}

/**
 * `allow` when the tool needs no pre-check, the call targets an organization other than
 * the one the token's permissions describe (a multi-org user routing by `organization_id`
 * — we cannot judge that org), the token carries no permission strings, or it carries the
 * required one. Otherwise `deny` in enforce mode and `would_deny` in shadow mode (the call
 * proceeds, the audit line records the verdict).
 */
export function decidePermission({ tool, scopes, mode, tokenOrg, targetOrg }: PermissionQuery): PermissionDecision {
  const required = TOOL_PERMISSIONS[tool];
  const judgeable = Boolean(tokenOrg) && (!targetOrg || targetOrg === tokenOrg);
  const permissions = (scopes ?? []).filter((scope) => PERMISSION_RE.test(scope));

  if (mode === "off" || !required || !judgeable || permissions.length === 0 || permissions.includes(required)) {
    return "allow";
  }

  return mode === "enforce" ? "deny" : "would_deny";
}

export function missingPermissionError(tool: string): DiditError {
  const required = TOOL_PERMISSIONS[tool];

  return new DiditError({
    code: "missing_scope",
    message: `Your role in this organization does not include the permission '${required}' that ${tool} requires.`,
    field: "permission",
    hint: `Ask an organization owner or admin to grant '${required}' to your role, then retry.`,
  });
}

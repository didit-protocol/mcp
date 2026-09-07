/**
 * Catalog profiles: which subset of the tool catalog a given MCP endpoint offers.
 *
 * The hosted server exposes the SAME tool definitions to every client. That is right for
 * Claude, Cursor, Codex and the console assistant, but the ChatGPT app review (OpenAI Apps
 * SDK) rejects any tool whose INPUT collects a restricted sensitive data type: government ID
 * numbers, identity-document or face images, or one-time codes sent to a customer's own
 * email/phone (rejections of 2026-07-06, 07-09, 08-17 and the upheld appeal of 08-25). Those
 * inputs are the product for every other client, so they are not removed globally.
 *
 * Instead the server serves two catalogs from one deployment:
 *
 *   - `full`    : everything (default; `/mcp`, stdio).
 *   - `chatgpt` : an allow-list of core workspace tools with no restricted inputs, served at
 *                 `/mcp/chatgpt` and submitted to the ChatGPT app store.
 *
 * A profile is selected by ENDPOINT, never by guessing the client from headers: the ChatGPT
 * client registers dynamically so its OAuth client id is not known in advance, and a
 * User-Agent is not a contract. Tool OUTPUTS are not altered by any profile.
 */

export type CatalogProfile = "full" | "chatgpt";

export const CATALOG_PROFILES: readonly CatalogProfile[] = ["full", "chatgpt"];

/** Hosted path of the ChatGPT profile endpoint (sibling of the default `/mcp`). */
export const CHATGPT_MCP_PATH = "/mcp/chatgpt";

/**
 * The ChatGPT catalog. Chosen from 30 days of production tool-call telemetry (the console
 * assistant's Braintrust traces, 2026-08-07 .. 2026-09-06): these tools carry ~94% of real
 * usage, and none of them accepts a government ID number, an identity-document or face
 * image, or a one-time code. Kept deliberately small (48) because reviewers and models both
 * do better with a short catalog; add tools back only after approval.
 */
export const CHATGPT_CATALOG: ReadonlySet<string> = new Set([
  // Discovery / organization
  "didit_context_get",
  "didit_org_list",
  "didit_org_list_applications",
  "didit_org_get_application",
  "didit_org_get_balance",
  "didit_org_list_api_keys",
  // Analytics / reports
  "didit_analytics",
  "didit_report_list",
  "didit_report_export",
  "didit_report_get_download_url",
  // Sessions (the hosted verification flow: the operator gets a link, the end user verifies
  // on verify.didit.me where consent is captured; no identity data enters the conversation)
  "didit_session_create",
  "didit_session_search",
  "didit_session_list",
  "didit_session_get_decision",
  "didit_session_update_status",
  "didit_session_list_reviews",
  // Workflows
  "didit_workflow_list",
  "didit_workflow_search",
  "didit_workflow_get",
  "didit_workflow_get_graph",
  "didit_workflow_create_draft",
  "didit_workflow_create",
  "didit_workflow_update",
  "didit_workflow_edit_graph",
  "didit_workflow_validate_graph",
  "didit_workflow_publish",
  "didit_workflow_get_field_definitions",
  "didit_workflow_get_feature_config_schema",
  // Compliance advisor
  "didit_compliance_profile_get",
  "didit_compliance_profile_set",
  "didit_compliance_requirements",
  "didit_compliance_generate_workflow",
  "didit_compliance_check_workflow",
  "didit_compliance_interview_next",
  // Questionnaires
  "didit_questionnaire_list",
  "didit_questionnaire_get",
  "didit_questionnaire_create",
  "didit_questionnaire_update",
  // Webhooks
  "didit_webhook_list",
  "didit_webhook_get",
  "didit_webhook_create",
  "didit_webhook_update",
  "didit_webhook_delete",
  // Cases / vendors / branding
  "didit_case_search",
  "didit_case_get",
  "didit_vendor_user_search",
  "didit_vendor_business_search",
  "didit_branding_get",
]);

/**
 * Input properties removed from an allowed tool's schema in the ChatGPT profile, and refused
 * at call time if a client sends them anyway. `portrait_image` is the only restricted input on
 * an otherwise clean tool (a face image); every other restricted input lives on a tool that
 * the allow-list already excludes.
 */
export const CHATGPT_STRIPPED_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  didit_session_create: ["portrait_image"],
};

/**
 * Input property names that carry a restricted sensitive data type under the ChatGPT app
 * policy. Exported so the test suite can prove the ChatGPT catalog never advertises one, at
 * any nesting depth, whichever way the catalog evolves.
 */
export const RESTRICTED_INPUT_PROPERTY_PATTERN =
  /document_number|image_path|image_base64|portrait_image|password|^code$|^otp/i;

export function resolveCatalogProfile(value: string | undefined): CatalogProfile {
  const candidate = (value || "full").trim().toLowerCase();
  if ((CATALOG_PROFILES as readonly string[]).includes(candidate)) return candidate as CatalogProfile;
  throw new Error(`Unknown MCP catalog profile '${value}'. Expected one of: ${CATALOG_PROFILES.join(", ")}.`);
}

export function profileAllowsTool(profile: CatalogProfile, name: string): boolean {
  return profile === "full" || CHATGPT_CATALOG.has(name);
}

function strippedPropertiesFor(profile: CatalogProfile, name: string): readonly string[] {
  return profile === "chatgpt" ? CHATGPT_STRIPPED_PROPERTIES[name] ?? [] : [];
}

/** The shape of a tool definition this module needs to see; everything else passes through. */
export interface CatalogTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Reduce a tools/list catalog to the profile: drop tools outside the allow-list and remove the
 * stripped properties from the survivors' input schemas. Returns new objects; the shared tool
 * definitions are never mutated (the same process serves every profile).
 *
 * Deliberately NOT generic over the input element type: the catalog literal in index.ts is a
 * union of ~160 object types, and instantiating a spread per union member made tsc hang.
 */
export function applyCatalogProfile(tools: readonly CatalogTool[], profile: CatalogProfile): CatalogTool[] {
  if (profile === "full") return [...tools];
  const kept: CatalogTool[] = [];
  for (const tool of tools) {
    if (!profileAllowsTool(profile, tool.name)) continue;
    const stripped = strippedPropertiesFor(profile, tool.name);
    if (stripped.length === 0 || !tool.inputSchema?.properties) {
      kept.push(tool);
      continue;
    }
    const properties = { ...tool.inputSchema.properties };
    for (const key of stripped) delete properties[key];
    const required = tool.inputSchema.required?.filter((key) => !stripped.includes(key));
    kept.push({
      ...tool,
      inputSchema: { ...tool.inputSchema, properties, ...(required ? { required } : {}) },
    });
  }
  return kept;
}

/**
 * Why a tools/call must be refused under the profile, or undefined when it may proceed.
 * Mirrors the tools/list reduction so a client that memorised the full catalog (or crafts a
 * call by hand) cannot reach a tool or a property the endpoint does not offer.
 */
export function catalogProfileRefusal(
  profile: CatalogProfile,
  name: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!profileAllowsTool(profile, name)) {
    return `Tool '${name}' is not available on this endpoint. It is part of the full Didit MCP catalog at /mcp; this endpoint serves the reduced ChatGPT catalog.`;
  }
  const stripped = strippedPropertiesFor(profile, name).filter((key) => args?.[key] !== undefined);
  if (stripped.length > 0) {
    return `Tool '${name}' does not accept ${stripped.map((k) => `'${k}'`).join(", ")} on this endpoint. Remove the argument and retry; identity data is collected from the end user on the hosted verification page, not through the conversation.`;
  }
  return undefined;
}

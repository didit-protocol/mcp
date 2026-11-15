// Every tool area whose tools are declared one object per tool (tools/registry.ts). index.ts lists
// their definitions, annotates them and dispatches to them from here, and permissions.ts takes
// their permission entries from here. An area moves here in one change, with its entries removed
// from the name-keyed tables in the same change (test/tool-registry.test.mjs holds that).
import { byName, permissionsOf, type RegisteredTool } from "./registry";
import { WEBHOOK_TOOLS } from "./webhooks";
import { WORKFLOW_TOOLS } from "./workflows";
import {
  STANDALONE_AML_TOOLS,
  STANDALONE_BIOMETRIC_TOOLS,
  STANDALONE_CONTACT_TOOLS,
  STANDALONE_DOCUMENT_TOOLS,
  STANDALONE_KYB_TOOLS,
} from "./standalone";
import { SESSION_IMPORT_TOOLS, SESSION_TOOLS } from "./sessions";
import { BILLING_TOOLS } from "./billing";
import { BLOCKLIST_TOOLS } from "./blocklist";
import { ORG_MEMBER_TOOLS } from "./members";
import { AUDIT_AND_ALERT_TOOLS } from "./observability";
import { REPORT_TOOLS } from "./reports";
import { VENDOR_BUSINESS_TOOLS } from "./businesses";
import { VENDOR_USER_TOOLS } from "./users";
import { TRANSACTION_RULE_TOOLS, TRANSACTION_TOOLS } from "./transactions";
import { SEARCH_TOOLS } from "./search";
import { CASE_TOOLS } from "./cases";
import { LIST_TOOLS } from "./lists";
import { QUESTIONNAIRE_TOOLS } from "./questionnaires";
import { BRANDING_TOOLS } from "./customization";

const AREAS: readonly (readonly RegisteredTool[])[] = [WEBHOOK_TOOLS, BRANDING_TOOLS, QUESTIONNAIRE_TOOLS, LIST_TOOLS, CASE_TOOLS, TRANSACTION_RULE_TOOLS, SEARCH_TOOLS, TRANSACTION_TOOLS, VENDOR_USER_TOOLS, VENDOR_BUSINESS_TOOLS, REPORT_TOOLS, AUDIT_AND_ALERT_TOOLS, ORG_MEMBER_TOOLS, BLOCKLIST_TOOLS, BILLING_TOOLS, SESSION_TOOLS, SESSION_IMPORT_TOOLS, STANDALONE_DOCUMENT_TOOLS, STANDALONE_KYB_TOOLS, STANDALONE_BIOMETRIC_TOOLS, STANDALONE_AML_TOOLS, STANDALONE_CONTACT_TOOLS, WORKFLOW_TOOLS];

export const REGISTERED_TOOL_LIST: readonly RegisteredTool[] = AREAS.flat();
export const REGISTERED_TOOLS = byName(REGISTERED_TOOL_LIST);
export const REGISTERED_TOOL_PERMISSIONS = permissionsOf(REGISTERED_TOOL_LIST);

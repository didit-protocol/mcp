import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { PAGE_PROPS, pageParams } from "../paging";
import {
  FEATURE_CONFIG_CHECKSUM,
  FEATURE_CONFIG_SCHEMA,
  WORKFLOW_FEATURES,
  renderFeatureItemReference,
} from "../feature-config-schema";
import { WORKFLOW_GRAPH_SCHEMA } from "./shared-schema";
import { createWorkflow, deleteWorkflow, getWorkflowVersion, listWorkflowVersions, updateWorkflow } from "./settings";
import { searchWorkflows } from "./search";
import {
  annotateAgeAssurance,
  createWorkflowDraft,
  editWorkflowGraph,
  getIdVerificationMethodsCatalog,
  getKybRegistryCatalog,
  getWorkflowBranchFields,
  getWorkflowFieldDefinitions,
  getWorkflowGraph,
  publishWorkflow,
  setWorkflowGraph,
  validateWorkflowGraph,
} from "./workflow-graph";

// The workflow tools: settings (tools/settings.ts), the graph (tools/workflow-graph.ts) and the
// feature-config contract this server ships with. Their handlers live in those modules; this one
// declares the tools (tools/registry.ts).

const WORKFLOW_FEATURE_ITEM = {
  type: "object" as const,
  properties: {
    feature: { type: "string", enum: WORKFLOW_FEATURES, description: "Feature to run (uppercase)" },
    config: {
      type: "object",
      description:
        renderFeatureItemReference() +
        "\n\nThe MCP normalizes the allow-lists for you before it saves: documents_allowed / " +
        "poa_documents_allowed accept a plain doc-type array ([\"PASSPORT\"] = passport-only, any " +
        "country), doc NAMES (PASSPORT/ID/DRIVER_LICENSE/RESIDENCE_PERMIT) as well as codes " +
        "(P/ID/DL/RP), scalar flags, and an \"ALL\" country key - all of it becomes the canonical " +
        "{ISO3:{CODE:{enabled:1}}}. poa_languages_allowed likewise accepts a language array " +
        "([\"es\"]) or a map ({\"es\":1}). Omit an allow-list to accept everything.",
    },
    label: { type: "string", description: "Optional internal node label" },
  },
  required: ["feature"],
};

/**
 * The feature-config contract, answered from the artifact this server ships with: no API call, so it
 * works before a workflow or an application even exists.
 */
async function featureConfigSchema(feature: string | undefined): Promise<unknown> {
  if (feature && !FEATURE_CONFIG_SCHEMA.features[feature]) {
    throw new Error(`Unknown feature "${feature}". Known features: ${WORKFLOW_FEATURES.join(", ")}.`);
  }
  return {
    schema_version: FEATURE_CONFIG_SCHEMA.schema_version,
    checksum: FEATURE_CONFIG_CHECKSUM,
    source: FEATURE_CONFIG_SCHEMA.source,
    value_kinds: FEATURE_CONFIG_SCHEMA.value_kinds,
    features: feature ? { [feature]: FEATURE_CONFIG_SCHEMA.features[feature] } : FEATURE_CONFIG_SCHEMA.features,
  };
}

/** Annotated after the rows are in, so the flag behaves the same on the scoped list and across every application. */
async function withAgeAssurance(rows: Promise<unknown>, args: Record<string, any>): Promise<unknown> {
  const listed = await rows;
  return args.include_age_assurance ? annotateAgeAssurance(listed) : listed;
}

// ── The workflow tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const WORKFLOW_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_workflow_list",
      description: "List verification workflows. With multiple apps (or no scope) it auto-spans every app, each row tagged with its org/app. To find one workflow by id/label across all apps, prefer didit_workflow_search. The `features` on a row do NOT tell you whether a workflow checks age: age assurance done from the DOCUMENT (age restrictions on the OCR step) shows no feature of its own. For any question about which workflows do age assurance, pass `include_age_assurance:true` — it annotates each row with `does_age_assurance`/`methods` server-side, which is the only reliable way to find them. In one application the answer is ONE PAGE, most recently changed first: 20 workflows unless `limit` says otherwise, with `count` as the total and `offset` to read the ones after. Across applications it is the first 50 unless `limit` says otherwise, with `total_matched` as the total and the same `offset`. To count or filter workflows, read until you have them all.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          include_age_assurance: {
            type: "boolean",
            description: "Annotate each non-archived row with whether it does age assurance, and how. Required to find workflows that check age from the document.",
          },
          ...PAGE_PROPS,
        },
      },
    },
    // With no application named, it lists the workflows of every application of the organization.
    access: "read",
    permission: "read:workflows", // GET …/verification-settings/ → verification_settings.py:74
    spanAllApplications: (args) => withAgeAssurance(searchWorkflows(args), args),
    run: (args) => withAgeAssurance(listWorkflowVersions(pageParams(args)), args),
  },
  {
    def: {
      name: "didit_workflow_create",
      description: "Create a SIMPLE (linear) verification workflow from an ordered list of features. Send `features` in execution order (uppercase values; put dependency features first, e.g. OCR before FACE_MATCH/NFC/DATABASE_VALIDATION). The MCP assembles them into a real workflow graph and publishes it; pass status:'draft' to keep it unpublished. A bad feature order fails validation and leaves a fixable draft. A workflow verifies EITHER a person (KYC) or a business (KYB), never both, and the type follows WHO is verified: KYB workflows use the KYB_* features (company paperwork belongs in KYB_DOCUMENTS or DOCUMENT_AI) and must not mix in person-only features (OCR/LIVENESS/FACE_MATCH/NFC/PROOF_OF_ADDRESS/DATABASE_VALIDATION/AGE_ESTIMATION); to verify the people behind a company, create a separate KYC workflow and link it from the KYB_KEY_PEOPLE node. For BRANCHING or conditional logic, use the graph tools instead: didit_workflow_get_field_definitions, then didit_workflow_validate_graph, then didit_workflow_set_graph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_label: { type: "string", description: "Display name (max 50 chars)" },
          features: {
            type: "array",
            minItems: 1,
            items: WORKFLOW_FEATURE_ITEM,
            description: "Verification features in execution order. Each: { feature, config?, label? }. Example: [{\"feature\":\"OCR\"},{\"feature\":\"LIVENESS\",\"config\":{\"face_liveness_method\":\"PASSIVE\"}},{\"feature\":\"FACE_MATCH\"}]",
          },
          is_default: { type: "boolean", description: "Set as default workflow for new sessions" },
          status: { type: "string", enum: ["draft", "published"], description: "Omit to publish immediately; 'draft' saves without publishing" },
          is_white_label_enabled: { type: "boolean" },
          is_desktop_allowed: { type: "boolean" },
          is_session_reference_enabled: {
            type: "boolean",
            description: "Show the person a short reference such as S-20481 on the Declined and In review screens, to give to your support. Default false.",
          },
          max_retry_attempts: { type: "number" },
          retry_window_days: { type: "number" },
          session_expiration_time: { type: "number" },
        },
        required: ["features"],
      },
    },
    access: "write",
    permission: "write:workflows", // POST …/verification-settings/ → verification_settings.py:146
    run: (args) => createWorkflow(args),
  },
  {
    def: {
      name: "didit_workflow_get",
      description:
        "Get the full configuration of a specific workflow, including `response_attributes` " +
        "(returned data / data minimization): which data points the client receives per feature.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_id: { type: "string", description: "Workflow version uuid (`version_uuid`)" },
        },
        required: ["workflow_id"],
      },
    },
    access: "read",
    permission: "read:workflows", // GET …/verification-settings/{uuid}/ (+ …/{workflow_id}/versions/) → verification_settings.py:214
    run: (args) => getWorkflowVersion(args.workflow_id),
  },
  {
    def: {
      name: "didit_workflow_update",
      description: "Update a workflow's top-level SETTINGS only (workflow_label, is_default, retry/expiration, white-label, etc.). Omitted status preserves the current draft/published state; publication changes only when status is explicitly passed. It does NOT change which features run: to add/remove/reorder features, add a conditional branch, or add a Document-AI step, edit the graph with didit_workflow_edit_graph (small ops, preserves the big allow-lists) or didit_workflow_set_graph (full replace) — those are the only ways feature changes actually persist.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_id: { type: "string", description: "Workflow UUID" },
          workflow_label: { type: "string" },
          is_default: { type: "boolean" },
          status: { type: "string", enum: ["draft", "published"] },
          is_white_label_enabled: { type: "boolean" },
          is_desktop_allowed: { type: "boolean" },
          is_session_reference_enabled: {
            type: "boolean",
            description: "Show the person a short reference such as S-20481 on the Declined and In review screens, to give to your support. Default false.",
          },
          max_retry_attempts: { type: "number" },
          retry_window_days: { type: "number" },
          session_expiration_time: { type: "number" },
        },
        required: ["workflow_id"],
      },
    },
    // Overwrites the workflow's settings.
    access: "destructive",
    permission: "write:workflows", // PATCH …/verification-settings/{uuid}/ → verification_settings.py:219
    run: ({ workflow_id, ...data }) => updateWorkflow(workflow_id, data),
  },
  {
    def: {
      name: "didit_workflow_delete",
      description: "Delete a draft verification workflow. If the API forbids deletion (including an only or published version), archive it instead. Existing sessions using it are not affected.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          workflow_id: { type: "string", description: "Workflow UUID" },
        },
        required: ["workflow_id"],
      },
    },
    access: "destructive",
    permission: "write:workflows", // DELETE …/verification-settings/{uuid}/ → verification_settings.py:224
    run: (args) => deleteWorkflow(args.workflow_id),
  },
  {
    def: {
      name: "didit_workflow_search",
      description: "Find verification workflows ACROSS ALL your apps/orgs in one call. Pass `workflow_id` to locate a specific workflow by its version uuid OR stable workflow_id (returns which org/app it lives in), or `search` to match by label. Use this instead of guessing the application when you only have a workflow id. Rows: `workflow_id` = the STABLE id for integrations and sessions; `version_uuid` (= `uuid`) = one exact version, which pins a session to it; `is_live_version` = the version new sessions run. `search` matches the LABEL ONLY: a CAPABILITY (age assurance, AML screening, …) is not searchable by name — for age assurance use didit_workflow_list with `include_age_assurance:true`, which reports what each workflow actually does.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Match a specific workflow by version uuid or stable workflow_id" },
          search: { type: "string", description: "Case-insensitive substring match on the workflow label" },
          limit: { type: "number", description: "Max results after merging (default 50, max 200)" },
          ...ORG_APP_PROPS,
        },
      },
    },
    // The routing ids narrow the search to one organization or application.
    access: "read",
    permission: "read:workflows", // per-app fan-out over the list endpoint
    routingIds: true,
    run: (args) => searchWorkflows(args),
  },
  {
    def: {
      name: "didit_workflow_get_graph",
      description: "Get the node/graph for a workflow (the structure: nodes, branches, conditions, Document-AI steps) + `status`/`version`/`is_editable`. Large feature configs (documents_allowed, poa_documents_allowed, phone countries) are SUMMARIZED by default so the response never overflows — set `include_config:true` for the raw config. Includes `returned_data` (response_attributes): the ONLY source of truth for what data the client/relying party receives in the API response and webhooks — never infer that from which features run. Also includes `age_assurance`: whether the workflow checks age, and by which method (document age restrictions and/or AGE_ESTIMATION) — decide that from this block, never from the workflow's name. Pass just `workflow_id`; the owning org/app is resolved automatically. To MODIFY the graph, prefer didit_workflow_edit_graph (small ops, no need to resend big configs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          include_config: { type: "boolean", description: "Return full feature configs verbatim (default false → summarized). Can be very large." },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    access: "read",
    permission: "read:workflows", // GET …/verification-settings/{uuid}/workflow-graph/ → workflow_graph.py:44
    run: (args) => getWorkflowGraph(args.workflow_id, args, Boolean(args.include_config)),
  },
  {
    def: {
      name: "didit_workflow_get_field_definitions",
      description: "List every field you can branch on plus the operators valid for each (e.g. kyc.status, kyc.extra_fields.profession with `fuzzy_match`, document_ai.<key>, aml.risk_score). Call this before building branch rules so the field/operator pairs are valid.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Any workflow in the target application (used to resolve the app). Its uuid or stable workflow_id from didit_workflow_search/list — NOT a label, slug or node id. An exact label is resolved when it matches exactly one workflow; otherwise the candidates are listed for you to pick." },
          feature: { type: "string", enum: WORKFLOW_FEATURES, description: "Return only fields for this feature to keep the response small" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    access: "read",
    permission: "read:workflows", // GET …/workflow-graph/field-definitions/ → workflow_graph.py:451
    run: (args) => getWorkflowFieldDefinitions(args.workflow_id, args),
  },
  {
    def: {
      name: "didit_workflow_get_feature_config_schema",
      description:
        "The exact `config` object each workflow feature accepts - every key, its type, bounds, " +
        "default, accepted values and meaning. Generated from the backend serializers that validate " +
        "a save (contract " + FEATURE_CONFIG_CHECKSUM + "), so it is never out of date with the API. " +
        "Call it before configuring a feature you have not configured before, and whenever a config " +
        "key you set came back missing: a key outside this contract is dropped silently. Pass " +
        "`feature` for one feature (" + WORKFLOW_FEATURES.join(", ") + "), or omit it for all of them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          feature: {
            type: "string",
            enum: WORKFLOW_FEATURES,
            description: "Restrict the answer to one feature. Omit for the whole contract.",
          },
        },
      },
    },
    access: "read",
    permission: null, // no backend call — bundled artifact
    run: (args) => featureConfigSchema(args.feature),
  },
  {
    def: {
      name: "didit_workflow_get_id_verification_methods_catalog",
      description:
        "The ID Verification methods catalog: per country, whether non-doc lookup (the user types their " +
        "national ID number and we check the official government database) is offered, which " +
        "digital-identity wallets (MitID, BankID, itsme, ...) are offered, their availability " +
        "(`available` can be enabled, `coming_soon` cannot), the plain-language request and response " +
        "fields, and catalog prices. Read this BEFORE setting `methods` on an OCR node: a method or " +
        "wallet that is not available for the country is rejected on save. Wallets are an accept-list " +
        "(no ordering). Every non-document price except the document price is a placeholder until " +
        "the pricing catalog is published. Pass `country` (ISO3) to get one country's view.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Any workflow in the target application (used to resolve the app)" },
          country: { type: "string", description: "ISO 3166-1 alpha-3 code to narrow the catalog to one country (e.g. ZAF, DNK)" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    access: "read",
    permission: "read:workflows", // GET …/workflow-graph/id-verification-methods-catalog/ → workflow_graph.py
    run: (args) => getIdVerificationMethodsCatalog(args.workflow_id, args),
  },
  {
    def: {
      name: "didit_workflow_get_kyb_registry_catalog",
      description:
        "The KYB registry catalog: per country (ISO-2, unlike `methods`/`documents_allowed` which are " +
        "ISO-3), which company-data tiers the registries offer - `basic` (Lite: company profile), " +
        "`shareholders`, `ubo` (beneficial owners) - with their retail price per company selected, and " +
        "whether continuous registry monitoring is sold there (per company per year). Read this BEFORE " +
        "writing `kyb_registry_countries_config` with a tier other than `basic`, or switching " +
        "`kyb_registry_monitoring_enabled` on: a tier the country does not offer is rejected on save, and " +
        "monitoring only applies to countries at an ownership tier where it is available. A company the " +
        "applicant types in by hand is billed a flat fee instead. Without `countries` you get a summary " +
        "(counts, the countries with no registry, the Lite-only ones); pass `countries` for the exact " +
        "per-country table. Prices here are the catalog's retail prices, not placeholders.",
      inputSchema: {
        type: "object" as const,
        properties: {
          countries: {
            type: "array",
            items: { type: "string" },
            description: "ISO 3166-1 alpha-2 codes to narrow the catalog to (e.g. [\"ES\", \"DE\"]). Omit for the summary.",
          },
        },
      },
    },
    // Public pricing catalog: no org/app scope to resolve.
    access: "read",
    permission: null, // GET /organization/kyb-registry-pricing/ → application.py KYBRegistryPricingView (anonymous, no privilege)
    scopeAgnostic: true,
    run: (args) => getKybRegistryCatalog(args.countries),
  },
  {
    def: {
      name: "didit_workflow_get_branch_fields",
      description: "Given a candidate graph and a branch node, return the fields actually available at that point (only features that completed on every path reaching the branch, plus dynamically-derived Document-AI/questionnaire fields).",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          graph: {
            ...WORKFLOW_GRAPH_SCHEMA,
            description: "REQUIRED. The candidate graph to evaluate: the `graph` object returned by didit_workflow_get_graph / ui_workflow_get_graph (start_node + nodes), optionally with your unsaved edits applied.",
          },
          branch_node_id: { type: "string", description: "REQUIRED. The id of a branch node in that graph (a key of graph.nodes whose node_type is 'branch') — availability is evaluated at that point." },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id", "graph", "branch_node_id"],
      },
    },
    access: "read",
    permission: "read:workflows", // POST …/workflow-graph/branch-fields/ → workflow_graph.py:202
    run: (args) => getWorkflowBranchFields(args.workflow_id, args.graph, args.branch_node_id ?? args.node_id, args),
  },
  {
    def: {
      name: "didit_workflow_validate_graph",
      description: "Dry-run validate a graph WITHOUT saving. Returns per-node errors (bad field/operator, missing dependency, branching on a field before its feature runs, etc.). Always validate before didit_workflow_set_graph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: {
            type: "string",
            description:
              "Workflow version uuid or stable workflow_id. OPTIONAL: omit to validate a graph for a workflow " +
              "that does not exist yet (an unsaved canvas); pass workflow_type instead when KYC/KYB matters.",
          },
          workflow_type: { type: "string", enum: ["kyc", "kyb"], description: "Segregation check for a not-yet-created workflow." },
          graph: WORKFLOW_GRAPH_SCHEMA,
          include_config: { type: "boolean", description: "Return the validated graph's full feature configs (default false summarizes large values)" },
          ...ORG_APP_PROPS,
        },
        required: ["graph"],
      },
    },
    access: "read",
    permission: "read:workflows", // POST …/workflow-graph/validate/ → workflow_graph.py:142
    run: (args) => validateWorkflowGraph(args.workflow_id, args.graph, args, Boolean(args.include_config)),
  },
  {
    def: {
      name: "didit_workflow_edit_graph",
      description: "MODIFY an existing workflow's graph with small OPERATIONS - the right tool for editing a live workflow. You send only the deltas; the MCP fetches the full current graph SERVER-SIDE, applies your ops in order, validates, auto-creates a DRAFT (the live version is never touched), and saves. This means huge feature configs (documents_allowed, poa_documents_allowed, phone countries) are preserved exactly and you NEVER resend them. Validation failures return `applied:false` with the errors (nothing saved). The six op shapes are documented on the `operations` parameter; a typical edit upserts new nodes with set_node and rewires their neighbors with set_next. To branch after a feature node, point its `next` at a new branch node whose `branches` carry the rules (from didit_workflow_get_field_definitions) and whose goto targets are new status or feature nodes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          operations: {
            type: "array",
            minItems: 1,
            description: "Ordered edits applied to the full server-side graph. Each: one of — {op:'set_node', node_id, node:{…}} upsert a node; {op:'remove_node', node_id}; {op:'set_next', node_id, next:'<id|null>'} rewire a node's unconditional next; {op:'set_branches', node_id, branches:[…]} set conditional branches; {op:'merge_node_config', node_id, config:{…}, replace?} merge config keys (preserves the big allow-lists); a map value merges BY ENTRY (sent entries update/add, others are kept), arrays/scalars replace, replace:true replaces maps whole; {op:'set_start', start_node}.",
            items: { type: "object", properties: { op: { type: "string", enum: ["set_node", "remove_node", "set_next", "set_branches", "merge_node_config", "set_start"] }, node_id: { type: "string" }, node: { type: "object" }, next: { type: ["string", "null"] }, branches: { type: "array", items: { type: "object" } }, config: { type: "object" }, replace: { type: "boolean" }, start_node: { type: "string" } }, required: ["op"] },
          },
          publish: { type: "boolean", description: "Publish after saving (default false → leaves a reviewable DRAFT)" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id", "operations"],
      },
    },
    // Changes the saved graph, and can publish it.
    access: "destructive",
    permission: "write:workflows", // PUT …/verification-settings/{uuid}/workflow-graph/ → workflow_graph.py:63
    run: (args) => editWorkflowGraph(args.workflow_id, args.operations, Boolean(args.publish), args),
  },
  {
    def: {
      name: "didit_workflow_set_graph",
      description: "Replace a workflow's ENTIRE node/graph. Use this only to build a NEW/small workflow from scratch — to modify an EXISTING workflow prefer didit_workflow_edit_graph (you'd otherwise have to resend every node incl. multi-100KB allow-lists). If the workflow is published, a DRAFT is auto-created and the graph applied there (a live version is NEVER mutated); reviewable DRAFT unless `publish:true`. Validate first. Example graph: OCR → branch[ kyc.status==Declined → status(Declined); kyc.extra_fields.profession fuzzy_match 'Software Engineer' score 80 → DOCUMENT_AI(proof of funds) → status(Determine) ; else → status(Determine) ].",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          graph: WORKFLOW_GRAPH_SCHEMA,
          publish: { type: "boolean", description: "Publish the draft after saving (default false → leaves a reviewable DRAFT)" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id", "graph"],
      },
    },
    // Overwrites the whole graph, and can publish it.
    access: "destructive",
    permission: "write:workflows", // PUT …/verification-settings/{uuid}/workflow-graph/ → workflow_graph.py:63
    run: (args) => setWorkflowGraph(args.workflow_id, args.graph, Boolean(args.publish), args),
  },
  {
    def: {
      name: "didit_workflow_create_draft",
      description: "Create an editable DRAFT version from a published workflow (graph/config edits require a DRAFT). Returns the new draft's uuid.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "Workflow version uuid or stable workflow_id" },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    access: "write",
    permission: "write:workflows", // POST …/verification-settings/{uuid}/create-draft/ → verification_settings.py:328
    run: (args) => createWorkflowDraft(args.workflow_id, args),
  },
  {
    def: {
      name: "didit_workflow_publish",
      description: "Publish the workflow version that holds the pending changes — makes it live for NEW sessions. Existing sessions are unaffected. Pass the `version_uuid` that set_graph/edit_graph returned: a published version can never hold an edit, so a stable workflow_id resolves to the version that is ALREADY live. Publishing a live version with no draft is refused instead of reported as done.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_id: { type: "string", description: "The DRAFT version uuid to publish — the `version_uuid` returned by didit_workflow_set_graph / didit_workflow_edit_graph. A stable workflow_id also resolves, and then the draft holding the changes is published rather than the version already live." },
          ...ORG_APP_PROPS,
        },
        required: ["workflow_id"],
      },
    },
    // Makes the pending changes live for new sessions.
    access: "destructive",
    permission: "write:workflows", // PATCH …/verification-settings/{uuid}/ → verification_settings.py:219
    run: (args) => publishWorkflow(args.workflow_id, args),
  },
];

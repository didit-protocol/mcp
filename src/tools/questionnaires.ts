import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { pathSegment } from "../security";
import { PAGE_PROPS, pageParams } from "../paging";

// The schema pieces of the questionnaire tools' definitions (below), moved here with them.
// Real backend FormElementType (questionnaires/config/choices.py) — uppercase.
const FORM_ELEMENT_TYPES = [
  "SHORT_TEXT", "LONG_TEXT", "PARAGRAPH", "DROPDOWN", "SINGLE_CHOICE", "MULTIPLE_CHOICE",
  "NUMBER", "IMAGE", "FILE_UPLOAD", "TIME", "EMAIL", "ADDRESS", "PHONE", "COUNTRY",
  "DATE_PICKER", "CONSENT", "SECTION_HEADER", "SEPARATOR", "HEADING", "REPEATABLE_GROUP",
];
const QUESTIONNAIRE_LANG_PROPS = {
  languages: {
    type: "array",
    items: { type: "string" },
    description: "Locales the questionnaire is offered in. Defaults to [\"en\"]; \"en\" must always be included.",
  },
  default_language: { type: "string", description: "Locale shown by default (must be in `languages`). Defaults to the first language." },
} as const;

// A create with no status publishes immediately (backend QuestionnaireCreateSerializer.create),
// while an update with no status edits in place and never publishes — so the two tools must not
// advertise the same `status` wording.
const QUESTIONNAIRE_CREATE_STATUS_PROP = {
  status: { type: "string", enum: ["draft", "published"], description: "Omit to publish immediately; 'draft' saves without publishing." },
} as const;

const QUESTIONNAIRE_UPDATE_STATUS_PROP = {
  status: {
    type: "string",
    enum: ["draft", "published"],
    description: "Omit to edit in place without changing the published state; 'draft' saves without publishing; 'published' publishes (a draft goes live, a published questionnaire gets a new published version).",
  },
} as const;

const FORM_ELEMENTS_PROP = {
  form_elements: {
    type: "array",
    description:
      "REQUIRED. Array of form-element objects, in the order the user answers them. Each: { element_type (uppercase, one of the allowed types), title (a plain string, or an object of locale→string e.g. {\"en\":\"Your name\"}), is_required (bool), placeholder (hint text), and for choice types a `choices` array }. A per-question hint goes in `placeholder`: `description` is only accepted on HEADING, SECTION_HEADER and PARAGRAPH elements.",
    items: {
      type: "object",
      properties: {
        element_type: { type: "string", enum: FORM_ELEMENT_TYPES, description: "Element type (UPPERCASE)" },
        title: { type: "object", description: "Locale → label, e.g. {\"en\":\"Question text\"}" },
        is_required: { type: "boolean" },
        choices: { type: "array", items: { type: "object" }, description: "Options for DROPDOWN/SINGLE_CHOICE/MULTIPLE_CHOICE. Each: { value, label?, requires_text_input? }" },
      },
      required: ["element_type"],
    },
  },
} as const;

// Questionnaires — org/app-scoped console resource. Reads (list/get) map 1:1. The console
// edits questionnaires via versioned drafts (create-draft); the create/update/delete tools
// target the same org/app resource and may surface a 405 if the console only supports the
// draft flow for that operation.
//
// WRITES go through a GRAPH. The backend takes `graph` ({start_node, nodes}) plus
// `languages`/`default_language`; the flat `form_elements` array this tool used to POST has
// not been accepted for a while ("graph: This field is required"), so every questionnaire the
// copilot tried to create failed. Rather than push graph plumbing onto the model — node ids,
// `next` pointers, per-language title objects, all of it invented token by token — the tool
// keeps its ordered list of questions and assembles the graph here, the same division of
// labour didit_workflow_create already uses for workflow graphs.

type Translatable = Record<string, string>;

export type FormElementInput = {
  element_type: string;
  title?: string | Translatable;
  placeholder?: string | Translatable;
  description?: string | Translatable;
  is_required?: boolean;
  choices?: Array<{ value?: string; label?: string | Translatable; requires_text_input?: boolean }>;
  [key: string]: unknown;
};

export type QuestionnaireWrite = {
  title?: string;
  description?: string;
  form_elements?: FormElementInput[];
  languages?: string[];
  default_language?: string;
  status?: string;
  [key: string]: unknown;
};

/** A translatable field must carry EVERY declared language or the backend rejects it, so a
 * plain string is broadcast to all of them (one language is the overwhelmingly common case). */
function translatable(value: unknown, languages: string[]): Translatable | undefined {
  if (value && typeof value === "object") return value as Translatable;
  const text = typeof value === "string" ? value : "";

  return text ? Object.fromEntries(languages.map((lang) => [lang, text])) : undefined;
}

function toChoice(choice: Record<string, unknown>, languages: string[]) {
  const label = translatable(choice.label ?? choice.value, languages);
  const value = String(choice.value ?? "").trim() || Object.values(label ?? {})[0] || "";

  return { ...choice, value, label };
}

/** `{start_node, nodes}` from an ordered list of questions: node ids are positional and each
 * node points at the next one, which is exactly the linear form the questions describe. */
export function buildQuestionnaireGraph(elements: FormElementInput[], languages: string[]) {
  const ids = elements.map((_, index) => `q${index + 1}`);
  const nodes = Object.fromEntries(
    elements.map((element, index) => {
      const { title, placeholder, description, choices, ...rest } = element;

      return [
        ids[index],
        {
          ...rest,
          is_required: element.is_required ?? false,
          ...(translatable(title, languages) && { title: translatable(title, languages) }),
          ...(translatable(placeholder, languages) && {
            placeholder: translatable(placeholder, languages),
          }),
          ...(translatable(description, languages) && {
            description: translatable(description, languages),
          }),
          ...(Array.isArray(choices) && {
            choices: choices.map((choice) => toChoice(choice as Record<string, unknown>, languages)),
          }),
          next: ids[index + 1] ?? null,
        },
      ];
    }),
  );

  return { start_node: ids[0], nodes };
}

/** The wire payload: `form_elements` become the graph, everything else passes through. The
 * org/app selectors are routing, not content — they are already in the path. */
function toGraphPayload(data: QuestionnaireWrite): Record<string, any> {
  const { form_elements, languages, organization_id, application_id, ...rest } = data;
  const langs = languages?.length ? languages : ["en"];
  if (!form_elements) return { ...rest, ...(languages && { languages }) };

  return {
    ...rest,
    languages: langs,
    default_language: data.default_language ?? langs[0],
    graph: buildQuestionnaireGraph(form_elements, langs),
  };
}

/** One page of the application's questionnaires (50 unless `limit` says otherwise), newest first. */
export async function listQuestionnaires(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/questionnaires/"), { params });
}

export async function createQuestionnaire(data: QuestionnaireWrite): Promise<any> {
  return apiRequest(orgAppPath("/questionnaires/"), { method: "POST", json: toGraphPayload(data) });
}

function compactTranslations(value: any): any {
  if (Array.isArray(value)) return value.map(compactTranslations);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value);
  if (entries.length > 1 && entries.every(([key]) => /^[a-z]{2}(?:-[A-Z]{2})?$/.test(key))) {
    const [locale, text] = Object.prototype.hasOwnProperty.call(value, "en")
      ? ["en", value.en]
      : entries[0];
    return { [locale]: compactTranslations(text) };
  }
  return Object.fromEntries(entries.map(([key, nested]) => [key, compactTranslations(nested)]));
}

export async function getQuestionnaire(uuid: string, includeTranslations = false): Promise<any> {
  const result = await apiRequest(orgAppPath(`/questionnaires/${pathSegment(uuid, "questionnaire_id")}/`));
  if (includeTranslations) return result;
  return {
    ...compactTranslations(result),
    translations_summarized: true,
    hint: "Translations are limited to English (or the first available locale). Pass include_translations:true for every locale.",
  };
}

export async function updateQuestionnaire(uuid: string, data: QuestionnaireWrite): Promise<any> {
  return apiRequest(orgAppPath(`/questionnaires/${pathSegment(uuid, "questionnaire_id")}/`), {
    method: "PATCH",
    json: toGraphPayload(data),
  });
}

type ChoiceInput = NonNullable<FormElementInput["choices"]>[number];

/** The node a choice batch targets: the explicit id when given, otherwise the only node that
 * carries choices — with several candidates the caller must name one. */
function resolveChoiceNode(nodes: Record<string, any>, nodeId?: string): string {
  const candidates = Object.keys(nodes).filter((id) => Array.isArray(nodes[id]?.choices));
  const target = nodeId ?? (candidates.length === 1 ? candidates[0] : undefined);

  if (!target || !candidates.includes(target)) {
    throw new Error(
      `node_id must be one of the question nodes with choices: [${candidates.join(", ")}]`,
    );
  }

  return target;
}

/** Append ONE batch of choices to a stored question. A long option list cannot travel in a
 * single create/update call — the model emits the call token by token and the step's output
 * budget cuts it off mid-JSON, silently keeping only the first ~100 options — so the batches
 * arrive here one call at a time. Dedup by value makes a retried batch safe, and the compact
 * result spares the model the full graph it would otherwise re-read after every batch.
 *
 * Draft discipline: a PATCH changes the published state only when it asks for it explicitly
 * — omitting `status` edits in place and never publishes, and a published questionnaire
 * rejects every further edit — so intermediate batches pin `status: "draft"` and only the
 * `publish: true` batch (the last one) sends `status: "published"` to publish. */
export async function appendQuestionnaireChoices(
  uuid: string,
  data: { node_id?: string; choices?: ChoiceInput[]; publish?: boolean },
): Promise<any> {
  // This is a read-modify-write path. Fetch the complete locale maps so the
  // PATCH cannot overwrite a multilingual questionnaire with the compact
  // read-only representation returned by the public get tool.
  const current = await getQuestionnaire(uuid, true);
  const graph = current?.graph ?? { nodes: {} };
  const languages: string[] = current?.languages?.length ? current.languages : ["en"];
  const nodeId = resolveChoiceNode(graph.nodes ?? {}, data.node_id);
  const node = graph.nodes[nodeId];
  const stored = new Set((node.choices ?? []).map((choice: any) => choice?.value));
  const incoming = (data.choices ?? []).map((choice) =>
    toChoice(choice as Record<string, unknown>, languages),
  );
  const fresh = incoming.filter((choice) => !stored.has(choice.value));

  node.choices = [...(node.choices ?? []), ...fresh];
  if (fresh.length || data.publish) {
    await updateQuestionnaire(uuid, { graph, status: data.publish ? "published" : "draft" });
  }

  return {
    questionnaire_id: uuid,
    node_id: nodeId,
    appended: fresh.length,
    skipped_existing: incoming.length - fresh.length,
    total_choices: node.choices.length,
    status: data.publish ? "published" : (current?.status ?? "draft"),
  };
}

export async function deleteQuestionnaire(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/questionnaires/${pathSegment(uuid, "questionnaire_id")}/`), { method: "DELETE" });
}

// ── The questionnaire tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const QUESTIONNAIRE_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_questionnaire_list",
      description: "List all custom questionnaires for your application. One page, newest first: 50 unless `limit` says otherwise, with `count` as the total and `offset` to read the ones after.",
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS, ...PAGE_PROPS } },
    },
    access: "read",
    permission: "read:questionnaires", // GET …/questionnaires/ → questionnaire.py:96
    run: (args) => listQuestionnaires(pageParams(args)),
  },
  {
    def: {
      name: "didit_questionnaire_create",
      description: "Create a custom questionnaire from an ordered list of questions. Send `title` + `form_elements` (an array of form-element objects, each with an UPPERCASE element_type) — NOT `questions`. The MCP assembles them into the questionnaire graph the backend stores (node ids and their ordering are derived here), so send the questions in the order the user should answer them and never build a graph yourself. Pass status:'draft' to keep it unpublished. A choice list longer than ~100 options does NOT fit in one call (the call is emitted token by token and gets cut off mid-JSON): create with status:'draft' carrying only the first ~100 choices, then add the rest with didit_questionnaire_append_choices in batches (its publish flag publishes with the final batch — a published questionnaire cannot be edited further).",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          title: { type: "string", description: "Questionnaire title" },
          description: { type: "string", description: "Description shown to the user" },
          ...FORM_ELEMENTS_PROP,
          ...QUESTIONNAIRE_LANG_PROPS,
          ...QUESTIONNAIRE_CREATE_STATUS_PROP,
        },
        required: ["title", "form_elements"],
      },
    },
    access: "write",
    permission: "write:questionnaires", // POST …/questionnaires/ → questionnaire.py:149
    run: (args) => createQuestionnaire(args),
  },
  {
    def: {
      name: "didit_questionnaire_append_choices",
      description:
        "Append a batch of answer options to ONE question of an existing DRAFT questionnaire (create it with status:'draft' — a published questionnaire cannot be edited). Use it for long choice lists: create with the first ~100 choices, then append the rest here in batches of ~100 until the source list is exhausted, passing publish:true on the FINAL batch to publish. Choices the question already has (same value) are skipped, so retrying a batch never duplicates. Returns a compact summary whose total_choices is the stored count — verify against it instead of re-fetching the questionnaire.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
          node_id: {
            type: "string",
            description:
              "Graph node id of the question (e.g. 'q1', positional from the create call). Optional when exactly one question has choices.",
          },
          choices: {
            type: "array",
            items: { type: "object" },
            description:
              "Batch of choices to append, ~100 per call maximum. Each: { value, label?, requires_text_input? }",
          },
          publish: {
            type: "boolean",
            description:
              "Pass true on the LAST batch to publish the questionnaire; intermediate batches keep it a draft.",
          },
        },
        required: ["questionnaire_id", "choices"],
      },
    },
    access: "write",
    permission: "write:questionnaires", // PATCH …/questionnaires/{uuid}/ → questionnaire.py:208
    run: ({ questionnaire_id, ...data }) => appendQuestionnaireChoices(questionnaire_id, data),
  },
  {
    def: {
      name: "didit_questionnaire_get",
      description: "Get questionnaire questions and options. Translations are summarized to one locale by default to keep the response consumable; pass include_translations:true for every locale.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
          include_translations: { type: "boolean", description: "Return every locale translation (default false returns English or the first available locale)" },
        },
        required: ["questionnaire_id"],
      },
    },
    access: "read",
    permission: "read:questionnaires", // GET …/questionnaires/{uuid}/ → questionnaire.py:204
    run: (args) => getQuestionnaire(args.questionnaire_id, Boolean(args.include_translations)),
  },
  {
    def: {
      name: "didit_questionnaire_update",
      description: "Overwrite a questionnaire's supplied settings. Sending form_elements REPLACES the entire question list, removing omitted questions; pass every question to keep, in order, with UPPERCASE element_type. Omitted status preserves the current draft/published state; publication changes only when status is explicitly passed. Before calling, show the questionnaire and proposed changes and obtain explicit user confirmation, including the full replacement when form_elements is supplied.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
          title: { type: "string" },
          description: { type: "string" },
          ...FORM_ELEMENTS_PROP,
          ...QUESTIONNAIRE_LANG_PROPS,
          ...QUESTIONNAIRE_UPDATE_STATUS_PROP,
        },
        required: ["questionnaire_id"],
      },
    },
    // Replaces the questionnaire's questions, and can publish it: a client asks before running it.
    access: "destructive",
    permission: "write:questionnaires", // PATCH …/questionnaires/{uuid}/ → questionnaire.py:208
    run: ({ questionnaire_id, ...data }) => updateQuestionnaire(questionnaire_id, data),
  },
  {
    def: {
      name: "didit_questionnaire_delete",
      description: "Delete a questionnaire.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
        },
        required: ["questionnaire_id"],
      },
    },
    access: "destructive",
    permission: "write:questionnaires", // DELETE …/questionnaires/{uuid}/ → questionnaire.py:227
    run: (args) => deleteQuestionnaire(args.questionnaire_id),
  },
];

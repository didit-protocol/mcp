import { apiRequest, orgAppPath } from "../config";

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

export async function listQuestionnaires(): Promise<any> {
  return apiRequest(orgAppPath("/questionnaires/"));
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
  const result = await apiRequest(orgAppPath(`/questionnaires/${uuid}/`));
  if (includeTranslations) return result;
  return {
    ...compactTranslations(result),
    translations_summarized: true,
    hint: "Translations are limited to English (or the first available locale). Pass include_translations:true for every locale.",
  };
}

export async function updateQuestionnaire(uuid: string, data: QuestionnaireWrite): Promise<any> {
  return apiRequest(orgAppPath(`/questionnaires/${uuid}/`), {
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
 * Draft discipline: a PATCH that omits `status` PUBLISHES a draft, and a published
 * questionnaire rejects every further edit — so intermediate batches pin `status: "draft"`
 * and only a `publish: true` batch (the last one) lets the PATCH publish. */
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
    await updateQuestionnaire(uuid, data.publish ? { graph } : { graph, status: "draft" });
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
  return apiRequest(orgAppPath(`/questionnaires/${uuid}/`), { method: "DELETE" });
}

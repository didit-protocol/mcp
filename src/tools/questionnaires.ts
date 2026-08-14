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

export async function getQuestionnaire(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/questionnaires/${uuid}/`));
}

export async function updateQuestionnaire(uuid: string, data: QuestionnaireWrite): Promise<any> {
  return apiRequest(orgAppPath(`/questionnaires/${uuid}/`), {
    method: "PATCH",
    json: toGraphPayload(data),
  });
}

export async function deleteQuestionnaire(uuid: string): Promise<any> {
  return apiRequest(orgAppPath(`/questionnaires/${uuid}/`), { method: "DELETE" });
}

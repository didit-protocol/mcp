import { apiRequest, orgAppPath } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { DiditError, pathSegment } from "../security";
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
    description:
      "Locales the questionnaire is offered in. A create without it uses [\"en\"]; an update without it keeps the stored ones and writes a plain string in all of them. \"en\" must always be included.",
  },
  default_language: {
    type: "string",
    description: "Locale shown by default (must be in `languages`). Defaults to the first language; an update that changes `languages` without it uses the first of the new list.",
  },
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
      "REQUIRED. Array of form-element objects, in the order the user answers them. Each: { element_type (uppercase, one of the allowed types), title (a plain string, or an object of locale→string e.g. {\"en\":\"Your name\"}), is_required (bool), placeholder (hint text), and for choice types a `choices` array }. A per-question hint goes in `placeholder`: `description` is only accepted on HEADING, SECTION_HEADER and PARAGRAPH elements. Conditional logic is kept if well formed, else refused: `required_if: {rules:[{field:<id>,operator,value}]}`, `branches: [{id,rules,goto:<id>}]`, `repeatable_config` (REPEATABLE_GROUP needs it). `next` follows the order. An update replaces the whole list: send every stored question again with the `id` that `didit_questionnaire_get` returns.",
    items: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Optional stable question id: the key this question's answer is stored and returned under. Kept as given (hyphens survive; the public API documents lowercase letters, numbers and underscores). An update replaces the whole list, so send each stored question's id again exactly as `didit_questionnaire_get` returns it; a question sent without `id` gets a positional q1, q2, … key, and an update is refused when that would leave out a stored id of its own. Omit only on create.",
        },
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

/** Conditional fields travel inside the graph this tool posts to the console resource, and that
 * resource KEEPS them when they are well formed. Measured on the real backend (2026-11-19, sandbox
 * application): `required_if: {rules:[{field,operator,value}]}`, `branches: [{id, rules, goto}]`
 * and `repeatable_config` (which a REPEATABLE_GROUP cannot be created without) all come back as
 * sent. What it does not do is refuse a malformed one on UPDATE: a `required_if` with no `rules`
 * (`{field, operator, value}`, `{question, value}`) is stored as `{}` and answered with success,
 * which the customer read as "saved". So the shape is checked here, before any
 * request, and a field that cannot be stored is refused with the shape that can. `next` is written
 * from the order of the questions, so a value the order implies (as didit_questionnaire_get returns
 * it) is accepted and only a disagreeing one is refused. A `goto` or a rule `field` that names a
 * question outside this request is refused too: the backend rejects it ("references non-existent
 * node"), and a rule may only name a question of the same questionnaire (measured 2026-11-19). */
type Rule = { field?: unknown; operator?: unknown };

function conditionalError(index: number, element: FormElementInput, field: string, problem: string, shape: string): DiditError {
  const named = typeof element.id === "string" && element.id.trim() ? ` ("${element.id.trim()}")` : "";
  return new DiditError({
    code: "bad_request",
    message: `form_elements[${index}]${named}.${field} ${problem}`,
    field: `form_elements[${index}].${field}`,
    hint: `Nothing was written. ${shape}`,
  });
}

/** `rules` must be there and be a list; an empty list is a real value (the "otherwise" branch,
 * a required_if that never applies), a missing one is what the backend stores as `{}`. */
function rulesProblem(rules: unknown): string | undefined {
  if (!Array.isArray(rules)) return "needs a `rules` array.";
  const bad = rules.findIndex((rule: Rule) => {
    const named = (value: unknown) => typeof value === "string" && value.trim() !== "";
    return !rule || typeof rule !== "object" || !named(rule.field) || !named(rule.operator);
  });
  return bad === -1 ? undefined : `has a rule (rules[${bad}]) without a \`field\` and an \`operator\`.`;
}

const REQUIRED_IF_SHAPE =
  "Send required_if as { rules: [{ field: <question id>, operator: \"equals\", value: <answer> }] } (optional logic: \"and\" | \"or\").";
const BRANCHES_SHAPE =
  "Send branches as [{ id: <branch id>, rules: [{ field: <question id>, operator: \"equals\", value: <answer> }], goto: <question id> }]; " +
  "rules: [] is the otherwise path (put it last) and goto: null ends the questionnaire.";

function unknownReference(index: number, element: FormElementInput, field: string, value: unknown, keys: string[], shape: string): DiditError {
  return conditionalError(
    index,
    element,
    field,
    `names "${String(value)}", which is not a question in this request.`,
    `The questions in this request are: ${keys.join(", ")}. ${shape}`,
  );
}

function assertRuleFields(index: number, element: FormElementInput, rules: unknown, base: string, keys: string[]) {
  const known = new Set(keys);
  (rules as Rule[]).forEach((rule, at) => {
    if (!known.has(String(rule.field))) {
      throw unknownReference(index, element, `${base}[${at}].field`, rule.field, keys,
        "A rule `field` must name a question of the same questionnaire.");
    }
  });
}

function assertConditionalFields(elements: FormElementInput[], keys: string[]) {
  elements.forEach((element, index) => {
    if (!element || typeof element !== "object") return;
    if ("required_if" in element) {
      // null clears the condition; the backend takes it.
      const value = element.required_if as { rules?: unknown } | null;
      const problem = value === null ? undefined : typeof value !== "object" || Array.isArray(value) ? "must be an object." : rulesProblem(value.rules);
      if (problem) throw conditionalError(index, element, "required_if", problem, REQUIRED_IF_SHAPE);
    }
    if ("branches" in element) {
      const value = element.branches;
      if (!Array.isArray(value)) throw conditionalError(index, element, "branches", "must be an array.", BRANCHES_SHAPE);
      value.forEach((branch: { id?: unknown; rules?: unknown; goto?: unknown } | null, at: number) => {
        // `goto` must be stated: a question id, or null for a path that ends the questionnaire.
        // An update takes a branch without one and reads it as null, a destination nobody chose.
        const gotoStated = branch?.goto === null || (typeof branch?.goto === "string" && branch.goto.trim() !== "");
        const problem =
          !branch || typeof branch !== "object"
            ? "must be an object."
            : typeof branch.id !== "string" || !branch.id.trim()
              ? "needs an `id`."
              : rulesProblem(branch.rules) ?? (gotoStated ? undefined : "needs a `goto`: a question id, or null to end the questionnaire there.");
        if (problem) throw conditionalError(index, element, `branches[${at}]`, problem, BRANCHES_SHAPE);
      });
    }
    // A read returns `next` on every question. Accept exactly the value the order implies, so a
    // read can be sent back unchanged; refuse a disagreement and name the implied value.
    if ("next" in element) {
      const implied = keys[index + 1] ?? null;
      if (element.next !== implied) {
        throw conditionalError(index, element, "next",
          `is ${JSON.stringify(element.next)} but the order implies ${implied === null ? "null (this is the last question)" : `"${implied}"`}.`,
          "Remove `next` (the order decides it) or set it to the implied value. To jump to another question on an answer, use `branches` with a `goto`.");
      }
    }
    // Every reference must resolve to a question in this request: the backend refuses a `goto` or
    // rule `field` that names a node outside the graph, and a rule may only name a question of the
    // same questionnaire. `goto: null` and `rules: []` are real values and stay allowed.
    if ("required_if" in element) {
      const value = element.required_if as { rules?: unknown } | null;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        assertRuleFields(index, element, value.rules, "required_if.rules", keys);
      }
    }
    if ("branches" in element) {
      const known = new Set(keys);
      (element.branches as Array<{ rules?: unknown; goto?: unknown }>).forEach((branch, at) => {
        if (branch?.goto !== null && !known.has(String(branch.goto))) {
          throw unknownReference(index, element, `branches[${at}].goto`, branch.goto, keys,
            "A `goto` must name a question of the same questionnaire; null ends it there.");
        }
        assertRuleFields(index, element, branch.rules, `branches[${at}].rules`, keys);
      });
    }
  });
}

const KEPT_FIELDS = ["required_if", "branches", "repeatable_config"] as const;

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value as object).length === 0;
}

/** The last line of defence against a write that answers success for something it did not keep:
 * every conditional field that was sent non-empty must come back non-empty in the stored graph.
 * When the answer carries no graph there is nothing to compare, and the result passes through. */
function withDroppedFieldsWarning(payload: Record<string, any>, result: any): any {
  const sent = payload?.graph?.nodes;
  const stored = result?.graph?.nodes;
  if (!sent || !stored || typeof stored !== "object") return result;
  const dropped: string[] = [];
  for (const [key, node] of Object.entries(sent as Record<string, Record<string, unknown>>)) {
    for (const field of KEPT_FIELDS) {
      if (!isEmpty(node[field]) && isEmpty(stored[key]?.[field])) dropped.push(`${key}.${field}`);
    }
  }
  if (!dropped.length) return result;
  return {
    ...result,
    warning:
      `The questionnaire was written, but these fields were NOT stored: ${dropped.join(", ")}. ` +
      "Do not tell the user the conditional logic is saved. Check their shape (didit_questionnaire_get shows what is stored) and send them again.",
  };
}

/** The keys an update stores: each question's trimmed `id`, else the positional `q${index+1}`
 * `buildQuestionnaireGraph` derives. */
function writtenKeys(elements: FormElementInput[]): string[] {
  return elements.map((element, index) => {
    const supplied = typeof element?.id === "string" ? element.id.trim() : "";
    return supplied || `q${index + 1}`;
  });
}

/** `{start_node, nodes}` from an ordered list of questions. A question's `id`, when given, is
 * its node key — the key its answer is stored under, and the name `required_if` rules and
 * `branches[].goto` refer to it by — so a stable id is preserved verbatim rather than replaced
 * by a positional `qN`; each node points at the next one in the list. */
export function buildQuestionnaireGraph(elements: FormElementInput[], languages: string[]) {
  const keys = writtenKeys(elements);
  assertConditionalFields(elements, keys);
  keys.forEach((key, index) => {
    if (keys.indexOf(key) !== index) {
      throw new DiditError({
        code: "bad_request",
        message: `form_elements[${index}] would use the question id "${key}", which another question already uses.`,
        field: `form_elements[${index}].id`,
        hint: "Question ids are the stored answer keys and must be unique: give each question its own id, or omit the id on the questions that do not need a stable key.",
      });
    }
  });
  const nodes = Object.fromEntries(
    elements.map((element, index) => {
      const { id: _id, title, placeholder, description, choices, ...rest } = element;

      return [
        keys[index],
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
          next: keys[index + 1] ?? null,
        },
      ];
    }),
  );

  return { start_node: keys[0], nodes };
}

/** True when a field `translatable` expands is a plain string: those are written in the payload's
 * languages, so an update that names none has to know the stored ones (see updateQuestionnaire). */
function hasPlainTranslatable(elements: FormElementInput[] | undefined): boolean {
  const plain = (value: unknown) => typeof value === "string" && value.trim() !== "";
  return !!elements?.some(
    (element) =>
      plain(element?.title) ||
      plain(element?.placeholder) ||
      plain(element?.description) ||
      (Array.isArray(element?.choices) && element.choices.some((choice) => plain(choice?.label ?? choice?.value))),
  );
}

/** The part of a stored questionnaire the broadcast warning compares against. */
type StoredQuestion = {
  id?: string;
  title?: unknown;
  placeholder?: unknown;
  description?: unknown;
  choices?: Array<{ value?: unknown; label?: unknown }>;
};

/** The warning for an update that writes a plain string into more than one language. The payload
 * carries those languages (the caller's, else the stored ones), and a plain string has to carry
 * every one of them or the node is refused, so `translatable` copies that same text into each: a
 * Spanish respondent then reads the English text, and translation-completeness views count the
 * question as translated.
 * The example is an internal issue's: an English/Spanish questionnaire, `title: "What is your occupation?"`
 * stored as `{"en": "What is your occupation?", "es": "What is your occupation?"}`.
 *
 * One grouped warning for the whole update, not one per field. `languages` are the ones the
 * payload writes: the caller's when the update names them, else the stored ones. Nothing is warned
 * when only one language is written, when a field is sent as an object carrying every one of them
 * (a translation, not a broadcast), or when the plain string is already stored under every one (an
 * unchanged read-back of text that really is the same everywhere). Best effort: this needs the
 * stored questionnaire, so a read the connection may not make leaves the update unwarned. Such a
 * connection still updates when its fields are sent per language, when it names `languages`, or
 * when the questionnaire is stored in one language; a plain string on a questionnaire stored in
 * several is refused by the backend, which names the missing locale (see updateQuestionnaire). */
function languageBroadcastWarning(
  elements: FormElementInput[] | undefined,
  stored: { form_elements?: StoredQuestion[] } | undefined,
  languages: string[],
): string | undefined {
  if (languages.length < 2 || !elements?.length) return undefined;
  const names = languages.map(String);
  // The uncompacted `form_elements` of the read keeps every locale; `graph` is summarized for
  // display, so comparing against it would call an unchanged read-back a broadcast.
  const known = new Map<string, StoredQuestion>(
    (Array.isArray(stored?.form_elements) ? stored.form_elements : [])
      .filter((element) => typeof element?.id === "string")
      .map((element) => [String(element.id), element]),
  );
  const kept = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const sameInEveryLanguage = (storedValue: unknown, text: string) =>
    kept(storedValue) && names.every((name) => storedValue[name] === text);
  // `translatable` copies any string as it stands, so "" is the one value that is not a broadcast.
  const plain = (value: unknown): value is string => typeof value === "string" && value !== "";
  const keys = writtenKeys(elements);
  const broadcast: string[] = [];
  elements.forEach((element, index) => {
    const question = known.get(keys[index]);
    for (const field of ["title", "placeholder", "description"] as const) {
      const value = element?.[field];
      if (plain(value) && !sameInEveryLanguage(question?.[field], value)) broadcast.push(`${keys[index]}.${field}`);
    }
    if (Array.isArray(element?.choices)) {
      const storedChoices = Array.isArray(question?.choices) ? question.choices : [];
      // `toChoice` labels a choice from its `value` when it sends no `label`, so that string is
      // broadcast as the label too; the stored choice it replaces is the one with the same value,
      // which is what identifies a choice across a reorder or an insertion.
      const choiceValue = (choice: { value?: unknown; label?: unknown }) =>
        String(choice?.value ?? "").trim() || Object.values(translatable(choice?.label, names) ?? {})[0] || "";
      element.choices.forEach((choice, at) => {
        const label = choice?.label ?? choice?.value;
        if (!plain(label)) return;
        const storedChoice = storedChoices.find((candidate) => candidate?.value === choiceValue(choice));
        if (!sameInEveryLanguage(storedChoice?.label, label)) {
          broadcast.push(`${keys[index]}.choices[${at}].label`);
        }
      });
    }
  });
  if (!broadcast.length) return undefined;
  const shape = names.map((name) => `"${name}": ...`).join(", ");
  return `These fields were written as the same text in ${names.join(", ")}: ${broadcast.join(", ")}. ` +
    `Send { ${shape} } to translate it.`;
}

/** The wire payload: `form_elements` become the graph, everything else passes through. The
 * org/app selectors are routing, not content — they are already in the path. A PATCH without
 * `languages` keeps the stored ones (backend QuestionnaireCreateSerializer.validate), so an update
 * that does not name them leaves a multilingual questionnaire alone instead of PATCHing it down to
 * English — which is what an unchanged `form_elements` read-back must do. Create still sends
 * English when nothing is given. `storedLanguages` are the ones such an update keeps: a plain
 * string has to carry every one of them or the backend refuses the node ("missing translations"). */
function toGraphPayload(data: QuestionnaireWrite, forUpdate = false, storedLanguages?: string[]): Record<string, any> {
  const { form_elements, languages, organization_id, application_id, ...rest } = data;
  const langs = languages?.length ? languages : storedLanguages?.length ? storedLanguages : ["en"];
  if (!form_elements) return { ...rest, ...(languages && { languages }) };

  const sendLanguages = !forUpdate || !!languages?.length;
  // A new `languages` list without a `default_language` would leave the stored default outside it:
  // the backend checks the default it is given (English when absent) and keeps the stored one.
  const sendDefaultLanguage = !forUpdate || data.default_language !== undefined || !!languages?.length;
  return {
    ...rest,
    ...(sendLanguages && { languages: langs }),
    ...(sendDefaultLanguage && { default_language: data.default_language ?? langs[0] }),
    graph: buildQuestionnaireGraph(form_elements, langs),
  };
}

/** One page of the application's questionnaires (50 unless `limit` says otherwise), newest first. */
export async function listQuestionnaires(params?: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/questionnaires/"), { params });
}

export async function createQuestionnaire(data: QuestionnaireWrite): Promise<any> {
  const json = toGraphPayload(data);
  return withDroppedFieldsWarning(json, await apiRequest(orgAppPath("/questionnaires/"), { method: "POST", json }));
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

/** The keys of `graph.nodes` are question ids, and a caller may name two questions `ar` and `br`:
 * read as a locale map, that pair lost every question but the first. So the map of questions is
 * walked key by key and only what is inside a question is compacted. */
function compactQuestionnaire(result: any): any {
  const nodes = result?.graph?.nodes;
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return compactTranslations(result);
  const { graph, ...rest } = result;
  const { nodes: _nodes, ...graphRest } = graph;
  return {
    ...compactTranslations(rest),
    graph: {
      ...compactTranslations(graphRest),
      nodes: Object.fromEntries(Object.entries(nodes).map(([key, node]) => [key, compactTranslations(node)])),
    },
  };
}

export async function getQuestionnaire(uuid: string, includeTranslations = false): Promise<any> {
  const result = await apiRequest(orgAppPath(`/questionnaires/${pathSegment(uuid, "questionnaire_id")}/`));
  // `form_elements` is built from the UNCOMPACTED read: it is the list an update sends back, so it
  // keeps every locale a title carries even when `graph` and `sections` are summarized for display.
  const full = withFormElements(result);
  if (includeTranslations) return full;
  return {
    ...compactQuestionnaire(result),
    ...(full.form_elements && { form_elements: full.form_elements }),
    ...(full.form_elements_round_trip === false && {
      form_elements_round_trip: false,
      form_elements_note: full.form_elements_note,
    }),
    translations_summarized: true,
    hint:
      "Translations are summarized in `graph` and `sections`; `form_elements` keeps every locale so it can be sent back. Pass include_translations:true for every locale. " +
      "To change the questionnaire, edit `form_elements` and send the whole list back with didit_questionnaire_update: it is the stored list, " +
      "in the order a respondent answers it." +
      (full.form_elements_round_trip === false ? ` ${full.form_elements_note}` : ""),
  };
}

/** Every stored question in the one shape the write tools accept: `id` plus every stored field, in
 * the order a respondent meets it: the `start_node` → `next` chain, with a branch target that is
 * not on it placed straight after the question that branches to it. `sections[].items` is grouped
 * for display (the backend walks it breadth-first, so a branch target can come before the next
 * question) and is not a list to send back. Sending the list back is an exact round trip only when
 * `form_elements_round_trip` is not false; a graph whose branches leave the main path cannot be one
 * ordered list, because an update writes each question's `next` from that order. A questionnaire
 * whose graph is not readable answers without `form_elements`. */
function withFormElements(result: any): any {
  const nodes = result?.graph?.nodes;
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return result;
  const order = questionOrder(result.graph);
  const form_elements = order.keys.map((key) => ({ id: key, ...nodes[key] }));
  if (order.roundTrip) return { ...result, form_elements };
  return {
    ...result,
    form_elements,
    form_elements_round_trip: false,
    form_elements_note:
      "This questionnaire's branches leave the main path (a branch target is not the next question), " +
      "so this list cannot be sent back unchanged: an update writes every question's `next` from the list order. " +
      "Edit this questionnaire in Console Advanced Mode, or read `graph` as before.",
  };
}

/** Every stored question in the order a respondent meets it. The `next` chain from `start_node` is
 * the main path; an off-path branch target (and whatever only it reaches: its own `next` chain and
 * branch targets) follows the question that branches to it. A node no path reaches is appended.
 * `roundTrip` is true only when the list is the whole `next` chain, the one shape an ordered update
 * can write back unchanged. */
function questionOrder(graph: any): { keys: string[]; roundTrip: boolean } {
  const nodes = graph?.nodes;
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return { keys: [], roundTrip: true };
  const chain = storedOrder(graph);
  const onChain = new Set(chain);
  const keys: string[] = [];
  const placed = new Set<string>();
  const branchesOf = (key: string) => (Array.isArray(nodes[key]?.branches) ? nodes[key].branches : []);
  const appendOffChain = (start: unknown) => {
    if (typeof start !== "string" || !nodes[start] || onChain.has(start) || placed.has(start)) return;
    placed.add(start);
    keys.push(start);
    appendOffChain(nodes[start].next);
    for (const branch of branchesOf(start)) appendOffChain(branch?.goto);
  };
  for (const key of chain) {
    keys.push(key);
    for (const branch of branchesOf(key)) appendOffChain(branch?.goto);
  }
  for (const key of Object.keys(nodes)) appendOffChain(key);
  return { keys, roundTrip: keys.length === chain.length };
}

/** The keys of the stored questions in the order a respondent meets them: start at `start_node`
 * and follow each node's `next` until null. A node this walk does not reach has no position. */
function storedOrder(graph: any): string[] {
  const nodes = graph?.nodes;
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return [];
  const order: string[] = [];
  for (
    let key: any = graph?.start_node;
    typeof key === "string" && key && nodes[key] && !order.includes(key);
    key = nodes[key].next
  ) {
    order.push(key);
  }
  return order;
}

/** Positional at its place: a stored question at 0-based index `i` of the stored order whose key
 * is exactly `q${i + 1}`. Nothing else is positional: `q99` in first place is not, `q3` in second
 * place is not, and a node the walk does not reach has no place at all. */
function isPositionalAtItsPlace(key: string, position: number | undefined): boolean {
  return position !== undefined && key === `q${position + 1}`;
}

/** The refusal for a rename guard whose stored read did not answer. The reason is our own words
 * (a refused read, or a failed one); the upstream body is never echoed, and the hint carries the
 * way out that needs no read at all. */
function unreadableStoredIds(error: unknown): DiditError {
  const refused = error instanceof DiditError && (error.shape.status === 403 || error.shape.code === "forbidden");
  return new DiditError({
    code: "bad_request",
    message:
      `This update sends a question without an id, so the stored ids had to be read to check that none ` +
      `is renamed, and the read did not answer: ${refused ? "no read permission" : "the read failed"}.`,
    field: "form_elements",
    hint:
      "Nothing was written. Send an id for every question and no read is needed: the id each stored " +
      "question already has, exactly as didit_questionnaire_get returns it, or q1, q2, … in order for a " +
      "questionnaire whose own ids are positional.",
  });
}

/** An update must never change, in silence, the key under which a stored question's answers are
 * kept. The rule, with every term defined:
 *
 * - Stored order: the stored questions in the order a respondent meets them: start at
 *   `start_node` and follow each node's `next` until null. A stored node this walk does not reach
 *   has no position.
 * - Positional at its place: a stored question at index `i` of the stored order (0-based) whose
 *   key is exactly `q${i + 1}`. Nothing else is positional: `q99` in first place is not, `q3` in
 *   second place is not, a node the walk does not reach is not.
 * - Final keys of the update: for each question of the update, its trimmed `id` when given, else
 *   `q${index + 1}`: the keys `buildQuestionnaireGraph` will write.
 * - Missing: a stored key that is not among the final keys.
 *
 * 1. No stored key is missing: allow.
 * 2. Every question of the update carries an id: allow, with NO read (a missing stored key was
 *    deleted on purpose), so a connection that may write but not read always works.
 * 3. Otherwise (at least one question has no id) read the stored questionnaire once:
 *    - the read is refused or fails: refuse the update, naming the way out that needs no read;
 *    - no stored key is missing: allow;
 *    - every missing stored key is positional at its place: allow (questions were removed from a
 *      questionnaire that numbers its questions by position);
 *    - any missing stored key is not positional at its place: refuse, naming those keys and the
 *      two ways out: send that question's id again, or give the new question an id of its own. */
async function assertNoStoredIdsAreRenamed(elements: FormElementInput[] | undefined, readStored: () => Promise<any>) {
  if (!elements?.length) return;
  if (elements.every((element) => typeof element?.id === "string" && element.id.trim())) return;
  let stored: any;
  try {
    stored = await readStored();
  } catch (error) {
    throw unreadableStoredIds(error);
  }
  const nodes = stored?.graph?.nodes;
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return;
  const finalKeys = new Set(writtenKeys(elements));
  const missing = Object.keys(nodes).filter((key) => !finalKeys.has(key));
  if (!missing.length) return;
  const order = storedOrder(stored.graph);
  const positionOf = new Map(order.map((key, index) => [key, index]));
  const renamed = missing.filter((key) => !isPositionalAtItsPlace(key, positionOf.get(key)));
  if (!renamed.length) return;
  throw new DiditError({
    code: "bad_request",
    message: `This update sends a question without an id while the stored ${renamed.length === 1 ? "key" : "keys"} ${renamed.map((key) => `"${key}"`).join(", ")} would be renamed, so the key under which ${renamed.length === 1 ? "that question's answers are" : "those questions' answers are"} kept would change in silence.`,
    field: "form_elements",
    hint:
      `Nothing was written. Send the stored questions again with their ids, exactly as didit_questionnaire_get returns them (${renamed.join(", ")}); if the question without an id is a new one, give it an id of its own.`,
  });
}

/** An update that states no `next` anywhere leaves the order implicit: the same stored questions
 * in another order are then a reorder nobody said out loud, which is the one an answer has to
 * name. A single question cannot be reordered, and a read (which carries `next` on every question)
 * already states the order it was read in. */
function statesNoOrder(elements: FormElementInput[] | undefined): boolean {
  return (
    !!elements &&
    elements.length > 1 &&
    elements.every((element) => !(element && typeof element === "object" && "next" in element))
  );
}

/** The warning for an update that keeps every stored question but in another order and says no
 * `next`: the reorder is a legitimate edit, so it is written, and the caller is told which order
 * it was before. A different set of questions is not a reorder (the ids say so). */
function reorderWarning(stored: string[], elements: FormElementInput[]): string | undefined {
  const keys = writtenKeys(elements);
  const storedKeys = new Set(stored);
  const sameQuestions = keys.length === stored.length && keys.every((key) => storedKeys.has(key));
  if (!sameQuestions || keys.join("\u0000") === stored.join("\u0000")) return undefined;
  return `The order of ${keys.length} questions changed: ${keys.join(", ")} (was ${stored.join(", ")}). The questions and their ids are unchanged.`;
}

export async function updateQuestionnaire(uuid: string, data: QuestionnaireWrite): Promise<any> {
  // Build (and so validate) the graph before any read: a malformed conditional field is still
  // refused before any request, as it was before.
  let json = toGraphPayload(data, true);
  // Everything below that needs the stored questionnaire reads it at most once. The rename guard
  // needs it when a question has no id; the reorder warning when no question states its `next`;
  // the language broadcast when a plain string is sent and more than one language is written.
  // Only the guard's refusal is fatal: without a read no warning is given and the write goes out
  // exactly as built, which still updates when the caller sends fields per language, names
  // `languages`, or the questionnaire is stored in one language. A plain string on a questionnaire
  // stored in several is refused by the backend, which names the missing locale — the same answer
  // development gives, since without a read the stored languages are unknowable.
  let stored: Promise<any> | undefined;
  const readStored = () => (stored ??= getQuestionnaire(uuid));
  let broadcast: string | undefined;
  // A plain string is copied into every language of the payload, whether the caller names them or
  // the update keeps the stored ones; only a payload with one language is not a broadcast.
  const namedLanguages = data.languages?.length ? data.languages : undefined;
  if ((!namedLanguages || namedLanguages.length > 1) && hasPlainTranslatable(data.form_elements)) {
    // The warning has to know the stored questionnaire to leave an unchanged read-back alone. When
    // the update names no languages it needs it for the write too: the backend checks each
    // translatable field against the STORED set, so a plain string written in English alone is
    // refused on a multilingual questionnaire ("missing translations for: es"). Write it in every
    // stored language instead of resetting the questionnaire to English to make it pass.
    try {
      const storedQuestionnaire = await readStored();
      const storedLanguages = storedQuestionnaire?.languages;
      if (namedLanguages) {
        broadcast = languageBroadcastWarning(data.form_elements, storedQuestionnaire, namedLanguages);
      } else if (Array.isArray(storedLanguages) && storedLanguages.length) {
        json = toGraphPayload(data, true, storedLanguages);
        broadcast = languageBroadcastWarning(data.form_elements, storedQuestionnaire, storedLanguages);
      }
    } catch {
      // No read: the write goes out as built and the backend names the missing locale; the
      // broadcast is simply not reported (best effort, like the other warnings).
    }
  }
  let warnings: string[] | undefined;
  if (statesNoOrder(data.form_elements)) {
    try {
      const order = questionOrder((await readStored())?.graph);
      if (!order.roundTrip) {
        // A graph whose branches leave the main path cannot come back as one ordered list: writing
        // this one puts its branch-only questions on a single `next` chain. Say so, do not flatten
        // it in silence.
        warnings = [
          "This stored questionnaire's branches leave the main path, so a form_elements update without `next` " +
            "writes one chain: its branch-only questions move onto that chain. Check the result with didit_questionnaire_get.",
        ];
      } else {
        const warning = reorderWarning(order.keys, data.form_elements!);
        if (warning) warnings = [warning];
      }
    } catch {
      // Best effort: a read this connection may not make leaves the update unwarned, not refused.
    }
  }
  if (broadcast) warnings = [...(warnings ?? []), broadcast];
  await assertNoStoredIdsAreRenamed(data.form_elements, readStored);
  const result = withDroppedFieldsWarning(
    json,
    await apiRequest(orgAppPath(`/questionnaires/${pathSegment(uuid, "questionnaire_id")}/`), { method: "PATCH", json }),
  );
  return warnings ? { ...result, warnings } : result;
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
    permission: ["read:questionnaires", "list:questionnaires"], // GET …/questionnaires/ → questionnaire.py:96
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
              "Graph node id of the question: the `id` given to it in the create call, or its positional 'q1', 'q2'. Optional when exactly one question has choices.",
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
      description:
        "Get a questionnaire. `form_elements` is every stored question, in answering order and in the shape didit_questionnaire_update takes: to change it, edit that list and send the whole list back. `sections` is grouped for display, not the question order. Translations are summarized except in `form_elements`, which keeps every locale.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          questionnaire_id: { type: "string", description: "Questionnaire UUID" },
          include_translations: { type: "boolean", description: "Return every locale in `graph` and `sections` too (default false summarizes them for display; `form_elements` always keeps every locale)" },
        },
        required: ["questionnaire_id"],
      },
    },
    access: "read",
    permission: ["read:questionnaires", "list:questionnaires"], // GET …/questionnaires/{uuid}/ → questionnaire.py:204
    run: (args) => getQuestionnaire(args.questionnaire_id, Boolean(args.include_translations)),
  },
  {
    def: {
      name: "didit_questionnaire_update",
      description: "Overwrite a questionnaire's supplied settings. Read the current questions with didit_questionnaire_get first, edit its `form_elements` and send the whole list back: sending form_elements REPLACES the entire question list, removing omitted questions, so pass every question to keep, in order, with its stored `id` and UPPERCASE element_type. An order that differs from the stored one is written and reported in `warnings`. Omit `languages` to keep the stored ones. A question sent without `id` gets a positional q1, q2, … key; an update that would leave out a stored id that way is refused. Omitted status preserves the current draft/published state; publication changes only when status is explicitly passed. Before calling, show the questionnaire and proposed changes and obtain explicit user confirmation, including the full replacement when form_elements is supplied.",
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
      description:
        "Delete a DRAFT VERSION of a questionnaire, not the questionnaire itself. A published version is immutable and cannot be deleted. Neither can the only version of a questionnaire (that would erase it): a draft with no other version, such as one created and never published, has to stay a draft instead, which respondents never see. Only a draft with another version of the same questionnaire is deleted.",
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

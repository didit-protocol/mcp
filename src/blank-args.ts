// Blank OPTIONAL arguments are dropped before a tool handler sees them.
//
// Some model arms fill EVERY declared argument of a tool and blank the ones they
// have no value for (`""`, or `null` on a property whose schema never admits
// null). Prod 16-17 Sep 2026 (didit-ai-assistant, gpt-5.6-luna): every
// `didit_session_search` carried `date_from: ""` / `date_to: ""` and the console
// API answered 400 "Enter a valid date"; a workflow-check tool got
// `label: ""` and resolved it to "Several workflows are labelled """. Both were
// the call a schema-honouring model would have made, minus the blanks — so the
// blanks are removed and the argument is omitted.
//
// A REQUIRED argument is never touched: a blank there is the model's mistake to
// hear about from the handler ("session_id must not be empty."), and dropping
// it would turn that into a misleading "value was dropped before it reached the
// handler". Nested objects are left alone too: their shape is the handler's
// contract, not this seam's.

type PropertySchema = { type?: unknown };

export type InputSchema = {
  properties?: Record<string, PropertySchema>;
  required?: string[];
};

function admitsNull(property: PropertySchema | undefined): boolean {
  const type = property?.type;

  return Array.isArray(type) ? type.includes("null") : type === "null";
}

function isBlank(value: unknown, property: PropertySchema | undefined): boolean {
  return value === "" || (value === null && !admitsNull(property));
}

export function dropBlankOptionals<T extends Record<string, unknown> | undefined>(
  args: T,
  schema: InputSchema | undefined,
): T {
  if (!args || !schema) return args;
  const required = new Set(schema.required ?? []);
  const kept = Object.entries(args).filter(
    ([key, value]) => required.has(key) || !isBlank(value, schema.properties?.[key]),
  );

  return (kept.length === Object.keys(args).length ? args : Object.fromEntries(kept)) as T;
}

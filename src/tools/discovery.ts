/**
 * Discovery tools: how a connection reaches the part of the catalog it did not load.
 *
 * A connection lists a small default (toolsets.ts). These four tools keep everything else one
 * step away, so a short catalog never costs a capability:
 *
 *   didit_tool_search      find tools by what they do, or list one toolset
 *   didit_tool_describe    the full description and input schema of named tools
 *   didit_tool_call_read   run a read-only tool that is not listed
 *   didit_tool_call_write  run a tool that changes data and is not listed
 *
 * Two call tools rather than one, so a client's approval screen can tell a lookup from a
 * change: the read tool is annotated read-only and refuses anything else, the write tool is
 * annotated destructive. A call through either one is unwrapped at the very top of the
 * dispatcher (index.ts) and then runs through exactly the same checks as a direct call: the
 * hosted exclusions, the permission pre-check, read-only mode, confirm guards, the audit line.
 * Nothing is reachable through them that the caller could not reach by naming the tool.
 *
 * They are listed only when the connection's catalog is a strict subset of what the caller
 * may use. With `toolsets=all` there is nothing left to discover, so they are not offered.
 *
 * Search is lexical on purpose: no embeddings, no model call, no dependency, the same answer
 * every time. The catalog is a few hundred short documents whose names already say
 * `<domain>_<action>`, which is the case where weighted keyword matching is enough.
 */
import { TOOLSETS, toolsetOf } from "../toolsets";

export const TOOL_SEARCH = "didit_tool_search";
export const TOOL_DESCRIBE = "didit_tool_describe";
export const TOOL_CALL_READ = "didit_tool_call_read";
export const TOOL_CALL_WRITE = "didit_tool_call_write";

const DISCOVERY_TOOL_NAMES: ReadonlySet<string> = new Set([TOOL_SEARCH, TOOL_DESCRIBE, TOOL_CALL_READ, TOOL_CALL_WRITE]);

export function isDiscoveryToolName(name: string): boolean {
  return DISCOVERY_TOOL_NAMES.has(name);
}

/** The two tools that run another tool. */
export function isToolCallProxy(name: string): boolean {
  return name === TOOL_CALL_READ || name === TOOL_CALL_WRITE;
}

export type ToolAccess = "read" | "write" | "destructive";

/** One tool as the discovery tools see it. Built per caller by index.ts. */
export interface DiscoverableTool {
  name: string;
  description: string;
  inputSchema: { properties?: Record<string, unknown>; required?: readonly string[]; [key: string]: unknown };
  access: ToolAccess;
  /** Whether the tool is already in this connection's tool list. */
  listed: boolean;
}

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const MAX_DESCRIBE = 5;
const SUMMARY_CHARS = 280;

function unloadedSummary(tools: readonly DiscoverableTool[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    if (tool.listed) continue;
    const id = toolsetOf(tool.name);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return TOOLSETS.filter((toolset) => counts.has(toolset.id))
    .map((toolset) => `${toolset.id} (${counts.get(toolset.id)})`)
    .join(", ");
}

/**
 * The discovery tools for one connection. Their descriptions name what is not loaded, because
 * that is the only place every client shows a model what else exists (not every client passes
 * server instructions on).
 */
export function discoveryToolDefs(tools: readonly DiscoverableTool[], options: { readOnly: boolean }): ToolDef[] {
  const unloaded = tools.filter((tool) => !tool.listed).length;
  const callArgs = {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "The tool's exact name, as didit_tool_search returned it." },
      arguments: {
        type: "object",
        description: "The tool's own arguments, exactly as you would pass them when calling it directly.",
        additionalProperties: true,
      },
    },
    required: ["name"],
    additionalProperties: false,
  };
  const defs: ToolDef[] = [
    {
      name: TOOL_SEARCH,
      description:
        `Find Didit tools that are not in your tool list. This connection loads part of the Didit catalog; ` +
        `${unloaded} more ${options.readOnly ? "read-only " : ""}tools are available, by toolset: ${unloadedSummary(tools)}. ` +
        "Search by what you want to do (\"export sessions to CSV\", \"add a face to the blocklist\"), pass `toolset` " +
        "to list one area, or pass nothing to see what each toolset covers. Each match gives the tool's name, what it " +
        "does, its parameters and whether it reads, writes or is destructive. Run a match with " +
        `${TOOL_CALL_READ}${options.readOnly ? "" : ` or ${TOOL_CALL_WRITE}`}; a match marked loaded is already in ` +
        "your tool list, so call it directly.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you want to do, in a few words." },
          toolset: {
            type: "string",
            enum: TOOLSETS.map((toolset) => toolset.id),
            description: "List the tools of one toolset. Combine with query to search inside it.",
          },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Maximum matches (default ${DEFAULT_LIMIT}).` },
        },
        additionalProperties: false,
      },
    },
    {
      name: TOOL_DESCRIBE,
      description:
        `Get the full description and input schema of up to ${MAX_DESCRIBE} Didit tools by name. Use it when the ` +
        `one-line parameter summary from ${TOOL_SEARCH} is not enough, for example for nested objects.`,
      inputSchema: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_DESCRIBE,
            description: "Exact tool names.",
          },
        },
        required: ["names"],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_CALL_READ,
      description:
        `Run a read-only Didit tool that is not in your tool list (find it with ${TOOL_SEARCH}). Pass its \`name\` and ` +
        "its own `arguments`. It never changes data: a tool that writes is refused here.",
      inputSchema: callArgs,
    },
  ];
  if (!options.readOnly) {
    defs.push({
      name: TOOL_CALL_WRITE,
      description:
        `Run a Didit tool that creates, changes or deletes data and is not in your tool list (find it with ${TOOL_SEARCH}). ` +
        "Pass its `name` and its own `arguments`. The tool's own rules still apply: one that needs `confirm: true` " +
        "needs it inside `arguments`, and only after the person has agreed to that exact action.",
      inputSchema: callArgs,
    });
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "in", "on", "at", "by", "my", "me", "i", "we", "our", "and", "or", "with",
  "how", "do", "does", "can", "is", "are", "what", "which", "that", "this", "it", "from", "into", "please",
  "didit", "tool", "tools",
]);

/** Words people say for a thing the catalog names differently. Kept short: it is a hint, not a thesaurus. */
const SYNONYM_LIST: Readonly<Record<string, readonly string[]>> = {
  // Verbs: the catalog says create / get / update / delete / search / list.
  change: ["update"],
  modify: ["update"],
  edit: ["update"],
  set: ["update"],
  rename: ["update"],
  remove: ["delete"],
  erase: ["delete"],
  add: ["create"],
  make: ["create"],
  new: ["create"],
  start: ["create"],
  show: ["get", "list"],
  view: ["get"],
  read: ["get"],
  fetch: ["get"],
  see: ["get", "list"],
  find: ["search"],
  lookup: ["search"],
  look: ["search"],
  // Things
  kyb: ["business"],
  company: ["business", "kyb"],
  registry: ["kyb"],
  kyc: ["session", "verify"],
  verification: ["session", "verify"],
  customer: ["vendor", "user"],
  csv: ["export"],
  download: ["export", "pdf"],
  approve: ["accept"],
  reject: ["override"],
  team: ["member"],
  invite: ["member"],
  teammate: ["member"],
  price: ["billing", "balance"],
  cost: ["billing", "balance"],
  credit: ["balance"],
  invoice: ["receipt", "billing"],
  sanction: ["aml"],
  sanctioned: ["aml"],
  pep: ["aml"],
  watchlist: ["aml"],
  screening: ["aml"],
  adverse: ["aml"],
  selfie: ["face", "liveness"],
  biometric: ["face", "liveness"],
  passport: ["id"],
  document: ["id"],
  proof: ["poa"],
  utility: ["poa"],
  sms: ["phone"],
  otp: ["phone", "email"],
  logo: ["branding"],
  color: ["branding"],
  colour: ["branding"],
  theme: ["branding"],
  wallet: ["screen"],
  crypto: ["wallet", "transaction"],
  rule: ["transaction"],
  age: ["verify"],
  role: ["member"],
  permission: ["role", "member"],
  key: ["api"],
  usage: ["analytics", "billing"],
  plan: ["billing"],
  payment: ["billing"],
  receipt: ["billing"],
  form: ["questionnaire"],
  survey: ["questionnaire"],
  notification: ["webhook", "alert"],
  callback: ["webhook"],
  ban: ["blocklist"],
  block: ["blocklist"],
  fraud: ["blocklist", "aml"],
  log: ["audit"],
  history: ["audit", "review"],
  stats: ["analytics", "statistics"],
  metric: ["analytics"],
  dashboard: ["analytics"],
  many: ["analytics"],
  count: ["analytics", "statistics"],
  volume: ["analytics"],
  conversion: ["analytics"],
  who: ["list"],
};

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);

  return word;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(singular);
}

/** The synonyms in the same form as the words they are compared with (lowercase, singular). */
const SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(SYNONYM_LIST).map(([word, related]) => [singular(word), related.map(singular)]),
);

/** 1 for the same word, 0.5 for words that share a long stem ("verify" / "verification"), else 0. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return 0;
  let common = 0;
  while (common < shorter && a[common] === b[common]) common++;

  return common >= 4 && common >= shorter * 0.7 ? 0.5 : 0;
}

function best(word: string, bag: readonly string[]): number {
  let score = 0;
  for (const candidate of bag) {
    score = Math.max(score, similarity(word, candidate));
    if (score === 1) break;
  }

  return score;
}

interface IndexedTool {
  tool: DiscoverableTool;
  toolset: string;
  nameWords: string[];
  areaWords: string[];
  paramWords: string[];
  descriptionWords: string[];
  /** Name and description as plain lowercase text, for whole-phrase matches. */
  text: string;
}

/** Lowercase words separated by single spaces, so "proof-of-address" and "Proof of Address" read alike. */
function plainText(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function indexTool(tool: DiscoverableTool): IndexedTool {
  const toolset = toolsetOf(tool.name) ?? "";
  const definition = TOOLSETS.find((candidate) => candidate.id === toolset);

  return {
    tool,
    toolset,
    nameWords: tokenize(tool.name),
    areaWords: tokenize(`${toolset} ${definition?.groups.map(([, label]) => label).join(" ") ?? ""}`),
    paramWords: tokenize(Object.keys(tool.inputSchema.properties ?? {}).join(" ")),
    descriptionWords: tokenize(tool.description),
    text: plainText(`${tool.name} ${tool.description}`),
  };
}

const WEIGHT = { name: 8, area: 4, param: 2, description: 1.5, phrase: 6, complete: 3, coverage: 3 } as const;
/** A synonym is a slightly weaker signal than the word the person actually used. */
const SYNONYM_WEIGHT = 0.9;

type Rarity = (word: string) => number;

/**
 * How much a word narrows the catalog down, from 1 (found in one tool) towards 0 (found in
 * most of them). "session" and "list" appear in dozens of names and say little; "export" or
 * "aml" appear in one or two and say nearly everything. Without this a request such as "export
 * sessions to CSV" is answered with every tool that has "session" in its name, and a common
 * word in a long description ("list", "check") counts as much as the one word that matters.
 */
function rarity(index: readonly IndexedTool[], wordsOf: (entry: IndexedTool) => readonly string[]): Rarity {
  const frequency = new Map<string, number>();
  for (const entry of index) {
    for (const word of new Set(wordsOf(entry))) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  const total = Math.max(index.length, 2);
  const cache = new Map<string, number>();

  return (word) => {
    const cached = cache.get(word);
    if (cached !== undefined) return cached;
    // The best partial match decides how common the word is, as it decides the score.
    let count = 0;
    for (const [candidate, hits] of frequency) if (similarity(word, candidate) > 0) count = Math.max(count, hits);
    const value = count === 0 ? 1 : Math.log(1 + total / count) / Math.log(1 + total);
    cache.set(word, value);

    return value;
  };
}

interface Rarities {
  /** Over tool names and toolset labels. */
  name: Rarity;
  /** Over descriptions and argument names. */
  text: Rarity;
}

function wordScore(entry: IndexedTool, word: string, rare: Rarities): number {
  return (
    rare.name(word) * (WEIGHT.name * best(word, entry.nameWords) + WEIGHT.area * best(word, entry.areaWords)) +
    rare.text(word) * (WEIGHT.param * best(word, entry.paramWords) + WEIGHT.description * best(word, entry.descriptionWords))
  );
}

/** A word counts as answered by a tool only when it matched with some weight, not in passing. */
const ANSWERED = 1;

function scoreTool(entry: IndexedTool, words: readonly string[], phrase: string, rare: Rarities): number {
  let score = 0;
  let answered = 0;
  const named = new Set<string>();
  for (const word of words) {
    // The word itself, plus the best of its synonyms: a group of synonyms counts once.
    const forms = [word, ...(SYNONYMS.get(word) ?? [])];
    const direct = wordScore(entry, word, rare);
    const related = Math.max(0, ...forms.slice(1).map((synonym) => wordScore(entry, synonym, rare)));
    const hit = direct + SYNONYM_WEIGHT * related;
    score += hit;
    if (hit >= ANSWERED) answered++;
    for (const nameWord of entry.nameWords) {
      if (forms.some((form) => similarity(form, nameWord) > 0)) named.add(nameWord);
    }
  }
  if (score === 0) return 0;
  // A tool that answers every word of the request outranks one that answers a single word well.
  if (words.length > 1 && answered === words.length) score += WEIGHT.complete;
  // The request, word for word, in the tool's own text ("proof of address").
  if (words.length > 1 && entry.text.includes(phrase)) score += WEIGHT.phrase;
  // How much of the tool's NAME the request explains: "delete a session" is didit_session_delete
  // before it is didit_session_batch_delete, whose name says more than was asked.
  score += WEIGHT.coverage * (named.size / Math.max(entry.nameWords.length, 1));

  return score;
}

function firstSentences(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));

  return end > limit * 0.4 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}...`;
}

/** `session_id*: string, status: Approved|Declined, limit: number` - top-level arguments, required ones starred. */
function parameterSummary(tool: DiscoverableTool): string {
  const required = new Set(tool.inputSchema.required ?? []);

  return Object.entries(tool.inputSchema.properties ?? {})
    .map(([name, raw]) => {
      const schema = (raw ?? {}) as { type?: unknown; enum?: unknown[] };
      const values = Array.isArray(schema.enum) ? schema.enum : undefined;
      const type =
        values && values.length <= 8
          ? values.join("|")
          : Array.isArray(schema.type)
            ? schema.type.join("|")
            : typeof schema.type === "string"
              ? schema.type
              : "any";

      return `${name}${required.has(name) ? "*" : ""}: ${type}`;
    })
    .join(", ");
}

function summarize(tool: DiscoverableTool): Record<string, unknown> {
  return {
    name: tool.name,
    toolset: toolsetOf(tool.name) ?? null,
    access: tool.access,
    loaded: tool.listed,
    description: firstSentences(tool.description, SUMMARY_CHARS),
    parameters: parameterSummary(tool),
  };
}

function toolsetOverview(tools: readonly DiscoverableTool[]): Record<string, unknown>[] {
  return TOOLSETS.map((toolset) => {
    const members = tools.filter((tool) => toolsetOf(tool.name) === toolset.id);

    return {
      id: toolset.id,
      description: toolset.description,
      tools: members.length,
      loaded: members.filter((tool) => tool.listed).length,
    };
  }).filter((row) => (row.tools as number) > 0);
}

/** didit_tool_search. `tools` is everything this caller may run on this connection. */
export function searchTools(tools: readonly DiscoverableTool[], args: Record<string, unknown> | undefined): Record<string, unknown> {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  const toolset = typeof args?.toolset === "string" ? args.toolset.trim().toLowerCase().replace(/-/g, "_") : "";
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(args?.limit) ? (args!.limit as number) : DEFAULT_LIMIT));

  if (!query && !toolset) {
    return {
      toolsets: toolsetOverview(tools),
      next_step: "Pass `query` to search by what you want to do, or `toolset` to list one of these areas.",
    };
  }

  const scoped = toolset ? tools.filter((tool) => toolsetOf(tool.name) === toolset) : tools;
  if (toolset && scoped.length === 0) {
    return {
      matches: [],
      total: 0,
      next_step: `No toolset '${toolset}' on this connection. Available: ${toolsetOverview(tools).map((row) => row.id).join(", ")}.`,
    };
  }
  if (!query) {
    // Listing a toolset is a request for all of it: the caller's limit applies only when sent.
    const cap = Number.isInteger(args?.limit) ? limit : MAX_LIMIT;

    return {
      matches: scoped.slice(0, cap).map(summarize),
      total: scoped.length,
      ...(scoped.length > cap ? { next_step: `Showing ${cap} of ${scoped.length}. Add a query to narrow it.` } : {}),
    };
  }

  const exact = scoped.find((tool) => tool.name === query || tool.name === `didit_${query}`);
  const words = [...new Set(tokenize(query))];
  const phrase = plainText(query);
  const index = scoped.map(indexTool);
  const rare: Rarities = {
    name: rarity(index, (entry) => [...entry.nameWords, ...entry.areaWords]),
    text: rarity(index, (entry) => [...entry.descriptionWords, ...entry.paramWords]),
  };
  const ranked = index
    .map((entry, position) => ({
      tool: entry.tool,
      position,
      score: entry.tool === exact ? Number.MAX_SAFE_INTEGER : scoreTool(entry, words, phrase, rare),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.position - b.position);

  if (ranked.length === 0) {
    return {
      matches: [],
      total: 0,
      next_step: `Nothing matched '${query}'. Try other words, or list an area with \`toolset\`: ${toolsetOverview(tools).map((row) => row.id).join(", ")}.`,
    };
  }

  return { matches: ranked.slice(0, limit).map((row) => summarize(row.tool)), total: ranked.length };
}

/** didit_tool_describe. Unknown names come back with the closest real names, never as an error. */
export function describeTools(tools: readonly DiscoverableTool[], args: Record<string, unknown> | undefined): Record<string, unknown> {
  const names = (Array.isArray(args?.names) ? args!.names : [args?.names])
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .map((name) => name.trim())
    .slice(0, MAX_DESCRIBE);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const found: Record<string, unknown>[] = [];
  const notFound: Record<string, unknown>[] = [];

  for (const name of names) {
    const tool = byName.get(name) ?? byName.get(`didit_${name}`);
    if (tool) {
      found.push({
        name: tool.name,
        toolset: toolsetOf(tool.name) ?? null,
        access: tool.access,
        loaded: tool.listed,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
      continue;
    }
    const close = searchTools(tools, { query: name.replace(/^didit_/, "").replace(/_/g, " "), limit: 3 });
    notFound.push({
      name,
      did_you_mean: ((close.matches as { name: string }[] | undefined) ?? []).map((match) => match.name),
    });
  }

  return {
    tools: found,
    ...(notFound.length > 0 ? { not_found: notFound } : {}),
    ...(names.length === 0 ? { next_step: "Pass `names`: an array of exact tool names from didit_tool_search." } : {}),
  };
}

// ---------------------------------------------------------------------------
// Running another tool
// ---------------------------------------------------------------------------

export interface UnwrappedCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The tool a didit_tool_call_* request names, with its own arguments. A model sometimes sends
 * the nested arguments as a JSON string; that is accepted, since the intent is unambiguous.
 * Returns a message instead when the request cannot be read.
 */
export function unwrapToolCall(args: Record<string, unknown> | undefined): UnwrappedCall | string {
  const name = typeof args?.name === "string" ? args.name.trim() : "";
  if (!name) return "Pass `name`: the exact name of the tool to run, as didit_tool_search returned it.";
  if (isDiscoveryToolName(name)) return `'${name}' is a discovery tool: call it directly, not through another one.`;

  let inner: unknown = args?.arguments ?? {};
  if (typeof inner === "string") {
    try {
      inner = inner.trim() === "" ? {} : JSON.parse(inner);
    } catch {
      return "`arguments` must be an object holding the tool's own arguments.";
    }
  }
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    return "`arguments` must be an object holding the tool's own arguments.";
  }

  return { name, arguments: inner as Record<string, unknown> };
}

/**
 * didit_docs_search: the Didit documentation, searched from the same connection that operates
 * the account.
 *
 * Someone integrating Didit asks two kinds of question in one conversation: "what does my
 * account look like" (the other tools) and "how is this supposed to work" (the documentation).
 * Without this tool the second kind is answered from the model's memory, which is where wrong
 * endpoint names and outdated webhook fields come from.
 *
 * It is a thin proxy to the public documentation search server at docs.didit.me/mcp, which is
 * re-indexed on every documentation deploy, so results are always the current pages. That
 * server is public and needs no credentials; the caller's Didit token is never sent to it.
 */
import { DiditError } from "../security";

export const DOCS_SEARCH_TOOL = "didit_docs_search";

const DEFAULT_DOCS_MCP_URL = "https://docs.didit.me/mcp";
/** The documentation server's own search tool. */
const UPSTREAM_SEARCH_TOOL = "search_didit_docs";
const TIMEOUT_MS = 10_000;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
/** Enough of a section to answer from; the link carries the rest. */
const MAX_CONTENT_CHARS = 1500;

/** DIDIT_DOCS_MCP_URL: unset means the public documentation; set but empty switches the tool off. */
export function docsMcpUrl(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.DIDIT_DOCS_MCP_URL;
  if (url === undefined) return DEFAULT_DOCS_MCP_URL;

  return url.trim() ? url.trim() : null;
}

export function docsSearchToolDef(): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return {
    name: DOCS_SEARCH_TOOL,
    description:
      "Search the Didit documentation (docs.didit.me): API reference, webhooks, SDKs, verification features, pricing " +
      "and guides. Use it for any question about how Didit works or how to integrate it, instead of answering from " +
      "memory. Returns the matching sections with their titles and links; cite the link you used.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, in a few words." },
        language: { type: "string", description: "Documentation language code, for example es. Defaults to en." },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, description: `Maximum sections (default ${DEFAULT_RESULTS}).` },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function unavailable(reason: string): DiditError {
  return new DiditError({
    code: "docs_unavailable",
    message: `Documentation search is not available right now (${reason}).`,
    hint: "Answer from what the tools returned and say the documentation could not be checked, or point the person to https://docs.didit.me.",
  });
}

/** The JSON-RPC reply, whether the server answered as JSON or as a one-message event stream. */
function parseReply(body: string): { result?: { content?: unknown; isError?: boolean }; error?: { message?: string } } {
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  return JSON.parse(data.length > 0 ? data[data.length - 1] : body);
}

/** One search hit: the upstream block is `Title: / Link: / Page: / Content:` in plain text. */
function parseHit(text: string): { title: string; url: string; content: string } | undefined {
  const title = /^Title:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  const url = /^Link:\s*(\S+)/m.exec(text)?.[1] ?? "";
  const start = text.indexOf("Content:");
  const content = (start >= 0 ? text.slice(start + "Content:".length) : text).trim();
  if (!title && !url && !content) return undefined;

  return {
    title,
    url,
    content: content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}...` : content,
  };
}

export async function searchDocs(args: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new DiditError({ code: "bad_request", message: "query is required.", field: "query" });
  }
  const url = docsMcpUrl();
  if (!url) throw unavailable("it is switched off on this server");
  const limit = Math.min(MAX_RESULTS, Math.max(1, Number.isInteger(args?.limit) ? (args!.limit as number) : DEFAULT_RESULTS));
  const language = typeof args?.language === "string" && args.language.trim() ? args.language.trim() : undefined;

  let body: string;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: UPSTREAM_SEARCH_TOOL, arguments: { query, ...(language ? { language } : {}) } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw unavailable(`the documentation server answered ${response.status}`);
    body = await response.text();
  } catch (error) {
    if (error instanceof DiditError) throw error;
    throw unavailable("the documentation server did not answer");
  }

  let reply: ReturnType<typeof parseReply>;
  try {
    reply = parseReply(body);
  } catch {
    throw unavailable("the documentation server sent an unreadable answer");
  }
  if (reply.error || reply.result?.isError) throw unavailable("the documentation server reported an error");

  const blocks = Array.isArray(reply.result?.content) ? (reply.result!.content as { type?: string; text?: string }[]) : [];
  const results = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => parseHit(block.text as string))
    .filter((hit): hit is { title: string; url: string; content: string } => hit !== undefined)
    .slice(0, limit);

  return {
    query,
    results,
    ...(results.length === 0 ? { next_step: "No section matched. Try other words, or fewer of them." } : {}),
  };
}

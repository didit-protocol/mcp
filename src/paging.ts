/**
 * Lists that the API serves one page at a time.
 *
 * Most list endpoints answer `{ count, next, previous, results }` with a default page (20
 * workflows, 50 of most other things). A tool that sent no paging argument therefore returned
 * the first page and nothing said so: an application with 76 workflows listed 20, the search
 * across applications read the same first page of each, and a workflow outside the 20 most
 * recently changed could not be found by its name.
 *
 * Two answers, depending on who reads the list:
 *
 * - A tool a model calls takes `limit` and `offset` (PAGE_PROPS, pageParams) and its answer
 *   carries `count`, so the model sees that there is more and can ask for it.
 * - Code inside the server that needs the WHOLE list to be right (finding a workflow by its
 *   label, the organizations and applications a caller can reach) reads every page (everyPage).
 */
import { DiditError } from "./security";

/** The largest page a tool asks the API for. */
export const MAX_PAGE_SIZE = 200;

/** `limit` and `offset`, spread into the input schema of a paged list tool. */
export const PAGE_PROPS = {
  limit: {
    type: "number",
    description: `How many to return in this call (1 to ${MAX_PAGE_SIZE}). \`count\` in the answer is the total.`,
  },
  offset: {
    type: "number",
    description: "How many to skip: pass the number you have already read to get the ones after them.",
  },
} as const;

function wholeNumber(value: unknown, field: "limit" | "offset", min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  // A model sometimes sends "50" where 50 is asked for; both mean the same thing here.
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
    throw new DiditError({
      code: "bad_request",
      message: `${field} must be a whole number from ${min} to ${max}.`,
      field,
      hint:
        field === "limit"
          ? "To read more than one page, keep `limit` and raise `offset` by the number of rows you got."
          : "offset is how many rows to skip, counted from the first one.",
    });
  }

  return number;
}

/** The paging arguments of a call as query parameters; an absent one is left to the API's default. */
export function pageParams(args: Record<string, unknown> | undefined): { limit?: number; offset?: number } {
  const limit = wholeNumber(args?.limit, "limit", 1, MAX_PAGE_SIZE);
  const offset = wholeNumber(args?.offset, "offset", 0, Number.MAX_SAFE_INTEGER);

  return { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) };
}

/** Pages read before giving up: 5,000 rows, far past any real list, so a list that never ends cannot hang a call. */
const MAX_PAGES = 25;

export interface WholeList {
  rows: any[];
  /** The total the API reports, or the number of rows when it reports none. */
  total: number;
  /** False when the page cap stopped the read before the end. */
  complete: boolean;
}

/**
 * Every row of a list. `fetchPage` asks the API for one page; an answer that is a bare array is
 * a list the API does not page, and is the whole of it.
 *
 * The end of a list is a page with no `next`, never a number of rows: some endpoints stop
 * counting at 100 (`count` is then a floor, not the total) while `next` goes on to the last row.
 */
export async function everyPage(fetchPage: (page: { limit: number; offset: number }) => Promise<any>): Promise<WholeList> {
  const rows: any[] = [];
  let total = 0;
  for (let read = 0; read < MAX_PAGES; read++) {
    const page = await fetchPage({ limit: MAX_PAGE_SIZE, offset: rows.length });
    if (Array.isArray(page)) return { rows: page, total: page.length, complete: true };
    const results: any[] = Array.isArray(page?.results) ? page.results : [];
    rows.push(...results);
    total = typeof page?.count === "number" ? page.count : rows.length;
    if (!page?.next || results.length === 0) return { rows, total: Math.max(total, rows.length), complete: true };
  }

  return { rows, total: Math.max(total, rows.length), complete: false };
}

/**
 * The answer of a list endpoint with every page read into it. It keeps the envelope the API
 * uses (`count` and `results`, with no `next`), so whoever read the first page before reads the
 * whole list the same way.
 */
export async function wholeEnvelope(fetchPage: (page: { limit: number; offset: number }) => Promise<any>): Promise<any> {
  let envelope = true;
  const whole = await everyPage(async (page) => {
    const answer = await fetchPage(page);
    if (Array.isArray(answer)) envelope = false;

    return answer;
  });
  if (!envelope) return whole.rows;

  return { count: whole.total, next: null, previous: null, results: whole.rows, ...(whole.complete ? {} : { incomplete: true }) };
}

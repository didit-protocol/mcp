/**
 * What a request's `Accept` header says, for the two places the hosted endpoint chooses between
 * answers: an event stream or plain JSON on POST, and the page a person reads or the protocol's
 * 405 on GET.
 *
 * Why: both choices used to be made by looking for a substring. The streamable-HTTP
 * transport refuses a POST whose Accept does not name *both* `application/json` and
 * `text/event-stream` (406), and the connect page answered any GET whose Accept merely mentioned
 * `text/html`, redirecting a client that had asked for JSON to an HTML page. A connector that names
 * only JSON therefore saw a refusal, or a page, at the step that adds the server — the step a
 * connector reports as "could not verify the server" / "could not add the connector" — while a
 * browser and the dual-Accept clients saw what they always see. These helpers read the header as
 * the media ranges it is (RFC 9110 12.5.1), so each answer follows what the caller asked for.
 */

export interface MediaRange {
  type: string;
  subtype: string;
  /** 0 when the caller explicitly refused the range (`q=0`), 1 when it named no quality. */
  q: number;
}

const WILDCARD = "*";

/** The header's media ranges, lower-cased, each with its q-value. Anything malformed is dropped. */
export function mediaRangesOf(accept: unknown): MediaRange[] {
  if (typeof accept !== "string") return [];

  return accept
    .split(",")
    .map((part) => {
      const [range, ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
      const [type, subtype] = (range ?? "").split("/");
      if (!type || !subtype) return undefined;
      const quality = params.find((param) => param.startsWith("q="));
      const q = quality === undefined ? 1 : Number(quality.slice(2));

      return { type, subtype, q: Number.isFinite(q) ? q : 0 };
    })
    .filter((range): range is MediaRange => range !== undefined);
}

/** True when the caller names this media type itself and accepts it — a wildcard does not count. */
export function namesMediaType(accept: unknown, mediaType: string): boolean {
  const [type, subtype] = mediaType.toLowerCase().split("/");

  return mediaRangesOf(accept).some((range) => range.type === type && range.subtype === subtype && range.q > 0);
}

/**
 * True when the caller accepts this media type, whether it names it or covers it with a wildcard.
 *
 * The most specific range that covers the type decides (RFC 9110 12.5.1): the type itself, then the
 * wildcard for its own type, then the wildcard for everything. So a caller that accepts every
 * `application` type and refuses `application/json;q=0` by name does not get JSON, wherever the
 * refusal stands in the header.
 */
export function acceptsMediaType(accept: unknown, mediaType: string): boolean {
  const [type, subtype] = mediaType.toLowerCase().split("/");
  const specificity = (range: MediaRange): number => {
    if (range.type === type && range.subtype === subtype) return 3;
    if (range.type === type && range.subtype === WILDCARD) return 2;

    return range.type === WILDCARD && range.subtype === WILDCARD ? 1 : 0;
  };
  let decisive: MediaRange | undefined;
  for (const range of mediaRangesOf(accept)) {
    if (specificity(range) > (decisive ? specificity(decisive) : 0)) decisive = range;
  }

  return decisive !== undefined && decisive.q > 0;
}

/** The transport's two answer shapes: an event stream, or one plain JSON body. */
export type AnswerFormat = "event-stream" | "json";

/**
 * The shape to answer in: an event stream when the caller named one, which is exactly the stream every
 * client gets today; otherwise JSON when the caller accepts it, including through a wildcard; and
 * undefined when it accepts neither, where the transport's own 406 is the right answer.
 */
export function answerFormatFor(accept: unknown): AnswerFormat | undefined {
  if (namesMediaType(accept, "text/event-stream")) return "event-stream";
  if (acceptsMediaType(accept, "application/json")) return "json";

  return undefined;
}

/**
 * The page that says how to connect is for a browser: a GET that names `text/html` and names neither
 * MCP media type. A client that lists HTML among the types it can take still gets the protocol's
 * answer, so no MCP client is ever handed the page.
 */
export function isBrowserNavigation(accept: unknown): boolean {
  return namesMediaType(accept, "text/html") && !namesMcpMediaType(accept);
}

/**
 * A GET that names an MCP media type comes from a client reaching for the server. At the server's
 * bare address, where the page is the default answer (a crawler and `curl` name no type at all), this
 * is what tells a client from everyone else.
 */
export function namesMcpMediaType(accept: unknown): boolean {
  return namesMediaType(accept, "application/json") || namesMediaType(accept, "text/event-stream");
}

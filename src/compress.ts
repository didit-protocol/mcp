/**
 * Compressed responses for the hosted server.
 *
 * tools/list is the largest answer the server gives: about 350 KB of JSON for the full catalog,
 * sent again on every connection (about 33,000 times a day in production in November 2026,
 * roughly 12 GB a day). It is text that repeats itself, so gzip takes it to about a sixth. A
 * client that sends `Accept-Encoding` gets the smaller answer; one that does not gets exactly
 * the bytes it got before.
 *
 * Two things make this more than mounting the middleware:
 *
 * - `no-transform`. The MCP SDK marks its event streams `Cache-Control: no-cache, no-transform`,
 *   and the compressor reads that directive as "never compress". But the directive speaks to
 *   intermediaries (RFC 9111, 5.2.2.6): a proxy must not alter what the origin sent. This server
 *   is the origin choosing its own content coding, so the directive is hidden from the compressor
 *   while it decides and put back before the headers leave. On the wire the answer is compressed
 *   AND still tells every proxy to leave it alone. Without this, the event stream path, which is
 *   the one every client before the 2026-07-28 protocol uses, is never compressed.
 * - Event streams. A compressor holds bytes back until it has a full block, which would delay an
 *   event that is meant to arrive now, so every write to an event stream is flushed at once.
 */
import compression from "compression";
import onHeaders from "on-headers";
import type { RequestHandler, Response } from "express";

/** Below this an answer is not worth compressing (a health check, a refusal). */
const THRESHOLD_BYTES = 1024;

const NO_TRANSFORM = "no-transform";

/** Responses whose `no-transform` is out of the Cache-Control header while the compressor decides. */
const hiddenNoTransform = new WeakSet<Response>();

const directivesOf = (res: Response): string[] =>
  String(res.getHeader("Cache-Control") ?? "")
    .split(",")
    .map((directive) => directive.trim())
    .filter(Boolean);

/*
 * Header listeners fire in the reverse order they were added (on-headers). The compressor adds
 * its own when its middleware runs, so a listener added AFTER it runs before it, and one added
 * BEFORE it runs after it. That is the whole mechanism: hide, let the compressor decide, restore.
 */

/** Mounted before the compressor, so it runs last: the directive goes back on the wire. */
const restoreNoTransform: RequestHandler = (_req, res, next) => {
  onHeaders(res, () => {
    if (!hiddenNoTransform.has(res)) return;
    res.setHeader("Cache-Control", [...directivesOf(res), NO_TRANSFORM].join(", "));
  });
  next();
};

/** Mounted after the compressor, so it runs first: the compressor decides on the content type alone. */
const hideNoTransform: RequestHandler = (_req, res, next) => {
  onHeaders(res, () => {
    const directives = directivesOf(res);
    const rest = directives.filter((directive) => directive.toLowerCase() !== NO_TRANSFORM);
    if (rest.length === directives.length) return;
    if (rest.length > 0) res.setHeader("Cache-Control", rest.join(", "));
    else res.removeHeader("Cache-Control");
    hiddenNoTransform.add(res);
  });
  next();
};

const isEventStream = (res: Response): boolean =>
  String(res.getHeader("Content-Type") ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");

/** After the compressor: an event written to an event stream leaves the server now, not with the next block. */
const flushEventStreams: RequestHandler = (_req, res, next) => {
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  res.write = ((...args: unknown[]) => {
    const accepted = write(...args);
    if (isEventStream(res)) res.flush();

    return accepted;
  }) as typeof res.write;
  next();
};

/**
 * The middleware to mount before every route. Which answers are compressed is the library's
 * rule: text types (JSON, event streams, HTML) the client accepts compressed; never a PDF, a
 * PNG or a font, which are compressed already.
 */
export function compressResponses(): RequestHandler[] {
  return [restoreNoTransform, compression({ threshold: THRESHOLD_BYTES }), hideNoTransform, flushEventStreams];
}

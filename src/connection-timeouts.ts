import type { Server } from "node:http";

/**
 * How long the server keeps an idle connection open: longer than the load balancer in front of it.
 *
 * The hosted server sits behind a load balancer that reuses its connections to a task and closes one
 * after 60 seconds without traffic. Node closes an idle connection after 5 seconds by default. With
 * the shorter timeout on the server's side, the balancer regularly sends a request down a connection
 * the server is closing at that moment, gets no answer, and tells the client `502 Bad Gateway`: about
 * one or two requests an hour in production (42 between 12 and 13 Nov 2026, for Claude, Cursor, Codex
 * and API clients alike, each with a target time of a few milliseconds and no status from the task).
 * A connector reads that as a server that cannot be reached, and a session that was starting fails.
 *
 * The side that closes idle connections must be the balancer, so this timeout has to be the longer
 * one. `MCP_KEEP_ALIVE_TIMEOUT_MS` follows the balancer's setting when that changes.
 */
export const BALANCER_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = BALANCER_IDLE_TIMEOUT_MS + 5_000;

/** How far the headers timeout stays above the keep-alive timeout. */
const HEADERS_MARGIN_MS = 1_000;

/**
 * The longest delay a Node timer takes. Given a longer one, Node warns on every connection and does
 * not use the value: older releases run the timer after 1 millisecond, which would close every idle
 * connection at once (the failure this module exists to prevent), newer ones cut it to this maximum.
 */
const NODE_TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * The configured keep-alive timeout. Anything that is not a whole number of milliseconds, or that a
 * Node timer cannot hold together with the headers timeout above it, is the default.
 */
export function keepAliveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.MCP_KEEP_ALIVE_TIMEOUT_MS?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(configured)) return DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  const milliseconds = Number(configured);

  return milliseconds + HEADERS_MARGIN_MS <= NODE_TIMER_MAX_MS ? milliseconds : DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
}

/**
 * Applies the timeouts to a listening server and returns it.
 *
 * `headersTimeout` bounds how long a request's headers may take to arrive. It stays above the
 * keep-alive timeout so that it can never be what ends a connection that is merely idle.
 */
export function holdIdleConnections(server: Server, keepAliveMs: number = keepAliveTimeoutMs()): Server {
  server.keepAliveTimeout = keepAliveMs;
  server.headersTimeout = keepAliveMs + HEADERS_MARGIN_MS;

  return server;
}

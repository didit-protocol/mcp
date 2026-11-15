import type { Response } from "express";

// Public build: the page a browser gets at the server's own address is a page of Didit's hosted
// server, so it is not part of the open-source distribution. This module is intentionally inert:
// there is no page, and a browser that opens the server's address gets the protocol's answer.

export interface ConnectPageOptions {
  mcpUrl: string;
  chatgpt?: boolean;
}

/** Answers a request with the page. */
export type SendConnectPage = (res: Response) => void;

/** There is no page, and says so. */
export function connectPage(_options: ConnectPageOptions): SendConnectPage | undefined {
  return undefined;
}

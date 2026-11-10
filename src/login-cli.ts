// `didit-mcp-server login` / `logout`: the terminal front end of the device-code sign-in.
// Everything goes to stderr (stdout stays clean) and no token is ever printed.

import { MCP_AUTHORIZATION_SERVER_ORIGIN } from "./config";
import {
  DeviceLoginDeps,
  DeviceLoginError,
  credentialsFilePath,
  defaultDeps,
  logout,
  pollDeviceLogin,
  startDeviceLogin,
} from "./device-login";

export type LoginCliCommand = "login" | "logout";

export function loginCliCommand(argv: string[]): LoginCliCommand | undefined {
  const first = argv[0];
  return first === "login" || first === "logout" ? first : undefined;
}

/** Runs the command and returns the process exit code. */
export async function runLoginCli(
  command: LoginCliCommand,
  deps: DeviceLoginDeps = defaultDeps,
  out: (line: string) => void = (line) => console.error(line),
  origin: string = MCP_AUTHORIZATION_SERVER_ORIGIN,
): Promise<number> {
  try {
    if (command === "logout") {
      const { hadCredentials, revoked } = await logout(deps, origin);
      if (!hadCredentials) {
        out(`No Didit credentials are stored for ${origin}.`);
      } else if (revoked) {
        out(`Logged out. The Didit grant was revoked and the credentials in ${credentialsFilePath()} were deleted.`);
      } else {
        out(
          `Credentials in ${credentialsFilePath()} were deleted, but Didit could not be reached to revoke the grant. ` +
            "Revoke it from your Didit console if this machine is not yours.",
        );
      }
      return 0;
    }

    const pending = await startDeviceLogin(deps, origin);
    out(`To connect this machine to your Didit account, open ${pending.verification_uri} and enter the code ${pending.user_code}`);
    out(`Or open: ${pending.verification_uri_complete}`);
    out("Approve only if the code on the page matches this one.");
    out(`Waiting for approval (the code expires in ${Math.round((pending.expires_at - deps.now()) / 60000)} minutes)...`);
    const result = await pollDeviceLogin(deps, pending);
    if (result.status !== "connected") return 1;
    out(`Connected to Didit. Scopes granted: ${result.scope || "(none reported)"}`);
    out(`Credentials saved to ${result.credentialsPath} (readable by you only). Run \`didit-mcp-server logout\` to disconnect.`);
    return 0;
  } catch (err) {
    out(err instanceof DeviceLoginError ? `Login failed: ${err.message}` : `Login failed: ${(err as Error)?.message ?? "unexpected error"}`);
    return 1;
  }
}

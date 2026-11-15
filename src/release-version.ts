// Which release this process is.
//
// `package.json` says 5.1.1 on every release: a release is a git tag, and nothing writes the tag
// back into the file. So a v5.1.54 server answered "version":"5.1.1" on /healthz and in the
// MCP handshake, and the only way to tell which build was live was to probe for a feature.
//
// The deploy does name the release: the image is tagged with the git tag (v5.1.54), or with the
// build time on a branch deploy (2026.11.11.225733). A container reads its own image name from
// the ECS task metadata endpoint, a local address ECS gives every task, so the version needs
// nothing from the build or the deploy.

/** The version an image tag stands for: `v5.1.54` and `5.1.54` are 5.1.54, a build stamp is itself. */
export function versionFromImage(image: unknown): string | undefined {
  if (typeof image !== "string") return undefined;
  // `registry:5000/repo:tag` has a colon in the registry too, and a digest (`repo@sha256:...`)
  // names no version: only what follows the last `/` can carry the tag.
  const name = image.slice(image.lastIndexOf("/") + 1);
  if (name.includes("@")) return undefined;
  const tag = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : "";
  const match = /^v?(\d+(?:\.\d+){1,3})$/.exec(tag);

  return match ? match[1] : undefined;
}

/** How the task metadata is read. Every field has a default; tests pass their own. */
export interface ReleaseLookup {
  /** Reads before giving up. On 12 November 2026 production tasks that autoscaling started answered
   *  "5.1.1" while the deployed ones answered "5.1.57": one read at start is not enough. */
  attempts?: number;
  /** The wait before the second read, doubled before each read after it. */
  delayMs?: number;
  /** The longest a single wait may be; a late lookup keeps its reads minutes apart instead of hours. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Told why the release could not be named, once, when the lookup gives up on ECS. */
  onGiveUp?: (reason: string) => void;
}

// Referenced: the wait is part of the lookup a caller awaits, and an unreferenced timer would let the
// process end before the next read. A caller that runs the lookup in the background says so (`void`).
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The version of the release this process runs, or undefined when nothing names it (then the
 * caller keeps the package version).
 *
 * `MCP_SERVER_VERSION` is for a host that is not ECS and knows what it deployed. On ECS a read
 * that fails, or that names no image yet, is tried again; an image whose tag names no release is an
 * answer, not a failure. Never throws.
 */
export async function resolveReleaseVersion(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  { attempts = 5, delayMs = 1000, maxDelayMs = Infinity, sleep = wait, onGiveUp }: ReleaseLookup = {},
): Promise<string | undefined> {
  const stated = env.MCP_SERVER_VERSION?.trim();
  if (stated) return stated.replace(/^v(?=\d)/, "");
  const metadata = env.ECS_CONTAINER_METADATA_URI_V4;
  if (!metadata) return undefined;
  let reason = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(Math.min(delayMs * 2 ** (attempt - 2), maxDelayMs));
    try {
      const response = await fetchImpl(metadata, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) {
        reason = `the task metadata answered HTTP ${response.status}`;
        continue;
      }
      const image = ((await response.json()) as { Image?: unknown })?.Image;
      if (typeof image !== "string" || !image) {
        reason = "the task metadata named no image";
        continue;
      }
      const version = versionFromImage(image);
      if (!version) onGiveUp?.(`the image tag names no release (${image.slice(image.lastIndexOf("/") + 1)})`);
      return version;
    } catch (error) {
      reason = `the task metadata could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  onGiveUp?.(`${reason}, ${attempts} ${attempts === 1 ? "read" : "reads"}`);
  return undefined;
}

/**
 * The schedule behind the startup read: `/healthz` and the MCP handshake must answer immediately, so
 * the first read is one attempt with no wait, and this one runs in the background after it failed.
 *
 * It reads for MINUTES, not seconds. On 13 November 2026 production was on v5.1.58 - the deployment
 * record says so, and the reporting customer's browser read "5.1.58" from the host - while `/healthz`
 * answered "5.1.1", the package placeholder, to every sample taken hours later. Two explanations fit:
 * a task that the autoscaler starts under load cannot read its metadata endpoint during its first
 * seconds and then keeps the placeholder for life, or the read fails on that task for good. Only the
 * first is a hypothesis here, not a finding: #274 already retried for fifteen seconds before this and
 * the mixed answers persisted. Minutes of reads cost nothing and cover a slow start; they cannot help
 * a read that never succeeds. Which one it is shows in the line the lookup already writes when it
 * gives up - "Release version unknown: ...", live since the 2026-11-13T06:45Z rollout. A task that
 * logged it never named its release, and every later `/healthz` from that task is the placeholder.
 */
export const LATE_RELEASE_LOOKUP = { attempts: 40, delayMs: 1000, maxDelayMs: 15_000 } as const;

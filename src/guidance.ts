/**
 * What the server tells a model about itself: the instructions sent when a client connects,
 * and the prompts a person can start from.
 *
 * Instructions carry what is true for the whole server and would otherwise be repeated in
 * every tool description: where to start, how organization and application ids resolve, the
 * sandbox, what this connection loaded and how to reach the rest, and the confirm rule. Clients
 * truncate long instructions (some after 512 characters, most after a few thousand), so the
 * first paragraph stands on its own and the whole text stays short.
 *
 * Prompts are named starting points for the jobs people actually bring: integrating Didit,
 * working the review queue, explaining a decision. A client shows them as slash commands or
 * menu entries. A prompt names each tool the way this connection reaches it: by its own name
 * when the tool is listed, through a discovery tool when it is not. So it works whatever
 * toolsets were selected, and never tells a model to call something it cannot see.
 */
import { ALL_TOOLSETS, CORE_TOOLSET, selectionLabel, type CatalogSelection } from "./toolsets";
import { TOOL_CALL_READ, TOOL_CALL_WRITE, TOOL_SEARCH } from "./tools/discovery";
import { DOCS_SEARCH_TOOL, docsMcpUrl } from "./tools/docs";

/** How one connection reaches a tool, for the text of a prompt. */
export interface PromptContext {
  /** The tool as this connection calls it: its name, or the discovery tool that runs it. */
  use: (tool: string) => string;
  /** Whether the documentation search is available. */
  docs: boolean;
}

export interface GuidanceContext {
  /** A remote (OAuth) server, as opposed to a person's local stdio server. */
  hosted: boolean;
  /**
   * The connection authenticated with an application API key instead of a person's sign-in
   * (api-key-connection.ts): it is that one application, with the key's own access.
   */
  apiKey?: boolean;
  selection: CatalogSelection;
  /** Ids of the toolsets that hold at least one tool this connection does not list. */
  unloaded: readonly string[];
  /** Every toolset id a person may ask for on this server. */
  selectable: readonly string[];
}

function howToLoadMore(hosted: boolean): string {
  return hosted
    ? "add `?toolsets=<ids>` (comma separated, or `toolsets=all`) to the server URL"
    : "set DIDIT_TOOLSETS=<ids> (comma separated, or `all`) or pass --toolsets=<ids>";
}

function loadedParagraph({ hosted, selection, unloaded, selectable }: GuidanceContext): string {
  const mode = selection.readOnly
    ? " It is read-only: tools that change data are not available, and the person reconnects without read-only to allow changes."
    : "";
  const ignored =
    selection.unknown.length > 0
      ? ` Unknown toolsets were ignored: ${selection.unknown.join(", ")}. Valid ids: ${[CORE_TOOLSET, ...selectable, ALL_TOOLSETS].join(", ")}.`
      : "";
  if (selection.toolsets === ALL_TOOLSETS || unloaded.length === 0) {
    return `This connection loads every toolset.${mode}${ignored}`;
  }
  const run = selection.readOnly ? TOOL_CALL_READ : `${TOOL_CALL_READ} or ${TOOL_CALL_WRITE}`;

  return (
    `This connection loads these toolsets: ${selectionLabel(selection)}.${mode} More tools exist in: ${unloaded.join(", ")}. ` +
    `They are not in your tool list: find one with ${TOOL_SEARCH}, then run it with ${run}. ` +
    `To load a toolset directly, the person can ${howToLoadMore(hosted)}.${ignored}`
  );
}

/** The `instructions` of the initialize result (and of server/discover). */
export function serverInstructions(context: GuidanceContext): string {
  const signIn = context.apiKey
    ? " This connection is already authenticated with its API key: never ask for a password, an API key or a one-time code."
    : context.hosted
      ? " Sign-in is handled by OAuth: never ask the person for a password, an API key or a one-time code."
      : "";
  const docs = docsMcpUrl()
    ? `For how Didit works or how to integrate it, use ${DOCS_SEARCH_TOOL} instead of answering from memory.`
    : "";
  const PLATFORM =
    "Didit is an identity verification platform: KYC, KYB, AML screening, transaction monitoring, document and biometric checks.";
  // Who the connection is, how ids resolve and which environment it works in: a person reaches
  // every organization their role allows, a key is the one application it belongs to.
  const identity = context.apiKey
    ? [
        `${PLATFORM} This server acts as the application that owns this API key, with the key's own access and no ` +
          "person behind it. Start with didit_context_get: it names the application and its organization, and says " +
          "whether the application is sandbox or live.",
        "organization_id and application_id are never needed: every tool acts on that one application, and a call that " +
          "names another one is refused. What needs a person (members, roles, API keys, billing details, the audit log) " +
          "is not on this connection: the person does it in the Didit console.",
        "In a sandbox application checks are free and didit_session_simulate finishes a session with the outcome you " +
          "choose. In a live application every verification is real and billed.",
      ]
    : [
        `${PLATFORM} This server acts as the signed-in person, with their role's permissions. Start with ` +
          "didit_context_get: it returns the organizations and applications you can use, their ids, and whether each " +
          "application is sandbox or live.",
        "organization_id and application_id are optional on every tool: they default to the person's only organization " +
          "and application. Pass them when didit_context_get shows several.",
        "Build and test in a sandbox application: checks there are free and didit_session_simulate finishes a session " +
          "with the outcome you choose. Use a live application for real verifications only.",
      ];

  return [
    ...identity,
    loadedParagraph(context),
    "Tools that overwrite a decision, delete records or issue credentials take `confirm: true`. Send it only after " +
      `the person has agreed to that exact action in this conversation.${signIn}`,
    docs,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

interface PromptArgumentDef {
  name: string;
  description: string;
  required?: boolean;
}

interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments?: PromptArgumentDef[];
  text: (args: Record<string, string>, context: PromptContext) => string;
}

const PROMPTS: readonly PromptDef[] = [
  {
    name: "integrate_didit",
    title: "Integrate Didit",
    description: "Set up a working verification flow in a sandbox application and wire it into your code.",
    arguments: [{ name: "stack", description: "Your stack, for example Next.js, Django or React Native." }],
    text: ({ stack }, { use, docs }) =>
      [
        `Help me integrate Didit identity verification${stack ? ` into my ${stack} app` : ""}, end to end, in the sandbox first.`,
        `1. Call ${use("didit_context_get")} and pick my sandbox application. Tell me which one you are using.`,
        `2. Find a workflow with ${use("didit_workflow_search")}. If I have none, create a simple one with ${use("didit_workflow_create")}.`,
        `3. Create a session with ${use("didit_session_create")} and give me its verification link.`,
        `4. Finish it with ${use("didit_session_simulate")}, then read ${use("didit_session_get_decision")} so I see the result payload.`,
        `5. Check ${use("didit_webhook_list")}. If I have no destination, ask me for my endpoint URL and create one with ` +
          `${use("didit_webhook_create")}; then show me the delivery with ${use("didit_session_webhooks")}.`,
        `6. Look up the server-side SDK and the webhook signature check for my stack ${
          docs ? `with ${use(DOCS_SEARCH_TOOL)}` : "in the documentation at https://docs.didit.me"
        }, and write the code in my project, citing the pages you used.`,
        `7. When I need an API key for my backend, create it with ${use("didit_org_create_api_key")} after I confirm.`,
        "Stop and ask me whenever a step needs a choice only I can make.",
      ].join("\n"),
  },
  {
    name: "review_queue",
    title: "Work the review queue",
    description: "Go through the sessions waiting for a manual decision, one at a time.",
    arguments: [{ name: "limit", description: "How many sessions to go through (default 5)." }],
    text: ({ limit }, { use }) =>
      [
        `Go through my verification sessions that are waiting for review, up to ${limit || "5"} of them, oldest first.`,
        `1. Find them with ${use("didit_session_search")} (status In Review).`,
        `2. For each one, call ${use("didit_session_explain_decision")} and tell me in two or three lines why it stopped and what the evidence says.`,
        "3. Recommend approve, decline or resubmission, with the reason.",
        `4. Change nothing until I answer. When I decide, apply it with ${use("didit_session_update_status")} and confirm: true, then move to the next one.`,
      ].join("\n"),
  },
  {
    name: "explain_session",
    title: "Explain a decision",
    description: "Why one verification session was approved, declined or sent to review.",
    arguments: [{ name: "session_id", description: "The session id.", required: true }],
    text: ({ session_id }, { use }) =>
      [
        `Explain why verification session ${session_id || "<session id>"} ended the way it did.`,
        `Use ${use("didit_session_explain_decision")} for the trace and ${use("didit_session_get_decision")} for the details.`,
        "Tell me which check decided the outcome, what it saw, and what would have to be different for another result. Do not change the session.",
      ].join("\n"),
  },
  {
    name: "build_workflow",
    title: "Build a workflow",
    description: "Design and create a verification workflow for a use case.",
    arguments: [
      { name: "goal", description: "What the workflow is for, for example onboarding customers of a crypto exchange in Spain.", required: true },
    ],
    text: ({ goal }, { use }) =>
      [
        `Design a Didit verification workflow for: ${goal || "<describe the use case>"}.`,
        `1. Call ${use("didit_context_get")} and use my sandbox application unless I say otherwise.`,
        "2. Propose the steps in order, with one line on why each is there. Ask me anything that changes the design.",
        `3. Once I agree, create it with ${use("didit_workflow_create")} (an ordered list of steps). If it needs branches or ` +
          `conditions, add them with ${use("didit_workflow_edit_graph")}.`,
        `4. Create one test session with ${use("didit_session_create")} and finish it with ${use("didit_session_simulate")} to show me it runs.`,
      ].join("\n"),
  },
  {
    name: "verification_report",
    title: "Verification report",
    description: "Summarize verification volume, outcomes and what is driving declines.",
    arguments: [{ name: "days", description: "How many days back (default 7)." }],
    text: ({ days }, { use }) =>
      [
        `Give me a report of my verification activity over the last ${days || "7"} days.`,
        `Use ${use("didit_analytics")} for volume, completion and outcomes, and ${use("didit_session_search")} for examples of recent declines.`,
        "Lead with the numbers that changed, then the top reasons for declines and reviews, then anything I should act on. Keep it short.",
      ].join("\n"),
  },
];

export function listPrompts(): Record<string, unknown>[] {
  return PROMPTS.map(({ name, title, description, arguments: args }) => ({
    name,
    title,
    description,
    ...(args ? { arguments: args.map((arg) => ({ ...arg, required: arg.required === true })) } : {}),
  }));
}

/** The messages of one prompt for this connection, or undefined for a name that does not exist. */
export function getPrompt(
  name: string,
  args: Record<string, unknown> | undefined,
  context: PromptContext,
): { description: string; messages: { role: "user"; content: { type: "text"; text: string } }[] } | undefined {
  const prompt = PROMPTS.find((candidate) => candidate.name === name);
  if (!prompt) return undefined;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    // Prompt arguments are strings by protocol; anything else is ignored, never interpolated.
    if (typeof value === "string") values[key] = value.trim().slice(0, 500);
  }

  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text: prompt.text(values, context) } }],
  };
}

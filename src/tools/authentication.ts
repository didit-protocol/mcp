import { DIDIT_AUTH_BASE_URL, apiRequest, resolveApplicationId, resolveOrganizationId } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { DiditError, assertBoolean, pathSegment } from "../security";

// Didit Authentication setup, served by service-didit-auth (an internal issue's `API contract:`):
//
//   GET   organizations/{org}/applications/{app}/authentication/                 configuration + read-back
//   PUT   organizations/{org}/applications/{app}/authentication/methods/{name}/  one sign-in method
//   GET   …/authentication/settings/                                             product settings
//   PATCH …/authentication/settings/
//   GET   …/authentication/onboarding/                                           progress
//   PATCH …/authentication/onboarding/
//
// The owner-approved credentials an internal issue admits on these setup routes are an OAuth grant carrying
// `didit:management` (the MCP connection, or the device-code grant) and a NAMED application API key
// whose scopes give `authentication` the level the call needs. The primary secret, an unscoped
// "full access" key and the programmatic token keep answering 403 there, which the hint below says.
// Branding, emails, protection, hosted domain, native apps and verified are multi-route families,
// left for a follow-up (the PR says so); the configuration PATCH (redirect URIs) is too.

const METHOD_NAMES = [
  "password", "code", "passkey", "magic", "phone", "wallet", "sso", "google", "microsoft", "apple", "github",
];

const SIGN_IN_UI = ["hosted", "own"];
const WEBHOOK_EVENT_KINDS = [
  "auth.sign_in", "auth.sign_in_failed", "auth.new_device", "auth.account_locked",
  "auth.two_factor_changed", "auth.session_revoked", "auth.agent_access_approved", "auth.agent_access_revoked",
];

/** Every path segment the client controls goes through pathSegment (see security.ts). */
function setupPath(args: Record<string, any>): string {
  const org = pathSegment(resolveOrganizationId(args.organization_id), "organization_id");
  const app = pathSegment(resolveApplicationId(args.application_id), "application_id");

  return `/organizations/${org}/applications/${app}/authentication/`;
}

// ── What the backend never echoes back ──────────────────────────────────────
// A provider's client_secret and the sealed credential blob are write-only in the backend's
// serializers (MethodSerializer.credentials, Method.encrypted_credentials); dropping them here as
// well means an answer can never hand a secret back to the conversation, whatever it carries.
const SECRET_FIELDS = new Set(["client_secret", "encrypted_credentials", "private_key", "secret"]);

function withoutSecrets(value: any, secret?: string): any {
  const redact = (text: string) => secret ? text.split(secret).join("[redacted]") : text;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => withoutSecrets(item, secret));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_FIELDS.has(key))
      .map(([key, inner]) => [redact(key), withoutSecrets(inner, secret)]),
  );
}

// ── Refusals a model can act on ─────────────────────────────────────────────
// The backend answers a validation code in one field (`{"credential_source": "sandbox_only"}`),
// which parseErrorBody turns into "credential_source: sandbox_only". The codes below mean one
// thing each for this setup, so say it instead of leaving the model to retry the same call.
const SETUP_REFUSAL_HINTS: Readonly<Record<string, string>> = {
  sandbox_only:
    "credential_source didit_test uses Didit's own test provider apps, so it works only on a sandbox application. " +
    "Use the sandbox application (its mode is in didit_context_get), or send the provider's own client_id and client_secret.",
  unavailable:
    "Didit's test app for this provider is not configured in this environment. Configure the provider with its own " +
    "client_id and client_secret, or leave that method disabled.",
  not_supported:
    "That field does not apply to this method: credentials and credential_source only to google, microsoft, apple " +
    "and github, and workflow_id only to phone.",
  always_on: "The Didit ID Wallet method is always on: read it as always_on instead of trying to disable it.",
  method_unavailable: `The method name must be one of ${METHOD_NAMES.join(", ")}.`,
  owner_or_admin_required:
    "This one setting needs a person signed in as an organization owner or admin (a named API key has no membership " +
    "to be one with). Ask them to change it in the console, or set the other settings here.",
  passkey_required: "agent_humans_only needs the person to have a passkey enrolled on their account.",
  empty_update: "Send at least one field to change; an empty update is refused.",
};

const FORBIDDEN_HINT =
  "This setup needs a credential that holds write:authentication (or read:authentication to read it). An MCP sign-in " +
  "needs the didit:management scope it asks for when you connect; a named API key needs the authentication scope on " +
  "this application. The application's primary secret, the programmatic token and a full-access key with empty scopes " +
  "are refused here by design; if your role does not carry the permission, ask an owner or admin to grant it.";

/** The backend's own refusal, with the one thing this setup means added as its hint. */
function clearSetupError(error: unknown, secret?: string): unknown {
  if (!(error instanceof DiditError)) {
    return secret ? new Error("The authentication setup request failed.") : error;
  }
  const { shape } = error;
  const named = [shape.backend_code, ...(shape.message.match(/\b[a-z_]+\b/g) ?? [])]
    .find((code) => code !== undefined && Object.prototype.hasOwnProperty.call(SETUP_REFUSAL_HINTS, code));
  const hint = named ? SETUP_REFUSAL_HINTS[named] : shape.status === 403 ? FORBIDDEN_HINT : undefined;

  // Validation messages, field names and next_step can all echo submitted credentials.
  if (secret) {
    return new DiditError({
      code: shape.code,
      status: shape.status,
      message: named ?? "Authentication setup failed. Check the provider credentials and retry.",
      hint,
    });
  }
  return new DiditError({ ...shape, hint: hint ?? shape.hint });
}

async function setupRequest(args: Record<string, any>, resource: string, init: { method?: string; json?: unknown } = {}): Promise<any> {
  try {
    return withoutSecrets(await apiRequest(setupPath(args) + resource, { baseUrl: DIDIT_AUTH_BASE_URL, ...init }), args.client_secret);
  } catch (error) {
    throw clearSetupError(error, args.client_secret);
  }
}

// ── The setup steps ─────────────────────────────────────────────────────────

export async function getAuthentication(args: Record<string, any>): Promise<any> {
  return setupRequest(args, "");
}

/**
 * `PUT methods/<name>/` with MethodSerializer's fields: enabled (required), credentials
 * ({client_id, client_secret}, provider methods only), credential_source (own | didit_test) and
 * workflow_id (phone only). Built explicitly rather than forwarded so no tool argument can reach
 * the backend's strict serializer as an unknown field.
 */
export async function setAuthenticationMethod(args: Record<string, any>): Promise<any> {
  assertBoolean(args.enabled, "enabled");
  if (typeof args.enabled !== "boolean") {
    throw new DiditError({
      code: "bad_request",
      message: "enabled is required: true turns the method on, false turns it off.",
      field: "enabled",
    });
  }
  const body: Record<string, unknown> = { enabled: args.enabled };
  if (args.client_id !== undefined || args.client_secret !== undefined) {
    if (typeof args.client_id !== "string" || !args.client_id.trim() || typeof args.client_secret !== "string" || !args.client_secret) {
      throw new DiditError({
        code: "bad_request",
        message: "client_id and client_secret are both required to configure a provider's own app.",
        field: "client_id",
        hint: "Send the pair the provider issued for this application; the secret is stored and never returned.",
      });
    }
    body.credentials = { client_id: args.client_id.trim(), client_secret: args.client_secret };
  }
  if (args.credential_source !== undefined) body.credential_source = args.credential_source;
  if (args.workflow_id !== undefined) body.workflow_id = args.workflow_id;

  return setupRequest(args, `methods/${pathSegment(args.name, "name")}/`, { method: "PUT", json: body });
}

export async function getAuthenticationSettings(args: Record<string, any>): Promise<any> {
  return setupRequest(args, "settings/");
}

/** `PATCH settings/` with only the fields the caller sent (ProductSettingsSerializer). */
export async function updateAuthenticationSettings(args: Record<string, any>): Promise<any> {
  const fields = [
    "sign_in_ui", "agents_enabled", "agent_humans_only", "agent_scopes", "agent_lifetime", "agent_idle_timeout",
    "agent_approval", "organizations_enabled", "mfa_policy", "default_member_role", "webhook_events_disabled",
  ];
  const body = Object.fromEntries(fields.filter((field) => args[field] !== undefined).map((field) => [field, args[field]]));
  if (Object.keys(body).length === 0) {
    throw new DiditError({
      code: "bad_request",
      message: "Nothing to update: send at least one setting.",
      field: "settings",
      allowed: fields,
    });
  }

  return setupRequest(args, "settings/", { method: "PATCH", json: body });
}

export async function getAuthenticationOnboarding(args: Record<string, any>): Promise<any> {
  return setupRequest(args, "onboarding/");
}

/** `PATCH onboarding/` with only the fields the caller sent (OnboardingSerializer refuses an empty update). */
export async function updateAuthenticationOnboarding(args: Record<string, any>): Promise<any> {
  const fields = ["test_skipped", "import_skipped", "sign_in_ui"];
  const body = Object.fromEntries(fields.filter((field) => args[field] !== undefined).map((field) => [field, args[field]]));
  if (Object.keys(body).length === 0) {
    throw new DiditError({
      code: "bad_request",
      message: "Nothing to update: send test_skipped, import_skipped or sign_in_ui.",
      field: "onboarding",
      allowed: fields,
    });
  }

  return setupRequest(args, "onboarding/", { method: "PATCH", json: body });
}

// ── The tools (tools/registry.ts) ───────────────────────────────────────────

const APPROVAL_HINT =
  " didit_test is sandbox-only. Owners approve didit:management through hosted MCP OAuth or local " +
  "didit_account_device_login_start and didit_account_device_login_poll.";

export const AUTHENTICATION_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_authentication_get",
      description: "Read the configuration and every sign-in method’s enabled state and credential_source." + APPROVAL_HINT,
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    access: "read",
    permission: "read:authentication", // GET …/authentication/ → management.py ConfigurationView.get
    routingIds: true,
    run: (args) => getAuthentication(args),
  },
  {
    def: {
      name: "didit_authentication_method_set",
      description: "Enable or disable a sign-in method. For social methods, use own provider credentials or didit_test." + APPROVAL_HINT,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          name: {
            type: "string",
            enum: METHOD_NAMES,
            description: "The method to change. wallet is always on; phone sends one-time codes through a verification workflow.",
          },
          enabled: { type: "boolean", description: "true turns the method on, false turns it off." },
          credential_source: {
            type: "string",
            enum: ["own", "didit_test"],
            description:
              "Provider methods only. own uses the credentials sent with this call (or already stored); didit_test uses " +
              "Didit's test provider app and works only on a sandbox application.",
          },
          client_id: { type: "string", description: "The provider's OAuth client id for this application (google, microsoft, apple, github)." },
          client_secret: {
            type: "string",
            description: "The provider's OAuth client secret, sent with client_id. Stored write-only: it is never echoed back.",
          },
          workflow_id: { type: "string", description: "phone only: the verification workflow whose phone step delivers the code." },
        },
        required: ["name", "enabled"],
      },
    },
    access: "write",
    permission: "write:authentication", // PUT …/authentication/methods/{name}/ → management.py MethodView.put
    routingIds: true,
    run: (args) => setAuthenticationMethod(args),
  },
  {
    def: {
      name: "didit_authentication_settings_get",
      description: "Read sign-in, agent, organization, MFA and webhook settings." + APPROVAL_HINT,
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    access: "read",
    permission: "read:authentication", // GET …/authentication/settings/ → product_settings.py get
    routingIds: true,
    run: (args) => getAuthenticationSettings(args),
  },
  {
    def: {
      name: "didit_authentication_settings_update",
      description: "Update the supplied settings. Enabling agent_humans_only requires an owner or admin with an enrolled passkey." + APPROVAL_HINT,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          sign_in_ui: { type: "string", enum: SIGN_IN_UI, description: "hosted: Didit's sign-in page; own: your own UI calling the API." },
          agents_enabled: { type: "boolean", description: "Let end-user AI agents act on behalf of your users." },
          agent_humans_only: { type: "boolean", description: "Only people, never agents, may approve agent access. Needs an owner/admin with a passkey." },
          agent_scopes: { type: "array", items: { type: "string", enum: ["read", "act"] }, description: "What an approved end-user agent may do." },
          agent_lifetime: { type: "number", enum: [86400, 604800, 2592000], description: "How long an agent grant lives, in seconds." },
          agent_idle_timeout: { type: "number", enum: [1800, 7200, 86400], description: "Idle timeout of an agent grant, in seconds." },
          agent_approval: { type: "string", enum: ["passkey", "sign_in"], description: "How a person approves an agent: with a passkey or by signing in." },
          organizations_enabled: { type: "boolean", description: "Let your users create organizations of their own." },
          mfa_policy: { type: "string", enum: ["optional", "everyone", "organization_admins"], description: "Who must use two factors." },
          default_member_role: { type: "string", enum: ["admin", "member", "billing"], description: "Role a new member gets." },
          webhook_events_disabled: {
            type: "array",
            items: { type: "string", enum: WEBHOOK_EVENT_KINDS },
            description: "Events to stop delivering to this application's webhooks.",
          },
        },
      },
    },
    access: "write",
    permission: "write:authentication", // PATCH …/authentication/settings/ → product_settings.py patch
    routingIds: true,
    run: (args) => updateAuthenticationSettings(args),
  },
  {
    def: {
      name: "didit_authentication_onboarding_get",
      description: "Read setup progress, including the sign-in UI choice and test sign-in status." + APPROVAL_HINT,
      inputSchema: { type: "object" as const, properties: { ...ORG_APP_PROPS } },
    },
    access: "read",
    permission: "read:authentication", // GET …/authentication/onboarding/ → onboarding.py get
    routingIds: true,
    run: (args) => getAuthenticationOnboarding(args),
  },
  {
    def: {
      name: "didit_authentication_onboarding_update",
      description: "Record a skipped test sign-in, skipped user import or the selected sign-in UI." + APPROVAL_HINT,
      inputSchema: {
        type: "object" as const,
        properties: {
          ...ORG_APP_PROPS,
          test_skipped: { type: "boolean", description: "Record that the test sign-in was skipped." },
          import_skipped: { type: "boolean", description: "Record that importing existing users was skipped." },
          sign_in_ui: { type: "string", enum: SIGN_IN_UI, description: "The sign-in UI you chose; confirming it also marks the methods step done." },
        },
      },
    },
    access: "write",
    permission: "write:authentication", // PATCH …/authentication/onboarding/ → onboarding.py patch
    routingIds: true,
    run: (args) => updateAuthenticationOnboarding(args),
  },
];

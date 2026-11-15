import { apiRequest, getHeaders, orgPath, requestContext, resolveOrganizationId, MCP_AUTHORIZATION_SERVER_ORIGIN } from "../config";
import type { RegisteredTool } from "./registry";
import { ORG_APP_PROPS } from "../orgapp";
import { assertBoolean, DiditError, pathSegment } from "../security";

// Billing is ORG-level on the console (no flat /billing/balance/). The org top-up endpoint
// (GET) returns balance + auto-refill config; checkout-session (GET) creates a Stripe Checkout.

const TOP_UP_MINIMUM = 50;
// Self-serve ceiling: the API refuses a larger checkout (raised from $10,000 on 5 Nov 2026).
export const TOP_UP_MAXIMUM = 20_000;
// What a top-up link pre-fills when the caller names no amount: the smallest common preset.
const DEFAULT_TOP_UP_LINK_AMOUNT = 100;

const CONSOLE_ORIGIN = new URL(MCP_AUTHORIZATION_SERVER_ORIGIN).origin;

/**
 * Console pages where the PERSON finishes a billing action an agent cannot take for them: paying
 * a top-up, saving a card, turning on automatic top-up, changing the plan. The agent never moves
 * money; it hands over the link. `top_up_amount` opens the console's top-up dialog with the
 * amount filled in (fe-application-console `TopUpDialog`).
 */
export function billingLinks(organizationId?: string, amount?: number): Record<string, string> {
  const org = pathSegment(resolveOrganizationId(organizationId), "organization_id");
  const billing = `${CONSOLE_ORIGIN}/console/${org}/settings/billing`;
  const topUp = amount && Number.isInteger(amount) && amount > 0 ? amount : DEFAULT_TOP_UP_LINK_AMOUNT;
  return {
    top_up_url: `${billing}?top_up_amount=${topUp}`,
    automatic_top_up_url: `${billing}/payment-methods`,
    plans_url: `${billing}/plans`,
    billing_details_url: billing,
  };
}

/**
 * A signed top-up request link for the person: the console's Top up dialog opens with the amount
 * filled in and says "Requested by <agent> for <person>". Creates no payment and moves no money
 * (the backend only signs the amount), so it is allowed on every endpoint. Best effort: returns
 * null when no amount is known, no Bearer is present, or the call fails, and the caller keeps the
 * unsigned `?top_up_amount=` link.
 */
export async function signedTopUpLink(amountInDollars: unknown, organizationId?: string): Promise<string | null> {
  if (typeof amountInDollars !== "number" || !Number.isFinite(amountInDollars) || amountInDollars < TOP_UP_MINIMUM || amountInDollars > TOP_UP_MAXIMUM) {
    return null;
  }
  try {
    if (!getHeaders().Authorization) return null;
    const res = await apiRequest(orgPath("/billing/top-up-requests/", { organizationId }), {
      method: "POST",
      json: { amount_in_dollars: amountInDollars },
    });
    return typeof res?.url === "string" && res.url.startsWith("https://") ? res.url : null;
  } catch {
    return null;
  }
}

const PERSON_ACTS =
  "Didit tools never charge a card. Give the person the link: they confirm and pay in the Didit console " +
  "(or turn on automatic top-up there, so a saved card refills the balance when it runs low).";

// The monthly free credit is decided per organization, and only /credits/ knows the outcome.
// It enriches the balance, so its failure must never cost the balance itself.
// `agentTopUp` (the agent payments endpoint and stdio only) adds whether the organization's
// "Connected AI agents can top up with your saved card" switch is on, so an agent knows before it
// tries. Best effort like the credit.
export async function getBalance(
  organizationId?: string,
  options: { links?: boolean; agentTopUp?: boolean } = {},
): Promise<any> {
  // An API key connection (api-key-connection.ts): the console's organization routes only answer
  // to a person, so the balance comes from the public API's own route for a key, which already
  // carries the automatic top-up settings and the agent top-up switch.
  if (requestContext.getStore()?.apiKey) {
    const { agent_top_up: agentTopUp, ...balance } = (await apiRequest("/billing/balance/")) ?? {};
    const result = options.agentTopUp && agentTopUp ? { ...balance, agent_top_up: agentTopUp } : balance;

    return options.links ? { ...result, next_steps: { ...billingLinks(organizationId), note: PERSON_ACTS } } : result;
  }
  const [balance, credits, agentSpending] = await Promise.all([
    apiRequest(orgPath("/top-up/", { organizationId })),
    apiRequest(orgPath("/credits/", { organizationId })).catch(() => null),
    options.agentTopUp
      ? apiRequest(orgPath("/billing/agent-spending/", { organizationId })).catch(() => null)
      : Promise.resolve(null),
  ]);

  const withCredit = credits?.free_credit ? { free_credit: credits.free_credit, ...balance } : balance;
  const result =
    options.agentTopUp && typeof agentSpending?.enabled === "boolean"
      ? { ...withCredit, agent_top_up: { enabled: agentSpending.enabled } }
      : withCredit;
  if (!options.links) return result;
  return { ...result, next_steps: { ...billingLinks(organizationId), note: PERSON_ACTS } };
}

export const TOP_UP_PAYMENT_METHODS = ["checkout", "saved_card"] as const;
export type TopUpPaymentMethod = (typeof TOP_UP_PAYMENT_METHODS)[number];

export interface TopUpOptions {
  payment_method?: unknown;
  idempotency_key?: unknown;
}

function assertTopUpAmount(amountInDollars: unknown): asserts amountInDollars is number {
  if (typeof amountInDollars !== "number" || !Number.isFinite(amountInDollars)) {
    throw new DiditError({
      code: "bad_request",
      message: "amount must be a finite number (USD).",
      field: "amount",
      hint: "Pass a numeric dollar amount, e.g. amount:100.",
    });
  }
  if (amountInDollars < TOP_UP_MINIMUM) {
    throw new DiditError({ code: "unprocessable", message: `Minimum top-up is $${TOP_UP_MINIMUM}.`, field: "amount" });
  }
  if (amountInDollars > TOP_UP_MAXIMUM) {
    throw new DiditError({
      code: "unprocessable",
      message: `Top-up amount exceeds the maximum of $${TOP_UP_MAXIMUM}.`,
      field: "amount",
    });
  }
}

function resolvePaymentMethod(value: unknown): TopUpPaymentMethod {
  if (value === undefined || value === null) return "checkout";
  if (typeof value !== "string" || !(TOP_UP_PAYMENT_METHODS as readonly string[]).includes(value)) {
    throw new DiditError({
      code: "bad_request",
      message: "payment_method must be checkout or saved_card.",
      field: "payment_method",
      allowed: [...TOP_UP_PAYMENT_METHODS],
    });
  }
  return value as TopUpPaymentMethod;
}

function assertIdempotencyKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || !value.trim()) {
    throw new DiditError({
      code: "bad_request",
      message: "idempotency_key is required for payment_method saved_card: a string of 1 to 255 characters.",
      field: "idempotency_key",
      hint:
        "Choose ONE unique key per intended top-up (for example a UUID) and reuse the same key on any retry of " +
        "that same top-up, so a retry can never charge the card twice.",
    });
  }
}

export async function topUp(
  amountInDollars: unknown,
  confirm?: unknown,
  organizationId?: string,
  options: TopUpOptions = {},
): Promise<any> {
  assertTopUpAmount(amountInDollars);
  const paymentMethod = resolvePaymentMethod(options.payment_method);
  if (paymentMethod === "saved_card") assertIdempotencyKey(options.idempotency_key);
  assertBoolean(confirm, "confirm");
  if (confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: `Top-up of $${amountInDollars} moves money and is not confirmed.`,
      field: "confirm",
      hint:
        paymentMethod === "saved_card"
          ? "Re-call with confirm:true once a human has approved. saved_card charges the organization's saved card now."
          : "Re-call with confirm:true once a human has approved. This returns a checkout URL; it never auto-charges.",
    });
  }
  if (paymentMethod === "saved_card") return topUpWithSavedCard(amountInDollars, options.idempotency_key as string, organizationId);

  // An API key connection pays through the public API's top-up route (the same Checkout page).
  if (requestContext.getStore()?.apiKey) {
    const checkout = await apiRequest("/billing/top-up/", { method: "POST", json: { amount_in_dollars: amountInDollars } });

    return {
      ...checkout,
      requires_human_approval: true,
      next_steps: {
        checkout: "Give the person checkout_session_url; the balance updates within seconds of payment.",
        console_top_up_url: billingLinks(organizationId, Math.round(amountInDollars)).top_up_url,
      },
    };
  }

  // The console's Checkout route (GET with the amount). The organization's top-up route answers
  // GET/PUT only, so the POST this tool used to send was refused with 405 on every call.
  const res = await apiRequest(orgPath("/checkout-session/", { organizationId }), {
    params: { amount_in_dollars: amountInDollars },
  });
  const signedLink = await signedTopUpLink(amountInDollars, organizationId);
  return {
    ...res,
    requires_human_approval: true,
    next_steps: {
      checkout: "Give the person checkout_session_url; the balance updates within seconds of payment.",
      console_top_up_url: signedLink ?? billingLinks(organizationId, Math.round(amountInDollars)).top_up_url,
    },
  };
}

/**
 * Charge the organization's saved primary card now, when a person turned on "Connected AI agents can top up with your saved card" in the console (off by default),
 * through the console's agent route (the caller's Bearer: an MCP connection, or the local server's
 * own login). One POST, never retried here: the Idempotency-Key makes a retry by the caller safe
 * (same key, same amount returns the same top-up), and a new key would be a second charge. The
 * backend body is the result; a refusal keeps its code, detail and next_step.
 */
async function topUpWithSavedCard(amountInDollars: number, idempotencyKey: string, organizationId?: string): Promise<any> {
  try {
    // An API key charges the saved card through the public API's top-up route; a person's
    // connection through the console's agent route. Same switch, same answers, same codes.
    if (requestContext.getStore()?.apiKey) {
      return await apiRequest("/billing/top-up/", {
        method: "POST",
        json: { amount_in_dollars: amountInDollars, payment_method: "saved_card" },
        headers: { ...getHeaders(), "Idempotency-Key": idempotencyKey },
      });
    }

    return await apiRequest(orgPath("/billing/agent-top-ups/", { organizationId }), {
      method: "POST",
      json: { amount_in_dollars: amountInDollars },
      headers: { ...getHeaders(), "Idempotency-Key": idempotencyKey },
    });
  } catch (error) {
    // The backend's own code (agent_top_up_not_enabled, authentication_required, ...) replaces the
    // generic status code so the model can act on it; its next_step rides along unchanged.
    if (error instanceof DiditError && error.shape.backend_code) {
      // The generic per-status hint ("may require a different role") would mislead: next_step says what to do.
      throw new DiditError({ ...error.shape, code: error.shape.backend_code, hint: undefined });
    }
    throw error;
  }
}

// ── Plans and billing details (read, quote, and the details printed on invoices) ──────────────

export async function getPlan(organizationId?: string): Promise<any> {
  const plan = await apiRequest(orgPath("/billing/plans/", { organizationId }));
  return { ...plan, next_steps: { plans_url: billingLinks(organizationId).plans_url } };
}

const PLANS = ["free", "growth", "scale"] as const;
const INTERVALS = ["monthly", "yearly"] as const;

export async function quotePlan(plan: unknown, billingInterval?: unknown, organizationId?: string): Promise<any> {
  if (typeof plan !== "string" || !(PLANS as readonly string[]).includes(plan)) {
    throw new DiditError({
      code: "bad_request",
      message: "plan must be one of free, growth, scale.",
      field: "plan",
      allowed: [...PLANS],
      hint: "Enterprise is an annual contract: the person contacts Didit sales from the Plans page.",
    });
  }
  if (billingInterval !== undefined && !(INTERVALS as readonly unknown[]).includes(billingInterval)) {
    throw new DiditError({
      code: "bad_request",
      message: "billing_interval must be monthly or yearly.",
      field: "billing_interval",
      allowed: [...INTERVALS],
    });
  }
  const quote = await apiRequest(orgPath("/billing/plans/quote/", { organizationId }), {
    params: { plan, billing_interval: billingInterval },
  });
  const interval = billingInterval === "yearly" ? "?billing=yearly" : "";
  return {
    ...quote,
    next_steps: {
      plans_url: `${billingLinks(organizationId).plans_url}${interval}`,
      note:
        "A plan change charges the saved card, so the person confirms it on the Plans page (Didit tools never " +
        "buy a plan). Show them amount_due and credit_added from this quote first.",
    },
  };
}

export async function listPaymentMethods(organizationId?: string): Promise<any> {
  const methods = await apiRequest(orgPath("/billing/payment-methods/", { organizationId }));
  return {
    ...methods,
    next_steps: {
      add_card_url: billingLinks(organizationId).automatic_top_up_url,
      note: "Cards are added and removed by the person in the console; the card number never reaches an agent.",
    },
  };
}

export async function listReceipts(organizationId?: string, limit?: number, offset?: number): Promise<any> {
  return apiRequest(orgPath("/billing/receipts/", { organizationId }), { params: { limit, offset } });
}

export async function getBillingDetails(organizationId?: string): Promise<any> {
  return apiRequest(orgPath("/billing/details/", { organizationId }));
}

// The fields the console's Billing details dialog saves. A PUT replaces every one of them, so an
// update reads the saved details first and changes only what the caller passed.
const DETAIL_FIELDS = ["legal_name", "tax_id_type", "tax_id", "address", "billing_emails", "po_number"] as const;
const ADDRESS_FIELDS = ["line1", "line2", "city", "state", "postal_code", "country"] as const;

export async function updateBillingDetails(changes: Record<string, unknown>, organizationId?: string): Promise<any> {
  const unknownKeys = Object.keys(changes).filter((key) => !(DETAIL_FIELDS as readonly string[]).includes(key));
  if (unknownKeys.length) {
    throw new DiditError({
      code: "bad_request",
      message: `Unknown billing detail(s): ${unknownKeys.join(", ")}.`,
      allowed: [...DETAIL_FIELDS],
    });
  }
  if (!Object.keys(changes).length) {
    throw new DiditError({ code: "bad_request", message: "Pass at least one billing detail to change.", allowed: [...DETAIL_FIELDS] });
  }
  const saved = await getBillingDetails(organizationId);
  const savedAddress = (saved?.address ?? {}) as Record<string, unknown>;
  const changedAddress = (changes.address ?? {}) as Record<string, unknown>;
  const body: Record<string, unknown> = {
    legal_name: saved?.legal_name ?? "",
    tax_id_type: saved?.tax_id_type ?? "",
    tax_id: saved?.tax_id ?? "",
    billing_emails: saved?.billing_emails ?? [],
    po_number: saved?.po_number ?? "",
    ...changes,
    address: Object.fromEntries(
      ADDRESS_FIELDS.map((field) => [field, changedAddress[field] ?? savedAddress[field] ?? ""]),
    ),
  };
  try {
    return await apiRequest(orgPath("/billing/details/", { organizationId }), { method: "PUT", json: body });
  } catch (error) {
    // The organization asks members to confirm sensitive billing changes with their authenticator,
    // which an agent must never collect: the person saves the change in the console instead.
    if (error instanceof DiditError && /otp|two-factor|authenticator|confirm/i.test(error.shape.message ?? "")) {
      throw new DiditError({
        ...error.shape,
        hint: `This organization confirms billing changes with an authenticator code. Ask the person to save them at ${billingLinks(organizationId).billing_details_url}.`,
      });
    }
    throw error;
  }
}

// ── The billing tools (tools/registry.ts) ──────────────────────────────────
// Each tool declares here what index.ts and permissions.ts used to keep in their name-keyed tables.
// The definitions are listed where these tools always were, so the tool list does not change.
export const BILLING_TOOLS: readonly RegisteredTool[] = [
  {
    def: {
      name: "didit_billing_get_plan",
      description:
        "Get the organization's plan: the plan and its status, monthly fee and credit, the next charge, the last " +
        "payment, any unpaid invoice and any scheduled plan change. `next_steps.plans_url` is the console page where " +
        "the person changes the plan.",
      inputSchema: { type: "object" as const, properties: { organization_id: ORG_APP_PROPS.organization_id } },
    },
    // Billing is the organization's: its path is built from the organization the caller sent.
    access: "read",
    permission: "read:subscription", // GET /organization/{org}/billing/plans/ → billing/views.py PlanBillingView
    routingIds: true,
    run: (args) => getPlan(args.organization_id),
  },
  {
    def: {
      name: "didit_billing_quote_plan",
      description:
        "Quote a plan change without making it: what it charges today (`amount_due`), the credit it adds " +
        "(`credit_added`) and the billing period. Plans: free, growth ($99/month, $115 of credit a month, 4% off every " +
        "price), scale ($299/month, $350 of credit a month, 10% off); yearly billing is cheaper. Show the person the " +
        "quote; they confirm and pay on `next_steps.plans_url` (Didit tools never buy a plan).",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: ORG_APP_PROPS.organization_id,
          plan: { type: "string", enum: ["free", "growth", "scale"], description: "The plan to quote." },
          billing_interval: { type: "string", enum: ["monthly", "yearly"], description: "Defaults to monthly." },
        },
        required: ["plan"],
      },
    },
    // Quotes a plan change (a GET): nothing is bought, the person confirms in the console.
    access: "read",
    permission: "read:subscription", // GET …/billing/plans/quote/ → PlanQuoteView
    routingIds: true,
    run: (args) => quotePlan(args.plan, args.billing_interval, args.organization_id),
  },
  {
    def: {
      name: "didit_billing_list_payment_methods",
      description:
        "List the organization's saved cards (brand, last 4 digits, expiry) in the order automatic charges try them, " +
        "card 1 being the primary. An empty list means no card is saved: top-ups then go through Checkout or the " +
        "console. `next_steps.add_card_url` is where the person adds a card or turns on automatic top-up.",
      inputSchema: { type: "object" as const, properties: { organization_id: ORG_APP_PROPS.organization_id } },
    },
    access: "read",
    permission: "read:subscription", // GET …/billing/payment-methods/ → PaymentMethodsView
    routingIds: true,
    run: (args) => listPaymentMethods(args.organization_id),
  },
  {
    def: {
      name: "didit_billing_list_receipts",
      description: "List the organization's payment receipts (top-ups and plan charges), newest first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: ORG_APP_PROPS.organization_id,
          limit: { type: "number", description: "Page size (default set by the server)." },
          offset: { type: "number", description: "Rows to skip." },
        },
      },
    },
    access: "read",
    permission: "read:subscription", // GET …/billing/receipts/ → ReceiptsView
    routingIds: true,
    run: (args) => listReceipts(args.organization_id, args.limit, args.offset),
  },
  {
    def: {
      name: "didit_billing_get_details",
      description:
        "Get the billing details printed on every receipt and invoice: legal name, tax ID, address, billing emails " +
        "and PO number.",
      inputSchema: { type: "object" as const, properties: { organization_id: ORG_APP_PROPS.organization_id } },
    },
    access: "read",
    permission: "read:subscription", // GET …/billing/details/ → BillingDetailsView
    routingIds: true,
    run: (args) => getBillingDetails(args.organization_id),
  },
  {
    def: {
      name: "didit_billing_update_details",
      description:
        "Change the billing details printed on receipts and invoices. Pass only the fields to change; the rest " +
        "keep their saved values. Before calling, show the person each change and get their confirmation. When " +
        "the organization confirms billing changes with an authenticator code, the change is refused and the " +
        "person saves it in the console instead (the error names the page).",
      inputSchema: {
        type: "object" as const,
        properties: {
          organization_id: ORG_APP_PROPS.organization_id,
          legal_name: { type: "string", description: "The company's legal name." },
          tax_id_type: { type: "string", description: "Stripe tax ID type, e.g. eu_vat, gb_vat, us_ein. Needs tax_id." },
          tax_id: { type: "string", description: "The tax ID number. Needs tax_id_type." },
          address: {
            type: "object",
            description: "Billing address; only the lines passed change.",
            properties: {
              line1: { type: "string" },
              line2: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              postal_code: { type: "string" },
              country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. ES, US." },
            },
            additionalProperties: false,
          },
          billing_emails: { type: "array", items: { type: "string" }, description: "Addresses that receive receipts and invoices (replaces the list)." },
          po_number: { type: "string", description: "Purchase order number printed on invoices." },
        },
      },
    },
    // The routing ids route the call; they are not billing details.
    access: "write",
    permission: "write:subscription", // PUT …/billing/details/ → BillingDetailsView (+ step-up)
    run: ({ organization_id: _org, application_id: _app, ...changes }) => updateBillingDetails(changes),
  },
];

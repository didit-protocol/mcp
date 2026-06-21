import { apiRequest, orgPath } from "../config";
import { assertBoolean, DiditError } from "../security";

// Billing is ORG-level on the console (no flat /billing/balance/). The org top-up endpoint
// (GET) returns balance + auto-refill config; POST initiates a top-up checkout.

const TOP_UP_MINIMUM = 50;
const TOP_UP_MAXIMUM = 1_000_000;

export async function getBalance(): Promise<any> {
  return apiRequest(orgPath("/top-up/"));
}

export async function topUp(
  amountInDollars: unknown,
  confirm?: unknown,
  successUrl?: string,
  cancelUrl?: string,
): Promise<any> {
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
  assertBoolean(confirm, "confirm");
  if (confirm !== true) {
    throw new DiditError({
      code: "unsafe_operation",
      message: `Top-up of $${amountInDollars} moves money and is not confirmed.`,
      field: "confirm",
      hint: "Re-call with confirm:true once a human has approved. This returns a checkout URL; it never auto-charges.",
    });
  }
  const res = await apiRequest(orgPath("/top-up/"), {
    method: "POST",
    json: { amount_in_dollars: amountInDollars, success_url: successUrl, cancel_url: cancelUrl },
  });
  return { ...res, requires_human_approval: true };
}

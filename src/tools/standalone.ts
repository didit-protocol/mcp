import { apiRequest, buildFormData, orgAppPath } from "../config";
import { applicationApiKeyHeaders } from "../app-api-key";
import { assertSafeWebhookUrl, requireFileSource } from "../security";
import type { FileSource } from "../security";

// Standalone verification APIs via the console's user-Bearer proxy:
// /organization/{org}/application/{app}/apis/<check>/  (mirrors the console "manual checks"
// feature). This lets these run with the user's OAuth Bearer + role permissions — no
// app api-key. org/app resolve from the tool args via the request context (orgAppPath).
// The phone OTP pair is the one exception: see the note above phoneSend.
//
// Every image input is a FileSource: a local absolute *_path (stdio/local runs) or
// inline *_base64 content (hosted runs — e.g. Didit Copilot chat attachments).

export async function idVerification(
  frontImage: FileSource,
  backImage: FileSource | undefined,
  options: Record<string, any> = {},
): Promise<any> {
  const form = buildFormData(
    { front_image: requireFileSource(frontImage, "front_image"), back_image: backImage },
    options,
  );
  return apiRequest(orgAppPath("/apis/id-verification/"), { method: "POST", form });
}

export async function poaVerification(
  documentImage: FileSource,
  options: Record<string, any> = {},
): Promise<any> {
  const form = buildFormData({ document: requireFileSource(documentImage, "document_image") }, options);
  return apiRequest(orgAppPath("/apis/poa/"), { method: "POST", form });
}

/**
 * `POST /bank/account-check/` is a public product API: only an application x-api-key is accepted, and the
 * console proxy has no route for it, so it reads the key like the phone OTP pair (see app-api-key.ts).
 */
export async function accountCheck(data: Record<string, any>): Promise<any> {
  return apiRequest("/bank/account-check/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

export async function databaseValidation(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/database-validation/"), { method: "POST", json: data });
}

export async function passiveLiveness(image: FileSource, options: Record<string, any> = {}): Promise<any> {
  const form = buildFormData({ user_image: requireFileSource(image, "image") }, options);
  return apiRequest(orgAppPath("/apis/passive-liveness/"), { method: "POST", form });
}

export async function faceMatch(
  image1: FileSource,
  image2: FileSource,
  options: Record<string, any> = {},
): Promise<any> {
  const form = buildFormData(
    {
      user_image: requireFileSource(image1, "image_1"),
      ref_image: requireFileSource(image2, "image_2"),
    },
    options,
  );
  return apiRequest(orgAppPath("/apis/face-match/"), { method: "POST", form });
}

export async function faceSearch(image: FileSource, options: Record<string, any> = {}): Promise<any> {
  const form = buildFormData({ user_image: requireFileSource(image, "image") }, options);
  return apiRequest(orgAppPath("/apis/face-search/"), { method: "POST", form });
}

export async function ageEstimation(image: FileSource, options: Record<string, any> = {}): Promise<any> {
  const form = buildFormData({ user_image: requireFileSource(image, "image") }, options);
  return apiRequest(orgAppPath("/apis/age-estimation/"), { method: "POST", form });
}

export async function amlScreening(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/aml/"), { method: "POST", json: data });
}

export async function kybSearch(data: Record<string, any>): Promise<any> {
  const json = { ...data };
  // The backend calls webhook_url when a registry result resolves — SSRF-guard it.
  if (typeof json.webhook_url === "string") json.webhook_url = assertSafeWebhookUrl(json.webhook_url, "webhook_url");
  return apiRequest(orgAppPath("/apis/kyb/search/"), { method: "POST", json });
}

export async function kybSelect(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/kyb/select/"), { method: "POST", json: data });
}

export async function emailSend(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/email/send/"), { method: "POST", json: data });
}

export async function emailCheck(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/email/check/"), { method: "POST", json: data });
}

// Phone OTP is the exception to the proxy rule above: the console registers no
// …/apis/phone/send/ or …/apis/phone/check/ proxy (both 404), so these two call the
// public product APIs directly - {DIDIT_API_BASE_URL}/phone/send/ and /phone/check/
// (service-didit-verification apis/urls.py:24-25, mounted under the /v2/ and /v3/
// API-key prefixes by core/urls.py:127,178). Those views accept an application
// x-api-key and refuse a user Bearer; app-api-key.ts resolves the key and explains why.
export async function phoneSend(data: Record<string, any>): Promise<any> {
  return apiRequest("/phone/send/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

export async function phoneCheck(data: Record<string, any>): Promise<any> {
  return apiRequest("/phone/check/", { method: "POST", json: data, headers: await applicationApiKeyHeaders() });
}

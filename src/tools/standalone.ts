import { apiRequest, buildFormData, orgAppPath } from "../config";
import { assertSafeWebhookUrl } from "../security";

// Standalone verification APIs via the console's user-Bearer proxy:
// /organization/{org}/application/{app}/apis/<check>/  (mirrors the console "manual checks"
// feature). This lets these run with the user's OAuth Bearer + role permissions — no
// app api-key. org/app resolve from the tool args via the request context (orgAppPath).

export async function idVerification(
  frontImagePath: string,
  backImagePath?: string,
  options: Record<string, any> = {},
): Promise<any> {
  const form = buildFormData({ front_image: frontImagePath, back_image: backImagePath }, options);
  return apiRequest(orgAppPath("/apis/id-verification/"), { method: "POST", form });
}

export async function poaVerification(
  documentImagePath: string,
  options: Record<string, any> = {},
): Promise<any> {
  const form = buildFormData({ document: documentImagePath }, options);
  return apiRequest(orgAppPath("/apis/poa/"), { method: "POST", form });
}

export async function databaseValidation(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/database-validation/"), { method: "POST", json: data });
}

export async function passiveLiveness(imagePath: string, options: Record<string, any> = {}): Promise<any> {
  const form = buildFormData({ user_image: imagePath }, options);
  return apiRequest(orgAppPath("/apis/passive-liveness/"), { method: "POST", form });
}

export async function faceMatch(
  image1Path: string,
  image2Path: string,
  options: Record<string, any> = {},
): Promise<any> {
  const form = buildFormData({ user_image: image1Path, ref_image: image2Path }, options);
  return apiRequest(orgAppPath("/apis/face-match/"), { method: "POST", form });
}

export async function faceSearch(imagePath: string, options: Record<string, any> = {}): Promise<any> {
  const form = buildFormData({ user_image: imagePath }, options);
  return apiRequest(orgAppPath("/apis/face-search/"), { method: "POST", form });
}

export async function ageEstimation(imagePath: string, options: Record<string, any> = {}): Promise<any> {
  const form = buildFormData({ user_image: imagePath }, options);
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

export async function phoneSend(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/phone/send/"), { method: "POST", json: data });
}

export async function phoneCheck(data: Record<string, any>): Promise<any> {
  return apiRequest(orgAppPath("/apis/phone/check/"), { method: "POST", json: data });
}

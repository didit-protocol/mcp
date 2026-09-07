import { apiRequest, buildFormData, orgAppPath } from "../config";

// White-label branding — the console resource is `white-label-customization`, org/app-scoped.

export async function getCustomization(): Promise<any> {
  return apiRequest(orgAppPath("/white-label-customization/"));
}

/**
 * Update branding images. Accepts the tool's *_path (local/stdio) or *_base64
 * (hosted) inputs and maps them to the API's multipart field names. Throws if
 * no image was supplied so the caller gets a clear local error instead of an
 * empty PATCH.
 */
export async function updateCustomization(inputs: {
  image_square_path?: string;
  image_rectangular_path?: string;
  image_favicon_path?: string;
  image_square_base64?: string;
  image_rectangular_base64?: string;
  image_favicon_base64?: string;
}): Promise<any> {
  const files = {
    image_square: { path: inputs.image_square_path, base64: inputs.image_square_base64 },
    image_rectangular: { path: inputs.image_rectangular_path, base64: inputs.image_rectangular_base64 },
    image_favicon: { path: inputs.image_favicon_path, base64: inputs.image_favicon_base64 },
  };
  const provided = Object.values(files).some((f) => f.path || f.base64);
  if (!provided) {
    throw new Error(
      "updateCustomization requires at least one image (square, rectangular, or favicon) as *_path or *_base64.",
    );
  }
  return apiRequest(orgAppPath("/white-label-customization/"), { method: "PATCH", form: buildFormData(files) });
}

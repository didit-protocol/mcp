import { apiRequest, buildFormData, orgAppPath } from "../config";

// White-label branding — the console resource is `white-label-customization`, org/app-scoped.

export async function getCustomization(): Promise<any> {
  return apiRequest(orgAppPath("/white-label-customization/"));
}

/**
 * Update branding images. Accepts the tool's *_path inputs and maps them to the
 * API's multipart field names. Throws if no image was supplied so the caller gets
 * a clear local error instead of an empty PATCH.
 */
export async function updateCustomization(paths: {
  image_square_path?: string;
  image_rectangular_path?: string;
  image_favicon_path?: string;
}): Promise<any> {
  const files = {
    image_square: paths.image_square_path,
    image_rectangular: paths.image_rectangular_path,
    image_favicon: paths.image_favicon_path,
  };
  if (!files.image_square && !files.image_rectangular && !files.image_favicon) {
    throw new Error("updateCustomization requires at least one image path (square, rectangular, or favicon).");
  }
  return apiRequest(orgAppPath("/white-label-customization/"), { method: "PATCH", form: buildFormData(files) });
}

/** Raster images a browser draws without running anything; SVG is not one of them (it can carry script). */
export const INLINE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/**
 * The only types served inline from the Human UI's origin. Any other type downloads as
 * application/octet-stream, so an HTML or SVG attachment never runs with the Human's powers.
 */
export const INLINE_MIMES = [...INLINE_IMAGE_MIMES, "application/pdf", "text/plain"] as const;

const BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar": "application/x-tar",
  ".heic": "image/heic",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** A bare `type/subtype`, lowercase and without parameters: the only form stored and echoed in headers. */
export function isValidMime(mime: string): boolean {
  return MIME.test(mime);
}

export function isInlineMime(mime: string): boolean {
  return (INLINE_MIMES as readonly string[]).includes(mime);
}

export function isInlineImageMime(mime: string): boolean {
  return (INLINE_IMAGE_MIMES as readonly string[]).includes(mime);
}

export function guessMime(name: string): string {
  const ext = name.includes(".") ? `.${name.split(".").pop()?.toLowerCase()}` : "";
  return BY_EXT[ext] ?? "application/octet-stream";
}

/** The sender's declared type when it is a real one, else a guess from the name; any type is accepted. */
export function resolveUploadMime(mime: string | undefined | null, name: string): string {
  const essence = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (isValidMime(essence) && essence !== "application/octet-stream") return essence;
  return guessMime(name || "paste.png");
}

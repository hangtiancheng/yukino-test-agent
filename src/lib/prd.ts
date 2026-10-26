/**
 * Shared PRD (product requirements document) upload helpers.
 *
 * The client-side checks mirror the server guard in
 * `src/server/services/projects.ts` (`parsePrdText`), so an invalid file is
 * rejected immediately in the UI instead of after a round-trip.
 */

/** Extensions accepted for PRD uploads (parity with the server parser). */
export const ALLOWED_PRD_EXTS = [".md", ".markdown", ".txt", ".pdf", ".docx"];

/** Upload ceiling in megabytes; the server enforces the same 20 MB limit. */
export const MAX_PRD_MB = 20;

/** Value for a file input's `accept` attribute. */
export const PRD_ACCEPT = ALLOWED_PRD_EXTS.join(",");

/**
 * Validate a PRD file before upload.
 * @returns a human-readable error message, or `null` when the file is allowed.
 */
export function validatePrdFile(file: File): string | null {
  const lower = file.name.toLowerCase();
  if (!ALLOWED_PRD_EXTS.some((ext) => lower.endsWith(ext))) {
    return "Only .md, .txt, .pdf or .docx files are supported";
  }
  if (file.size > MAX_PRD_MB * 1024 * 1024) {
    return `File must be smaller than ${MAX_PRD_MB} MB`;
  }
  return null;
}

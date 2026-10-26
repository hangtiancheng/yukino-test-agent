/**
 * Helpers for exposing execution evidence (screenshots, videos) to the
 * browser. Evidence is stored on disk under OUTPUT_DIR with absolute paths
 * in the database; the file route serves it back by relative path.
 */
import path from "node:path";

import { serverEnv } from "#/server/env";

/**
 * Convert an absolute on-disk evidence path to a `/api/files/...` URL.
 * Returns null when the path is empty or escapes OUTPUT_DIR.
 */
export function toFileUrl(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const rel = path.relative(serverEnv.outputDir, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const encoded = rel
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/files/${encoded}`;
}

/**
 * Resolve a request path (relative to OUTPUT_DIR) to a safe absolute path.
 * Returns null when the resolved path escapes OUTPUT_DIR.
 */
export function resolveOutputPath(relativePath: string): string | null {
  const decoded = relativePath
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join(path.sep);
  const abs = path.resolve(serverEnv.outputDir, decoded);
  const root = path.resolve(serverEnv.outputDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

export function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".webm":
      return "video/webm";
    case ".mp4":
      return "video/mp4";
    case ".html":
      return "text/html; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

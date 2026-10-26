/**
 * Server-side configuration read from process.env (populated by dotenv-cli
 * from .env.local in dev, or by the platform in production).
 */
import path from "node:path";

const resolvedRoot = process.cwd();

/** Parse LLM_EXTRA_BODY JSON; invalid or non-object values are ignored. */
function parseLlmExtraBody(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const {
        model: _m,
        messages: _g,
        ...rest
      } = parsed as Record<string, unknown>;
      return rest;
    }
  } catch {
    // Ignore malformed JSON rather than crashing boot.
  }
  return {};
}

export const serverEnv = {
  /** Directory for execution evidence: screenshots, videos, reports. */
  outputDir: path.resolve(resolvedRoot, process.env.OUTPUT_DIR || "./outputs"),
  /** Default URL of the system under test (bundled demo site). */
  targetUrlDefault: process.env.TARGET_URL_DEFAULT || "http://127.0.0.1:8200",
  llm: {
    apiKey: process.env.LLM_API_KEY || "",
    baseUrl: process.env.LLM_BASE_URL || "",
    model: process.env.LLM_MODEL || "",
  },
  llmVision: {
    apiKey: process.env.LLM_VISION_API_KEY || "",
    baseUrl: process.env.LLM_VISION_BASE_URL || "",
    model: process.env.LLM_VISION_MODEL || "",
  },
  /**
   * Extra JSON fields merged into every LLM chat request body, e.g.
   * provider-specific switches such as `{"enable_thinking": false}` for
   * hybrid-reasoning models. `model` and `messages` are always ignored.
   */
  llmExtraBody: parseLlmExtraBody(process.env.LLM_EXTRA_BODY),
};

export function appRoot(): string {
  return resolvedRoot;
}

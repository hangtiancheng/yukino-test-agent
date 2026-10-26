/**
 * OpenAI-compatible LLM client with graceful degradation.
 *
 * Handles the response shapes seen across providers/models:
 * - `content` may be a string, an array of parts, or an object;
 * - reasoning models may put the final answer in `content` or only in
 *   `reasoning_content` (and friends);
 * - reasoning models can burn the whole max_tokens budget on hidden
 *   reasoning and finish with finish_reason=length;
 * - GLM-5.2/5.3 cannot disable thinking but accept reasoning_effort=low,
 *   which the client adds automatically;
 * - providers that reject unknown extension parameters (400/422) get an
 *   automatic retry with the parameters stripped.
 *
 * Any unrecoverable failure (missing key, timeout, 429, no final answer,
 * invalid JSON) throws `LlmUnavailableError`; callers decide whether to
 * degrade to deterministic rule mode.
 */

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export interface ChatMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatMessageContentPart[];
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

const REASONING_KEYS = [
  "reasoning_content",
  "reasoning",
  "thinking",
  "analysis",
] as const;

/** Business wrapper keys used to prefer real answers over example JSON. */
const JSON_KEYS_HINT = new Set([
  "testCases",
  "cases",
  "points",
  "testPoints",
  "patch",
  "verdict",
  "review_status",
]);

/** Normalise OpenAI-compatible `content` (string / part array / object). */
function contentToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      let text = "";
      if (typeof item === "string") {
        text = item;
      } else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        text = String(record.text ?? record.content ?? record.summary ?? "");
      }
      text = text.trim();
      if (text) parts.push(text);
    }
    return parts.join("\n").trim();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = record.text ?? record.content ?? "";
    if (typeof text === "string" || typeof text === "number") {
      return String(text).trim();
    }
    return "";
  }
  return String(value).trim();
}

/**
 * Extract balanced JSON fragments from text that mixes prose and JSON,
 * avoiding the greedy regex that spans multiple objects.
 */
function balancedJsonCandidates(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] !== "{" && text[i] !== "[") {
      i += 1;
      continue;
    }
    const start = i;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let j = i;
    let closed = false;
    while (j < n) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        stack.push(ch);
      } else if (ch === "}" || ch === "]") {
        if (stack.length > 0) {
          stack.pop();
          if (stack.length === 0) {
            out.push(text.slice(start, j + 1));
            i = j;
            closed = true;
            break;
          }
        }
      }
      j += 1;
    }
    if (!closed) {
      // Leave unclosed fragments to the truncation repair logic.
      i = start + 1;
      continue;
    }
    i += 1;
    if (out.length >= 50) break;
  }
  return out;
}

function loadsWithRepair(text: string): unknown | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to repairs
  }

  // Repair 1: trailing commas
  const fixed = trimmed.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(fixed);
  } catch {
    // fall through
  }

  // Repair 2: array truncated by max_tokens — close at the last complete
  // object.
  if (fixed.trimStart().startsWith("[")) {
    const idx = fixed.lastIndexOf("}");
    if (idx > 0) {
      try {
        return JSON.parse(`${fixed.slice(0, idx + 1)}]`);
      } catch {
        // fall through
      }
    }
  }

  // Repair 3: object truncated at the end — cut back to the last complete
  // field and close the object.
  if (fixed.trimStart().startsWith("{")) {
    const idx = fixed.lastIndexOf("}");
    if (idx > 0) {
      try {
        return JSON.parse(fixed.slice(0, idx + 1));
      } catch {
        // fall through
      }
    }
  }
  return null;
}

/**
 * Parse an LLM reply as JSON, tolerating markdown fences, surrounding
 * prose, trailing commas, truncation, and multiple JSON fragments inside
 * reasoning output. Returns null when nothing parseable exists.
 */
export function tryParseLlmJson(content: string): unknown | null {
  if (!content) return null;
  const text = content.trim();
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  // Keep the legacy greedy extraction; balanced extraction covers reasoning
  // output that embeds several JSON fragments.
  const greedy = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (greedy) candidates.push(greedy[0]);
  candidates.push(...balancedJsonCandidates(text));

  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    const obj = loadsWithRepair(candidate);
    if (obj !== null) parsed.push(obj);
  }
  if (parsed.length === 0) return null;

  const score = (item: unknown): number => {
    let size = 0;
    try {
      size = JSON.stringify(item)?.length ?? 0;
    } catch {
      size = 0;
    }
    const keys =
      item && typeof item === "object" && !Array.isArray(item)
        ? new Set(Object.keys(item))
        : new Set<string>();
    const businessKey = [...keys].some((key) => JSON_KEYS_HINT.has(key));
    // Prefer business wrapper objects over example JSON inside reasoning.
    return size + (businessKey ? 10000 : 0);
  };

  // On equal scores take the later candidate: the final answer usually
  // appears after the reasoning.
  let bestIndex = 0;
  let bestScore = score(parsed[0]);
  for (let index = 1; index < parsed.length; index += 1) {
    const current = score(parsed[index]);
    if (current >= bestScore) {
      bestScore = current;
      bestIndex = index;
    }
  }
  return parsed[bestIndex];
}

/** Strip code fences and parse JSON, repairing common LLM output defects. */
export function parseLlmJson(content: string): unknown {
  const parsed = tryParseLlmJson(content);
  if (parsed === null) {
    throw new LlmUnavailableError(
      "LLM returned invalid JSON (possibly truncated)",
    );
  }
  return parsed;
}

export class LlmClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  /** Extra fields merged into every chat request body (provider switches). */
  readonly extraBody: Record<string, unknown>;

  private lastFinishReason = "";
  private lastReasoningChars = 0;
  private lastTextSource = "";
  private lastUsage: Record<string, unknown> = {};

  constructor(
    apiKey = "",
    baseUrl = "",
    model = "",
    extraBody: Record<string, unknown> = {},
  ) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = model || DEFAULT_MODEL;
    this.extraBody = extraBody;
  }

  available(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Plain-text connectivity/light call; when `content` is empty, reasoning
   * output still counts as evidence the model responded.
   */
  async chatText(messages: ChatMessage[], maxTokens = 256): Promise<string> {
    const { text } = await this.chatRaw(messages, maxTokens, false);
    if (!text) {
      throw new LlmUnavailableError(
        `LLM returned no content (${this.detail()})`,
      );
    }
    return text;
  }

  /**
   * Chat and parse the reply as JSON (object or array).
   *
   * Strategy:
   * 1. `content` first; when it is empty, reasoning output that is valid
   *    JSON is accepted too;
   * 2. finish_reason=length retries once with a bigger token budget;
   * 3. json_mode failures fall back to plain mode (some providers reject
   *    response_format);
   * 4. unsupported extension parameters (400/422) are stripped and retried.
   */
  async chatJson(
    messages: ChatMessage[],
    maxTokens = 8192,
    jsonMode = false,
  ): Promise<unknown> {
    let { text } = await this.chatRaw(messages, maxTokens, jsonMode);
    let parsed = tryParseLlmJson(text);
    if (parsed !== null) return parsed;

    // Reasoning consumed the budget: retry once with more tokens instead of
    // degrading to rule mode immediately.
    if (this.lastFinishReason === "length" && maxTokens < 32768) {
      const bigger = Math.min(Math.max(maxTokens * 2, 8192), 32768);
      const retried = await this.chatRaw(messages, bigger, jsonMode);
      text = retried.text;
      parsed = tryParseLlmJson(text);
      if (parsed !== null) return parsed;
    }

    // Some compatible servers only return usable bodies in plain mode.
    if (jsonMode) {
      const retried = await this.chatRaw(messages, maxTokens, false);
      text = retried.text;
      parsed = tryParseLlmJson(text);
      if (parsed !== null) return parsed;
    }

    if (!text) {
      throw new LlmUnavailableError(
        `LLM returned no final answer (${this.detail()})`,
      );
    }
    throw new LlmUnavailableError(
      `LLM reply could not be parsed as JSON (${this.detail()})`,
    );
  }

  private requestExtras(): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    const model = (this.model || "").toLowerCase();
    if (
      (model.includes("glm-5.3") || model.includes("glm-5.2")) &&
      !("reasoning_effort" in this.extraBody)
    ) {
      // GLM-5.2/5.3 always think and default to max effort; long JSON tasks
      // burn every token on reasoning_content and finish with length.
      extras.reasoning_effort = "low";
    }
    return { ...extras, ...this.extraBody };
  }

  /** Returns the reply text plus its source (content/reasoning/choice). */
  private async chatRaw(
    messages: ChatMessage[],
    maxTokens: number,
    jsonMode: boolean,
  ): Promise<{ text: string; source: string }> {
    if (!this.available()) {
      throw new LlmUnavailableError("No LLM API key configured");
    }
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
    };
    const response = await this.request(payload, jsonMode);

    if (response.status === 429) {
      throw new LlmUnavailableError("LLM rate limited (429)");
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new LlmUnavailableError(`LLM HTTP ${response.status}: ${body}`);
    }

    const body = (await response.json()) as {
      choices?: {
        message?: Record<string, unknown>;
        text?: unknown;
        finish_reason?: unknown;
      }[];
      usage?: Record<string, unknown>;
      output_text?: unknown;
    };
    this.lastUsage = body.usage ?? {};
    const choice = body.choices?.[0];
    const message = choice?.message ?? {};
    // finish_reason lives on the choice in the OpenAI-compatible protocol;
    // reading it from the message kept it empty and disabled the
    // truncated-reasoning retry.
    this.lastFinishReason = String(choice?.finish_reason ?? "");
    this.lastReasoningChars = 0;
    this.lastTextSource = "";

    const text = contentToText(message.content);
    if (text) {
      this.lastTextSource = "content";
      return { text, source: "content" };
    }
    for (const key of REASONING_KEYS) {
      const reasoning = contentToText(message[key]);
      if (reasoning) {
        this.lastReasoningChars = reasoning.length;
        this.lastTextSource = key;
        return { text: reasoning, source: key };
      }
    }
    const alt = contentToText(choice?.text) || contentToText(body.output_text);
    if (alt) {
      this.lastTextSource = "choice_text";
      return { text: alt, source: "choice_text" };
    }
    return { text: "", source: "" };
  }

  /** Send the request; on 400/422 fall back json_mode, then extras. */
  private async request(
    payload: Record<string, unknown>,
    jsonMode: boolean,
  ): Promise<Response> {
    const extras = this.requestExtras();
    const attempts: { useJson: boolean; extras: Record<string, unknown> }[] =
      [];
    if (jsonMode) attempts.push({ useJson: true, extras });
    attempts.push({ useJson: false, extras });
    if (Object.keys(extras).length > 0) {
      attempts.push({ useJson: false, extras: {} });
    }

    let lastResponse: Response | null = null;
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const body: Record<string, unknown> = { ...payload };
      if (attempt.useJson) {
        body.response_format = { type: "json_object" };
      }
      Object.assign(body, attempt.extras);
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(240_000),
        });
      } catch (error) {
        throw new LlmUnavailableError(`LLM request failed: ${String(error)}`);
      }
      lastResponse = response;
      if (
        (response.status === 400 || response.status === 422) &&
        index < attempts.length - 1
      ) {
        // Consume the body so the connection can be reused.
        await response.text().catch(() => "");
        continue;
      }
      return response;
    }
    return lastResponse as Response;
  }

  private detail(): string {
    const usage = this.lastUsage ?? {};
    const details =
      usage.completion_tokens_details &&
      typeof usage.completion_tokens_details === "object"
        ? (usage.completion_tokens_details as Record<string, unknown>)
        : {};
    const bits = [`finish=${this.lastFinishReason || "unknown"}`];
    if (
      details.reasoning_tokens !== undefined &&
      details.reasoning_tokens !== null
    ) {
      bits.push(`reasoning_tokens=${details.reasoning_tokens}`);
    }
    if (
      usage.completion_tokens !== undefined &&
      usage.completion_tokens !== null
    ) {
      bits.push(`completion_tokens=${usage.completion_tokens}`);
    }
    if (this.lastReasoningChars > 0) {
      bits.push(`reasoning_chars=${this.lastReasoningChars}`);
    }
    bits.push(`source=${this.lastTextSource || "empty"}`);
    return bits.join(", ");
  }
}

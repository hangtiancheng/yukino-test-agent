/**
 * Normalise LLM "expected results" into a clean string list.
 *
 * Handles the shapes the model (and legacy dirty rows) actually produce:
 * - a normal array of sentences
 * - a single string: must be kept whole, never iterated char-by-char
 * - legacy dirty data split into single characters (["对","一","个",...]):
 *   when there are >=4 items and every item is one character, rejoin them
 */
export function asTextList(value: unknown, limit?: number): string[] {
  if (value === null || value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    let text: string;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      text = String(obj.text ?? obj.expected ?? obj.value ?? "");
    } else {
      text = String(item ?? "");
    }
    text = text.split(/\s+/).join(" ").trim();
    if (text) out.push(text);
  }
  if (out.length >= 4 && out.every((item) => item.length === 1)) {
    return [out.join("")];
  }
  return limit ? out.slice(0, limit) : out;
}

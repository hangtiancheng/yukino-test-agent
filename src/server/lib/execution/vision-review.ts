/**
 * Execution screenshot review (vision LLM).
 *
 * Rules:
 * - No vision model configured -> no review (returns null); the execution
 *   keeps its original status.
 * - Configured but call failed / no screenshots -> verdict=unavailable,
 *   handed to human review.
 * - Judgments rely only on screenshots and step records; insufficient
 *   evidence is always suspect — never a false pass.
 */
import fs from "node:fs";

import { getVisionClient } from "#/server/services/settings";
import { LlmUnavailableError } from "#/server/lib/llm";

import type { ChatMessageContentPart, LlmClient } from "#/server/lib/llm";
import type {
  ExecutionStepRecord,
  ImageReview,
  ReviewIssue,
  ReviewVerdict,
} from "#/lib/types";

export const VERDICT_OK: ReviewVerdict = "ok";
export const VERDICT_SUSPECT: ReviewVerdict = "suspect";
export const VERDICT_UNAVAILABLE: ReviewVerdict = "unavailable";

const MAX_IMAGES = 6;
/** Failed executions need more context to judge (legacy vision_max_images_failed). */
const MAX_IMAGES_FAILED = 10;
/** Second-pass budget when the first pass lacked evidence (legacy MAX_IMAGES_EXTENDED). */
const MAX_IMAGES_EXTENDED = 12;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface VisionReviewResult {
  verdict: ReviewVerdict;
  reason: string;
  model: string;
  imageCount: number;
  imageReviews: ImageReview[];
  issues: ReviewIssue[];
}

interface PickedImage {
  label: string;
  path: string;
  stepIndex: number | null;
}

/** Pick key screenshots: failed steps (after/before) -> last step -> assert
 * steps -> first step, at most 6. */
export function pickImages(
  steps: ExecutionStepRecord[],
  maxImages = MAX_IMAGES,
): PickedImage[] {
  const picked: PickedImage[] = [];
  const seen = new Set<string>();

  const add = (
    imagePath: string | null | undefined,
    label: string,
    stepIndex: number | null,
  ): void => {
    if (!imagePath || picked.length >= maxImages || seen.has(imagePath)) return;
    try {
      const stat = fs.statSync(imagePath);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return;
    } catch {
      return;
    }
    seen.add(imagePath);
    picked.push({ label, path: imagePath, stepIndex });
  };

  steps.forEach((step, i) => {
    const idx = i + 1;
    if (step.result !== "passed") {
      add(
        step.screenshotAfter,
        `Step ${idx} "${step.action}" after action (result ${step.result})`,
        idx,
      );
      add(step.screenshotBefore, `Step ${idx} before action`, idx);
    }
  });
  if (steps.length > 0) {
    const last = steps[steps.length - 1];
    add(last.screenshotAfter, "After the last step", steps.length);
  }
  steps.forEach((step, i) => {
    const idx = i + 1;
    if (step.stepType === "state_assert") {
      add(step.screenshotAfter, `Step ${idx} after assertion`, idx);
    }
  });
  if (steps.length > 0) {
    add(steps[0].screenshotAfter, "After the first step", 1);
  }
  steps.forEach((step, i) => {
    add(step.screenshotAfter, `Step ${i + 1} after action`, i + 1);
  });
  return picked;
}

function stepsText(steps: ExecutionStepRecord[]): string {
  return steps
    .map((s, i) => {
      let line = `${i + 1}. [${s.stepType}] ${s.action} (result: ${s.result})`;
      if (s.target) line += ` target: ${s.target}`;
      if (s.selectorUsed) line += ` execution evidence: ${s.selectorUsed}`;
      const evidence = s.evidence || {};
      if (Object.keys(evidence).length > 0) {
        const bits: string[] = [];
        if (evidence.inputValueLength !== undefined)
          bits.push(`input length: ${evidence.inputValueLength}`);
        if (evidence.actualValueLength !== undefined)
          bits.push(`DOM actual length: ${evidence.actualValueLength}`);
        if (evidence.valueMatch !== undefined)
          bits.push(`value match: ${evidence.valueMatch}`);
        if (evidence.sensitive)
          bits.push("sensitive field: plaintext not recorded");
        if (evidence.actualValuePreview)
          bits.push(`value preview: ${evidence.actualValuePreview}`);
        if (evidence.evidenceError)
          bits.push(`evidence collection failed: ${evidence.evidenceError}`);
        if (bits.length > 0) line += ` ${bits.join("; ")}`;
      }
      if (s.error) line += ` error: ${s.error}`;
      return line;
    })
    .join("\n");
}

function buildPrompt(
  kase: { title: string; expectedResults: string[] },
  steps: ExecutionStepRecord[],
  targetUrl: string,
  images: PickedImage[],
): string {
  const expected =
    (kase.expectedResults || []).join(", ") ||
    "(the case lists no expected result)";
  const imageList = images
    .map((img, i) => `Image ${i + 1}: ${img.label}`)
    .join("\n");
  return `You are a UI automation test result reviewer. Based on the case, the step records, and the key screenshots, judge whether this execution truly meets the business expectation.

Target URL: ${targetUrl}
Case title: ${kase.title}
Expected result: ${expected}

Execution steps and results:
${stepsText(steps)}

Screenshot list:
${imageList}

Review requirements:
1. Judge only from what is visible in the screenshots and the step records; never speculate about information not shown.
2. If a screenshot shows an error toast, a blank page, a login page, or a page/copy/data contradicting the expectation, verdict suspect.
3. A browser refresh is a page action that screenshots usually cannot show. When the step records explicitly contain "browser reloaded" or performance.navigation.type=reload, treat that as objective evidence of the refresh; use the screenshots only to verify the post-refresh page state, and do not judge suspect merely because the refresh itself is invisible.
4. Only judge suspect for a missing refresh when the case expects one but the step records contain neither a refresh action nor Navigation Timing evidence.
5. If the screenshots are insufficient to prove other expectations (a key result was not captured, images are blurry), also judge suspect — do not let it slide.
6. Judge ok only when the screenshots clearly show the expected result (copy, list data, state change, etc.).
7. Do not judge ok just because step results say passed; look at the screenshots yourself.

Supplementary rule for deterministic assertion evidence:
- When the step records contain "assertion evidence: Text anchors hit" or "assertion evidence: URL hit", Playwright already performed an exact check. Unless a screenshot contradicts it (error, blank page, wrong page, opposite state), do not judge suspect merely because of screenshot resolution or because the copy is not prominent in the image.

Give every image its own analysis (images array, one entry per image) for human review:
- image: image number (starting at 1)
- verdict: ok (this image matches the expectation) / suspect (this image has a problem or cannot prove the expectation)
- analysis: what this image shows and whether it matches the expectation, 1-2 sentences
- If the image has a definite problem, also add an entry to issues:
  - image: image number
  - bbox: normalized coordinates [x1,y1,x2,y2] in 0~1 relative to the image top-left corner; must frame the problem element/hint; omit when unsure
  - problem: one sentence describing the problem

Output only JSON:
{"verdict":"ok|suspect","reason":"conclusion in at most 120 words","images":[{"image":1,"verdict":"ok","analysis":"The screenshot shows the new order in the list, matching the expectation"}],"issues":[{"image":1,"step":2,"bbox":[0.12,0.35,0.78,0.52],"problem":"the concrete problem"}]}`;
}

/** Read PNG dimensions from the header (no image library needed). */
function pngSize(file: string): { width: number; height: number } | null {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    const signature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    if (!head.subarray(0, 8).equals(signature)) return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function normalizeBbox(
  raw: unknown,
  file: string,
): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  let vals = raw.map((v) => Number(v));
  if (vals.some((v) => !Number.isFinite(v))) return null;
  const size = pngSize(file);
  // Models occasionally return pixel coordinates: normalize by image size.
  if (vals.some((v) => v > 1)) {
    if (!size) return null;
    vals = [
      vals[0] / size.width,
      vals[1] / size.height,
      vals[2] / size.width,
      vals[3] / size.height,
    ];
  }
  let [x1, y1, x2, y2] = vals as [number, number, number, number];
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];
  x1 = Math.min(Math.max(0, x1), 1);
  y1 = Math.min(Math.max(0, y1), 1);
  x2 = Math.min(Math.max(0, x2), 1);
  y2 = Math.min(Math.max(0, y2), 1);
  if (x2 - x1 < 0.02 || y2 - y1 < 0.02) return null;
  return [
    Number(x1.toFixed(4)),
    Number(y1.toFixed(4)),
    Number(x2.toFixed(4)),
    Number(y2.toFixed(4)),
  ];
}

function parseIssues(raw: unknown, images: PickedImage[]): ReviewIssue[] {
  const out: ReviewIssue[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const dict = item as Record<string, unknown>;
    const idx = Number(dict.image || dict.imageIndex || 0);
    const img = idx >= 1 && idx <= images.length ? images[idx - 1] : null;
    const problem = String(dict.problem || "").trim();
    if (!problem) continue;
    out.push({
      imageIndex: Number.isFinite(idx) ? idx : 0,
      stepIndex: img ? img.stepIndex : ((dict.step as number | null) ?? null),
      label: img ? img.label : null,
      screenshot: img ? img.path : null,
      bbox: img ? normalizeBbox(dict.bbox, img.path) : null,
      problem: problem.slice(0, 500),
    });
  }
  return out;
}

function parseImageReviews(raw: unknown, images: PickedImage[]): ImageReview[] {
  const out: ImageReview[] = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set<number>();
  for (const item of raw.slice(0, 10)) {
    if (!item || typeof item !== "object") continue;
    const dict = item as Record<string, unknown>;
    const idx = Number(dict.image || dict.imageIndex || 0);
    if (
      !Number.isFinite(idx) ||
      seen.has(idx) ||
      idx < 1 ||
      idx > images.length
    ) {
      continue;
    }
    const img = images[idx - 1];
    const analysis = String(dict.analysis || "").trim();
    if (!analysis) continue;
    seen.add(idx);
    const rawVerdict = String(dict.verdict || "")
      .trim()
      .toLowerCase();
    out.push({
      imageIndex: idx,
      stepIndex: img.stepIndex,
      label: img.label,
      screenshot: img.path,
      // Only accept an explicit ok; anything else counts as suspect so a
      // missing analysis is never mistaken for a healthy screenshot.
      verdict: rawVerdict === "ok" ? "ok" : "suspect",
      analysis: analysis.slice(0, 1000),
      bbox: normalizeBbox(dict.bbox, img.path),
    });
  }
  return out;
}

function normalizeVerdict(
  rawVerdict: unknown,
  imageReviews: ImageReview[],
  issues: ReviewIssue[],
  imageCount: number,
): { verdict: ReviewVerdict; downgradeReason: string | null } {
  let verdict = String(rawVerdict || "")
    .trim()
    .toLowerCase();
  const reasons: string[] = [];
  if (verdict !== VERDICT_OK && verdict !== VERDICT_SUSPECT) {
    verdict = VERDICT_SUSPECT;
    reasons.push("The model returned no valid overall verdict");
  }
  if (issues.length > 0) {
    verdict = VERDICT_SUSPECT;
    reasons.push("The review found concrete problems");
  }
  if (imageReviews.some((item) => item.verdict === VERDICT_SUSPECT)) {
    verdict = VERDICT_SUSPECT;
    reasons.push("At least one key screenshot looks anomalous");
  }
  const reviewed = new Set(imageReviews.map((item) => item.imageIndex));
  if (reviewed.size < imageCount) {
    verdict = VERDICT_SUSPECT;
    reasons.push(
      `Only ${reviewed.size}/${imageCount} key screenshots were analyzed`,
    );
  }
  return {
    verdict: verdict as ReviewVerdict,
    downgradeReason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}

export async function visionEnabled(): Promise<boolean> {
  const client = await getVisionClient();
  return client.available();
}

/**
 * Screenshot budget for one review (legacy `_image_limit`): a base of 6,
 * raised to 10 when any step did not pass, and to 12 on an extended
 * second pass.
 */
function imageLimit(steps: ExecutionStepRecord[], extended = false): number {
  let limit = Math.max(1, MAX_IMAGES);
  if (steps.some((step) => step.result !== "passed")) {
    limit = Math.max(limit, MAX_IMAGES_FAILED);
  }
  if (extended) limit = Math.max(limit, MAX_IMAGES_EXTENDED);
  return limit;
}

/** Suspect only because evidence was thin — no concrete problem found. */
function isEvidenceSuspect(result: VisionReviewResult): boolean {
  return (
    result.verdict === VERDICT_SUSPECT &&
    result.issues.length === 0 &&
    !result.imageReviews.some((item) => item.verdict === VERDICT_SUSPECT)
  );
}

/** Review one execution; returns null when no vision model is configured. */
export async function reviewExecution(
  kase: { title: string; expectedResults: string[] },
  steps: ExecutionStepRecord[],
  targetUrl: string,
): Promise<VisionReviewResult | null> {
  if (!(await visionEnabled())) return null;
  const client = await getVisionClient();
  const model = client.model;
  const allImages = pickImages(steps, Number.MAX_SAFE_INTEGER);
  if (allImages.length === 0) {
    return {
      verdict: VERDICT_UNAVAILABLE,
      reason: "No usable screenshots; AI review cannot run",
      model,
      imageCount: 0,
      imageReviews: [],
      issues: [],
    };
  }

  const limit = Math.min(imageLimit(steps), allImages.length);
  const result = await reviewBatch(
    client,
    model,
    kase,
    steps,
    targetUrl,
    allImages.slice(0, limit),
  );

  // Two-pass review (legacy vision_two_pass_review): when the first pass is
  // suspect purely for lack of evidence and more screenshots exist, re-review
  // with an extended budget instead of leaving a false suspect.
  if (isEvidenceSuspect(result) && allImages.length > limit) {
    const extendedLimit = Math.min(imageLimit(steps, true), allImages.length);
    if (extendedLimit > limit) {
      const extended = await reviewBatch(
        client,
        model,
        kase,
        steps,
        targetUrl,
        allImages.slice(0, extendedLimit),
      );
      extended.reason =
        `${extended.reason}; re-reviewed with additional screenshots`.slice(
          0,
          2000,
        );
      return extended;
    }
  }

  return result;
}

/** Run a single vision review over an explicit set of screenshots. */
async function reviewBatch(
  client: LlmClient,
  model: string,
  kase: { title: string; expectedResults: string[] },
  steps: ExecutionStepRecord[],
  targetUrl: string,
  images: PickedImage[],
): Promise<VisionReviewResult> {
  const prompt = buildPrompt(kase, steps, targetUrl, images);
  const content: ChatMessageContentPart[] = [{ type: "text", text: prompt }];
  for (const img of images) {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(img.path);
    } catch {
      continue;
    }
    content.push({ type: "text", text: `Screenshot: ${img.label}` });
    content.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${raw.toString("base64")}` },
    });
  }

  let data: unknown;
  try {
    data = await client.chatJson([{ role: "user", content }], 2500, true);
  } catch (error) {
    const message =
      error instanceof LlmUnavailableError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      verdict: VERDICT_UNAVAILABLE,
      reason: `AI review call failed: ${message}`.slice(0, 2000),
      model,
      imageCount: images.length,
      imageReviews: [],
      issues: [],
    };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      verdict: VERDICT_UNAVAILABLE,
      reason: "Vision model returned an invalid structure",
      model,
      imageCount: images.length,
      imageReviews: [],
      issues: [],
    };
  }
  const dict = data as Record<string, unknown>;
  const imageReviews = parseImageReviews(dict.images, images);
  const issues = parseIssues(dict.issues, images);
  const { verdict, downgradeReason } = normalizeVerdict(
    dict.verdict,
    imageReviews,
    issues,
    images.length,
  );
  let reason = String(dict.reason || "").trim();
  if (downgradeReason) {
    reason = reason ? `${reason}; ${downgradeReason}` : downgradeReason;
  }
  if (issues.length > 0) {
    const parts = issues.map((it) => `Image ${it.imageIndex}: ${it.problem}`);
    reason = `${reason}; ${parts.join("; ")}`.slice(0, 2000);
  } else {
    reason = reason.slice(0, 2000);
  }

  return {
    verdict,
    reason: reason || "The vision model gave no reason",
    model,
    imageCount: images.length,
    imageReviews,
    issues,
  };
}

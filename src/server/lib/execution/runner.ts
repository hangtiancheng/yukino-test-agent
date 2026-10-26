/**
 * Automated runner (Playwright): uiSelector mapping + five-level fallback +
 * three-layer assertions + screenshots & video.
 *
 * Iron rules:
 * - No false green: what cannot be verified is marked skipped, never passed
 *   just because "nothing errored".
 * - Failure classification uses the six ERROR_CATEGORY enum values.
 */
import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

import type {
  ErrorCategory,
  ExecutionStepRecord,
  RunnerResult,
  StructuredStep,
} from "#/lib/types";

/** Quote anchors: straight and curly double quotes. */
const QUOTE_ANCHOR_RE = /["“]([^"”]+)["”]/g;
const REFRESH_RE = /refresh the page|refresh the browser|reload/i;
/** Runtime variables: ${name} / ${name+1} / ${name-1} */
const VARIABLE_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:([+-])(\d+))?\}/g;
const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const STEP_TIMEOUT_MS = 10_000;

class StepError extends Error {
  category: ErrorCategory;
  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.category = category;
  }
}

function resolveVariables(
  value: string | undefined | null,
  variables: Map<string, string>,
): string {
  if (!value || !String(value).includes("${")) return String(value ?? "");
  return String(value).replace(
    VARIABLE_RE,
    (
      _match,
      name: string,
      op: string | undefined,
      delta: string | undefined,
    ) => {
      if (!variables.has(name)) {
        throw new StepError(
          "CASE_INVALID",
          `Runtime variable not captured: ${name}`,
        );
      }
      const raw = variables.get(name)!;
      if (!op) return raw;
      const base = Number.parseInt(raw.trim(), 10);
      const number = Number.parseInt(delta || "0", 10);
      if (!Number.isFinite(base)) {
        throw new StepError(
          "CASE_INVALID",
          `Variable ${name}=${raw} is not an integer; cannot apply ${op}${delta}`,
        );
      }
      return String(op === "+" ? base + number : base - number);
    },
  );
}

function refreshRequested(step: StructuredStep): boolean {
  return REFRESH_RE.test(`${step.action || ""} ${step.target || ""}`);
}

/** uiSelector -> Playwright selector. `route` is handled by the caller. */
function selectorFor(step: StructuredStep): string | null {
  const sel = step.uiSelector;
  const type = sel?.type;
  const value = sel?.value || "";
  if (!value) return null;
  if (type === "route") return null;
  if (type === "placeholder") return `[placeholder="${value}"]`;
  if (type === "text") return null; // handled by the fallback chain
  if (type === "label") {
    return `label:has-text("${value}") >> xpath=following::input[1]`;
  }
  if (type === "role") return `[role="${value}"]`;
  if (type === "testid") return `[data-testid="${value}"]`;
  if (type === "css" || type === "xpath") return value;
  return null;
}

/** Five-level fallback chain. */
function fallbackChain(step: StructuredStep): string[] {
  const sel = step.uiSelector;
  const type = sel?.type;
  const value = sel?.value || "";
  const target = step.target || "";
  const chain: string[] = [];
  // 1. Exact uiSelector match
  if (type === "text" && value) {
    chain.push(
      `button:has-text("${value}"), a:has-text("${value}"), [role="button"]:has-text("${value}"), input[value="${value}"], summary:has-text("${value}")`,
    );
  } else if (type !== "route" && value) {
    const s = selectorFor(step);
    if (s) chain.push(s);
  }
  // 2. Target text on button/a/[role=button]
  if (target) {
    chain.push(
      `button:has-text("${target}"), a:has-text("${target}"), [role="button"]:has-text("${target}")`,
    );
  }
  // 3. Target text anywhere on the page (excluding option/script/style)
  if (target) {
    chain.push(
      `body :not(option):not(script):not(style):has-text("${target}")`,
    );
  }
  // 4. normalize-space XPath (two-word buttons may render with a gap)
  if (target) {
    chain.push(`xpath=//button[normalize-space(.)="${target}"]`);
  }
  return chain;
}

interface LocatorLike {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
}

interface PageLike {
  locator(selector: string): { first(): LocatorLike };
}

async function findLocator(
  page: PageLike,
  step: StructuredStep,
): Promise<{ locator: LocatorLike | null; attempted: string[] }> {
  const chain = fallbackChain(step);
  const attempted: string[] = [];
  for (const sel of chain) {
    attempted.push(sel);
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        return { locator: loc, attempted };
      }
    } catch {
      continue;
    }
  }
  return { locator: null, attempted };
}

/**
 * Three-layer assertion: URL -> quoted text anchors -> honest skipped.
 * Returns [status, detail].
 */
async function doAssert(
  page: { url: () => string; innerText: (selector: string) => Promise<string> },
  expected: string,
): Promise<["passed" | "failed" | "skipped", string]> {
  // Layer 1: URL assertion
  if (/URL|redirect|route|page address|\/[\w/]+/i.test(expected)) {
    const pathMatch = /(\/[\w/{}]+)/.exec(expected);
    if (pathMatch && page.url().includes(pathMatch[1])) {
      return ["passed", `URL hit: ${pathMatch[1]}`];
    }
  }
  // Layer 2: DOM text assertion via quoted anchors
  const anchors: string[] = [];
  const re = new RegExp(QUOTE_ANCHOR_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(expected)) !== null) {
    const anchor = m[1].trim();
    if (anchor) anchors.push(anchor);
  }
  if (anchors.length > 0) {
    const text = await page.innerText("body");
    const missing = anchors.filter((a) => !text.includes(a));
    if (missing.length === 0) {
      return ["passed", `Text anchors hit: ${anchors.join(", ")}`];
    }
    return ["failed", `Text anchors missing: ${missing.join(", ")}`];
  }
  // Layer 3: honest skipped — never a false green
  return [
    "skipped",
    "No verifiable URL or quoted text anchor in the expectation; marked skipped instead of guessing",
  ];
}

async function reloadAndVerify(page: {
  reload(options?: { waitUntil?: string }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
}): Promise<{ navigationType: string; url: string }> {
  await page.reload({ waitUntil: "load" });
  const navigation = await page.evaluate<{ type: string; url: string }>(
    `(() => {
      const entries = performance.getEntriesByType('navigation');
      const nav = entries && entries.length ? entries[entries.length - 1] : null;
      return { type: nav ? nav.type : '', url: location.href };
    })()`,
  );
  const navigationType = String(navigation?.type || "");
  if (navigationType !== "reload") {
    throw new StepError(
      "NAVIGATION_FAILED",
      `Browser reload failed Navigation Timing verification; actual type: ${navigationType}`,
    );
  }
  return { navigationType, url: navigation?.url || "" };
}

export interface RunnerCaseInput {
  id: string;
  structuredSteps: StructuredStep[];
}

/** Execute one case; returns the execution result record. */
export async function executeCase(
  kase: RunnerCaseInput,
  targetUrl: string,
  outputDir: string,
): Promise<RunnerResult> {
  const steps = kase.structuredSteps || [];
  const out = path.join(outputDir, kase.id || "exec");
  fs.mkdirSync(out, { recursive: true });

  const total = steps.length;
  let passed = 0;
  const stepResults: ExecutionStepRecord[] = [];
  const variables = new Map<string, string>();
  const record: RunnerResult = {
    status: "passed",
    errorCategory: null,
    errorMessage: null,
    videoPath: null,
    passedSteps: 0,
    totalSteps: total,
    steps: stepResults,
  };

  if (steps.length === 0) {
    record.status = "failed";
    record.errorCategory = "CASE_INVALID";
    record.errorMessage = "Case has no structured steps";
    return record;
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: out },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);

    let idx = 0;
    for (const step of steps) {
      idx += 1;
      const stype = step.type;
      const before = path.join(
        out,
        `step-${String(idx).padStart(2, "0")}-before.png`,
      );
      const after = path.join(
        out,
        `step-${String(idx).padStart(2, "0")}-after.png`,
      );
      let beforePath: string | null = before;
      let afterPath: string | null = after;
      const startedAt = Date.now();
      try {
        await page.screenshot({ path: before });
      } catch {
        beforePath = null;
      }

      let result: "passed" | "failed" | "skipped" = "passed";
      let error: string | null = null;
      let reloadEvidence: { navigationType: string; url: string } | null = null;
      let assertionDetail: string | null = null;
      let captureDetail: string | null = null;
      try {
        if (stype === "ui_action" && step.uiSelector?.type === "route") {
          const route = step.uiSelector.value;
          const url =
            targetUrl.replace(/\/+$/, "") +
            (route ? `/${route.replace(/^\/+/, "")}` : "");
          const response = await page.goto(url);
          if (response && response.status() >= 400) {
            throw new StepError(
              "NAVIGATION_FAILED",
              `Page returned HTTP ${response.status()}: ${url}`,
            );
          }
          await page.waitForTimeout(300);
        } else if (stype === "ui_action" && refreshRequested(step)) {
          reloadEvidence = await reloadAndVerify(page);
        } else if (stype === "ui_action") {
          const { locator, attempted } = await findLocator(page, step);
          if (!locator) {
            throw new StepError(
              "SELECTOR_NOT_FOUND",
              `Element not found; attempted chain: ${attempted.join(" | ")}`,
            );
          }
          await locator.click({ timeout: STEP_TIMEOUT_MS });
          await page.waitForTimeout(300);
        } else if (stype === "input") {
          if (!(step.inputValue && step.uiSelector?.value)) {
            throw new StepError(
              "CASE_INVALID",
              "input step missing uiSelector.value or inputValue",
            );
          }
          const { locator, attempted } = await findLocator(page, step);
          if (!locator) {
            throw new StepError(
              "SELECTOR_NOT_FOUND",
              `Input not found; attempted chain: ${attempted.join(" | ")}`,
            );
          }
          await locator.fill(resolveVariables(step.inputValue, variables), {
            timeout: STEP_TIMEOUT_MS,
          });
        } else if (stype === "capture") {
          const variable = String(step.variable || "").trim();
          const pattern = String(step.pattern || "").trim();
          if (!variable || !VARIABLE_NAME_RE.test(variable)) {
            throw new StepError(
              "CASE_INVALID",
              "capture step missing a valid variable",
            );
          }
          if (!pattern) {
            throw new StepError("CASE_INVALID", "capture step missing pattern");
          }
          let regex: RegExp;
          try {
            regex = new RegExp(pattern);
          } catch (exc) {
            throw new StepError(
              "CASE_INVALID",
              `capture pattern invalid: ${String(exc)}`,
            );
          }
          const bodyText = await page.innerText("body");
          const match = regex.exec(bodyText);
          if (!match) {
            throw new StepError(
              "ASSERT_FAILED",
              `Failed to capture variable ${variable} from the page; pattern=${pattern}`,
            );
          }
          const captured = match[1] !== undefined ? match[1] : match[0];
          variables.set(variable, String(captured));
          captureDetail = `capture ${variable}=${captured}`;
        } else if (stype === "state_assert") {
          if (
            REFRESH_RE.test(`${step.action || ""} ${step.expected || ""}`) &&
            reloadEvidence === null
          ) {
            reloadEvidence = await reloadAndVerify(page);
          }
          // Wait for navigation/render to settle (e.g. redirect 500ms after submit)
          await page.waitForTimeout(800);
          const resolvedExpected = resolveVariables(step.expected, variables);
          const [status, detail] = await doAssert(page, resolvedExpected);
          result = status;
          if (status === "passed") assertionDetail = detail;
          if (status === "failed") throw new StepError("ASSERT_FAILED", detail);
          if (status === "skipped") error = detail;
        } else {
          throw new StepError(
            "CASE_INVALID",
            `Unknown step type: ${String(stype)}`,
          );
        }
      } catch (caught) {
        if (caught instanceof StepError) {
          result = "failed";
          error = caught.message;
          record.errorCategory = record.errorCategory || caught.category;
        } else if (caught instanceof Error && caught.name === "TimeoutError") {
          result = "failed";
          error = `Step timed out: ${caught.message}`;
          record.errorCategory = record.errorCategory || "TIMEOUT";
        } else {
          result = "failed";
          const message =
            caught instanceof Error
              ? `${caught.name}: ${caught.message}`
              : String(caught);
          error = message;
          const isNavigation =
            stype === "ui_action" && step.uiSelector?.type === "route";
          record.errorCategory =
            record.errorCategory ||
            (isNavigation ? "NAVIGATION_FAILED" : "ENV_ERROR");
        }
      }

      try {
        await page.screenshot({ path: after });
      } catch {
        afterPath = null;
      }

      let actionForRecord = String(step.action || "");
      let targetForRecord = String(step.target || "");
      let selectorForRecord: string | null = step.uiSelector?.value || null;
      if (reloadEvidence) {
        actionForRecord = `${actionForRecord} (browser reloaded: performance.navigation.type=${reloadEvidence.navigationType})`;
        targetForRecord = "browser.reload";
        selectorForRecord = `browser.reload; navigationType=${reloadEvidence.navigationType}`;
      } else if (stype === "state_assert" && assertionDetail) {
        actionForRecord = `${actionForRecord} (assertion evidence: ${assertionDetail})`;
      } else if (stype === "capture" && captureDetail) {
        actionForRecord = `${actionForRecord} (variable evidence: ${captureDetail})`;
      }

      if (result === "passed") passed += 1;
      stepResults.push({
        stepIndex: idx,
        stepType: String(stype),
        action: actionForRecord.slice(0, 255),
        target: targetForRecord.slice(0, 255),
        selectorUsed: selectorForRecord?.slice(0, 500) ?? null,
        result,
        screenshotBefore: beforePath,
        screenshotAfter: afterPath,
        error,
        durationMs: Date.now() - startedAt,
      });
      // Stop on failure (no point running meaningless steps)
      if (result === "failed") break;
    }

    await context.close();
    await browser.close();
    browser = null;

    // Playwright video filenames are random; find and rename to video.webm
    const videos = fs
      .readdirSync(out)
      .filter((name) => name.endsWith(".webm"))
      .map((name) => path.join(out, name));
    let videoPath: string | null = null;
    if (videos.length > 0) {
      const renamed = path.join(out, "video.webm");
      try {
        fs.renameSync(videos[0], renamed);
        videoPath = renamed;
      } catch {
        videoPath = videos[0]!;
      }
    }
    record.videoPath = videoPath;
    record.passedSteps = passed;
    if (record.errorCategory) {
      record.status = "failed";
    } else if (stepResults.some((s) => s.result === "failed")) {
      record.status = "failed";
    } else if (stepResults.some((s) => s.result === "skipped")) {
      record.status = "skipped";
    } else {
      record.status = "passed";
    }
    return record;
  } catch (error) {
    // Browser launch failure etc.
    record.status = "failed";
    record.errorCategory = record.errorCategory || "ENV_ERROR";
    record.errorMessage =
      error instanceof Error ? error.message : String(error);
    record.totalSteps = total;
    return record;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
}

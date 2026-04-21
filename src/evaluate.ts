/**
 * Core evaluation logic extracted from index.ts.
 *
 * This module runs the full M1 → M2 → M3 pipeline and emits progress
 * events via a callback. Both the CLI (index.ts) and the web server
 * (server.ts) use this same function.
 *
 * Progress messages come in two kinds:
 *   - User-facing prose (in Latvian, via lv.progress.*) for things
 *     that appear in the frontend log a demo viewer would read.
 *   - Technical check-ID lines (kept in English) — they stream to the
 *     same log but read better with check IDs and raw numbers intact.
 */

import * as fs from "fs"
import { launchAndNavigate } from "./utils/browser";
import { dismissConsentModal } from "./utils/consent";
import {
  injectHelpers,
  recordTabStops,
  detectTraps,
  analyzeFocusOrder,
  verifySkipLink,
  detectObscured,
} from "./modules/traversal";
import {
  analyzeIndicators,
  scanStylesheetsForOutlineRemoval,
} from "./modules/visibility";
import { analyzeInteractiveCoverage } from "./modules/coverage";
import {
  generateM1Issues,
  generateM2Issues,
  generateM3Issues,
  buildReportData,
  writeJsonReport,
  writeHtmlReport,
  ReportData,
} from "./reports/generator";
import { TabStop, ReportIssue } from "./types";
import { lv } from "./i18n/lv";
import * as path from "path";

/**
 * Deduplicate tab stops by selector, keeping the first occurrence.
 */
function deduplicateStops(stops: TabStop[]): TabStop[] {
  const seen = new Set<string>();
  const unique: TabStop[] = [];
  for (const stop of stops) {
    if (!seen.has(stop.selector)) {
      seen.add(stop.selector);
      unique.push(stop);
    }
  }
  return unique;
}

/**
 * Progress callback signature.
 * The server will forward these messages to the browser via SSE.
 */
export type ProgressCallback = (message: string) => void;

/**
 * Result of a full evaluation run.
 */
export interface EvaluationResult {
  report: ReportData;
  outputDir: string;
  jsonPath: string;
  htmlPath: string;
}

/**
 * Normalize a URL: prepend https:// if no protocol is given,
 * and do a basic format check.
 */
function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new Error(lv.errors.emptyUrl);

  // Local file path → file:// URL
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || /^[a-zA-Z]:\\/.test(url) || url.endsWith(".html") || url.endsWith(".htm")) {
    const absolutePath = require("path").resolve(url);
    url = "file://" + absolutePath;
  }
  // Prepend https:// if no protocol
  else if (!/^https?:\/\//i.test(url) && !url.startsWith("file://")) {
    url = "https://" + url;
  }

  // Basic validity check
  try {
    new URL(url);
  } catch {
    throw new Error(lv.errors.invalidUrl(raw));
  }

  return url;
}

/**
 * Run the full keyboard accessibility evaluation on a URL.
 *
 * @param url        - The page to evaluate
 * @param onProgress - Called with human-readable status messages during the run
 * @returns The completed report data and file paths
 */
export async function runEvaluation(
  rawUrl: string,
  onProgress: ProgressCallback = () => {}
): Promise<EvaluationResult> {
  const url = normalizeUrl(rawUrl);
  const startTime = Date.now();

  onProgress(lv.progress.launching);

  let browserContext;
  try {
    browserContext = await launchAndNavigate(url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Translate common Playwright navigation errors into clear messages
    if (msg.includes("ERR_NAME_NOT_RESOLVED") || msg.includes("getaddrinfo")) {
      throw new Error(lv.errors.nameNotResolved(url));
    }
    if (msg.includes("ERR_CONNECTION_REFUSED")) {
      throw new Error(lv.errors.connectionRefused(url));
    }
    if (msg.includes("ERR_CERT") || msg.includes("SSL")) {
      throw new Error(lv.errors.certError(url));
    }
    if (msg.includes("Timeout") || msg.includes("timeout")) {
      throw new Error(lv.errors.timeout(url));
    }
    throw new Error(lv.errors.loadFailed(url, msg));
  }

  const { browser, page } = browserContext;

  try {
    await injectHelpers(page);

    // ---- Dismiss consent modals ----
    const consentResult = await dismissConsentModal(page);
    if (consentResult) {
      onProgress(`Consent: ${consentResult}`);
      // Re-inject helpers — clicking the consent button may have
      // triggered a page reload or navigation that wiped them out.
      await injectHelpers(page);
    } else {
      onProgress("Consent: no modal detected");
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = path.join("output", `run-${timestamp}`);
    fs.mkdirSync(outputDir, { recursive: true });

    // Capture page screenshot before any interaction
    const pageScreenshotPath = path.join(outputDir, "page-screenshot.png");
    try {
      await page.screenshot({ path: pageScreenshotPath, type: "png" });
      onProgress(lv.progress.capturedScreenshot);
    } catch {
      onProgress(lv.progress.screenshotFailed);
    }

    // ============================================================
    // MODULE 1: Focus Traversal & Order Analysis
    // ============================================================
    onProgress("M1-01: Recording forward tab sequence...");
    const { stops: forwardStops, inlineTraps: forwardInlineTraps } =
      await recordTabStops(page, "forward");
    const uniqueStops = deduplicateStops(forwardStops);
    onProgress(`M1-01: ${forwardStops.length} tab stops (${uniqueStops.length} unique)`);

    if (forwardInlineTraps.length > 0) {
      onProgress(`M1-02: ${forwardInlineTraps.length} trap(s) detected during traversal (early exit)`);
    }

    onProgress("M1-01: Recording backward tab sequence...");
    const { stops: backwardStops } = await recordTabStops(page, "backward");
    const uniqueBackward = deduplicateStops(backwardStops);
    onProgress(`M1-01: Backward pass — ${uniqueBackward.length} unique stops`);

    onProgress("M1-02: Checking for keyboard traps...");
    const traps = await detectTraps(page, forwardStops, forwardInlineTraps);
    onProgress(
      traps.length === 0
        ? "M1-02: No keyboard traps detected"
        : `M1-02: ${traps.length} potential trap(s) found`
    );

    onProgress("M1-03: Analyzing focus order vs visual layout...");
    const focusOrder = analyzeFocusOrder(uniqueStops);
    onProgress(`M1-03: Correlation score ${focusOrder.correlationScore}, ${focusOrder.violations.length} violation(s)`);

    onProgress("M1-04: Checking for skip link...");
    const skipLink = await verifySkipLink(page, forwardStops);
    onProgress(
      skipLink.exists
        ? `M1-04: Skip link found (target reachable: ${skipLink.targetReachable})`
        : "M1-04: No skip link found"
    );

    onProgress(`M1-05: Checking for obscured focus (${uniqueStops.length} elements)...`);
    const obscured = await detectObscured(page, uniqueStops, outputDir, (current, total) => {
      if (current % 5 === 0 || current === total) {
        onProgress(`M1-05: ${current}/${total} elements checked`);
      }
    });

    let obscuredCount = 0;
    let partialCount = 0;
    for (const [, result] of obscured) {
      if (result.fullyObscured) obscuredCount++;
      else if (result.partiallyObscured) partialCount++;
    }
    onProgress(`M1-05: ${obscuredCount} fully obscured, ${partialCount} partially obscured`);

    // ============================================================
    // MODULE 2: Focus Indicator Visibility Analysis
    // ============================================================
    onProgress("M2-02b: Scanning stylesheets for outline removal...");
    const outlineOverrides = await scanStylesheetsForOutlineRemoval(page);
    onProgress(`M2-02b: ${outlineOverrides.length} outline removal rule(s) found`);

    onProgress("M2-01/02/03/04: Analyzing focus indicators...");
    const indicatorResults = await analyzeIndicators(
      page,
      uniqueStops.length,
      outputDir,
      (current, total) => {
        onProgress(`M2: ${current}/${total} elements analyzed`);
      }
    );

    let scoreTotal = 0;
    let scoreCounts = { none: 0, poor: 0, partial: 0, good: 0, excellent: 0 };
    for (const r of indicatorResults) {
      scoreCounts[r.score.level]++;
      scoreTotal += r.score.score;
    }
    const avgScore = indicatorResults.length > 0
      ? Math.round(scoreTotal / indicatorResults.length)
      : 0;
    onProgress(`M2-05: Average visibility score ${avgScore}/100`);

    // ============================================================
    // MODULE 3: Interactive Element Coverage
    // ============================================================
    onProgress("M3: Analyzing interactive element coverage...");
    const m2ReachableSelectors = indicatorResults.map((r) => r.selector);

    const m3Results = await analyzeInteractiveCoverage(
      page,
      uniqueStops,
      m2ReachableSelectors,
      (phase, detail) => {
        onProgress(`${phase}: ${detail}`);
      }
    );
    onProgress(`M3-01: Coverage ${m3Results.coverageGap.coveragePercent}% (${m3Results.coverageGap.unreachableElements.length} unreachable)`);
    onProgress(`M3-02: ${m3Results.nonSemanticControls.length} non-semantic control(s) with issues`);
    onProgress(`M3-03: ${m3Results.scrollableRegions.filter(r => !r.isFocusable && !r.hasFocusableChild).length} inaccessible scrollable region(s)`);

    // ============================================================
    // REPORT GENERATION
    // ============================================================
    onProgress(lv.progress.generatingReport);

    const allIssues: ReportIssue[] = [
      ...generateM1Issues(
        forwardStops, uniqueStops, backwardStops, uniqueBackward,
        traps, focusOrder, skipLink, obscured, uniqueStops
      ),
      ...generateM2Issues(indicatorResults, outlineOverrides, (() => {
        const set = new Set<string>();
        for (const [idx, result] of obscured) {
          if (result.fullyObscured) {
            const stop = uniqueStops.find(s => s.index === idx);
            if (stop) set.add(stop.selector);
          }
        }
        return set;
      })()),
      ...generateM3Issues(
        m3Results.coverageGap,
        m3Results.nonSemanticControls,
        m3Results.scrollableRegions,
        new Set(uniqueStops.map(s => s.selector))
      ),
    ];

    const report = buildReportData(
      url, startTime, allIssues,
      uniqueStops.length,
      avgScore,
      m3Results.coverageGap.coveragePercent
    );

    const jsonPath = writeJsonReport(report, outputDir);
    const htmlPath = writeHtmlReport(report, outputDir, pageScreenshotPath);

    const seconds = ((Date.now() - startTime) / 1000).toFixed(1);
    onProgress(lv.progress.done(allIssues.length, report.summary.criticalCount, seconds));

    return { report, outputDir, jsonPath, htmlPath };
  } finally {
    await browser.close();
  }
}
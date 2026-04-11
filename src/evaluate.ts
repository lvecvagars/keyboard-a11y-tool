/**
 * Core evaluation logic extracted from index.ts.
 *
 * This module runs the full M1 → M2 → M3 pipeline and emits progress
 * events via a callback. Both the CLI (index.ts) and the web server
 * (server.ts) use this same function.
 */

import { launchAndNavigate } from "./utils/browser";
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
 * Run the full keyboard accessibility evaluation on a URL.
 *
 * @param url        - The page to evaluate
 * @param onProgress - Called with human-readable status messages during the run
 * @returns The completed report data and file paths
 */
export async function runEvaluation(
  url: string,
  onProgress: ProgressCallback = () => {}
): Promise<EvaluationResult> {
  const startTime = Date.now();

  onProgress("Launching browser and navigating to page...");
  const { browser, page } = await launchAndNavigate(url);

  try {
    await injectHelpers(page);

    // ============================================================
    // MODULE 1: Focus Traversal & Order Analysis
    // ============================================================
    onProgress("M1-01: Recording forward tab sequence...");
    const forwardStops = await recordTabStops(page, "forward");
    const uniqueStops = deduplicateStops(forwardStops);
    onProgress(`M1-01: ${forwardStops.length} tab stops (${uniqueStops.length} unique)`);

    onProgress("M1-01: Recording backward tab sequence...");
    const backwardStops = await recordTabStops(page, "backward");
    const uniqueBackward = deduplicateStops(backwardStops);
    onProgress(`M1-01: Backward pass — ${uniqueBackward.length} unique stops`);

    onProgress("M1-02: Checking for keyboard traps...");
    const traps = await detectTraps(page, forwardStops);
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
    const obscured = await detectObscured(page, uniqueStops, (current, total) => {
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

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = path.join("output", `run-${timestamp}`);

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
    onProgress("Generating report...");

    const allIssues: ReportIssue[] = [
      ...generateM1Issues(
        forwardStops, uniqueStops, backwardStops, uniqueBackward,
        traps, focusOrder, skipLink, obscured, uniqueStops
      ),
      ...generateM2Issues(indicatorResults, outlineOverrides),
      ...generateM3Issues(
        m3Results.coverageGap,
        m3Results.nonSemanticControls,
        m3Results.scrollableRegions
      ),
    ];

    const report = buildReportData(
      url, startTime, allIssues,
      uniqueStops.length,
      avgScore,
      m3Results.coverageGap.coveragePercent
    );

    const jsonPath = writeJsonReport(report, outputDir);
    const htmlPath = writeHtmlReport(report, outputDir);

    onProgress(`Done! ${allIssues.length} issues found (${report.summary.criticalCount} critical). Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    return { report, outputDir, jsonPath, htmlPath };
  } finally {
    await browser.close();
  }
}
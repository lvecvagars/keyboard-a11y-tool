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
import { TabStop } from "./types";
import * as path from "path";

/**
 * Deduplicate tab stops by selector, keeping the first occurrence.
 * Preserves the original index so results can map back to forwardStops.
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

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error("Usage: npx ts-node src/index.ts <url>");
    process.exit(1);
  }

  console.log(`Evaluating: ${url}`);

  const { browser, page } = await launchAndNavigate(url);

  try {
    // Inject shared helper functions into the page context
    await injectHelpers(page);

    // M1-01: Forward traversal
    const forwardStops = await recordTabStops(page, "forward");
    const uniqueStops = deduplicateStops(forwardStops);

    console.log(`\nForward: ${forwardStops.length} tab stops (${uniqueStops.length} unique)`);
    for (const stop of uniqueStops) {
      console.log(`  [${stop.index}] <${stop.tag}> ${stop.selector}`);
    }
    if (uniqueStops.length < forwardStops.length) {
      console.log(
        `  ... ${forwardStops.length - uniqueStops.length} duplicate stops omitted (likely from keyboard traps)`
      );
    }

    // M1-01: Backward traversal
    const backwardStops = await recordTabStops(page, "backward");
    const uniqueBackward = deduplicateStops(backwardStops);
    console.log(`\nBackward: ${backwardStops.length} tab stops (${uniqueBackward.length} unique)`);

    if (uniqueStops.length === uniqueBackward.length) {
      console.log("✓ Forward and backward unique counts match.");
    } else {
      console.log(
        `✗ Unique count mismatch: forward=${uniqueStops.length}, backward=${uniqueBackward.length}`
      );
    }

    // M1-02: Trap detection
    console.log("\nChecking for keyboard traps...");
    const traps = await detectTraps(page, forwardStops);

    if (traps.length === 0) {
      console.log("✓ No keyboard traps detected.");
    } else {
      for (const trap of traps) {
        console.log(
          `✗ ${trap.isTrap ? "TRAP CONFIRMED" : "Suspected trap (escapable)"} at ${trap.location}`
        );
        console.log(
          `  Trapped elements: ${trap.trappedElements.join(", ")}`
        );
        for (const attempt of trap.escapeAttempts) {
          console.log(
            `  ${attempt.escaped ? "✓" : "✗"} ${attempt.key}: ${attempt.escaped ? "escaped" : "still trapped"}`
          );
        }
      }
    }

    // M1-03: Focus order analysis (uses unique stops — duplicates skew correlation)
    console.log("\nAnalyzing focus order vs. visual layout...");
    const focusOrder = analyzeFocusOrder(uniqueStops);
    console.log(
      `  Correlation score: ${focusOrder.correlationScore} (1.0 = perfect match)`
    );

    if (focusOrder.violations.length === 0) {
      console.log("  ✓ No focus order violations detected.");
    } else {
      console.log(`  ${focusOrder.violations.length} violation(s):`);
      for (const v of focusOrder.violations) {
        if (v.direction === "other") {
          console.log(`  ⚠ tabindex > 0 on ${v.fromElement}`);
        } else {
          console.log(
            `  ⚠ ${v.direction}: ${v.fromElement} → ${v.toElement} (${v.jumpDistance}px jump)`
          );
        }
      }
    }

    // M1-04: Skip link verification
    console.log("\nChecking for skip link...");
    const skipLink = await verifySkipLink(page, forwardStops);

    if (!skipLink.exists) {
      console.log("  ✗ No skip link found.");
    } else if (skipLink.targetReachable) {
      console.log(
        `  ✓ Skip link found and works (target: ${skipLink.targetSelector})`
      );
    } else {
      console.log(
        `  ⚠ Skip link found but target is not reachable (target: ${skipLink.targetSelector})`
      );
    }

    // M1-05: Focus not obscured detection (use unique stops to avoid redundant work)
    console.log(`\nChecking for obscured focus (${uniqueStops.length} elements)...`);
    const obscured = await detectObscured(page, uniqueStops, (current, total) => {
      process.stdout.write(`\r  Progress: ${current}/${total}`);
    });
    process.stdout.write("\n");

    let obscuredCount = 0;
    let partialCount = 0;
    for (const [idx, result] of obscured) {
      const stop = uniqueStops.find(s => s.index === idx);
      if (result.fullyObscured) {
        obscuredCount++;
        console.log(
          `  ✗ [${idx}] ${stop?.selector} — fully obscured by ${result.obscuringElement}`
        );
      } else if (result.partiallyObscured) {
        partialCount++;
        console.log(
          `  ⚠ [${idx}] ${stop?.selector} — ${result.overlapPercent}% obscured by ${result.obscuringElement}`
        );
      }
    }
    if (obscuredCount === 0 && partialCount === 0) {
      console.log("  ✓ No focused elements are obscured.");
    } else {
      console.log(`  ${obscuredCount} fully obscured, ${partialCount} partially obscured.`);
    }

    // ============================================================
    // MODULE 2: Focus Indicator Visibility Analysis
    // ============================================================

    console.log("\n" + "=".repeat(60));
    console.log("MODULE 2: Focus Indicator Visibility Analysis");
    console.log("=".repeat(60));

    // M2-02 Part B: Stylesheet scan (runs once, before traversal)
    console.log("\nM2-02b: Scanning stylesheets for outline removal...");
    const outlineOverrides = await scanStylesheetsForOutlineRemoval(page);

    if (outlineOverrides.length === 0) {
      console.log("  ✓ No :focus outline removal rules found.");
    } else {
      for (const rule of outlineOverrides) {
        if (rule.hasReplacement) {
          console.log(
            `  ⚠ ${rule.selectorText} removes outline but has replacement: ${rule.replacementProperties.join(", ")} (${rule.source})`
          );
        } else {
          console.log(
            `  ✗ ${rule.selectorText} removes outline with NO replacement (${rule.source})`
          );
        }
      }
    }

    // M2-01 + M2-02 Part A + M2-03 + M2-04: Combined traversal pass
    console.log("\nM2-01/M2-02a/M2-03/M2-04: Checking focus indicators...");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = path.join("output", `m2-${timestamp}`);

    const indicatorResults = await analyzeIndicators(
      page,
      uniqueStops.length,
      outputDir,
      (current, total) => {
        process.stdout.write(`\r  Progress: ${current}/${total}`);
      }
    );
    process.stdout.write("\n");

    let noIndicatorCount = 0;
    let hasIndicatorCount = 0;
    let outlineRemovedCount = 0;
    let outlineNeverCount = 0;
    let styleChangeCount = 0;
    let contrastFailCount = 0;
    let contrastPassCount = 0;
    let areaPassCount = 0;
    let areaFailCount = 0;
    let scoreCounts = { none: 0, poor: 0, partial: 0, good: 0, excellent: 0 };
    let scoreTotal = 0;

    for (const result of indicatorResults) {
      // M2-01: Existence
      const existLabel = result.existence.hasVisibleChange
        ? `✓ ${result.existence.changedPixelCount}px changed`
        : `✗ NO visible indicator (${result.existence.changedPixelCount}px)`;

      if (result.existence.hasVisibleChange) {
        hasIndicatorCount++;
      } else {
        noIndicatorCount++;
      }

      // M2-02: CSS changes
      const changeCount = result.cssAnalysis.computedChanges.length;
      if (changeCount > 0) styleChangeCount++;

      const cssLabel = changeCount > 0
        ? `${changeCount} CSS change(s): ${result.cssAnalysis.computedChanges.map(c => c.property).join(", ")}`
        : "no CSS changes";

      let outlineWarning = "";
      if (result.cssAnalysis.outlineState === "removed") {
        outlineWarning = " ⚠ outline actively removed on focus, no replacement!";
        outlineRemovedCount++;
      } else if (result.cssAnalysis.outlineState === "never") {
        outlineWarning = " ⚠ no outline in either state, no replacement";
        outlineNeverCount++;
      }

      // M2-03: Contrast ratio
      let contrastLabel: string;
      if (!result.existence.hasVisibleChange) {
        contrastLabel = "n/a (no visible change)";
      } else if (result.contrast.medianContrast >= 3) {
        contrastLabel = `✓ median ${result.contrast.medianContrast}:1, min ${result.contrast.minContrast}:1, ${result.contrast.percentMeeting3to1}% ≥ 3:1`;
        contrastPassCount++;
      } else {
        contrastLabel = `✗ median ${result.contrast.medianContrast}:1, min ${result.contrast.minContrast}:1, ${result.contrast.percentMeeting3to1}% ≥ 3:1`;
        contrastFailCount++;
      }

      // M2-04: Area measurement
      let areaLabel: string;
      if (!result.existence.hasVisibleChange) {
        areaLabel = "n/a (no visible change)";
      } else if (result.area.areaRatio >= 1) {
        areaLabel = `✓ ${result.area.qualifyingPixelCount}px qualifying, ${result.area.minimumRequiredArea}px required (ratio ${result.area.areaRatio}), ${Math.round(result.area.perimeterCoverage * 100)}% perimeter`;
        areaPassCount++;
      } else {
        areaLabel = `✗ ${result.area.qualifyingPixelCount}px qualifying, ${result.area.minimumRequiredArea}px required (ratio ${result.area.areaRatio}), ${Math.round(result.area.perimeterCoverage * 100)}% perimeter`;
        areaFailCount++;
      }

      console.log(
        `  <${result.tag}> ${result.selector}`
      );
      console.log(
        `    M2-01: ${existLabel}`
      );
      console.log(
        `    M2-02: ${cssLabel}${outlineWarning}`
      );
      console.log(
        `    M2-03: ${contrastLabel}`
      );
      console.log(
        `    M2-04: ${areaLabel}`
      );
      console.log(
        `    M2-05: ${result.score.score}/100 (${result.score.level})`
      );

      scoreCounts[result.score.level]++;
      scoreTotal += result.score.score;
    }

    console.log(
      `\n  M2-01 Summary: ${hasIndicatorCount} with indicator, ${noIndicatorCount} without`
    );
    console.log(
      `  M2-02 Summary: ${styleChangeCount} with CSS changes, ${outlineRemovedCount} outline actively removed, ${outlineNeverCount} outline never present`
    );
    console.log(
      `  M2-03 Summary: ${contrastPassCount} pass (median ≥ 3:1), ${contrastFailCount} fail`
    );
    console.log(
      `  M2-04 Summary: ${areaPassCount} pass (area ratio ≥ 1.0), ${areaFailCount} fail`
    );
    const avgScore = indicatorResults.length > 0
      ? Math.round(scoreTotal / indicatorResults.length)
      : 0;
    console.log(
      `  M2-05 Summary: avg ${avgScore}/100 | ${scoreCounts.excellent} excellent, ${scoreCounts.good} good, ${scoreCounts.partial} partial, ${scoreCounts.poor} poor, ${scoreCounts.none} none`
    );
    console.log(`  Diff images saved to: ${outputDir}`);

    // ============================================================
    // MODULE 3: Interactive Element Coverage
    // ============================================================

    console.log("\n" + "=".repeat(60));
    console.log("MODULE 3: Interactive Element Coverage");
    console.log("=".repeat(60));

    // Build the full set of keyboard-reachable selectors from both M1 and M2.
    // M1 may miss elements beyond a keyboard trap; M2 does its own traversal.
    const m2ReachableSelectors = indicatorResults.map((r) => r.selector);

    const m3Results = await analyzeInteractiveCoverage(
      page,
      uniqueStops,
      m2ReachableSelectors,
      (phase, detail) => {
        process.stdout.write(`\r  [${phase}] ${detail}          `);
      }
    );
    process.stdout.write("\n");

    // M3-01: Coverage Gap
    console.log("\nM3-01: Pointer-Interactive vs. Keyboard-Reachable Gap");
    console.log(
      `  Total interactive: ${m3Results.coverageGap.totalInteractive} | ` +
      `Keyboard-reachable: ${m3Results.coverageGap.totalReachable} | ` +
      `Coverage: ${m3Results.coverageGap.coveragePercent}%`
    );

    if (m3Results.coverageGap.unreachableElements.length === 0) {
      console.log("  ✓ All interactive elements are keyboard-reachable.");
    } else {
      console.log(
        `  ✗ ${m3Results.coverageGap.unreachableElements.length} unreachable element(s):`
      );
      for (const el of m3Results.coverageGap.unreachableElements) {
        const signals: string[] = [];
        if (el.hasClickHandler) signals.push("click handler");
        if (el.hasCursorPointer) signals.push("cursor:pointer");
        if (el.role) signals.push(`role="${el.role}"`);
        console.log(
          `    ✗ <${el.tag}> ${el.selector} [${signals.join(", ")}]`
        );
      }
    }

    // M3-02: Non-Semantic Controls
    console.log("\nM3-02: Non-Semantic Interactive Element Detection");

    if (m3Results.nonSemanticControls.length === 0) {
      console.log("  ✓ No inaccessible non-semantic controls found.");
    } else {
      console.log(
        `  ✗ ${m3Results.nonSemanticControls.length} non-semantic control(s) with issues:`
      );
      for (const ctrl of m3Results.nonSemanticControls) {
        const attrs: string[] = [];
        if (ctrl.hasTabindex) attrs.push("tabindex ✓");
        else attrs.push("tabindex ✗");
        if (ctrl.hasRole) attrs.push("role ✓");
        else attrs.push("role ✗");
        if (ctrl.hasKeyHandler) attrs.push("key handler ✓");
        else attrs.push("key handler ✗");

        console.log(
          `    ✗ <${ctrl.tag}> ${ctrl.selector} [${attrs.join(", ")}]`
        );
        for (const issue of ctrl.issues) {
          console.log(`      → ${issue}`);
        }
      }
    }

    // M3-03: Scrollable Regions
    console.log("\nM3-03: Scrollable Region Keyboard Access");

    if (m3Results.scrollableRegions.length === 0) {
      console.log("  ✓ No scrollable regions found (or none with overflow).");
    } else {
      let inaccessibleScrollCount = 0;
      for (const region of m3Results.scrollableRegions) {
        const isAccessible = region.isFocusable || region.hasFocusableChild;
        if (!isAccessible) {
          inaccessibleScrollCount++;
          console.log(
            `  ✗ ${region.selector} — scrollable (${region.scrollHeight}px content in ${region.clientHeight}px container) but NOT keyboard-accessible`
          );
        } else {
          const method = region.isFocusable
            ? "focusable container"
            : "has focusable child";
          console.log(
            `  ✓ ${region.selector} — scrollable, accessible via ${method}`
          );
        }
      }
      if (inaccessibleScrollCount === 0) {
        console.log("  ✓ All scrollable regions are keyboard-accessible.");
      } else {
        console.log(`  ${inaccessibleScrollCount} inaccessible scrollable region(s).`);
      }
    }

  } finally {
    await browser.close();
  }
}

main();
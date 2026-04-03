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

    // M2-01 + M2-02 Part A: Combined traversal pass
    console.log("\nM2-01/M2-02a: Checking focus indicators...");

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
    let styleChangeCount = 0;

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

      const outlineWarning = result.cssAnalysis.outlineRemoved
        ? " ⚠ outline removed, no replacement!"
        : "";

      if (result.cssAnalysis.outlineRemoved) outlineRemovedCount++;

      console.log(
        `  <${result.tag}> ${result.selector}`
      );
      console.log(
        `    M2-01: ${existLabel}`
      );
      console.log(
        `    M2-02: ${cssLabel}${outlineWarning}`
      );
    }

    console.log(
      `\n  M2-01 Summary: ${hasIndicatorCount} with indicator, ${noIndicatorCount} without`
    );
    console.log(
      `  M2-02 Summary: ${styleChangeCount} with CSS changes, ${outlineRemovedCount} with outline removed (no replacement)`
    );
    console.log(`  Diff images saved to: ${outputDir}`);

  } finally {
    await browser.close();
  }
}

main();
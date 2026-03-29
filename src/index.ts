import { launchAndNavigate } from "./utils/browser";
import {
  injectHelpers,
  recordTabStops,
  detectTraps,
  analyzeFocusOrder,
  verifySkipLink,
  detectObscured,
} from "./modules/traversal";

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
    console.log(`\nForward: ${forwardStops.length} tab stops`);
    for (const stop of forwardStops) {
      console.log(`  [${stop.index}] <${stop.tag}> ${stop.selector}`);
    }

    // M1-01: Backward traversal
    const backwardStops = await recordTabStops(page, "backward");
    console.log(`\nBackward: ${backwardStops.length} tab stops`);

    if (forwardStops.length === backwardStops.length) {
      console.log("✓ Forward and backward counts match.");
    } else {
      console.log(
        `✗ Count mismatch: forward=${forwardStops.length}, backward=${backwardStops.length}`
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

    // M1-03: Focus order analysis
    console.log("\nAnalyzing focus order vs. visual layout...");
    const focusOrder = analyzeFocusOrder(forwardStops);
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
    // M1-05: Focus not obscured detection
    console.log("\nChecking for obscured focus...");
    const obscured = await detectObscured(page, forwardStops);

    let obscuredCount = 0;
    let partialCount = 0;
    for (const [idx, result] of obscured) {
      if (result.fullyObscured) {
        obscuredCount++;
        console.log(
          `  ✗ [${idx}] ${forwardStops[idx].selector} — fully obscured by ${result.obscuringElement}`
        );
      } else if (result.partiallyObscured) {
        partialCount++;
        console.log(
          `  ⚠ [${idx}] ${forwardStops[idx].selector} — ${result.overlapPercent}% obscured by ${result.obscuringElement}`
        );
      }
    }
    if (obscuredCount === 0 && partialCount === 0) {
      console.log("  ✓ No focused elements are obscured.");
    } else {
      console.log(`  ${obscuredCount} fully obscured, ${partialCount} partially obscured.`);
    }
  } finally {
    await browser.close();
  }
}

main();
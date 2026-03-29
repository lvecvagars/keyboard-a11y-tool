import { launchAndNavigate } from "./utils/browser";
import { recordTabStops, detectTraps } from "./modules/traversal";

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error("Usage: npx ts-node src/index.ts <url>");
    process.exit(1);
  }

  console.log(`Evaluating: ${url}`);

  const { browser, page } = await launchAndNavigate(url);

  try {
    // M1-01: Forward traversal
    const forwardStops = await recordTabStops(page, "forward");
    console.log(`\nForward: ${forwardStops.length} tab stops`);
    for (const stop of forwardStops) {
      console.log(
        `  [${stop.index}] <${stop.tag}> ${stop.selector}`
      );
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
        console.log(`  Trapped elements: ${trap.trappedElements.join(", ")}`);
        for (const attempt of trap.escapeAttempts) {
          console.log(
            `  ${attempt.escaped ? "✓" : "✗"} ${attempt.key}: ${attempt.escaped ? "escaped" : "still trapped"}`
          );
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main();
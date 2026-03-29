import { launchAndNavigate } from "./utils/browser";
import { recordTabStops } from "./modules/traversal";

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error("Usage: npx ts-node src/index.ts <url>");
    process.exit(1);
  }

  console.log(`Evaluating: ${url}`);

  const { browser, page } = await launchAndNavigate(url);

  try {
    const forwardStops = await recordTabStops(page, "forward");
    console.log(`\nForward: ${forwardStops.length} tab stops`);
    for (const stop of forwardStops) {
      console.log(
        `  [${stop.index}] <${stop.tag}> ${stop.selector}`
      );
    }

    const backwardStops = await recordTabStops(page, "backward");
    console.log(`\nBackward: ${backwardStops.length} tab stops`);
    for (const stop of backwardStops) {
      console.log(
        `  [${stop.index}] <${stop.tag}> ${stop.selector}`
      );
    }

    // Quick sanity check: both passes should find the same number of stops
    if (forwardStops.length === backwardStops.length) {
      console.log("\n✓ Forward and backward counts match.");
    } else {
      console.log(
        `\n✗ Count mismatch: forward=${forwardStops.length}, backward=${backwardStops.length}`
      );
    }
  } finally {
    await browser.close();
  }
}

main();
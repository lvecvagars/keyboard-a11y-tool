/**
 * CLI entry point.
 *
 * Now delegates to evaluate.ts for the actual evaluation logic.
 * This file just handles argument parsing and console output.
 */

import { runEvaluation } from "./evaluate";

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error("Usage: npx ts-node src/index.ts <url>");
    console.error("   or: npm run cli -- <url>");
    process.exit(1);
  }

  console.log(`Evaluating: ${url}\n`);

  try {
    const result = await runEvaluation(url, (message) => {
      console.log(`  ${message}`);
    });

    console.log(`\n${"=".repeat(60)}`);
    console.log("REPORT");
    console.log("=".repeat(60));
    console.log(`  ${result.report.issues.length} issues total: ${result.report.summary.criticalCount} critical, ${result.report.summary.warningCount} warning, ${result.report.summary.moderateCount} moderate, ${result.report.summary.infoCount} info`);
    console.log(`  JSON report: ${result.jsonPath}`);
    console.log(`  HTML report: ${result.htmlPath}`);
    console.log(`  Duration: ${(result.report.durationMs / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error("Evaluation failed:", err);
    process.exit(1);
  }
}

main();
/**
 * Batch evaluation runner.
 *
 * Reads URLs from a text file (one per line), runs the full evaluation
 * pipeline on each sequentially, and writes:
 *   - Per-site HTML + JSON reports (via runEvaluation, into output/)
 *   - An aggregate CSV summary (one row per URL)
 *
 * Usage:
 *   npx ts-node src/batch.ts <url-file> [--output <csv-path>]
 *
 * Example url-file (sites.txt):
 *   https://www.example.com
 *   https://gov.uk
 *   # Lines starting with # are skipped
 *   https://www.delfi.lv
 *
 * The CSV is written to output/batch-<timestamp>.csv by default.
 */

import * as fs from "fs";
import * as path from "path";
import { runEvaluation, EvaluationResult } from "./evaluate";

// ---- Types ----

interface BatchRow {
  url: string;
  status: "success" | "error";
  errorMessage: string;
  durationSec: string;
  totalTabStops: number;
  totalIssues: number;
  criticalCount: number;
  warningCount: number;
  moderateCount: number;
  infoCount: number;
  avgVisibilityScore: number;
  keyboardCoveragePercent: number;
  htmlReportPath: string;
  jsonReportPath: string;
}

// ---- CSV helpers ----

const CSV_COLUMNS: (keyof BatchRow)[] = [
  "url",
  "status",
  "errorMessage",
  "durationSec",
  "totalTabStops",
  "totalIssues",
  "criticalCount",
  "warningCount",
  "moderateCount",
  "infoCount",
  "avgVisibilityScore",
  "keyboardCoveragePercent",
  "htmlReportPath",
  "jsonReportPath",
];

function escCsv(val: string | number): string {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowToCsv(row: BatchRow): string {
  return CSV_COLUMNS.map((col) => escCsv(row[col])).join(",");
}

// ---- Argument parsing ----

function parseArgs(): { urlFile: string; csvPath: string | null } {
  const args = process.argv.slice(2);
  let urlFile = "";
  let csvPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      csvPath = args[++i];
    } else if (!urlFile) {
      urlFile = args[i];
    }
  }

  if (!urlFile) {
    console.error("Usage: npx ts-node src/batch.ts <url-file> [--output <csv-path>]");
    console.error("");
    console.error("  <url-file>  Text file with one URL per line (# comments allowed)");
    console.error("  --output    Path for the CSV summary (default: output/batch-<timestamp>.csv)");
    process.exit(1);
  }

  return { urlFile, csvPath };
}

function readUrls(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// ---- ANSI colors ----

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

// ---- Main ----

async function main() {
  const { urlFile, csvPath } = parseArgs();
  const urls = readUrls(urlFile);

  if (urls.length === 0) {
    console.error("No URLs found in file.");
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputCsv = csvPath || path.join("output", `batch-${timestamp}.csv`);

  console.log(`${C.bold}Batch keyboard accessibility evaluation${C.reset}`);
  console.log(`  URLs:   ${urls.length}`);
  console.log(`  Source: ${urlFile}`);
  console.log(`  CSV:    ${outputCsv}`);
  console.log();

  fs.mkdirSync(path.dirname(outputCsv), { recursive: true });

  // Write CSV header
  fs.writeFileSync(outputCsv, CSV_COLUMNS.join(",") + "\n");

  const rows: BatchRow[] = [];
  let successCount = 0;
  let errorCount = 0;
  const batchStart = Date.now();

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const num = `[${i + 1}/${urls.length}]`;

    console.log(`${C.cyan}${num}${C.reset} ${url}`);

    const siteStart = Date.now();
    let row: BatchRow;

    try {
      const result: EvaluationResult = await runEvaluation(url, (msg) => {
        // Show condensed progress — only module transitions and final line
        if (
          msg.startsWith("M1-01:") && msg.includes("unique") ||
          msg.startsWith("M1-02:") ||
          msg.startsWith("M2-05:") ||
          msg.startsWith("M3-01:") ||
          msg.startsWith("Pabeigts")
        ) {
          console.log(`  ${C.dim}${msg}${C.reset}`);
        }
      });

      const s = result.report.summary;
      const dur = ((Date.now() - siteStart) / 1000).toFixed(1);

      row = {
        url,
        status: "success",
        errorMessage: "",
        durationSec: dur,
        totalTabStops: s.totalTabStops,
        totalIssues: s.totalIssues,
        criticalCount: s.criticalCount,
        warningCount: s.warningCount,
        moderateCount: s.moderateCount,
        infoCount: s.infoCount,
        avgVisibilityScore: s.averageVisibilityScore,
        keyboardCoveragePercent: s.keyboardCoveragePercent,
        htmlReportPath: result.htmlPath,
        jsonReportPath: result.jsonPath,
      };

      successCount++;

      const sevStr = s.criticalCount > 0
        ? `${C.red}${s.criticalCount} critical${C.reset}`
        : `${C.green}0 critical${C.reset}`;
      console.log(
        `  ${C.green}OK${C.reset} ${dur}s — ` +
        `${s.totalTabStops} stops, ${s.totalIssues} issues (${sevStr}), ` +
        `score ${s.averageVisibilityScore}/100, coverage ${s.keyboardCoveragePercent}%`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const dur = ((Date.now() - siteStart) / 1000).toFixed(1);

      row = {
        url,
        status: "error",
        errorMessage: msg,
        durationSec: dur,
        totalTabStops: 0,
        totalIssues: 0,
        criticalCount: 0,
        warningCount: 0,
        moderateCount: 0,
        infoCount: 0,
        avgVisibilityScore: 0,
        keyboardCoveragePercent: 0,
        htmlReportPath: "",
        jsonReportPath: "",
      };

      errorCount++;
      console.log(`  ${C.red}ERROR${C.reset} ${dur}s — ${msg}`);
    }

    rows.push(row);

    // Append row to CSV immediately (so partial results survive a crash)
    fs.appendFileSync(outputCsv, rowToCsv(row) + "\n");

    console.log();
  }

  // ---- Summary ----
  const totalTime = ((Date.now() - batchStart) / 1000).toFixed(1);

  console.log("─".repeat(60));
  console.log(`${C.bold}Batch complete${C.reset}`);
  console.log(`  ${C.green}${successCount} succeeded${C.reset}, ${errorCount > 0 ? C.red : C.dim}${errorCount} failed${C.reset}`);
  console.log(`  Total time: ${totalTime}s`);
  console.log(`  CSV: ${outputCsv}`);

  if (successCount > 0) {
    const successful = rows.filter((r) => r.status === "success");

    const avgIssues = (
      successful.reduce((sum, r) => sum + r.totalIssues, 0) / successful.length
    ).toFixed(1);

    const avgScore = (
      successful.reduce((sum, r) => sum + r.avgVisibilityScore, 0) / successful.length
    ).toFixed(1);

    const avgCoverage = (
      successful.reduce((sum, r) => sum + r.keyboardCoveragePercent, 0) / successful.length
    ).toFixed(1);

    const totalCritical = successful.reduce((sum, r) => sum + r.criticalCount, 0);

    console.log();
    console.log(`  ${C.bold}Aggregates across ${successful.length} sites:${C.reset}`);
    console.log(`    Avg issues:   ${avgIssues}`);
    console.log(`    Avg score:    ${avgScore}/100`);
    console.log(`    Avg coverage: ${avgCoverage}%`);
    console.log(`    Total critical: ${totalCritical}`);
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${C.red}Batch runner crashed:${C.reset}`, err);
  process.exit(2);
});
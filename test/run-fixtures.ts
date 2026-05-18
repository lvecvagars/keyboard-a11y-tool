// Fixture runner: loads each HTML test page via file://, runs the full
// pipeline, asserts issue counts match expectations.

import * as path from "path";
import { runEvaluation } from "../src/evaluate";
import { Severity } from "../src/types";

interface Expectation {
  checks?: Partial<Record<string, number>>;
  maxCritical?: number;
  maxTotal?: number;
}

interface FixtureSpec {
  file: string;
  description: string;
  expect: Expectation;
}

const FIXTURES: FixtureSpec[] = [
  {
    file: "m0-clean-page.html",
    description: "Fully accessible page — should produce zero issues",
    expect: { maxCritical: 0, maxTotal: 0 },
  },
  {
    file: "m1-01-basic-tabs.html",
    description: "Clean page with a simple forward/backward tab sequence",
    expect: { maxCritical: 0 },
  },
  {
    file: "m1-02-keyboard-trap.html",
    description: "Two buttons that trap focus between each other",
    expect: { checks: { "M1-02": 1 } },
  },
  {
    file: "m1-03-reordered-grid.html",
    description: "CSS grid with order properties diverging from DOM order",
    expect: { checks: { "M1-03": 1 } },
  },
  {
    file: "m1-03-positive-tabindex.html",
    description: "Buttons with positive tabindex values",
    expect: { checks: { "M1-03": 2 } },
  },
  {
    file: "m1-04-no-skip-link.html",
    description: "Page with navigation but no skip link",
    expect: { checks: { "M1-04": 1 } },
  },
  {
    file: "m1-04-broken-skip-link.html",
    description: "Skip link whose target doesn't exist",
    expect: { checks: { "M1-04": 1 } },
  },
  {
    file: "m1-05-sticky-obscures.html",
    description: "Sticky header that obscures focused content when scrolled",
    expect: { checks: { "M1-05": 1 } },
  },
  {
    file: "m2-01-no-focus-indicator.html",
    description: "Button with no visible focus state change",
    expect: { checks: { "M2-01": 1 } },
  },
  {
    file: "m2-02-outline-removed.html",
    description: "outline: none on :focus with no replacement",
    expect: { checks: { "M2-02": 1 } },
  },
  {
    file: "m2-03-low-contrast-indicator.html",
    description: "Visible focus outline with contrast below 3:1",
    expect: { checks: { "M2-03": 1 } },
  },
  {
    file: "m2-04-indicator-too-small.html",
    description: "1px outline, below WCAG 2.4.13 area minimum",
    expect: { checks: { "M2-04": 1 } },
  },
  {
    file: "m3-01-clickable-div-unreachable.html",
    description: "Div with role=button and click handler but no tabindex",
    // M3-02 subsumes M3-01 for non-semantic elements
    expect: { checks: { "M3-02": 1 } },
  },
  {
    file: "m3-02-non-semantic-button.html",
    description: "Div with click handler, no tabindex/role/key handler",
    expect: { checks: { "M3-02": 1 } },
  },
  {
    file: "m3-03-scrollable-no-access.html",
    description: "Scrollable div with no tabindex and no focusable children",
    expect: { checks: { "M3-03": 1 } },
  },
];

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
};

interface FixtureResult {
  spec: FixtureSpec;
  passed: boolean;
  failures: string[];
  actual: {
    total: number;
    bySeverity: Record<Severity, number>;
    byCheck: Record<string, number>;
  };
  durationMs: number;
}

function summarize(issues: { checkId: string; severity: Severity }[]) {
  const byCheck: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = {
    critical: 0, warning: 0, moderate: 0, info: 0,
  };
  for (const issue of issues) {
    byCheck[issue.checkId] = (byCheck[issue.checkId] || 0) + 1;
    bySeverity[issue.severity]++;
  }
  return { byCheck, bySeverity };
}

function validate(
  expect: Expectation,
  total: number,
  bySeverity: Record<Severity, number>,
  byCheck: Record<string, number>
): string[] {
  const failures: string[] = [];

  if (expect.checks) {
    for (const [checkId, minCount] of Object.entries(expect.checks)) {
      if (minCount === undefined) continue;
      const actual = byCheck[checkId] || 0;
      if (actual < minCount) {
        failures.push(`expected ≥${minCount} ${checkId}, got ${actual}`);
      }
    }
  }

  if (expect.maxCritical !== undefined && bySeverity.critical > expect.maxCritical) {
    failures.push(`expected ≤${expect.maxCritical} critical, got ${bySeverity.critical}`);
  }

  if (expect.maxTotal !== undefined && total > expect.maxTotal) {
    failures.push(`expected ≤${expect.maxTotal} total, got ${total}`);
  }

  return failures;
}

async function runFixture(spec: FixtureSpec): Promise<FixtureResult> {
  const fixturePath = path.join(__dirname, "fixtures", spec.file);
  const startTime = Date.now();

  try {
    const result = await runEvaluation(fixturePath, () => {});
    const issues = result.report.issues;
    const { byCheck, bySeverity } = summarize(issues);
    const failures = validate(spec.expect, issues.length, bySeverity, byCheck);

    return {
      spec, passed: failures.length === 0, failures,
      actual: { total: issues.length, bySeverity, byCheck },
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      spec, passed: false, failures: [`evaluation threw: ${msg}`],
      actual: {
        total: 0,
        bySeverity: { critical: 0, warning: 0, moderate: 0, info: 0 },
        byCheck: {},
      },
      durationMs: Date.now() - startTime,
    };
  }
}

function formatCounts(byCheck: Record<string, number>): string {
  const entries = Object.entries(byCheck).sort();
  if (entries.length === 0) return "no issues";
  return entries.map(([k, v]) => `${k}:${v}`).join(" ");
}

async function main() {
  console.log(`${C.bold}Keyboard-a11y-tool fixture tests${C.reset}\n`);
  console.log(`Running ${FIXTURES.length} fixture(s)...\n`);

  const results: FixtureResult[] = [];
  for (const spec of FIXTURES) {
    process.stdout.write(`  ${spec.file.padEnd(42)} `);
    const result = await runFixture(spec);
    results.push(result);

    const timeStr = `${C.dim}(${(result.durationMs / 1000).toFixed(1)}s)${C.reset}`;

    if (result.passed) {
      console.log(`${C.green}PASS${C.reset} ${timeStr}`);
      console.log(`    ${C.dim}${formatCounts(result.actual.byCheck)}${C.reset}`);
    } else {
      console.log(`${C.red}FAIL${C.reset} ${timeStr}`);
      console.log(`    ${C.dim}${spec.description}${C.reset}`);
      console.log(`    ${C.dim}actual: ${formatCounts(result.actual.byCheck)}${C.reset}`);
      for (const failure of result.failures) {
        console.log(`    ${C.red}✗${C.reset} ${failure}`);
      }
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log();
  console.log("─".repeat(60));
  if (failed === 0) {
    console.log(
      `${C.green}${C.bold}All ${passed} fixture(s) passed${C.reset} ` +
      `${C.dim}in ${(totalTime / 1000).toFixed(1)}s${C.reset}`
    );
    process.exit(0);
  } else {
    console.log(
      `${C.red}${C.bold}${failed} failed${C.reset}, ` +
      `${C.green}${passed} passed${C.reset} ` +
      `${C.dim}in ${(totalTime / 1000).toFixed(1)}s${C.reset}`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${C.red}Runner crashed:${C.reset}`, err);
  process.exit(2);
});
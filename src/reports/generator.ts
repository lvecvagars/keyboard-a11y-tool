/**
 * Report Generator
 *
 * Collects results from all three modules, flattens them into a list of
 * issues with severity and remediation, computes summary statistics,
 * and outputs both JSON and HTML reports.
 */

import * as fs from "fs";
import * as path from "path";
import {
  TabStop,
  TrapResult,
  FocusOrderResult,
  SkipLinkResult,
  ObscuredResult,
  ReportIssue,
  ReportSummary,
  Severity,
  CoverageGap,
  NonSemanticControl,
  ScrollableRegion,
} from "../types";
import { IndicatorAnalysis } from "../modules/visibility";
import { OutlineOverrideRule } from "../modules/visibility";

// ---- Issue Generation ----

/**
 * Generate issues from Module 1 results.
 */
export function generateM1Issues(
  forwardStops: TabStop[],
  uniqueStops: TabStop[],
  backwardStops: TabStop[],
  uniqueBackward: TabStop[],
  traps: TrapResult[],
  focusOrder: FocusOrderResult,
  skipLink: SkipLinkResult,
  obscuredResults: Map<number, ObscuredResult>,
  allStops: TabStop[]
): ReportIssue[] {
  const issues: ReportIssue[] = [];

  // M1-01: Forward/backward mismatch
  if (uniqueStops.length !== uniqueBackward.length) {
    issues.push({
      checkId: "M1-01",
      wcagCriterion: "2.4.3",
      severity: "warning",
      elementSelector: "page",
      description: `Forward traversal found ${uniqueStops.length} unique stops, backward found ${uniqueBackward.length}. The tab sequence may not be fully reversible.`,
      remediation: "Ensure all focusable elements are reachable in both forward (Tab) and backward (Shift+Tab) directions. Check for elements that programmatically manage focus in only one direction.",
    });
  }

  // M1-02: Keyboard traps
  for (const trap of traps) {
    issues.push({
      checkId: "M1-02",
      wcagCriterion: "2.1.2",
      severity: "critical",
      elementSelector: trap.location,
      description: trap.isTrap
        ? `Keyboard trap confirmed. Focus cycles between ${trap.trappedElements.length} elements (${trap.trappedElements.join(", ")}) with no escape.`
        : `Suspected keyboard trap at ${trap.location}, but escape was possible via ${trap.escapeAttempts.filter(a => a.escaped).map(a => a.key).join(", ")}.`,
      remediation: "Remove the keyboard trap. Ensure users can navigate away from all focusable elements using Tab, Shift+Tab, or Escape. If a modal or widget intentionally constrains focus, provide a clearly labeled close/exit mechanism.",
    });
  }

  // M1-03: Focus order violations
  if (focusOrder.correlationScore < 0.7) {
    issues.push({
      checkId: "M1-03",
      wcagCriterion: "2.4.3",
      severity: "warning",
      elementSelector: "page",
      description: `Focus order has low correlation with visual layout (Spearman ρ = ${focusOrder.correlationScore}). The tab sequence may be confusing for sighted keyboard users.`,
      remediation: "Review the DOM order to ensure it follows the visual reading order. Avoid using CSS reordering (flexbox order, grid order) that diverges from source order. If layout requires visual reordering, adjust the DOM order to match.",
    });
  }
  for (const v of focusOrder.violations) {
    if (v.direction === "other") {
      issues.push({
        checkId: "M1-03",
        wcagCriterion: "2.4.3",
        severity: "warning",
        elementSelector: v.fromElement,
        description: `Element has tabindex > 0, which overrides natural tab order and is a known anti-pattern.`,
        remediation: "Remove the positive tabindex value. Use tabindex=\"0\" to make elements focusable in DOM order, or restructure the DOM so elements appear in the desired order naturally.",
      });
    } else if (v.direction === "backward-vertical") {
      issues.push({
        checkId: "M1-03",
        wcagCriterion: "2.4.3",
        severity: "warning",
        elementSelector: v.toElement,
        description: `Focus jumps backward ${v.jumpDistance}px vertically from ${v.fromElement} to ${v.toElement}.`,
        remediation: "Review the DOM order of these elements. A large backward jump suggests the source order doesn't match the visual layout.",
      });
    }
  }

  // M1-04: Skip link
  if (!skipLink.exists) {
    issues.push({
      checkId: "M1-04",
      wcagCriterion: "2.4.1",
      severity: "moderate",
      elementSelector: "page",
      description: "No skip link found. Keyboard users must tab through all navigation elements to reach main content.",
      remediation: "Add a skip link as the first focusable element on the page. Use <a href=\"#main-content\">Skip to main content</a> and ensure the target element has id=\"main-content\" and is focusable (add tabindex=\"-1\" if needed).",
    });
  } else if (!skipLink.targetReachable) {
    issues.push({
      checkId: "M1-04",
      wcagCriterion: "2.4.1",
      severity: "moderate",
      elementSelector: skipLink.targetSelector || "unknown",
      description: `Skip link exists but its target (${skipLink.targetSelector}) is not reachable — focus did not move to the target when activated.`,
      remediation: "Ensure the skip link's target element exists, has the correct id, and is focusable. Add tabindex=\"-1\" to the target element if it's not natively focusable.",
    });
  }

  // M1-05: Obscured elements
  for (const [idx, result] of obscuredResults) {
    const stop = allStops.find(s => s.index === idx);
    if (result.fullyObscured) {
      issues.push({
        checkId: "M1-05",
        wcagCriterion: "2.4.11",
        severity: "critical",
        elementSelector: stop?.selector || `tab-stop-${idx}`,
        description: `Focused element is fully obscured (100%) by ${result.obscuringElement}.`,
        remediation: "Ensure focused elements are not hidden behind fixed or sticky positioned elements. Use scroll-padding-top or scroll-margin-top to offset content below sticky headers. Dismiss or reposition overlays (cookie banners, chat widgets) when they obscure focused content.",
      });
    } else if (result.partiallyObscured) {
      issues.push({
        checkId: "M1-05",
        wcagCriterion: "2.4.11",
        severity: "warning",
        elementSelector: stop?.selector || `tab-stop-${idx}`,
        description: `Focused element is ${result.overlapPercent}% obscured by ${result.obscuringElement}.`,
        remediation: "Ensure focused elements are not partially hidden behind fixed or sticky positioned elements. Use scroll-padding or adjust layout so focused elements remain fully visible.",
      });
    }
  }

  return issues;
}

/**
 * Generate issues from Module 2 results.
 */
export function generateM2Issues(
  indicatorResults: IndicatorAnalysis[],
  outlineOverrides: OutlineOverrideRule[]
): ReportIssue[] {
  const issues: ReportIssue[] = [];

  // M2-02 Part B: Stylesheet outline removal
  for (const rule of outlineOverrides) {
    if (!rule.hasReplacement) {
      issues.push({
        checkId: "M2-02",
        wcagCriterion: "2.4.7",
        severity: "critical",
        elementSelector: rule.selectorText,
        description: `CSS rule "${rule.selectorText}" removes outline on :focus with no replacement style (source: ${rule.source}).`,
        remediation: "Do not remove the default focus outline unless you provide an equally visible replacement. Add box-shadow, border, or a custom outline in the same rule.",
      });
    }
  }

  // Per-element results from the traversal pass
  for (const r of indicatorResults) {
    const scoreTag = ` Visibility score: ${r.score.score}/100 (${r.score.level}).`;

    // M2-01: No visible indicator
    if (!r.existence.hasVisibleChange) {
      issues.push({
        checkId: "M2-01",
        wcagCriterion: "2.4.7",
        severity: "critical",
        elementSelector: r.selector,
        description: `No visible focus indicator detected (${r.existence.changedPixelCount} changed pixels, threshold is 10).${scoreTag}`,
        remediation: "Add a visible focus indicator using :focus or :focus-visible. Use outline, box-shadow, or border that contrasts with the surrounding background.",
        screenshotPath: r.existence.diffImagePath || undefined,
      });
      continue; // Skip contrast/area checks — no indicator to measure
    }

    // M2-02: Outline actively removed
    if (r.cssAnalysis.outlineState === "removed") {
      issues.push({
        checkId: "M2-02",
        wcagCriterion: "2.4.7",
        severity: "critical",
        elementSelector: r.selector,
        description: `Default outline is actively removed on focus with no replacement CSS property.${scoreTag}`,
        remediation: "Do not suppress the focus outline without providing an alternative. Add box-shadow, border, or background-color change in the same :focus rule.",
      });
    }

    // M2-03: Contrast ratio
    if (r.contrast.medianContrast < 3) {
      issues.push({
        checkId: "M2-03",
        wcagCriterion: "2.4.13",
        severity: "warning",
        elementSelector: r.selector,
        description: `Focus indicator contrast is below 3:1 (median ${r.contrast.medianContrast}:1, ${r.contrast.percentMeeting3to1}% of pixels meet threshold).${scoreTag}`,
        remediation: "Increase the contrast of the focus indicator. Use a color that differs from both the element's background and the page background by at least 3:1. Dark outlines on light backgrounds or vice versa work well.",
        screenshotPath: r.existence.diffImagePath || undefined,
      });
    }

    // M2-04: Area
    if (r.area.areaRatio < 1) {
      issues.push({
        checkId: "M2-04",
        wcagCriterion: "2.4.13",
        severity: "warning",
        elementSelector: r.selector,
        description: `Focus indicator area is below WCAG 2.4.13 minimum (${r.area.qualifyingPixelCount}px qualifying vs ${r.area.minimumRequiredArea}px required, ratio ${r.area.areaRatio}).${scoreTag}`,
        remediation: "Increase the size of the focus indicator. Use an outline or border at least 2px thick around the entire element perimeter. Ensure the indicator meets both the minimum area and 3:1 contrast requirements.",
        screenshotPath: r.existence.diffImagePath || undefined,
      });
    }
  }

  return issues;
}

/**
 * Generate issues from Module 3 results.
 */
export function generateM3Issues(
  coverageGap: CoverageGap,
  nonSemanticControls: NonSemanticControl[],
  scrollableRegions: ScrollableRegion[]
): ReportIssue[] {
  const issues: ReportIssue[] = [];

  // M3-01: Unreachable interactive elements
  for (const el of coverageGap.unreachableElements) {
    const signals: string[] = [];
    if (el.hasClickHandler) signals.push("click handler");
    if (el.hasCursorPointer) signals.push("cursor:pointer");
    if (el.role) signals.push(`role="${el.role}"`);

    issues.push({
      checkId: "M3-01",
      wcagCriterion: "2.1.1",
      severity: el.role ? "critical" : "warning",
      elementSelector: el.selector,
      description: `Interactive element (${signals.join(", ")}) is not keyboard-reachable. Mouse users can interact with it but keyboard users cannot.`,
      remediation: el.role
        ? `This element has role="${el.role}" but is not focusable. Add tabindex="0" and ensure keyboard event handlers (keydown for Enter/Space) are present.`
        : "Make this element keyboard-accessible by using a native interactive element (<button>, <a href>) instead, or add tabindex=\"0\", an appropriate ARIA role, and keyboard event handlers.",
    });
  }

  // M3-02: Non-semantic interactive controls
  for (const ctrl of nonSemanticControls) {
    issues.push({
      checkId: "M3-02",
      wcagCriterion: "2.1.1",
      severity: "critical",
      elementSelector: ctrl.selector,
      description: `Non-semantic <${ctrl.tag}> element is used as an interactive control but is missing: ${ctrl.issues.join("; ")}.`,
      remediation: `Replace this <${ctrl.tag}> with a native interactive element (<button> or <a href>). If a custom element is necessary, add all of: tabindex="0" (focusability), role="button" or appropriate role (semantics), and a keydown handler for Enter and Space (operability).`,
    });
  }

  // M3-03: Inaccessible scrollable regions
  for (const region of scrollableRegions) {
    if (!region.isFocusable && !region.hasFocusableChild) {
      issues.push({
        checkId: "M3-03",
        wcagCriterion: "2.1.1",
        severity: "moderate",
        elementSelector: region.selector,
        description: `Scrollable region (${region.scrollHeight}px content in ${region.clientHeight}px container) is not keyboard-accessible. It has no tabindex and no focusable children.`,
        remediation: "Add tabindex=\"0\" to the scrollable container so keyboard users can focus it and scroll with arrow keys. Also add an appropriate role (e.g., role=\"region\") and an aria-label describing the content.",
      });
    }
  }

  return issues;
}

// ---- Summary Computation ----

function computeSummary(
  issues: ReportIssue[],
  totalTabStops: number,
  avgVisibilityScore: number,
  coveragePercent: number
): ReportSummary {
  return {
    totalTabStops,
    totalIssues: issues.length,
    criticalCount: issues.filter(i => i.severity === "critical").length,
    warningCount: issues.filter(i => i.severity === "warning").length,
    moderateCount: issues.filter(i => i.severity === "moderate").length,
    infoCount: issues.filter(i => i.severity === "info").length,
    averageVisibilityScore: avgVisibilityScore,
    keyboardCoveragePercent: coveragePercent,
  };
}

// ---- JSON Report ----

export interface ReportData {
  url: string;
  timestamp: string;
  durationMs: number;
  issues: ReportIssue[];
  summary: ReportSummary;
}

export function buildReportData(
  url: string,
  startTime: number,
  issues: ReportIssue[],
  totalTabStops: number,
  avgVisibilityScore: number,
  coveragePercent: number
): ReportData {
  return {
    url,
    timestamp: new Date(startTime).toISOString(),
    durationMs: Date.now() - startTime,
    issues,
    summary: computeSummary(issues, totalTabStops, avgVisibilityScore, coveragePercent),
  };
}

export function writeJsonReport(report: ReportData, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "report.json");
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ---- HTML Report ----

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "#dc2626",
  warning: "#d97706",
  moderate: "#2563eb",
  info: "#6b7280",
};

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  warning: "Warning",
  moderate: "Moderate",
  info: "Info",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function writeHtmlReport(report: ReportData, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "report.html");

  const { summary, issues, url, timestamp, durationMs } = report;
  const duration = (durationMs / 1000).toFixed(1);

  // Group issues by element for cleaner display — same element's issues appear together
  const issuesByElement = new Map<string, ReportIssue[]>();
  for (const issue of issues) {
    const key = issue.elementSelector;
    const list = issuesByElement.get(key) || [];
    list.push(issue);
    issuesByElement.set(key, list);
  }

  // Sort elements: critical issues first, then by module order
  const severityWeight: Record<Severity, number> = { critical: 0, warning: 1, moderate: 2, info: 3 };
  const sortedElements = Array.from(issuesByElement.entries()).sort(([, a], [, b]) => {
    const aMin = Math.min(...a.map(i => severityWeight[i.severity]));
    const bMin = Math.min(...b.map(i => severityWeight[i.severity]));
    if (aMin !== bMin) return aMin - bMin;
    return a[0].checkId.localeCompare(b[0].checkId);
  });

  // Build issue rows HTML
  let issueRows = "";

  for (const [selector, elementIssues] of sortedElements) {
    const worstSeverity = elementIssues.reduce((worst, i) =>
      severityWeight[i.severity] < severityWeight[worst] ? i.severity : worst,
      "info" as Severity
    );
    const color = SEVERITY_COLORS[worstSeverity];
    const label = SEVERITY_LABELS[worstSeverity];

    const checks = elementIssues.map(i =>
      `<code>${escapeHtml(i.checkId)}</code>`
    ).join(" ");

    const wcag = Array.from(new Set(elementIssues.map(i => i.wcagCriterion))).join(", ");

    const descriptions = elementIssues.map(i => {
      const screenshot = i.screenshotPath
        ? ` <a href="${escapeHtml(path.relative(outputDir, i.screenshotPath))}">screenshot</a>`
        : "";
      return `<p>${escapeHtml(i.description)}${screenshot}</p>`;
    }).join("\n");

    const remediations = Array.from(new Set(elementIssues.map(i => i.remediation)))
      .map(r => `<p>${escapeHtml(r)}</p>`)
      .join("\n");

    issueRows += `<tr>
  <td><span class="severity" style="background:${color}">${label}</span><br><small>WCAG ${escapeHtml(wcag)}</small><br>${checks}</td>
  <td><code class="selector">${escapeHtml(selector)}</code></td>
  <td>${descriptions}</td>
  <td>${remediations}</td>
</tr>\n`;
  }

  // Score bar color
  const scoreColor =
    summary.averageVisibilityScore >= 80 ? "#059669" :
    summary.averageVisibilityScore >= 50 ? "#d97706" : "#dc2626";

  const coverageColor =
    summary.keyboardCoveragePercent >= 95 ? "#059669" :
    summary.keyboardCoveragePercent >= 80 ? "#d97706" : "#dc2626";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Keyboard Accessibility Report — ${escapeHtml(url)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #fff; color: #111827; font-size: 14px; line-height: 1.6; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  .meta { font-size: 13px; color: #6b7280; margin-bottom: 24px; }
  .meta a { color: #2563eb; }

  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .summary-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; text-align: center; }
  .summary-card .value { font-size: 28px; font-weight: 700; }
  .summary-card .label { font-size: 12px; color: #6b7280; }

  .bar-container { width: 100%; height: 8px; background: #e5e7eb; border-radius: 4px; margin-top: 8px; }
  .bar-fill { height: 100%; border-radius: 4px; }

  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { text-align: left; padding: 10px 8px; background: #f9fafb; border-bottom: 2px solid #e5e7eb; font-size: 12px; text-transform: uppercase; color: #6b7280; }
  td { padding: 10px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; font-size: 13px; }
  tr.module-header td { background: #f3f4f6; font-weight: 700; font-size: 14px; padding: 8px; }
  tr:hover { background: #f9fafb; }

  .severity { display: inline-block; padding: 2px 8px; border-radius: 4px; color: #fff; font-size: 11px; font-weight: 700; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  code.selector { word-break: break-all; }
  small { color: #9ca3af; }

  .section-title { font-size: 17px; font-weight: 700; margin-top: 32px; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 2px solid #e5e7eb; }
  .pass-message { padding: 12px 16px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; color: #065f46; margin: 12px 0; }

  @media (max-width: 800px) {
    table { font-size: 12px; }
    .summary-grid { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>

<h1>Keyboard Accessibility Report</h1>
<p class="meta">
  <a href="${escapeHtml(url)}">${escapeHtml(url)}</a><br>
  Generated: ${escapeHtml(timestamp)} &middot; Duration: ${duration}s
</p>

<div class="summary-grid">
  <div class="summary-card">
    <div class="value">${summary.totalTabStops}</div>
    <div class="label">Tab Stops</div>
  </div>
  <div class="summary-card">
    <div class="value" style="color:${summary.criticalCount > 0 ? "#dc2626" : "#059669"}">${summary.totalIssues}</div>
    <div class="label">Issues Found</div>
  </div>
  <div class="summary-card">
    <div class="value" style="color:${summary.criticalCount > 0 ? "#dc2626" : "#059669"}">${summary.criticalCount}</div>
    <div class="label">Critical</div>
  </div>
  <div class="summary-card">
    <div class="value" style="color:#d97706">${summary.warningCount}</div>
    <div class="label">Warnings</div>
  </div>
  <div class="summary-card">
    <div class="value" style="color:${scoreColor}">${summary.averageVisibilityScore}/100</div>
    <div class="label">Avg Visibility Score</div>
    <div class="bar-container"><div class="bar-fill" style="width:${summary.averageVisibilityScore}%;background:${scoreColor}"></div></div>
  </div>
  <div class="summary-card">
    <div class="value" style="color:${coverageColor}">${summary.keyboardCoveragePercent}%</div>
    <div class="label">Keyboard Coverage</div>
    <div class="bar-container"><div class="bar-fill" style="width:${summary.keyboardCoveragePercent}%;background:${coverageColor}"></div></div>
  </div>
</div>

<div class="section-title">Issues (${summary.totalIssues})</div>

${issues.length === 0
  ? '<div class="pass-message">No keyboard accessibility issues detected.</div>'
  : `<table>
<thead>
  <tr>
    <th style="width:110px">Severity</th>
    <th style="width:220px">Element</th>
    <th>Issues</th>
    <th style="width:280px">Remediation</th>
  </tr>
</thead>
<tbody>
${issueRows}
</tbody>
</table>`}

</body>
</html>`;

  fs.writeFileSync(filePath, html);
  return filePath;
}
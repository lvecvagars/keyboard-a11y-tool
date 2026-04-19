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
        screenshotPath: result.screenshotPath,
      });
    } else if (result.partiallyObscured) {
      issues.push({
        checkId: "M1-05",
        wcagCriterion: "2.4.11",
        severity: "warning",
        elementSelector: stop?.selector || `tab-stop-${idx}`,
        description: `Focused element is ${result.overlapPercent}% obscured by ${result.obscuringElement}.`,
        remediation: "Ensure focused elements are not partially hidden behind fixed or sticky positioned elements. Use scroll-padding or adjust layout so focused elements remain fully visible.",
        screenshotPath: result.screenshotPath,
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

  for (const r of indicatorResults) {
    const scoreTag = ` Visibility score: ${r.score.score}/100 (${r.score.level}).`;

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
      continue;
    }

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

const SEVERITY_COLORS: Record<Severity, { bg: string; text: string; light: string }> = {
  critical: { bg: "#dc2626", text: "#fff", light: "#fef2f2" },
  warning:  { bg: "#d97706", text: "#fff", light: "#fffbeb" },
  moderate: { bg: "#2563eb", text: "#fff", light: "#eff6ff" },
  info:     { bg: "#6b7280", text: "#fff", light: "#f9fafb" },
};

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  warning: "Warning",
  moderate: "Moderate",
  info: "Info",
};

const CHECK_NAMES: Record<string, string> = {
  "M1-01": "Tab Sequence",
  "M1-02": "Keyboard Trap",
  "M1-03": "Focus Order",
  "M1-04": "Skip Link",
  "M1-05": "Focus Obscured",
  "M2-01": "No Focus Indicator",
  "M2-02": "Outline Removed",
  "M2-03": "Low Contrast",
  "M2-04": "Insufficient Area",
  "M2-05": "Visibility Score",
  "M3-01": "Not Keyboard-Reachable",
  "M3-02": "Non-Semantic Control",
  "M3-03": "Scrollable Region",
};

const MODULE_INFO: Record<string, { name: string; color: string }> = {
  "M1": { name: "Focus Traversal & Order", color: "#2563eb" },
  "M2": { name: "Focus Indicator Visibility", color: "#7c3aed" },
  "M3": { name: "Interactive Element Coverage", color: "#059669" },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Shorten a CSS selector for display — show the meaningful last part */
function shortenSelector(sel: string): string {
  if (sel === "page") return "Entire page";
  // If it's a short selector, show as-is
  if (sel.length <= 50) return sel;
  // Show the last 2 segments of a path selector
  const parts = sel.split(" > ");
  if (parts.length <= 2) return sel;
  return "… > " + parts.slice(-2).join(" > ");
}

export function writeHtmlReport(report: ReportData, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, "report.html");

  const { summary, issues, url, timestamp, durationMs } = report;
  const duration = (durationMs / 1000).toFixed(1);

  // Group issues by module
  const moduleGroups = new Map<string, ReportIssue[]>();
  for (const issue of issues) {
    const moduleKey = issue.checkId.substring(0, 2);
    const list = moduleGroups.get(moduleKey) || [];
    list.push(issue);
    moduleGroups.set(moduleKey, list);
  }

  // Module-level stats for summary cards
  const m1Issues = moduleGroups.get("M1") || [];
  const m2Issues = moduleGroups.get("M2") || [];
  const m3Issues = moduleGroups.get("M3") || [];

  const m1Criticals = m1Issues.filter(i => i.severity === "critical").length;
  const m1Warnings = m1Issues.filter(i => i.severity === "warning").length;
  const m2Criticals = m2Issues.filter(i => i.severity === "critical").length;
  const m2Warnings = m2Issues.filter(i => i.severity === "warning").length;
  const m3Criticals = m3Issues.filter(i => i.severity === "critical").length;
  const m3Warnings = m3Issues.filter(i => i.severity === "warning").length;

  const m1Traps = m1Issues.filter(i => i.checkId === "M1-02").length;
  const m1Obscured = m1Issues.filter(i => i.checkId === "M1-05").length;
  const m3Unreachable = m3Issues.filter(i => i.checkId === "M3-01").length;
  const m3NonSemantic = m3Issues.filter(i => i.checkId === "M3-02").length;

  // Score bar color
  const scoreColor =
    summary.averageVisibilityScore >= 80 ? "#059669" :
    summary.averageVisibilityScore >= 50 ? "#d97706" : "#dc2626";

  const coverageColor =
    summary.keyboardCoveragePercent >= 95 ? "#059669" :
    summary.keyboardCoveragePercent >= 80 ? "#d97706" : "#dc2626";

  // Severity bar widths (percentage of total)
  const total = summary.totalIssues || 1;
  const critPct = Math.round((summary.criticalCount / total) * 100);
  const warnPct = Math.round((summary.warningCount / total) * 100);
  const modPct = Math.round((summary.moderateCount / total) * 100);
  const infoPct = Math.round((summary.infoCount / total) * 100);

  // Build issue cards HTML grouped by module
  let issueCardsHtml = "";

  for (const [moduleKey, moduleIssues] of moduleGroups) {
    const info = MODULE_INFO[moduleKey] || { name: moduleKey, color: "#6b7280" };
    const critCount = moduleIssues.filter(i => i.severity === "critical").length;
    const warnCount = moduleIssues.filter(i => i.severity === "warning").length;
    const modCount = moduleIssues.filter(i => i.severity === "moderate").length;

    const countParts: string[] = [];
    if (critCount > 0) countParts.push(`<span style="color:#dc2626">${critCount} critical</span>`);
    if (warnCount > 0) countParts.push(`<span style="color:#d97706">${warnCount} warning</span>`);
    if (modCount > 0) countParts.push(`<span style="color:#2563eb">${modCount} moderate</span>`);

    issueCardsHtml += `
<div class="module-section">
  <div class="module-header">
    <span class="module-dot" style="background:${info.color}"></span>
    <span class="module-name">${escapeHtml(info.name)}</span>
    <span class="module-counts">${countParts.join(" &middot; ")}</span>
  </div>
`;

    // Sort: critical first, then warning, moderate, info
    const severityWeight: Record<Severity, number> = { critical: 0, warning: 1, moderate: 2, info: 3 };
    const sorted = [...moduleIssues].sort((a, b) => severityWeight[a.severity] - severityWeight[b.severity]);

    for (const issue of sorted) {
      const colors = SEVERITY_COLORS[issue.severity];
      const checkName = CHECK_NAMES[issue.checkId] || issue.checkId;
      const shortSel = shortenSelector(issue.elementSelector);

      const screenshotHtml = issue.screenshotPath
        ? (() => {
            const fileName = path.basename(issue.screenshotPath);
            if (issue.checkId === "M1-05") {
              return `<div class="screenshot-row">
  <div class="screenshot-label">Viewport showing obscured focus</div>
  <img src="${escapeHtml(fileName)}" alt="Viewport screenshot showing focused element obscured by overlay" loading="lazy">
</div>`;
            }
            const focusedFile = fileName.replace("_diff.png", "_focused.png");
            const unfocusedFile = fileName.replace("_diff.png", "_unfocused.png");
            return `<div class="screenshot-pair">
  <div class="screenshot-item">
    <div class="screenshot-label">Unfocused</div>
    <img src="${escapeHtml(unfocusedFile)}" alt="Element without focus" loading="lazy">
  </div>
  <div class="screenshot-item">
    <div class="screenshot-label">Focused</div>
    <img src="${escapeHtml(focusedFile)}" alt="Element with focus" loading="lazy">
  </div>
  <div class="screenshot-item">
    <div class="screenshot-label">Difference</div>
    <img src="${escapeHtml(fileName)}" alt="Pixel difference showing focus indicator" loading="lazy">
  </div>
</div>`;
          })()
        : "";

      issueCardsHtml += `
  <div class="issue-card" style="border-left-color:${colors.bg}">
    <div class="issue-top">
      <span class="severity-badge" style="background:${colors.bg};color:${colors.text}">${SEVERITY_LABELS[issue.severity]}</span>
      <span class="check-badge">${escapeHtml(issue.checkId)}: ${escapeHtml(checkName)}</span>
      <span class="wcag-ref">WCAG ${escapeHtml(issue.wcagCriterion)}</span>
    </div>
    <div class="issue-element" title="${escapeHtml(issue.elementSelector)}"><code>${escapeHtml(shortSel)}</code></div>
    <div class="issue-description">${escapeHtml(issue.description)}</div>
    ${screenshotHtml}
    <details class="remediation-details">
      <summary>How to fix</summary>
      <div class="remediation-text">${escapeHtml(issue.remediation)}</div>
    </details>
  </div>
`;
    }

    issueCardsHtml += `</div>\n`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Keyboard Accessibility Report — ${escapeHtml(url)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 960px;
    margin: 0 auto;
    padding: 0;
    background: #f8fafc;
    color: #1e293b;
    font-size: 14px;
    line-height: 1.6;
  }

  /* Header */
  .report-header {
    background: #1e293b;
    color: #f1f5f9;
    padding: 28px 32px;
  }
  .report-header h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .report-header .meta { font-size: 13px; color: #94a3b8; }
  .report-header .meta a { color: #60a5fa; text-decoration: none; }
  .report-header .meta a:hover { text-decoration: underline; }

  .content { padding: 24px 32px; }

  /* ---- Severity bar ---- */
  .severity-bar-section { margin-bottom: 24px; }
  .severity-bar-label {
    font-size: 12px;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  .severity-bar {
    display: flex;
    height: 28px;
    border-radius: 8px;
    overflow: hidden;
    background: #e2e8f0;
  }
  .severity-bar .seg {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    min-width: 28px;
    transition: width 0.3s ease;
  }
  .severity-bar .seg span { opacity: 0.95; }
  .severity-legend {
    display: flex;
    gap: 16px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .severity-legend-item {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: #475569;
  }
  .severity-legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  /* ---- Module summary cards ---- */
  .module-summary-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin-bottom: 24px;
  }
  .module-summary-card {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 18px 20px;
    border-top: 4px solid #ccc;
  }
  .module-summary-card .ms-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }
  .module-summary-card .ms-metric {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 6px;
  }
  .module-summary-card .ms-metric .ms-value {
    font-size: 28px;
    font-weight: 800;
    line-height: 1;
  }
  .module-summary-card .ms-metric .ms-unit {
    font-size: 13px;
    color: #64748b;
  }
  .module-summary-card .ms-details {
    font-size: 12px;
    color: #64748b;
    line-height: 1.6;
  }
  .module-summary-card .ms-details .ms-tag {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    margin-right: 4px;
  }

  /* Mini bar inside module cards */
  .ms-bar-bg {
    width: 100%;
    height: 6px;
    background: #e2e8f0;
    border-radius: 3px;
    margin-top: 10px;
    margin-bottom: 4px;
  }
  .ms-bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.4s ease;
  }

  /* ---- Key stats row ---- */
  .stats-row {
    display: flex;
    gap: 14px;
    margin-bottom: 28px;
  }
  .stat-item {
    flex: 1;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .stat-icon {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 800;
    flex-shrink: 0;
  }
  .stat-text .stat-value {
    font-size: 20px;
    font-weight: 800;
    line-height: 1.2;
  }
  .stat-text .stat-label {
    font-size: 11px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  /* Module sections */
  .module-section { margin-bottom: 28px; }
  .module-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 0;
    border-bottom: 2px solid #e2e8f0;
    margin-bottom: 12px;
  }
  .module-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .module-name { font-size: 16px; font-weight: 700; }
  .module-counts { margin-left: auto; font-size: 12px; color: #64748b; }

  /* Issue cards */
  .issue-card {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-left: 4px solid #ccc;
    border-radius: 8px;
    padding: 16px 18px;
    margin-bottom: 10px;
    transition: box-shadow 0.15s;
  }
  .issue-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.06); }

  .issue-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .severity-badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .check-badge {
    font-size: 12px;
    font-weight: 600;
    color: #475569;
    background: #f1f5f9;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .wcag-ref {
    font-size: 11px;
    color: #94a3b8;
    margin-left: auto;
  }

  .issue-element {
    margin-bottom: 8px;
  }
  .issue-element code {
    background: #f1f5f9;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
    color: #334155;
    word-break: break-all;
  }

  .issue-description {
    font-size: 13px;
    color: #475569;
    line-height: 1.6;
    margin-bottom: 8px;
  }

  /* Screenshots */
  .screenshot-row {
    margin: 10px 0;
  }
  .screenshot-row .screenshot-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #94a3b8;
    margin-bottom: 4px;
  }
  .screenshot-pair {
    display: flex;
    gap: 10px;
    margin: 10px 0;
  }
  .screenshot-item {
    flex: 1;
    min-width: 0;
  }
  .screenshot-item .screenshot-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #94a3b8;
    margin-bottom: 4px;
  }
  .screenshot-item img {
    width: 100%;
    height: auto;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    display: block;
  }
  .screenshot-row img {
    max-width: 100%;
    height: auto;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
  }

  /* Remediation collapsible */
  .remediation-details {
    margin-top: 4px;
  }
  .remediation-details summary {
    font-size: 12px;
    font-weight: 600;
    color: #2563eb;
    cursor: pointer;
    padding: 4px 0;
    user-select: none;
  }
  .remediation-details summary:hover { color: #1d4ed8; }
  .remediation-text {
    font-size: 13px;
    color: #475569;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 12px 14px;
    margin-top: 6px;
    line-height: 1.6;
  }

  /* Pass message */
  .pass-message {
    padding: 20px 24px;
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
    border-radius: 10px;
    color: #065f46;
    font-size: 15px;
    font-weight: 600;
    text-align: center;
  }

  /* Footer */
  .report-footer {
    text-align: center;
    padding: 20px;
    font-size: 11px;
    color: #94a3b8;
    border-top: 1px solid #e2e8f0;
    margin-top: 20px;
  }

  @media (max-width: 640px) {
    .content { padding: 16px; }
    .report-header { padding: 20px 16px; }
    .module-summary-grid { grid-template-columns: 1fr; }
    .stats-row { flex-direction: column; }
    .issue-top { flex-direction: column; align-items: flex-start; }
    .wcag-ref { margin-left: 0; }
  }
</style>
</head>
<body>

<div class="report-header">
  <h1>Keyboard Accessibility Report</h1>
  <p class="meta">
    <a href="${escapeHtml(url)}">${escapeHtml(url)}</a><br>
    Generated: ${escapeHtml(new Date(timestamp).toLocaleString())} &middot; Duration: ${duration}s
  </p>
</div>

<div class="content">

<!-- ===== Severity Distribution Bar ===== -->
<div class="severity-bar-section">
  <div class="severity-bar-label">${summary.totalIssues} issues found</div>
  <div class="severity-bar">
    ${summary.criticalCount > 0 ? `<div class="seg" style="width:${critPct}%;background:#dc2626"><span>${summary.criticalCount}</span></div>` : ""}
    ${summary.warningCount > 0 ? `<div class="seg" style="width:${warnPct}%;background:#d97706"><span>${summary.warningCount}</span></div>` : ""}
    ${summary.moderateCount > 0 ? `<div class="seg" style="width:${modPct}%;background:#2563eb"><span>${summary.moderateCount}</span></div>` : ""}
    ${summary.infoCount > 0 ? `<div class="seg" style="width:${infoPct}%;background:#6b7280"><span>${summary.infoCount}</span></div>` : ""}
    ${summary.totalIssues === 0 ? `<div class="seg" style="width:100%;background:#059669"><span>No issues</span></div>` : ""}
  </div>
  <div class="severity-legend">
    ${summary.criticalCount > 0 ? `<div class="severity-legend-item"><div class="severity-legend-dot" style="background:#dc2626"></div>${summary.criticalCount} Critical</div>` : ""}
    ${summary.warningCount > 0 ? `<div class="severity-legend-item"><div class="severity-legend-dot" style="background:#d97706"></div>${summary.warningCount} Warning</div>` : ""}
    ${summary.moderateCount > 0 ? `<div class="severity-legend-item"><div class="severity-legend-dot" style="background:#2563eb"></div>${summary.moderateCount} Moderate</div>` : ""}
    ${summary.infoCount > 0 ? `<div class="severity-legend-item"><div class="severity-legend-dot" style="background:#6b7280"></div>${summary.infoCount} Info</div>` : ""}
  </div>
</div>

<!-- ===== Module Summary Cards ===== -->
<div class="module-summary-grid">
  <!-- Module 1: Focus Traversal -->
  <div class="module-summary-card" style="border-top-color:#2563eb">
    <div class="ms-title" style="color:#2563eb">Focus Traversal &amp; Order</div>
    <div class="ms-metric">
      <span class="ms-value">${summary.totalTabStops}</span>
      <span class="ms-unit">tab stops</span>
    </div>
    <div class="ms-details">
      ${m1Issues.length === 0
        ? `<span class="ms-tag" style="background:#ecfdf5;color:#059669">All clear</span>`
        : `${m1Criticals > 0 ? `<span class="ms-tag" style="background:#fef2f2;color:#dc2626">${m1Criticals} critical</span>` : ""}${m1Warnings > 0 ? `<span class="ms-tag" style="background:#fffbeb;color:#d97706">${m1Warnings} warning</span>` : ""}`
      }
      ${m1Traps > 0 ? `<br>${m1Traps} keyboard trap${m1Traps > 1 ? "s" : ""}` : ""}
      ${m1Obscured > 0 ? `<br>${m1Obscured} obscured element${m1Obscured > 1 ? "s" : ""}` : ""}
    </div>
  </div>

  <!-- Module 2: Focus Indicators -->
  <div class="module-summary-card" style="border-top-color:#7c3aed">
    <div class="ms-title" style="color:#7c3aed">Focus Indicator Visibility</div>
    <div class="ms-metric">
      <span class="ms-value" style="color:${scoreColor}">${summary.averageVisibilityScore}</span>
      <span class="ms-unit">/ 100 avg score</span>
    </div>
    <div class="ms-bar-bg"><div class="ms-bar-fill" style="width:${summary.averageVisibilityScore}%;background:${scoreColor}"></div></div>
    <div class="ms-details">
      ${m2Issues.length === 0
        ? `<span class="ms-tag" style="background:#ecfdf5;color:#059669">All clear</span>`
        : `${m2Criticals > 0 ? `<span class="ms-tag" style="background:#fef2f2;color:#dc2626">${m2Criticals} critical</span>` : ""}${m2Warnings > 0 ? `<span class="ms-tag" style="background:#fffbeb;color:#d97706">${m2Warnings} warning</span>` : ""}`
      }
    </div>
  </div>

  <!-- Module 3: Coverage -->
  <div class="module-summary-card" style="border-top-color:#059669">
    <div class="ms-title" style="color:#059669">Interactive Element Coverage</div>
    <div class="ms-metric">
      <span class="ms-value" style="color:${coverageColor}">${summary.keyboardCoveragePercent}%</span>
      <span class="ms-unit">keyboard coverage</span>
    </div>
    <div class="ms-bar-bg"><div class="ms-bar-fill" style="width:${summary.keyboardCoveragePercent}%;background:${coverageColor}"></div></div>
    <div class="ms-details">
      ${m3Issues.length === 0
        ? `<span class="ms-tag" style="background:#ecfdf5;color:#059669">All clear</span>`
        : `${m3Criticals > 0 ? `<span class="ms-tag" style="background:#fef2f2;color:#dc2626">${m3Criticals} critical</span>` : ""}${m3Warnings > 0 ? `<span class="ms-tag" style="background:#fffbeb;color:#d97706">${m3Warnings} warning</span>` : ""}`
      }
      ${m3Unreachable > 0 ? `<br>${m3Unreachable} unreachable element${m3Unreachable > 1 ? "s" : ""}` : ""}
      ${m3NonSemantic > 0 ? `<br>${m3NonSemantic} non-semantic control${m3NonSemantic > 1 ? "s" : ""}` : ""}
    </div>
  </div>
</div>

<!-- ===== Issues ===== -->
${issues.length === 0
  ? '<div class="pass-message">No keyboard accessibility issues detected.</div>'
  : issueCardsHtml}

</div>

<div class="report-footer">
  Generated by Keyboard Accessibility Evaluation Tool &middot; WCAG 2.2
</div>

</body>
</html>`;

  fs.writeFileSync(filePath, html);
  return filePath;
}
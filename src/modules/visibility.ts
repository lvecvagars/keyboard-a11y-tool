import { Page } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import * as fs from "fs";
import * as path from "path";
import { IndicatorExistence, CSSFocusStyle, ComputedStyleChange, OutlineState, IndicatorContrast, IndicatorArea, VisibilityScore } from "../types";
import { computeContrastAndArea } from "./contrast";
import { computeVisibilityScore } from "./score";

const SCREENSHOT_PADDING = 20;
const DIFF_THRESHOLD = 0.1;
const MIN_CHANGED_PIXELS = 10;
const MAX_TAB_PRESSES = 500;

const FOCUS_STYLE_PROPERTIES = [
  "outline",
  "outlineColor",
  "outlineWidth",
  "outlineStyle",
  "outlineOffset",
  "border",
  "borderColor",
  "borderWidth",
  "borderStyle",
  "boxShadow",
  "backgroundColor",
  "color",
  "textDecoration",
] as const;

// Properties that count as valid replacements when outline is removed
const REPLACEMENT_PROPERTIES = [
  "boxShadow",
  "border",
  "borderColor",
  "borderWidth",
  "borderStyle",
  "backgroundColor",
  "textDecoration",
] as const;

async function captureActiveElementRegion(
  page: Page,
  padding: number
): Promise<{ png: PNG; clip: { x: number; y: number; width: number; height: number } } | null> {
  const box = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });

  if (!box || box.width === 0 || box.height === 0) return null;

  await page.waitForTimeout(50);

  const updatedBox = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });

  if (!updatedBox || updatedBox.width === 0 || updatedBox.height === 0) return null;

  const viewport = page.viewportSize();
  if (!viewport) return null;

  const clip = {
    x: Math.max(0, Math.floor(updatedBox.x - padding)),
    y: Math.max(0, Math.floor(updatedBox.y - padding)),
    width: 0,
    height: 0,
  };
  clip.width = Math.min(
    Math.ceil(updatedBox.width + padding * 2),
    viewport.width - clip.x
  );
  clip.height = Math.min(
    Math.ceil(updatedBox.height + padding * 2),
    viewport.height - clip.y
  );

  if (clip.width <= 0 || clip.height <= 0) return null;

  const buffer = await page.screenshot({ clip, type: "png" });
  const png = PNG.sync.read(buffer);

  return { png, clip };
}

async function captureClipRegion(
  page: Page,
  clip: { x: number; y: number; width: number; height: number }
): Promise<PNG | null> {
  const viewport = page.viewportSize();
  if (!viewport) return null;
  if (clip.width <= 0 || clip.height <= 0) return null;

  const buffer = await page.screenshot({ clip, type: "png" });
  return PNG.sync.read(buffer);
}

async function removeFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.blur === "function") {
      el.blur();
    }
    document.body.focus();
  });
  await page.waitForTimeout(50);
}

async function getElementBox(
  page: Page,
  selector: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate((sel: string) => {
    let el: Element | null = null;
    try { el = document.querySelector(sel); } catch { }
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
}

// Detect show/hide elements (e.g. off-screen skip links that move
// from top:-9999px to top:0 on focus). These produce unreliable
// screenshot diffs since the entire element appears/disappears.
function elementChangedVisibility(
  focusedBox: { x: number; y: number; width: number; height: number } | null,
  unfocusedBox: { x: number; y: number; width: number; height: number } | null
): boolean {
  if (!focusedBox || !unfocusedBox) return true;

  const focusedVisible = focusedBox.width > 2 && focusedBox.height > 2;
  const unfocusedVisible = unfocusedBox.width > 2 && unfocusedBox.height > 2;
  if (focusedVisible !== unfocusedVisible) return true;

  const dx = Math.abs(focusedBox.x - unfocusedBox.x);
  const dy = Math.abs(focusedBox.y - unfocusedBox.y);
  if (dx > 50 || dy > 50) return true;

  const maxW = Math.max(focusedBox.width, unfocusedBox.width, 1);
  const maxH = Math.max(focusedBox.height, unfocusedBox.height, 1);
  const wRatio = Math.abs(focusedBox.width - unfocusedBox.width) / maxW;
  const hRatio = Math.abs(focusedBox.height - unfocusedBox.height) / maxH;
  if (wRatio > 0.5 || hRatio > 0.5) return true;

  return false;
}

async function readFocusStyles(page: Page): Promise<Record<string, string> | null> {
  return page.evaluate((properties: string[]) => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;

    const styles = window.getComputedStyle(el);
    const result: Record<string, string> = {};
    for (const prop of properties) {
      result[prop] = styles.getPropertyValue(
        prop.replace(/([A-Z])/g, "-$1").toLowerCase()
      );
    }
    return result;
  }, [...FOCUS_STYLE_PROPERTIES]);
}

async function readUnfocusedStyles(
  page: Page,
  selector: string
): Promise<Record<string, string> | null> {
  return page.evaluate(
    (args: { selector: string; properties: string[] }) => {
      let el: Element | null = null;
      try {
        el = document.querySelector(args.selector);
      } catch { }
      if (!el) return null;

      const styles = window.getComputedStyle(el);
      const result: Record<string, string> = {};
      for (const prop of args.properties) {
        result[prop] = styles.getPropertyValue(
          prop.replace(/([A-Z])/g, "-$1").toLowerCase()
        );
      }
      return result;
    },
    { selector, properties: [...FOCUS_STYLE_PROPERTIES] }
  );
}

function compareStyles(
  focused: Record<string, string>,
  unfocused: Record<string, string>
): { computedChanges: ComputedStyleChange[]; outlineState: OutlineState; replacementProperties: string[] } {
  const computedChanges: ComputedStyleChange[] = [];

  for (const prop of FOCUS_STYLE_PROPERTIES) {
    const fVal = focused[prop] ?? "";
    const uVal = unfocused[prop] ?? "";
    if (fVal !== uVal) {
      computedChanges.push({ property: prop, unfocused: uVal, focused: fVal });
    }
  }

  const focusedOutlineWidth = focused["outlineWidth"] ?? "";
  const focusedOutlineStyle = focused["outlineStyle"] ?? "";
  const unfocusedOutlineWidth = unfocused["outlineWidth"] ?? "";
  const unfocusedOutlineStyle = unfocused["outlineStyle"] ?? "";

  const focusedOutlineGone =
    focusedOutlineStyle === "none" || focusedOutlineWidth === "0px";
  const unfocusedOutlineGone =
    unfocusedOutlineStyle === "none" || unfocusedOutlineWidth === "0px";

  const replacements: string[] = [];
  for (const rProp of REPLACEMENT_PROPERTIES) {
    const fVal = focused[rProp] ?? "";
    const uVal = unfocused[rProp] ?? "";
    if (fVal !== uVal) {
      replacements.push(rProp);
    }
  }

  let outlineState: OutlineState;
  if (!focusedOutlineGone) {
    outlineState = "present";
  } else if (!unfocusedOutlineGone) {
    outlineState = replacements.length > 0 ? "replaced" : "removed";
  } else {
    outlineState = replacements.length > 0 ? "replaced" : "never";
  }

  return { computedChanges, outlineState, replacementProperties: replacements };
}

async function getActiveElementInfo(page: Page): Promise<{
  selector: string;
  tag: string;
  width: number;
  height: number;
} | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;

    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    if (el.id) return { selector: "#" + el.id, tag, width, height };

    const attrs: [string, string | null][] = [
      ["href", el.getAttribute("href")],
      ["aria-label", el.getAttribute("aria-label")],
      ["name", el.getAttribute("name")],
      ["data-testid", el.getAttribute("data-testid")],
      ["type", tag === "input" ? el.getAttribute("type") : null],
    ];
    for (const [attr, val] of attrs) {
      if (val) {
        const escaped = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const candidate = tag + "[" + attr + '="' + escaped + '"]';
        try {
          if (document.querySelectorAll(candidate).length === 1) {
            return { selector: candidate, tag, width, height };
          }
        } catch { }
      }
    }

    if (tag.includes("-")) {
      try {
        if (document.querySelectorAll(tag).length === 1) {
          return { selector: tag, tag, width, height };
        }
      } catch { }
    }

    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift("#" + cur.id);
        break;
      }
      if (cur.parentElement) {
        const siblings = Array.from(cur.parentElement.children).filter(
          (s) => s.tagName === cur!.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          part += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return { selector: parts.join(" > "), tag, width, height };
  });
}

// ---- M2-02 Part B: Stylesheet scan for outline removal ----

export interface OutlineOverrideRule {
  selectorText: string;
  source: string;
  hasReplacement: boolean;
  replacementProperties: string[];
}

export async function scanStylesheetsForOutlineRemoval(
  page: Page
): Promise<OutlineOverrideRule[]> {
  return page.evaluate((replacementProps: string[]) => {
    const results: OutlineOverrideRule[] = [];

    for (let i = 0; i < document.styleSheets.length; i++) {
      const sheet = document.styleSheets[i];
      const source = sheet.href || "inline";

      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }

      for (let j = 0; j < rules.length; j++) {
        const rule = rules[j];
        if (!(rule instanceof CSSStyleRule)) continue;

        const sel = rule.selectorText;
        if (!sel) continue;
        if (!sel.includes(":focus")) continue;

        const style = rule.style;

        const outlineVal = style.getPropertyValue("outline").trim().toLowerCase();
        const outlineStyleVal = style.getPropertyValue("outline-style").trim().toLowerCase();
        const outlineWidthVal = style.getPropertyValue("outline-width").trim().toLowerCase();

        const removesOutline =
          outlineVal === "none" ||
          outlineVal === "0" ||
          outlineVal === "0px" ||
          outlineStyleVal === "none" ||
          outlineWidthVal === "0" ||
          outlineWidthVal === "0px";

        if (!removesOutline) continue;

        const foundReplacements: string[] = [];
        for (const rProp of replacementProps) {
          const kebab = rProp.replace(/([A-Z])/g, "-$1").toLowerCase();
          const val = style.getPropertyValue(kebab).trim();
          if (val && val !== "none" && val !== "0" && val !== "0px" && val !== "initial") {
            foundReplacements.push(rProp);
          }
        }

        results.push({
          selectorText: sel,
          source,
          hasReplacement: foundReplacements.length > 0,
          replacementProperties: foundReplacements,
        });
      }
    }

    return results;
  }, [...REPLACEMENT_PROPERTIES]);
}

// ---- Combined M2 analysis ----

const NO_CONTRAST: IndicatorContrast = {
  medianContrast: 1,
  minContrast: 1,
  percentMeeting3to1: 0,
};

const NO_AREA: IndicatorArea = {
  qualifyingPixelCount: 0,
  minimumRequiredArea: 0,
  areaRatio: 0,
  perimeterCoverage: 0,
};

export interface IndicatorAnalysis {
  selector: string;
  tag: string;
  existence: IndicatorExistence;
  cssAnalysis: CSSFocusStyle;
  contrast: IndicatorContrast;
  area: IndicatorArea;
  score: VisibilityScore;
}

/**
 * Single traversal pass: tabs through the page, capturing focused/unfocused
 * screenshots for each element and running M2-01 through M2-04 in one cycle.
 */
export async function analyzeIndicators(
  page: Page,
  stopCount: number,
  outputDir: string | null = null,
  onProgress?: (current: number, total: number) => void
): Promise<IndicatorAnalysis[]> {
  const results: IndicatorAnalysis[] = [];
  const seen = new Set<string>();

  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    document.body.focus();
  });

  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio) || 1;

  for (let i = 0; i < MAX_TAB_PRESSES; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(50);

    const info = await getActiveElementInfo(page);
    if (!info) continue;

    if (seen.has(info.selector)) break;
    seen.add(info.selector);

    onProgress?.(seen.size, stopCount);

    // Wait for focus styles/transitions to render
    await page.waitForTimeout(80);

    // Read CSS while focused
    const focusedStyles = await readFocusStyles(page);

    // Screenshot while focused
    const focusedCapture = await captureActiveElementRegion(page, SCREENSHOT_PADDING);

    // Blur
    await removeFocus(page);

    // Check for show/hide elements
    const unfocusedBox = await getElementBox(page, info.selector);
    let focusedBox: { x: number; y: number; width: number; height: number } | null = null;
    if (focusedCapture) {
      focusedBox = {
        x: focusedCapture.clip.x + SCREENSHOT_PADDING,
        y: focusedCapture.clip.y + SCREENSHOT_PADDING,
        width: info.width,
        height: info.height,
      };
    }
    const visibilityChanged = elementChangedVisibility(focusedBox, unfocusedBox);

    // Read CSS while unfocused
    const unfocusedStyles = await readUnfocusedStyles(page, info.selector);

    // Compare styles (M2-02)
    let cssAnalysis: CSSFocusStyle;
    if (focusedStyles && unfocusedStyles) {
      const comparison = compareStyles(focusedStyles, unfocusedStyles);
      cssAnalysis = {
        outlineState: comparison.outlineState,
        replacementProperties: comparison.replacementProperties,
        computedChanges: comparison.computedChanges,
      };
    } else {
      cssAnalysis = {
        outlineState: "never",
        replacementProperties: [],
        computedChanges: [],
      };
    }

    // Handle cases where screenshots can't be compared reliably
    if (!focusedCapture || visibilityChanged) {
      const hasChange = visibilityChanged && focusedCapture !== null;
      const existence: IndicatorExistence = {
        hasVisibleChange: hasChange,
        changedPixelCount: hasChange ? MIN_CHANGED_PIXELS : 0,
        diffImagePath: "",
      };
      // For show/hide elements, report passing contrast/area — the element
      // clearly changes state, we just can't measure it via pixel diff.
      const contrast = hasChange
        ? { medianContrast: 21, minContrast: 21, percentMeeting3to1: 100 }
        : NO_CONTRAST;
      const area = hasChange
        ? { qualifyingPixelCount: 9999, minimumRequiredArea: 1, areaRatio: 9999, perimeterCoverage: 1 }
        : NO_AREA;
      results.push({
        selector: info.selector,
        tag: info.tag,
        existence,
        cssAnalysis,
        contrast,
        area,
        score: computeVisibilityScore(existence, contrast, area),
      });
      await refocus(page, info.selector);
      continue;
    }

    const { png: focusedPng, clip } = focusedCapture;
    const unfocusedPng = await captureClipRegion(page, clip);

    if (!unfocusedPng) {
      const existence: IndicatorExistence = { hasVisibleChange: false, changedPixelCount: 0, diffImagePath: "" };
      results.push({
        selector: info.selector,
        tag: info.tag,
        existence,
        cssAnalysis,
        contrast: NO_CONTRAST,
        area: NO_AREA,
        score: computeVisibilityScore(existence, NO_CONTRAST, NO_AREA),
      });
      await refocus(page, info.selector);
      continue;
    }

    if (
      focusedPng.width !== unfocusedPng.width ||
      focusedPng.height !== unfocusedPng.height
    ) {
      const existence: IndicatorExistence = { hasVisibleChange: false, changedPixelCount: 0, diffImagePath: "" };
      results.push({
        selector: info.selector,
        tag: info.tag,
        existence,
        cssAnalysis,
        contrast: NO_CONTRAST,
        area: NO_AREA,
        score: computeVisibilityScore(existence, NO_CONTRAST, NO_AREA),
      });
      await refocus(page, info.selector);
      continue;
    }

    const { width, height } = focusedPng;
    const diffPng = new PNG({ width, height });

    const changedPixelCount = pixelmatch(
      focusedPng.data,
      unfocusedPng.data,
      diffPng.data,
      width,
      height,
      { threshold: DIFF_THRESHOLD }
    );

    const { contrast, area } = computeContrastAndArea(
      focusedPng,
      unfocusedPng,
      changedPixelCount,
      info.width,
      info.height,
      SCREENSHOT_PADDING,
      devicePixelRatio
    );

    // Save screenshot triplet (focused, unfocused, diff)
    let diffImagePath = "";
    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });
      const safeName = info.selector
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .substring(0, 80);
      const baseName = `m2-01_${results.length}_${safeName}`;

      fs.writeFileSync(
        path.join(outputDir, `${baseName}_focused.png`),
        PNG.sync.write(focusedPng)
      );
      fs.writeFileSync(
        path.join(outputDir, `${baseName}_unfocused.png`),
        PNG.sync.write(unfocusedPng)
      );
      diffImagePath = path.join(outputDir, `${baseName}_diff.png`);
      fs.writeFileSync(diffImagePath, PNG.sync.write(diffPng));
    }

    const existence: IndicatorExistence = {
      hasVisibleChange: changedPixelCount >= MIN_CHANGED_PIXELS,
      changedPixelCount,
      diffImagePath,
    };

    results.push({
      selector: info.selector,
      tag: info.tag,
      existence,
      cssAnalysis,
      contrast,
      area,
      score: computeVisibilityScore(existence, contrast, area),
    });

    await refocus(page, info.selector);
  }

  return results;
}

async function refocus(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    try {
      const el = document.querySelector(sel);
      if (el) (el as HTMLElement).focus();
    } catch { }
  }, selector);
  await page.waitForTimeout(30);
}
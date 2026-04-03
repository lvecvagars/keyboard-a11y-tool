import { Page } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import * as fs from "fs";
import * as path from "path";
import { IndicatorExistence } from "../types";

// ---- Configuration ----

/** Pixels of padding around the element's bounding box when cropping screenshots */
const SCREENSHOT_PADDING = 20;

/** pixelmatch color difference threshold (0–1). Lower = more sensitive. */
const DIFF_THRESHOLD = 0.1;

/** Minimum changed pixels to consider a focus indicator "visible" */
const MIN_CHANGED_PIXELS = 10;

/** Maximum tab presses (matches Module 1) */
const MAX_TAB_PRESSES = 500;

// ---- Helpers ----

/**
 * Capture a cropped screenshot of the region around the currently
 * focused element. Uses the live activeElement rather than a selector,
 * so it always works regardless of DOM changes.
 */
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

  // Small pause after scroll for layout to settle
  await page.waitForTimeout(50);

  // Re-read box after scroll since viewport position changed
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

/**
 * Capture a screenshot of a specific clip region (used for the
 * unfocused state — same region, no active element dependency).
 */
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

/**
 * Remove focus from the currently focused element.
 */
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

/**
 * Get info about the currently focused element.
 * Selector strategy matches injectHelpers().__getSelector in traversal.ts:
 *   1. #id
 *   2. Unique tag[attr="value"] (href, aria-label, name, data-testid, type)
 *   3. Custom element tag uniqueness
 *   4. Id-anchored nth-of-type path
 */
async function getActiveElementInfo(page: Page): Promise<{
  selector: string;
  tag: string;
} | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;

    const tag = el.tagName.toLowerCase();

    // Strategy 1: ID
    if (el.id) return { selector: "#" + el.id, tag };

    // Strategy 2: Unique attribute-based selector
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
            return { selector: candidate, tag };
          }
        } catch { /* skip */ }
      }
    }

    // Strategy 2b: Custom element tag uniqueness
    if (tag.includes("-")) {
      try {
        if (document.querySelectorAll(tag).length === 1) {
          return { selector: tag, tag };
        }
      } catch { /* skip */ }
    }

    // Strategy 3: Id-anchored nth-of-type path
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
    return { selector: parts.join(" > "), tag };
  });
}

// ---- M2-01: Focus Indicator Existence (Screenshot Diff) ----

/**
 * M2-01: Analyze focus indicator existence by tabbing through the page.
 *
 * Instead of re-finding elements by selector (which breaks on SPAs),
 * this function does its own tab traversal. For each focused element:
 *   1. Capture screenshot while focused (using live activeElement)
 *   2. Blur and capture same region unfocused
 *   3. Diff the two
 *
 * This approach always works because we never need to re-find elements
 * by selector — we work with whatever is currently focused.
 *
 * @param page       - Playwright page
 * @param stopCount  - Number of unique tab stops from M1 (used for cycle detection)
 * @param outputDir  - Directory to save diff images (null to skip saving)
 * @param onProgress - Optional progress callback
 * @returns Array of results with selector, tag, and indicator existence data
 */
export async function analyzeIndicatorExistence(
  page: Page,
  stopCount: number,
  outputDir: string | null = null,
  onProgress?: (current: number, total: number) => void
): Promise<{ selector: string; tag: string; existence: IndicatorExistence }[]> {
  const results: { selector: string; tag: string; existence: IndicatorExistence }[] = [];
  const seen = new Set<string>();

  // Reset focus to start of page
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    document.body.focus();
  });

  for (let i = 0; i < MAX_TAB_PRESSES; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(50);

    const info = await getActiveElementInfo(page);
    if (!info) continue;

    // Cycle detection: if we've seen this element, we've looped
    if (seen.has(info.selector)) break;
    seen.add(info.selector);

    onProgress?.(seen.size, stopCount);

    // ---- Screenshot while focused ----
    // Extra wait for focus styles/transitions to render
    await page.waitForTimeout(80);

    const focusedCapture = await captureActiveElementRegion(page, SCREENSHOT_PADDING);
    if (!focusedCapture) {
      results.push({
        selector: info.selector,
        tag: info.tag,
        existence: { hasVisibleChange: false, changedPixelCount: 0, diffImagePath: "" },
      });
      continue;
    }

    const { png: focusedPng, clip } = focusedCapture;

    // ---- Remove focus and screenshot same region ----
    await removeFocus(page);

    const unfocusedPng = await captureClipRegion(page, clip);
    if (!unfocusedPng) {
      results.push({
        selector: info.selector,
        tag: info.tag,
        existence: { hasVisibleChange: false, changedPixelCount: 0, diffImagePath: "" },
      });
      continue;
    }

    // ---- Diff ----
    if (
      focusedPng.width !== unfocusedPng.width ||
      focusedPng.height !== unfocusedPng.height
    ) {
      results.push({
        selector: info.selector,
        tag: info.tag,
        existence: { hasVisibleChange: false, changedPixelCount: 0, diffImagePath: "" },
      });
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

    // ---- Save images ----
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

    results.push({
      selector: info.selector,
      tag: info.tag,
      existence: {
        hasVisibleChange: changedPixelCount >= MIN_CHANGED_PIXELS,
        changedPixelCount,
        diffImagePath,
      },
    });

    // Re-focus the element so the next Tab press continues from here.
    // We use evaluate to re-focus via the selector we just computed.
    await page.evaluate((sel) => {
      try {
        const el = document.querySelector(sel);
        if (el) (el as HTMLElement).focus();
      } catch { /* will fall through to next tab */ }
    }, info.selector);
    await page.waitForTimeout(30);
  }

  return results;
}
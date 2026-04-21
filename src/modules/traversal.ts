import * as fs from "fs";
import * as path from "path";
import { Page } from "playwright";
import {
  TabStop,
  BoundingBox,
  TrapResult,
  EscapeAttempt,
  FocusOrderResult,
  FocusOrderViolation,
  SkipLinkResult,
  ObscuredResult,
} from "../types";

/** Maximum tab presses before we give up (prevents infinite loops) */
const MAX_TAB_PRESSES = 500;

type Direction = "forward" | "backward";

/** Keys to try when attempting to escape a suspected trap */
const ESCAPE_KEYS = [
  "Escape",
  "Shift+Tab",
  "ArrowDown",
  "ArrowUp",
  "ArrowRight",
  "ArrowLeft",
];

/**
 * How many times the same small set must repeat to suspect a trap.
 * With TRAP_UNIQUE_THRESHOLD=4 unique elements and TRAP_CYCLE_REPEATS=3,
 * we need to see the same ≤3 elements cycle 3 times (i.e., 9–12 consecutive
 * stops with no new element appearing).
 */
const TRAP_UNIQUE_THRESHOLD = 4;
const TRAP_CYCLE_REPEATS = 3;

/**
 * Once a trap is suspected during traversal, how many additional presses
 * to confirm it before breaking out. Keeps the traversal from spinning
 * for hundreds of presses inside a trap.
 */
const TRAP_CONFIRM_EXTRA_PRESSES = 6;

/**
 * Expose the selector builder inside the browser context.
 * Call this once after navigation, before running any checks.
 *
 * The selector strategy prioritizes stability across DOM re-renders:
 *   1. #id (most stable)
 *   2. Unique attribute combos: tag + href, tag + aria-label, etc.
 *   3. nth-of-type path fallback (least stable on SPAs)
 */
export async function injectHelpers(page: Page): Promise<void> {
  try {
    await page.exposeFunction("__buildSelector", async () => "");
  } catch {
    // Already registered from a previous call — safe to ignore
  }
  await page.evaluate(() => {
    (window as any).__getSelector = function (el: Element): string {
      // Strategy 1: ID
      if (el.id) {
        return "#" + CSS.escape(el.id);
      }

      // Strategy 2: Unique attribute-based selector
      const tag = el.tagName.toLowerCase();
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
            const matches = document.querySelectorAll(candidate);
            if (matches.length === 1) {
              return candidate;
            }
          } catch {
            // Selector might still be invalid for exotic attribute values
          }
        }
      }

      // Strategy 2b: Custom elements
      if (tag.includes("-")) {
        const matches = document.querySelectorAll(tag);
        if (matches.length === 1) {
          return tag;
        }
      }

      // Strategy 3: nth-of-type path (fallback)
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.documentElement) {
        let part = current.tagName.toLowerCase();
        if (current.id) {
          parts.unshift("#" + CSS.escape(current.id));
          break;
        }
        if (current.parentElement) {
          const siblings = Array.from(current.parentElement.children).filter(
            (s) => s.tagName === current!.tagName
          );
          if (siblings.length > 1) {
            const idx = siblings.indexOf(current) + 1;
            part += ":nth-of-type(" + idx + ")";
          }
        }
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
  });
}

/**
 * Get the selector of the currently focused element, or null if
 * nothing meaningful is focused.
 */
async function getActiveSelector(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return null;
    }
    return (window as any).__getSelector(el);
  });
}

/**
 * Get full info about the currently focused element.
 */
async function getActiveElementInfo(page: Page, startTime: number): Promise<{
  selector: string;
  tag: string;
  role: string | null;
  tabindex: number | null;
  domOrder: number;
  boundingBox: BoundingBox;
  timestamp: number;
} | null> {
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return null;
    }

    const selector = (window as any).__getSelector(el);

    const allElements = document.querySelectorAll("*");
    let domOrder = 0;
    for (let j = 0; j < allElements.length; j++) {
      if (allElements[j] === el) {
        domOrder = j;
        break;
      }
    }

    const rect = el.getBoundingClientRect();

    return {
      selector,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      tabindex: el.hasAttribute("tabindex")
        ? parseInt(el.getAttribute("tabindex")!, 10)
        : null,
      domOrder,
      boundingBox: {
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
      },
    };
  });

  if (!info) return null;

  return {
    ...info,
    boundingBox: info.boundingBox as BoundingBox,
    timestamp: Date.now() - startTime,
  };
}

// ---- Inline trap detector ----

/**
 * Lightweight trap detector that runs *during* the tab traversal.
 *
 * It maintains a sliding window of recent selectors. When the window
 * contains fewer than TRAP_UNIQUE_THRESHOLD unique elements for
 * TRAP_CYCLE_REPEATS full cycles, it signals a suspected trap.
 *
 * This lets recordTabStops() break out early instead of pressing Tab
 * 500 times inside a trap.
 */
class InlineTrapDetector {
  private recent: string[] = [];
  private readonly windowSize: number;

  constructor() {
    // Window = max unique elements × required repeats
    this.windowSize = TRAP_UNIQUE_THRESHOLD * TRAP_CYCLE_REPEATS;
  }

  /**
   * Feed a new selector. Returns the set of trapped selectors if a
   * trap is suspected, or null if traversal should continue.
   */
  push(selector: string): string[] | null {
    this.recent.push(selector);

    // Don't check until we have enough data
    if (this.recent.length < this.windowSize) return null;

    // Only keep the last windowSize entries
    if (this.recent.length > this.windowSize) {
      this.recent.shift();
    }

    const unique = new Set(this.recent);
    if (unique.size < TRAP_UNIQUE_THRESHOLD) {
      // Filter out elements that appear only once — they are entry
      // points into the trap, not part of the repeating cycle itself.
      const counts = new Map<string, number>();
      for (const sel of this.recent) {
        counts.set(sel, (counts.get(sel) || 0) + 1);
      }
      const repeating = Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([sel]) => sel)
        .sort();

      // Need at least 2 repeating elements to form a cycle
      if (repeating.length >= 2) {
        return repeating;
      }
    }

    return null;
  }

  /** Reset after breaking out of a trap */
  reset(): void {
    this.recent = [];
  }
}

/**
 * M1-01: Full Tab Sequence Recording
 *
 * Presses Tab (or Shift+Tab) repeatedly, recording every element that
 * receives focus. Stops when focus cycles back to the first element
 * or the maximum threshold is reached.
 *
 * Integrates inline trap detection: if a trap is suspected during
 * traversal, records it and breaks out early rather than pressing
 * Tab hundreds of times inside the trapped set.
 */
export async function recordTabStops(
  page: Page,
  direction: Direction
): Promise<{ stops: TabStop[]; inlineTraps: TrapResult[] }> {
  const stops: TabStop[] = [];
  const inlineTraps: TrapResult[] = [];
  const startTime = Date.now();
  const detector = new InlineTrapDetector();

  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    document.body.focus();
  });

  const key = direction === "forward" ? "Tab" : "Shift+Tab";
  let firstSelector: string | null = null;

  for (let i = 0; i < MAX_TAB_PRESSES; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(50);

    const info = await getActiveElementInfo(page, startTime);
    if (!info) continue;

    if (firstSelector === null) {
      firstSelector = info.selector;
    } else if (info.selector === firstSelector) {
      break;
    }

    stops.push({
      index: stops.length,
      selector: info.selector,
      tag: info.tag,
      role: info.role,
      tabindex: info.tabindex,
      domOrder: info.domOrder,
      boundingBox: info.boundingBox,
      timestamp: info.timestamp,
    });

    // ---- Inline trap detection ----
    const trapped = detector.push(info.selector);
    if (!trapped) continue;

    // Suspected trap — confirm with a few more presses
    let confirmed = true;
    for (let extra = 0; extra < TRAP_CONFIRM_EXTRA_PRESSES; extra++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(50);
      const sel = await getActiveSelector(page);
      if (sel && !trapped.includes(sel)) {
        // Focus escaped the suspected set — false alarm
        confirmed = false;
        const extraInfo = await getActiveElementInfo(page, startTime);
        if (extraInfo) {
          stops.push({
            index: stops.length,
            selector: extraInfo.selector,
            tag: extraInfo.tag,
            role: extraInfo.role,
            tabindex: extraInfo.tabindex,
            domOrder: extraInfo.domOrder,
            boundingBox: extraInfo.boundingBox,
            timestamp: extraInfo.timestamp,
          });
          if (firstSelector && extraInfo.selector === firstSelector) {
            return { stops, inlineTraps };
          }
          detector.reset();
          detector.push(extraInfo.selector);
        }
        break;
      }
    }

    if (confirmed) {
      const escapeAttempts = await tryEscape(page, trapped);
      const escaped = escapeAttempts.some((a) => a.escaped);

      inlineTraps.push({
        isTrap: !escaped,
        trappedElements: trapped,
        escapeAttempts,
        location: trapped[0],
      });

      if (!escaped) {
        // Confirmed hard trap — stop traversal
        break;
      }

      // Escaped — reset detector and continue
      detector.reset();
      const newSel = await getActiveSelector(page);
      if (newSel) {
        detector.push(newSel);
        if (firstSelector && newSel === firstSelector) break;
      }
    }
  }

  return { stops, inlineTraps };
}

/**
 * M1-02: Keyboard Trap Detection (post-traversal analysis)
 *
 * Analyzes a recorded tab stop sequence for repeating cycles.
 * This catches traps that the inline detector might miss (e.g.,
 * traps with exactly TRAP_UNIQUE_THRESHOLD elements).
 *
 * The inline detector handles most traps during traversal; this
 * function is a safety net that also handles the backward pass.
 */
export async function detectTraps(
  page: Page,
  stops: TabStop[],
  inlineTraps: TrapResult[] = []
): Promise<TrapResult[]> {
  const traps: TrapResult[] = [...inlineTraps];

  if (stops.length < 10) {
    return traps;
  }

  // Build a set of already-reported trapped element sets for deduplication
  const alreadyReportedSets = new Set(
    traps.map(t => [...t.trappedElements].sort().join("|"))
  );

  const windowSize = 10;
  const isSubsetOf = (a: string[], b: string[]) =>
    a.every((sel) => b.includes(sel));

  for (let i = 0; i <= stops.length - windowSize; i++) {
    const window = stops.slice(i, i + windowSize);
    const uniqueSelectors = new Set(window.map((s) => s.selector));

    if (uniqueSelectors.size >= TRAP_UNIQUE_THRESHOLD) {
      continue;
    }

    const cycleLength = uniqueSelectors.size;
    const requiredLength = cycleLength * TRAP_CYCLE_REPEATS;

    if (i + requiredLength > stops.length) {
      continue;
    }

    const extendedWindow = stops.slice(i, i + requiredLength);
    const extendedUnique = new Set(extendedWindow.map((s) => s.selector));

    if (extendedUnique.size > cycleLength) {
      continue;
    }

    const trappedSet = Array.from(uniqueSelectors).sort();
    const setKey = trappedSet.join("|");

    // Skip if already reported by inline detector
    if (alreadyReportedSets.has(setKey)) {
      i += requiredLength - 1;
      continue;
    }

    // Remove previous traps that are supersets of this one
    for (let j = traps.length - 1; j >= 0; j--) {
      if (
        isSubsetOf(trappedSet, traps[j].trappedElements) &&
        traps[j].trappedElements.length > trappedSet.length
      ) {
        traps.splice(j, 1);
      }
    }

    const alreadyReported = traps.some((t) => {
      const existing = [...t.trappedElements].sort();
      return isSubsetOf(existing, trappedSet);
    });

    if (alreadyReported) {
      continue;
    }

    const escapeAttempts = await tryEscape(page, trappedSet);
    const escaped = escapeAttempts.some((a) => a.escaped);

    traps.push({
      isTrap: !escaped,
      trappedElements: trappedSet,
      escapeAttempts,
      location: stops[i].selector,
    });

    alreadyReportedSets.add(setKey);
    i += requiredLength - 1;
  }

  return traps;
}

/**
 * Navigate focus to one of the trapped elements, then try each
 * escape key and check whether focus moves outside the trapped set.
 */
async function tryEscape(
  page: Page,
  trappedSelectors: string[]
): Promise<EscapeAttempt[]> {
  const attempts: EscapeAttempt[] = [];

  for (const key of ESCAPE_KEYS) {
    try {
      await page.focus(trappedSelectors[0]);
    } catch {
      return attempts;
    }

    await page.waitForTimeout(50);
    await page.keyboard.press(key);
    await page.waitForTimeout(50);

    const currentSelector = await getActiveSelector(page);

    const escaped =
      currentSelector !== null && !trappedSelectors.includes(currentSelector);

    attempts.push({ key, escaped });
  }

  return attempts;
}

/**
 * M1-04: Skip Link Verification
 *
 * Checks if one of the first few tab stops is a skip link (an anchor
 * pointing to an in-page #id). If found, activates it and verifies
 * that focus actually moves to the target element.
 */
export async function verifySkipLink(
  page: Page,
  stops: TabStop[]
): Promise<SkipLinkResult> {
  // Only check the first 3 tab stops — skip links should be very early
  const candidates = stops.slice(0, 3);

  for (const stop of candidates) {
    const skipInfo = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;

      // Check for an anchor with an in-page href AND skip-related text.
      // Requiring both prevents false positives on regular in-page
      // anchors like <a href="#top">Reference link</a>.
      const anchor = el.tagName === "A" ? el : el.querySelector("a");
      if (anchor) {
        const href = anchor.getAttribute("href");
        if (href && href.startsWith("#") && href.length > 1) {
          const text = (anchor.textContent || "").toLowerCase().trim();
          const isSkipText =
            text.includes("skip") ||
            text.includes("main content") ||
            text.includes("jump to") ||
            text.includes("pāriet uz") ||
            text.includes("pārlēkt");
          if (isSkipText) {
            return { href, text, selector };
          }
        }
      }

      // Check shadow DOM for anchors
      if (el.shadowRoot) {
        const shadowAnchor = el.shadowRoot.querySelector("a");
        if (shadowAnchor) {
          const href = shadowAnchor.getAttribute("href");
          if (href && href.startsWith("#") && href.length > 1) {
            const text = (shadowAnchor.textContent || "").toLowerCase().trim();
            return { href, text, selector };
          }
        }
      }

      // Detect by tag name — custom elements like <skip-to-content>
      const tagName = el.tagName.toLowerCase();
      if (
        tagName.includes("skip") ||
        tagName.includes("skipto")
      ) {
        return { href: null, text: tagName, selector };
      }

      // Check if the element itself has skip-related text
      const elText = (el.textContent || "").toLowerCase().trim();
      const isSkipText =
        elText.includes("skip") ||
        elText.includes("main content") ||
        elText.includes("jump to");
      if (isSkipText) {
        return { href: null, text: elText, selector };
      }

      return null;
    }, stop.selector);

    if (!skipInfo) continue;

    // We found something that looks like a skip link.
    // Now activate it and check where focus goes.
    await page.focus(stop.selector);
    await page.waitForTimeout(50);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    const targetInfo = await page.evaluate(
      (args: { expectedHref: string | null; skipLinkSelector: string }) => {
        const el = document.activeElement;
        const mainEl = document.querySelector("main, [role='main']");

        let skipEl: Element | null = null;
        try {
          skipEl = document.querySelector(args.skipLinkSelector);
        } catch {
          // Invalid selector — treat as not matching
        }

        const focusIsOnSkipLink =
          el !== null &&
          skipEl !== null &&
          (el === skipEl || skipEl.contains(el));

        if (
          el &&
          el !== document.body &&
          el !== document.documentElement &&
          !focusIsOnSkipLink
        ) {
          const sel = el.id ? "#" + CSS.escape(el.id) : null;
          const isInMain = mainEl ? mainEl.contains(el) : false;
          return { reachable: true, selector: sel, isInMain };
        }

        if (args.expectedHref) {
          const targetId = args.expectedHref.replace("#", "");
          const target = document.getElementById(targetId);
          if (target) {
            const rect = target.getBoundingClientRect();
            return {
              reachable: rect.top >= -10 && rect.top <= 200,
              selector: "#" + CSS.escape(targetId),
              isInMain: mainEl ? mainEl.contains(target) : false,
            };
          }
          return { reachable: false, selector: null, isInMain: false };
        }

        if (mainEl) {
          const rect = mainEl.getBoundingClientRect();
          return {
            reachable: rect.top >= -10 && rect.top <= 200,
            selector: mainEl.id ? "#" + CSS.escape(mainEl.id) : "main",
            isInMain: true,
          };
        }

        return { reachable: false, selector: null, isInMain: false };
      },
      { expectedHref: skipInfo.href, skipLinkSelector: stop.selector }
    );

    return {
      exists: true,
      targetReachable: targetInfo.reachable,
      targetSelector: targetInfo.selector,
    };
  }

  return {
    exists: false,
    targetReachable: false,
    targetSelector: null,
  };
}

/**
 * M1-03: Focus Order vs. Visual Layout Analysis
 *
 * Compares the tab sequence order against the visual reading order
 * derived from element bounding boxes (top-to-bottom, left-to-right).
 */
export function analyzeFocusOrder(stops: TabStop[]): FocusOrderResult {
  if (stops.length < 2) {
    return { correlationScore: 1, violations: [] };
  }

  // Elements within this vertical distance are considered on the same row
  const ROW_THRESHOLD = 30;

  const visualOrder = [...stops].sort((a, b) => {
    const ay = a.boundingBox.y;
    const by = b.boundingBox.y;
    if (Math.abs(ay - by) <= ROW_THRESHOLD) {
      return a.boundingBox.x - b.boundingBox.x;
    }
    return ay - by;
  });

  // Map each stop to its rank in visual order
  const visualRank = new Map<string, number>();
  visualOrder.forEach((stop, rank) => {
    visualRank.set(stop.selector, rank);
  });

  // Spearman rank correlation: rho = 1 - (6 * sum(d^2)) / (n * (n^2 - 1))
  const n = stops.length;
  let sumDSquared = 0;

  for (const stop of stops) {
    const tabRank = stop.index;
    const visRank = visualRank.get(stop.selector) ?? tabRank;
    const d = tabRank - visRank;
    sumDSquared += d * d;
  }

  const correlationScore =
    n > 1 ? 1 - (6 * sumDSquared) / (n * (n * n - 1)) : 1;

  // Detect individual violations
  const JUMP_THRESHOLD = 200;
  const violations: FocusOrderViolation[] = [];

  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const curr = stops[i];
    const dy = curr.boundingBox.y - prev.boundingBox.y;

    if (dy < -JUMP_THRESHOLD) {
      violations.push({
        fromElement: prev.selector,
        toElement: curr.selector,
        jumpDistance: Math.abs(dy),
        direction: "backward-vertical",
      });
    }
  }

  // Flag tabindex > 0 as a separate anti-pattern warning
  for (const stop of stops) {
    if (stop.tabindex !== null && stop.tabindex > 0) {
      violations.push({
        fromElement: stop.selector,
        toElement: stop.selector,
        jumpDistance: 0,
        direction: "other",
      });
    }
  }

  return {
    correlationScore: Math.round(correlationScore * 1000) / 1000,
    violations,
  };
}

/**
 * M1-05: Focus Not Obscured Detection
 *
 * Tabs through the page using real Tab presses and checks at each stop
 * whether the focused element is obscured by fixed/sticky elements.
 */
export async function detectObscured(
  page: Page,
  stops: TabStop[],
  outputDir: string | null = null,
  onProgress?: (current: number, total: number) => void
): Promise<Map<number, ObscuredResult>> {
  const results = new Map<number, ObscuredResult>();
  const viewportHeight = 720;
  const viewportWidth = 1280;

  // Reset focus to start of page
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    document.body.focus();
  });

  const stopSelectors = stops.map(s => s.selector);
  let stopIdx = 0;

  for (let tabPress = 0; tabPress < MAX_TAB_PRESSES && stopIdx < stops.length; tabPress++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(50);

    // Check what element is currently focused
    const currentSelector = await getActiveSelector(page);

    if (!currentSelector) continue;

    // Find which stop this corresponds to
    while (stopIdx < stops.length && stopSelectors[stopIdx] !== currentSelector) {
      results.set(stops[stopIdx].index, {
        fullyObscured: false,
        partiallyObscured: false,
        overlapPercent: 0,
        obscuringElement: null,
        focusedInViewport: true,
      });
      stopIdx++;
    }

    if (stopIdx >= stops.length) break;

    const stop = stops[stopIdx];
    onProgress?.(stopIdx + 1, stops.length);

    await page.waitForTimeout(10);

    const data = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;

      const fRect = el.getBoundingClientRect();
      const focusRect = { x: fRect.x, y: fRect.y, w: fRect.width, h: fRect.height };

      const checkPoints = [
        { x: fRect.x + fRect.width / 2, y: fRect.y + fRect.height / 2 },
        { x: fRect.x + 2, y: fRect.y + 2 },
        { x: fRect.x + fRect.width - 2, y: fRect.y + 2 },
        { x: fRect.x + 2, y: fRect.y + fRect.height - 2 },
        { x: fRect.x + fRect.width - 2, y: fRect.y + fRect.height - 2 },
      ].filter(p => p.x >= 0 && p.y >= 0);

      let obscuredPoints = 0;
      let obscurerSelector: string | null = null;

      for (const point of checkPoints) {
        const topEl = document.elementFromPoint(point.x, point.y);
        if (!topEl) continue;

        if (topEl === el || el.contains(topEl) || topEl.contains(el)) {
          continue;
        }

        obscuredPoints++;
        if (!obscurerSelector) {
          obscurerSelector = topEl.id
            ? "#" + CSS.escape(topEl.id)
            : topEl.tagName.toLowerCase();
        }
      }

      const totalPoints = checkPoints.length;
      const overlapPercent = totalPoints > 0
        ? Math.round((obscuredPoints / totalPoints) * 100)
        : 0;

      return { focusRect, overlapPercent, obscurerSelector };
    });

    if (!data) {
      results.set(stop.index, {
        fullyObscured: false,
        partiallyObscured: false,
        overlapPercent: 0,
        obscuringElement: null,
        focusedInViewport: false,
      });
      stopIdx++;
      continue;
    }

    const { focusRect, overlapPercent, obscurerSelector } = data;

    const focusedInViewport =
      focusRect.y + focusRect.h > 0 &&
      focusRect.y < viewportHeight &&
      focusRect.x + focusRect.w > 0 &&
      focusRect.x < viewportWidth;

    // Capture viewport screenshot when the element is obscured
    let screenshotPath: string | undefined;
    if (overlapPercent > 0 && outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });
      const safeName = stop.selector
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .substring(0, 80);
      const fileName = `m1-05_${stop.index}_${safeName}_obscured.png`;
      const filePath = path.join(outputDir, fileName);

      try {
        await page.screenshot({ path: filePath, type: "png" });
        screenshotPath = filePath;
      } catch {
        // Screenshot failed — continue without it
      }
    }

    results.set(stop.index, {
      fullyObscured: overlapPercent >= 100,
      partiallyObscured: overlapPercent > 0 && overlapPercent < 100,
      overlapPercent,
      obscuringElement: overlapPercent > 0 ? obscurerSelector : null,
      focusedInViewport,
      screenshotPath,
    });

    stopIdx++;
  }

  // Fill in any remaining stops we didn't reach
  while (stopIdx < stops.length) {
    results.set(stops[stopIdx].index, {
      fullyObscured: false,
      partiallyObscured: false,
      overlapPercent: 0,
      obscuringElement: null,
      focusedInViewport: true,
    });
    stopIdx++;
  }

  return results;
}
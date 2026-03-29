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
 * Helper used inside page.evaluate() calls to build a unique CSS selector.
 * Defined once here, called from multiple evaluate callbacks.
 */
function buildSelectorInPage(el: Element): string {
  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    if (current.parentElement) {
      const siblings = Array.from(current.parentElement.children).filter(
        (s) => s.tagName === current!.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ");
}

/**
 * Expose the selector builder inside the browser context.
 * Call this once after navigation, before running any checks.
 */
export async function injectHelpers(page: Page): Promise<void> {
  await page.exposeFunction("__buildSelector", async () => "");
  await page.evaluate(() => {
    (window as any).__getSelector = function (el: Element): string {
      if (el.id) {
        return "#" + CSS.escape(el.id);
      }
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.documentElement) {
        let part = current.tagName.toLowerCase();
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
 * M1-01: Full Tab Sequence Recording
 *
 * Presses Tab (or Shift+Tab) repeatedly, recording every element that
 * receives focus. Stops when focus cycles back to the first element
 * or the maximum threshold is reached.
 */
export async function recordTabStops(
  page: Page,
  direction: Direction
): Promise<TabStop[]> {
  const stops: TabStop[] = [];
  const startTime = Date.now();

  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    document.body.focus();
  });

  let firstSelector: string | null = null;

  for (let i = 0; i < MAX_TAB_PRESSES; i++) {
    if (direction === "forward") {
      await page.keyboard.press("Tab");
    } else {
      await page.keyboard.press("Shift+Tab");
    }

    await page.waitForTimeout(50);

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

    if (!info) {
      continue;
    }

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
      boundingBox: info.boundingBox as BoundingBox,
      timestamp: Date.now() - startTime,
    });
  }

  return stops;
}

/**
 * M1-02: Keyboard Trap Detection
 *
 * Analyzes a recorded tab stop sequence for repeating cycles.
 * If a suspected trap is found, navigates to it and attempts escape keys.
 */
export async function detectTraps(
  page: Page,
  stops: TabStop[]
): Promise<TrapResult[]> {
  const traps: TrapResult[] = [];

  if (stops.length < 10) {
    return traps;
  }

  const windowSize = 10;
  const isSubsetOf = (a: string[], b: string[]) =>
    a.every((sel) => b.includes(sel));

  for (let i = 0; i <= stops.length - windowSize; i++) {
    const window = stops.slice(i, i + windowSize);
    const uniqueSelectors = new Set(window.map((s) => s.selector));

    if (uniqueSelectors.size >= 4) {
      continue;
    }

    const cycleLength = uniqueSelectors.size;
    const requiredLength = cycleLength * 3;

    if (i + requiredLength > stops.length) {
      continue;
    }

    const extendedWindow = stops.slice(i, i + requiredLength);
    const extendedUnique = new Set(extendedWindow.map((s) => s.selector));

    if (extendedUnique.size > cycleLength) {
      continue;
    }

    const trappedSet = Array.from(uniqueSelectors).sort();

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

    const currentSelector = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        return null;
      }
      return (window as any).__getSelector(el);
    });

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

      // Check for an anchor with an in-page href
      const anchor = el.tagName === "A" ? el : el.querySelector("a");
      if (anchor) {
        const href = anchor.getAttribute("href");
        if (href && href.startsWith("#") && href.length > 1) {
          const text = (anchor.textContent || "").toLowerCase().trim();
          return { href, text, selector };
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

    const targetInfo = await page.evaluate((expectedHref) => {
      const el = document.activeElement;

      // Check if focus moved to a main content landmark
      const mainEl = document.querySelector("main, [role='main']");

      if (el && el !== document.body && el !== document.documentElement) {
        const sel = el.id ? "#" + CSS.escape(el.id) : null;
        // Focus landed on an element — check if it's inside main content
        const isInMain = mainEl ? mainEl.contains(el) : false;
        return {
          reachable: true,
          selector: sel,
          isInMain,
        };
      }

      // Focus didn't move to a specific element.
      // Check if the skip link navigated via href.
      if (expectedHref) {
        const targetId = expectedHref.replace("#", "");
        const target = document.getElementById(targetId);
        if (target) {
          const rect = target.getBoundingClientRect();
          return {
            reachable: rect.top >= -10 && rect.top <= 200,
            selector: "#" + CSS.escape(targetId),
            isInMain: mainEl ? mainEl.contains(target) : false,
          };
        }
      }

      // Last resort: check if main content scrolled near the top
      if (mainEl) {
        const rect = mainEl.getBoundingClientRect();
        return {
          reachable: rect.top >= -10 && rect.top <= 200,
          selector: mainEl.id ? "#" + CSS.escape(mainEl.id) : "main",
          isInMain: true,
        };
      }

      return { reachable: false, selector: null, isInMain: false };
    }, skipInfo.href);

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
 * For each tab stop, checks whether it is obscured by fixed or sticky
 * positioned elements (headers, footers, cookie banners, etc.).
 * Also checks whether the focused element is within the viewport.
 */
export async function detectObscured(
  page: Page,
  stops: TabStop[]
): Promise<Map<number, ObscuredResult>> {
  const results = new Map<number, ObscuredResult>();
  const viewportHeight = 720;
  const viewportWidth = 1280;

  for (const stop of stops) {
    try {
      await page.focus(stop.selector);
    } catch {
      results.set(stop.index, {
        fullyObscured: false,
        partiallyObscured: false,
        overlapPercent: 0,
        obscuringElement: null,
        focusedInViewport: false,
      });
      continue;
    }

    await page.waitForTimeout(30);

    // Check if the focused element is actually visually obscured
    // by using elementFromPoint at the center of the element.
    // This lets the browser's own rendering engine tell us what's on top.
    const data = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;

      const fRect = el.getBoundingClientRect();
      const focusRect = { x: fRect.x, y: fRect.y, w: fRect.width, h: fRect.height };

      // Check multiple points on the element to determine overlap percentage
      const checkPoints = [
        { x: fRect.x + fRect.width / 2, y: fRect.y + fRect.height / 2 },  // center
        { x: fRect.x + 2, y: fRect.y + 2 },                                // top-left
        { x: fRect.x + fRect.width - 2, y: fRect.y + 2 },                  // top-right
        { x: fRect.x + 2, y: fRect.y + fRect.height - 2 },                 // bottom-left
        { x: fRect.x + fRect.width - 2, y: fRect.y + fRect.height - 2 },   // bottom-right
      ].filter(p => p.x >= 0 && p.y >= 0);

      let obscuredPoints = 0;
      let obscurerSelector: string | null = null;

      for (const point of checkPoints) {
        const topEl = document.elementFromPoint(point.x, point.y);
        if (!topEl) continue;

        // If the top element is the focused element itself, or a
        // descendant/ancestor of it, the point is not obscured
        if (topEl === el || el.contains(topEl) || topEl.contains(el)) {
          continue;
        }

        // This point is covered by something else
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
      continue;
    }

    const { focusRect, overlapPercent, obscurerSelector } = data;

    const focusedInViewport =
      focusRect.y + focusRect.h > 0 &&
      focusRect.y < viewportHeight &&
      focusRect.x + focusRect.w > 0 &&
      focusRect.x < viewportWidth;

    results.set(stop.index, {
      fullyObscured: overlapPercent >= 100,
      partiallyObscured: overlapPercent > 0 && overlapPercent < 100,
      overlapPercent,
      obscuringElement: overlapPercent > 0 ? obscurerSelector : null,
      focusedInViewport,
    });
  }

  return results;
}
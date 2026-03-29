import { Page } from "playwright";
import { TabStop, BoundingBox, TrapResult, EscapeAttempt } from "../types";

/** Maximum tab presses before we give up (prevents infinite loops) */
const MAX_TAB_PRESSES = 500;

type Direction = "forward" | "backward";

/** Keys to try when attempting to escape a suspected trap */
const ESCAPE_KEYS = ["Escape", "Shift+Tab", "ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"];

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

  // Move focus to the very beginning of the page.
  // Clicking the body ensures we start from a clean state —
  // no element is focused yet, so the first Tab press lands
  // on the page's first focusable element.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    document.body.focus();
  });

  let firstSelector: string | null = null;

  for (let i = 0; i < MAX_TAB_PRESSES; i++) {
    // Press Tab or Shift+Tab
    if (direction === "forward") {
      await page.keyboard.press("Tab");
    } else {
      await page.keyboard.press("Shift+Tab");
    }

    // Small wait for focus styles / transitions to settle
    await page.waitForTimeout(50);

    // Extract info about the currently focused element
    const info = await page.evaluate(() => {
      const el = document.activeElement;

      // If focus landed on <body> or <html>, there's nothing useful to record
      if (!el || el === document.body || el === document.documentElement) {
        return null;
      }

      // Build a unique CSS selector for this element.
      // We try id first, then fall back to a path-based selector.
      function getSelector(element: Element): string {
        if (element.id) {
          return `#${CSS.escape(element.id)}`;
        }

        const parts: string[] = [];
        let current: Element | null = element;
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

      // Determine DOM source order: count how many elements precede
      // this one in a document-order traversal.
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
        selector: getSelector(el),
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

    // Focus landed on body/html — might mean we've gone past all elements
    if (!info) {
      continue;
    }

    // Cycle detection: if we've returned to the first focused element, stop
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
 * Analyzes a recorded tab stop sequence for repeating cycles —
 * a small set of elements visited over and over. If a suspected
 * trap is found, navigates to it and attempts escape keys.
 *
 * Should be called with the forward tab stops from recordTabStops.
 * If recordTabStops hit MAX_TAB_PRESSES without cycling, this is
 * especially likely to find a trap.
 */
export async function detectTraps(
  page: Page,
  stops: TabStop[]
): Promise<TrapResult[]> {
  const traps: TrapResult[] = [];

  // Nothing to analyze if the page has very few stops
  if (stops.length < 10) {
    return traps;
  }

  // Use a sliding window to find repeating patterns.
  // We look at windows of N selectors and check whether
  // the unique set is suspiciously small.
  const windowSize = 10;

  for (let i = 0; i <= stops.length - windowSize; i++) {
    const window = stops.slice(i, i + windowSize);
    const uniqueSelectors = new Set(window.map((s) => s.selector));

    // Fewer than 4 unique elements in a window of 10 is suspicious.
    // But we need to confirm it repeats — check that the pattern
    // continues for at least 3 full cycles of the unique set.
    if (uniqueSelectors.size >= 4) {
      continue;
    }

    const cycleLength = uniqueSelectors.size;
    const requiredLength = cycleLength * 3;

    // Make sure we have enough stops ahead to confirm 3 full cycles
    if (i + requiredLength > stops.length) {
      continue;
    }

    // Verify that the same small set repeats for 3 full cycles
    const extendedWindow = stops.slice(i, i + requiredLength);
    const extendedUnique = new Set(extendedWindow.map((s) => s.selector));

    if (extendedUnique.size > cycleLength) {
      // New elements appeared — not a real cycle
      continue;
    }

    // We have a suspected trap. Check if we've already flagged
    // these same elements or a superset containing them.
    const trappedSet = Array.from(uniqueSelectors).sort();
    const isSubsetOf = (a: string[], b: string[]) =>
      a.every((sel) => b.includes(sel));

    // Remove any previously reported trap that is a superset of this
    // smaller, more precise trapped set
    for (let j = traps.length - 1; j >= 0; j--) {
      if (isSubsetOf(trappedSet, traps[j].trappedElements) &&
          traps[j].trappedElements.length > trappedSet.length) {
        traps.splice(j, 1);
      }
    }

    // Skip if this exact set or a subset was already reported
    const alreadyReported = traps.some((t) => {
      const existing = [...t.trappedElements].sort();
      return isSubsetOf(existing, trappedSet);
    });

    if (alreadyReported) {
      continue;
    }

    // Now navigate to the trapped element and try to escape
    const escapeAttempts = await tryEscape(page, trappedSet);

    const escaped = escapeAttempts.some((a) => a.escaped);

    traps.push({
      isTrap: !escaped,
      trappedElements: trappedSet,
      escapeAttempts,
      location: stops[i].selector,
    });

    // Skip past this trapped region to avoid redundant detection
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
    // First, focus one of the trapped elements so we start inside the trap
    try {
      await page.focus(trappedSelectors[0]);
    } catch {
      // Element might not be focusable directly — skip escape testing
      return attempts;
    }

    await page.waitForTimeout(50);

    // Press the escape key
    await page.keyboard.press(key);
    await page.waitForTimeout(50);

    // Check where focus landed
    const currentSelector = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        return null;
      }

      function getSelector(element: Element): string {
        if (element.id) {
          return `#${CSS.escape(element.id)}`;
        }
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.documentElement) {
          let part = current.tagName.toLowerCase();
          if (current.parentElement) {
            const siblings = Array.from(
              current.parentElement.children
            ).filter((s) => s.tagName === current!.tagName);
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

      return getSelector(el);
    });

    // Did focus escape the trapped set?
    const escaped =
      currentSelector !== null && !trappedSelectors.includes(currentSelector);

    attempts.push({ key, escaped });
  }

  return attempts;
}
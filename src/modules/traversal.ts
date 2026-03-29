import { Page } from "playwright";
import { TabStop, BoundingBox } from "../types";

/** Maximum tab presses before we give up (prevents infinite loops) */
const MAX_TAB_PRESSES = 500;

type Direction = "forward" | "backward";

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
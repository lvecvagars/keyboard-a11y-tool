/**
 * Module 3: Interactive Element Coverage
 *
 * M3-01: Pointer-Interactive vs. Keyboard-Reachable Gap
 * M3-02: Non-Semantic Interactive Element Detection
 * M3-03: Scrollable Region Keyboard Access
 *
 * Depends on Module 1's tab stop data (the "keyboard-reachable" set).
 */

import { Page, CDPSession } from "playwright";
import {
  TabStop,
  CoverageGap,
  UnreachableElement,
  NonSemanticControl,
  ScrollableRegion,
} from "../types";

// ---- Configuration ----

const NATIVE_INTERACTIVE_TAGS = new Set([
  "a", "button", "input", "select", "textarea", "summary", "details",
]);

const NON_SEMANTIC_TAGS = new Set([
  "div", "span", "li", "td", "img", "p",
  "section", "article", "header", "footer", "nav", "label",
]);

/**
 * Extract the actual element tag from a CSS selector string.
 * For path selectors like "body > header > ul > li:nth-of-type(2)",
 * we want the LAST segment's tag, not the first.
 */
function extractTagFromSelector(selector: string): string {
  const segments = selector.split(">").map(s => s.trim());
  const lastSegment = segments[segments.length - 1] || "";
  const tag = lastSegment.split(/[.#\[:]/)[0].trim();
  return tag || "div";
}

const INTERACTIVE_ARIA_ROLES = new Set([
  "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "switch", "checkbox", "radio", "treeitem", "gridcell",
  "slider", "spinbutton", "combobox", "searchbox", "textbox", "listbox",
]);

// ---- Types ----

interface InteractiveCandidate {
  selector: string;
  tag: string;
  role: string | null;
  hasOnclick: boolean;
  hasCursorPointer: boolean;
  hasInteractiveRole: boolean;
  hasTabindex: boolean;
  tabindexValue: number | null;
  isHidden: boolean;
  isNativeInteractive: boolean;
  isNonSemantic: boolean;
  isAnchorWithoutHref: boolean;
}

// ---- DOM Candidate Collection ----

async function collectCandidatesFromDOM(page: Page): Promise<InteractiveCandidate[]> {
  return page.evaluate(
    (args: {
      interactiveRoles: string[];
      nativeInteractiveTags: string[];
      nonSemanticTags: string[];
    }) => {
      const interactiveRoles = new Set(args.interactiveRoles);
      const nativeInteractiveTags = new Set(args.nativeInteractiveTags);
      const nonSemanticTags = new Set(args.nonSemanticTags);
      const results: InteractiveCandidate[] = [];
      const seen = new Set<Element>();

      function getSelector(el: Element): string {
        if (el.id) return "#" + CSS.escape(el.id);
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
              if (document.querySelectorAll(candidate).length === 1) return candidate;
            } catch { /* skip */ }
          }
        }
        if (tag.includes("-")) {
          try {
            if (document.querySelectorAll(tag).length === 1) return tag;
          } catch { /* skip */ }
        }
        const parts: string[] = [];
        let cur: Element | null = el;
        while (cur && cur !== document.documentElement) {
          let part = cur.tagName.toLowerCase();
          if (cur.id) { parts.unshift("#" + CSS.escape(cur.id)); break; }
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
        return parts.join(" > ");
      }

      function isHidden(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return true;
        if (el.getAttribute("aria-hidden") === "true") return true;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return true;
        return false;
      }

      function processElement(el: Element) {
        if (seen.has(el)) return;
        seen.add(el);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const style = window.getComputedStyle(el);
        const hasCursorPointer = style.cursor === "pointer";
        const hasOnclick = el.hasAttribute("onclick");
        const hasInteractiveRole = role ? interactiveRoles.has(role) : false;
        const hasTabindex = el.hasAttribute("tabindex");
        const tabindexValue = hasTabindex
          ? parseInt(el.getAttribute("tabindex")!, 10)
          : null;
        const isAnchorWithHref = tag === "a" && el.hasAttribute("href");
        const isNativeInteractive =
          (nativeInteractiveTags.has(tag) && tag !== "a") || isAnchorWithHref;
        const isAnchorWithoutHref = tag === "a" && !el.hasAttribute("href");
        const isNonSemantic = nonSemanticTags.has(tag) || isAnchorWithoutHref;

        // Skip disabled native controls
        if (isNativeInteractive) {
          const htmlEl = el as HTMLElement;
          if ("disabled" in htmlEl && (htmlEl as any).disabled) return;
        }

        const hasSignal =
          isNativeInteractive ||
          hasCursorPointer ||
          hasOnclick ||
          hasInteractiveRole;

        if (!hasSignal) return;

        results.push({
          selector: getSelector(el),
          tag, role, hasOnclick, hasCursorPointer, hasInteractiveRole,
          hasTabindex, tabindexValue,
          isHidden: isHidden(el),
          isNativeInteractive, isNonSemantic, isAnchorWithoutHref,
        });
      }

      const allElements = document.querySelectorAll("*");
      for (let i = 0; i < allElements.length; i++) {
        processElement(allElements[i]);
      }
      return results;
    },
    {
      interactiveRoles: Array.from(INTERACTIVE_ARIA_ROLES),
      nativeInteractiveTags: Array.from(NATIVE_INTERACTIVE_TAGS),
      nonSemanticTags: Array.from(NON_SEMANTIC_TAGS),
    }
  );
}

// ---- CDP Event Listener Detection ----

async function detectEventListenersViaCDP(
  page: Page,
  candidateSelectors: string[]
): Promise<{ clickListeners: Set<string>; keyListeners: Set<string> }> {
  const clickListeners = new Set<string>();
  const keyListeners = new Set<string>();

  let cdp: CDPSession;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch {
    return { clickListeners, keyListeners };
  }

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");

    for (const selector of candidateSelectors) {
      try {
        const { result } = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(selector)})`,
          returnByValue: false,
        });
        if (!result.objectId) continue;

        const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
          objectId: result.objectId,
          depth: 0,
        });

        for (const listener of listeners) {
          const type = listener.type;
          if (type === "click" || type === "mousedown" || type === "mouseup" ||
              type === "pointerdown" || type === "pointerup") {
            clickListeners.add(selector);
          }
          if (type === "keydown" || type === "keyup" || type === "keypress") {
            keyListeners.add(selector);
          }
        }

        await cdp.send("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
      } catch { continue; }
    }
  } finally {
    await cdp.detach().catch(() => {});
  }

  return { clickListeners, keyListeners };
}

async function collectNonSemanticSelectorsForCDP(page: Page): Promise<string[]> {
  return page.evaluate((nonSemanticTags: string[]) => {
    const tagSet = new Set(nonSemanticTags);
    const results: string[] = [];
    const MAX = 200;

    function getSelector(el: Element): string {
      if (el.id) return "#" + CSS.escape(el.id);
      const tag = el.tagName.toLowerCase();
      const attrs: [string, string | null][] = [
        ["aria-label", el.getAttribute("aria-label")],
        ["data-testid", el.getAttribute("data-testid")],
      ];
      for (const [attr, val] of attrs) {
        if (val) {
          const escaped = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const candidate = tag + "[" + attr + '="' + escaped + '"]';
          try {
            if (document.querySelectorAll(candidate).length === 1) return candidate;
          } catch { /* skip */ }
        }
      }
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur !== document.documentElement) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift("#" + CSS.escape(cur.id)); break; }
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
      return parts.join(" > ");
    }

    const allElements = document.querySelectorAll("*");
    for (let i = 0; i < allElements.length && results.length < MAX; i++) {
      const el = allElements[i];
      const tag = el.tagName.toLowerCase();
      const isAnchorWithoutHref = tag === "a" && !el.hasAttribute("href");
      if (!tagSet.has(tag) && !isAnchorWithoutHref) continue;
      const style = window.getComputedStyle(el);
      if (style.cursor === "pointer") continue;
      if (el.hasAttribute("onclick")) continue;
      if (el.getAttribute("role")) continue;
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.getAttribute("aria-hidden") === "true") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      results.push(getSelector(el));
    }
    return results;
  }, Array.from(NON_SEMANTIC_TAGS));
}

// ---- M3-02: Non-Semantic Interactive Element Detection ----

export function analyzeNonSemanticControls(
  domCandidates: InteractiveCandidate[],
  clickListeners: Set<string>,
  keyListeners: Set<string>
): NonSemanticControl[] {
  const results: NonSemanticControl[] = [];

  for (const candidate of domCandidates) {
    if (!candidate.isNonSemantic && !candidate.isAnchorWithoutHref) continue;
    if (candidate.isHidden) continue;

    const hasClickHandler = candidate.hasOnclick || clickListeners.has(candidate.selector);
    if (!hasClickHandler) continue;

    const hasTabindex = candidate.hasTabindex && candidate.tabindexValue !== null;
    const hasRole = candidate.hasInteractiveRole;
    const hasKeyHandler = keyListeners.has(candidate.selector);

    const issues: string[] = [];
    if (!hasTabindex) issues.push("missing tabindex — not focusable via keyboard");
    if (!hasRole) issues.push("missing ARIA role — purpose not communicated to assistive technology");
    if (!hasKeyHandler) issues.push("no keydown/keypress handler — not operable via keyboard");

    if (issues.length === 0) continue;

    results.push({
      selector: candidate.selector,
      tag: candidate.tag,
      hasTabindex: !!hasTabindex,
      hasRole, hasKeyHandler, issues,
    });
  }
  return results;
}

// ---- M3-03: Scrollable Region Keyboard Access ----

export async function analyzeScrollableRegions(page: Page): Promise<ScrollableRegion[]> {
  return page.evaluate(() => {
    const results: ScrollableRegion[] = [];

    function getSelector(el: Element): string {
      if (el.id) return "#" + CSS.escape(el.id);
      const tag = el.tagName.toLowerCase();
      const attrs: [string, string | null][] = [
        ["aria-label", el.getAttribute("aria-label")],
        ["data-testid", el.getAttribute("data-testid")],
        ["name", el.getAttribute("name")],
      ];
      for (const [attr, val] of attrs) {
        if (val) {
          const escaped = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const candidate = tag + "[" + attr + '="' + escaped + '"]';
          try {
            if (document.querySelectorAll(candidate).length === 1) return candidate;
          } catch { /* skip */ }
        }
      }
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur !== document.documentElement) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift("#" + CSS.escape(cur.id)); break; }
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
      return parts.join(" > ");
    }

    const FOCUSABLE_SELECTOR = [
      "a[href]", "button:not([disabled])",
      "input:not([disabled]):not([type='hidden'])",
      "select:not([disabled])", "textarea:not([disabled])",
      "[tabindex]", "summary",
    ].join(", ");

    const allElements = document.querySelectorAll("*");
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const isScrollable =
        overflowY === "scroll" || overflowY === "auto" ||
        overflowX === "scroll" || overflowX === "auto";
      if (!isScrollable) continue;

      const hasOverflow =
        el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
      if (!hasOverflow) continue;

      const tag = el.tagName.toLowerCase();
      if (tag === "html" || tag === "body") continue;

      const tabindex = el.getAttribute("tabindex");
      const isFocusable = tabindex !== null && parseInt(tabindex, 10) >= 0;

      const focusableChildren = el.querySelectorAll(FOCUSABLE_SELECTOR);
      let hasFocusableChild = false;
      for (let j = 0; j < focusableChildren.length; j++) {
        const child = focusableChildren[j];
        const childStyle = window.getComputedStyle(child);
        if (childStyle.display !== "none" && childStyle.visibility !== "hidden") {
          if (child.hasAttribute("tabindex")) {
            const ti = parseInt(child.getAttribute("tabindex")!, 10);
            if (ti < 0) continue;
          }
          hasFocusableChild = true;
          break;
        }
      }

      results.push({
        selector: getSelector(el),
        isFocusable, hasFocusableChild,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
    }
    return results;
  });
}

// ---- Combined M3 Entry Point ----

export interface M3AnalysisResult {
  coverageGap: CoverageGap;
  nonSemanticControls: NonSemanticControl[];
  scrollableRegions: ScrollableRegion[];
}

/**
 * Run all three Module 3 checks.
 *
 * @param page  - Playwright page
 * @param stops - Deduplicated tab stops from Module 1
 * @param extraReachableSelectors - Additional selectors known to be keyboard-reachable
 *        (e.g., from M2's independent traversal). Merged into Set A for M3-01.
 * @param onProgress - Optional progress callback
 */
export async function analyzeInteractiveCoverage(
  page: Page,
  stops: TabStop[],
  extraReachableSelectors: string[] = [],
  onProgress?: (phase: string, detail: string) => void
): Promise<M3AnalysisResult> {
  // ---- Phase 1: DOM scan (shared between M3-01 and M3-02) ----
  onProgress?.("M3-01", "scanning DOM for interactive elements");
  const domCandidates = await collectCandidatesFromDOM(page);

  // ---- Phase 2: CDP event listener scan (shared between M3-01 and M3-02) ----
  onProgress?.("M3-01", "detecting event listeners via CDP");

  const domCandidateSelectors = domCandidates.map((c) => c.selector);
  const extraNonSemanticSelectors = await collectNonSemanticSelectorsForCDP(page);

  const allSelectorsForCDP = Array.from(
    new Set([...domCandidateSelectors, ...extraNonSemanticSelectors])
  );

  const { clickListeners, keyListeners } = await detectEventListenersViaCDP(
    page,
    allSelectorsForCDP
  );

  // ---- Phase 3: M3-01 — Coverage Gap ----
  onProgress?.("M3-01", "computing coverage gap");

  // Build Set A: union of M1 tab stops + M2 indicator selectors
  const reachableSelectors = new Set(stops.map((s) => s.selector));
  for (const sel of extraReachableSelectors) {
    reachableSelectors.add(sel);
  }

  // Build candidate map including CDP-only discoveries
  const candidateMap = new Map<string, InteractiveCandidate>();
  for (const c of domCandidates) {
    candidateMap.set(c.selector, c);
  }
  for (const sel of extraNonSemanticSelectors) {
    if (!candidateMap.has(sel) && clickListeners.has(sel)) {
      candidateMap.set(sel, {
        selector: sel,
        tag: extractTagFromSelector(sel),
        role: null,
        hasOnclick: false, hasCursorPointer: false,
        hasInteractiveRole: false, hasTabindex: false, tabindexValue: null,
        isHidden: false, isNativeInteractive: false,
        isNonSemantic: true, isAnchorWithoutHref: false,
      });
    }
  }

  const unreachable: UnreachableElement[] = [];
  let totalInteractive = 0;
  const pendingAncestorChecks: {
    selector: string;
    candidate: InteractiveCandidate;
    hasClickHandler: boolean;
  }[] = [];

  for (const [selector, candidate] of candidateMap) {
    if (candidate.isHidden) continue;

    const hasClickHandler = candidate.hasOnclick || clickListeners.has(selector);

    const isInteractive =
      candidate.isNativeInteractive ||
      hasClickHandler ||
      candidate.hasInteractiveRole;

    const cursorPointerInteractive =
      candidate.hasCursorPointer &&
      !candidate.isNativeInteractive &&
      (hasClickHandler || candidate.isNonSemantic);

    if (!isInteractive && !cursorPointerInteractive) continue;

    totalInteractive++;

    if (!reachableSelectors.has(selector)) {
      // If the only signal is cursor:pointer (no click handler, no role,
      // not natively interactive), it might just be a child element
      // inheriting cursor from an interactive ancestor (e.g., <span> inside <a>).
      // We'll check ancestry before flagging.
      const onlyCursorPointer =
        !hasClickHandler &&
        !candidate.hasInteractiveRole &&
        !candidate.isNativeInteractive &&
        candidate.hasCursorPointer;

      if (onlyCursorPointer) {
        pendingAncestorChecks.push({ selector, candidate, hasClickHandler });
      } else {
        unreachable.push({
          selector,
          tag: candidate.tag,
          role: candidate.role,
          hasClickHandler,
          hasCursorPointer: candidate.hasCursorPointer,
        });
      }
    }
  }

  // Batch ancestor check: for cursor:pointer-only elements, check if they
  // sit inside an already-reachable element. If so, they inherit keyboard
  // access from the ancestor and are not truly unreachable.
  if (pendingAncestorChecks.length > 0) {
    const reachableArray = Array.from(reachableSelectors);
    const selectorsToCheck = pendingAncestorChecks.map((p) => p.selector);

    const hasReachableAncestor = await page.evaluate(
      (args: { selectors: string[]; reachable: string[] }) => {
        const results: boolean[] = [];
        for (const sel of args.selectors) {
          let el: Element | null = null;
          try { el = document.querySelector(sel); } catch { /* skip */ }
          if (!el) { results.push(false); continue; }

          let ancestor = el.parentElement;
          let found = false;
          while (ancestor && ancestor !== document.documentElement) {
            for (const rSel of args.reachable) {
              try {
                if (ancestor.matches(rSel)) { found = true; break; }
              } catch { /* invalid selector */ }
            }
            if (found) break;
            ancestor = ancestor.parentElement;
          }
          results.push(found);
        }
        return results;
      },
      { selectors: selectorsToCheck, reachable: reachableArray }
    );

    for (let i = 0; i < pendingAncestorChecks.length; i++) {
      if (!hasReachableAncestor[i]) {
        const { selector, candidate, hasClickHandler } = pendingAncestorChecks[i];
        unreachable.push({
          selector,
          tag: candidate.tag,
          role: candidate.role,
          hasClickHandler,
          hasCursorPointer: candidate.hasCursorPointer,
        });
      }
    }
  }

  const coverageGap: CoverageGap = {
    unreachableElements: unreachable,
    totalInteractive,
    totalReachable: reachableSelectors.size,
    coveragePercent:
      totalInteractive > 0
        ? Math.round(
            (Math.min(reachableSelectors.size, totalInteractive) / totalInteractive) * 100
          )
        : 100,
  };

  // ---- Phase 4: M3-02 — Non-Semantic Controls ----
  onProgress?.("M3-02", "analyzing non-semantic interactive elements");

  const allCandidatesForM302 = Array.from(candidateMap.values());
  const nonSemanticControls = analyzeNonSemanticControls(
    allCandidatesForM302,
    clickListeners,
    keyListeners
  );

  // ---- Phase 5: M3-03 — Scrollable Regions ----
  onProgress?.("M3-03", "checking scrollable regions");
  const scrollableRegions = await analyzeScrollableRegions(page);

  return { coverageGap, nonSemanticControls, scrollableRegions };
}
/**
 * Consent modal dismissal.
 *
 * After page load, attempts to find and click a "accept all" / "allow"
 * button inside common consent management platforms (Cookiebot, OneTrust,
 * Quantcast, generic GDPR banners). This unblocks the page for keyboard
 * traversal so the evaluation tests the actual site, not the modal.
 *
 * Strategy:
 *   1. Check for known CMP iframes and interact inside them
 *   2. Check for known CMP button selectors in the main frame
 *   3. Fall back to heuristic text matching on visible buttons
 *
 * If nothing is found or the click fails, the evaluation proceeds
 * normally — the consent modal will simply be part of what's tested.
 */

import { Page, Frame } from "playwright";
export type { Page, Frame };

/** How long to wait for a consent modal to appear after page load */
const CONSENT_WAIT_MS = 2000;

/** How long to wait after clicking for the modal to disappear */
const DISMISS_WAIT_MS = 1000;

/**
 * Known CMP button selectors, ordered by specificity.
 * Each entry is tried in the main frame and common iframe contexts.
 */
const KNOWN_SELECTORS = [
  // Cookiebot
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  "#CybotCookiebotDialogBodyLevelButtonAccept",
  'a[data-cookiebanner="accept_button"]',

  // OneTrust
  "#onetrust-accept-btn-handler",
  ".onetrust-close-btn-handler",

  // Quantcast / CMP
  'button[class*="accept"]',
  ".qc-cmp2-summary-buttons button:first-child",

  // Didomi
  "#didomi-notice-agree-button",

  // Klaro
  'button[class*="cm-btn-accept"]',

  // Osano
  'button.osano-cm-accept-all',

  // Complianz
  'button.cmplz-accept',

  // Generic patterns used by many CMPs
  'button[data-consent="accept"]',
  'button[data-action="accept"]',
  'button[id*="accept"]',
  'button[id*="consent"][id*="accept"]',
];

/**
 * Heuristic text patterns for "accept all" buttons.
 * Checked against button text content (case-insensitive).
 * Includes English, Latvian, German, French, and Spanish — the
 * languages most likely in the thesis sample.
 */
const ACCEPT_TEXT_PATTERNS = [
  // English
  /^accept\s*(all)?$/i,
  /^allow\s*(all)?$/i,
  /^agree$/i,
  /^i\s*agree$/i,
  /^accept\s*cookies?$/i,
  /^allow\s*cookies?$/i,
  /^ok$/i,
  /^got\s*it$/i,

  // Latvian
  /^atļaut\s*(visu|visus)?$/i,
  /^pieņemt$/i,
  /^piekrītu$/i,
  /^apstiprināt$/i,
  /^pieņemt\s*(visu|visas)?$/i,
  /^atļaut\s*sīkdatnes?$/i,
  /^piekrist\s*(visam|visām|visiem)?$/i,

  // German
  /^alle\s*akzeptieren$/i,
  /^akzeptieren$/i,
  /^zustimmen$/i,

  // French
  /^tout\s*accepter$/i,
  /^accepter$/i,
  /^j'accepte$/i,

  // Spanish
  /^aceptar\s*(todo|todas)?$/i,
];

/**
 * Try to dismiss a consent modal on the page.
 *
 * @returns A description of what was done, or null if nothing was found.
 */
export async function dismissConsentModal(page: Page): Promise<string | null> {
  // Give the CMP a moment to initialize — many load async
  await page.waitForTimeout(CONSENT_WAIT_MS);

  // ---- Phase 1: Known selectors in main frame ----
  for (const selector of KNOWN_SELECTORS) {
    const result = await tryClickSelector(page, selector);
    if (result) return result;
  }

  // ---- Phase 2: Known CMP iframes ----
  const iframeResult = await tryConsentIframes(page);
  if (iframeResult) return iframeResult;

  // ---- Phase 3: Heuristic text matching ----
  const heuristicResult = await tryHeuristicTextMatch(page);
  if (heuristicResult) return heuristicResult;

  return null;
}

/**
 * Try to click a specific selector. Returns a description if successful.
 */
async function tryClickSelector(
  pageOrFrame: Page | Frame,
  selector: string
): Promise<string | null> {
  try {
    const el = await pageOrFrame.$(selector);
    if (!el) return null;

    // Check if the element is actually visible
    const visible = await el.isVisible();
    if (!visible) return null;

    await el.click();
    await pageOrFrame.waitForTimeout(DISMISS_WAIT_MS);
    return `Dismissed consent modal via selector: ${selector}`;
  } catch {
    return null;
  }
}

/**
 * Look for consent modals inside iframes (common with Cookiebot, Didomi).
 */
async function tryConsentIframes(page: Page): Promise<string | null> {
  const iframeSelectors = [
    'iframe[id*="cookie"]',
    'iframe[id*="consent"]',
    'iframe[id*="cmp"]',
    'iframe[src*="cookiebot"]',
    'iframe[src*="consent"]',
    'iframe[src*="didomi"]',
    'iframe[title*="cookie" i]',
    'iframe[title*="consent" i]',
  ];

  for (const iframeSel of iframeSelectors) {
    try {
      const iframeHandle = await page.$(iframeSel);
      if (!iframeHandle) continue;

      const frame = await iframeHandle.contentFrame();
      if (!frame) continue;

      // Try known selectors inside the iframe
      for (const selector of KNOWN_SELECTORS) {
        const result = await tryClickSelector(frame, selector);
        if (result) return result + ` (inside ${iframeSel})`;
      }

      // Try heuristic text match inside iframe
      const hResult = await tryHeuristicInFrame(frame);
      if (hResult) return hResult + ` (inside ${iframeSel})`;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Heuristic: find any visible button whose text matches common
 * "accept" patterns and click it.
 */
async function tryHeuristicTextMatch(page: Page): Promise<string | null> {
  return tryHeuristicInFrame(page);
}

async function tryHeuristicInFrame(
  context: Page | Frame
): Promise<string | null> {
  try {
    const result = await context.evaluate((patterns: string[]) => {
      const regexes = patterns.map((p) => new RegExp(p.slice(1, p.lastIndexOf("/")), p.slice(p.lastIndexOf("/") + 1)));

      // Check buttons and links with role="button"
      const candidates = [
        ...Array.from(document.querySelectorAll("button")),
        ...Array.from(document.querySelectorAll('a[role="button"]')),
        ...Array.from(document.querySelectorAll('[role="button"]')),
      ];

      for (const el of candidates) {
        const htmlEl = el as HTMLElement;
        const style = window.getComputedStyle(htmlEl);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const text = (htmlEl.textContent || "").trim();
        if (text.length === 0 || text.length > 50) continue;

        for (const regex of regexes) {
          if (regex.test(text)) {
            // Check if this looks like it's inside a consent/cookie context
            const parent = htmlEl.closest(
              '[class*="cookie"], [class*="consent"], [class*="gdpr"], ' +
              '[class*="privacy"], [id*="cookie"], [id*="consent"], ' +
              '[id*="gdpr"], [id*="cmp"], [id*="sikdat"], [class*="sikdat"], ' +
              '[role="dialog"], [aria-modal="true"]'
            );
            if (parent) {
              htmlEl.click();
              return `Clicked "${text}" inside consent context (${parent.tagName.toLowerCase()}.${parent.className.split(" ")[0]})`;
            }
          }
        }
      }
      return null;
    }, ACCEPT_TEXT_PATTERNS.map((r) => r.toString()));

    if (result) {
      await context.waitForTimeout(DISMISS_WAIT_MS);
      return result;
    }
  } catch {
    // Evaluation failed — page might have navigated
  }

  return null;
}
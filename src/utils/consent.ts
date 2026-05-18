// Tries to dismiss cookie/consent modals so the evaluation tests
// the actual site content, not a modal overlay.

import { Page, Frame } from "playwright";
export type { Page, Frame };

const CONSENT_WAIT_MS = 2000;
const DISMISS_WAIT_MS = 1000;

// Known CMP button selectors, ordered by specificity
const KNOWN_SELECTORS = [
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  "#CybotCookiebotDialogBodyLevelButtonAccept",
  'a[data-cookiebanner="accept_button"]',
  "#onetrust-accept-btn-handler",
  ".onetrust-close-btn-handler",
  'button[class*="accept"]',
  ".qc-cmp2-summary-buttons button:first-child",
  "#didomi-notice-agree-button",
  'button[class*="cm-btn-accept"]',
  'button.osano-cm-accept-all',
  'button.cmplz-accept',
  'button[data-consent="accept"]',
  'button[data-action="accept"]',
  'button[id*="accept"]',
  'button[id*="consent"][id*="accept"]',
];

// Heuristic text patterns for "accept" buttons (EN, LV, DE, FR, ES)
const ACCEPT_TEXT_PATTERNS = [
  /^accept\s*(all)?$/i,
  /^allow\s*(all)?$/i,
  /^agree$/i,
  /^i\s*agree$/i,
  /^accept\s*cookies?$/i,
  /^allow\s*cookies?$/i,
  /^ok$/i,
  /^got\s*it$/i,
  /^atļaut\s*(visu|visus)?$/i,
  /^pieņemt$/i,
  /^piekrītu$/i,
  /^apstiprināt$/i,
  /^pieņemt\s*(visu|visas)?$/i,
  /^atļaut\s*sīkdatnes?$/i,
  /^piekrist\s*(visam|visām|visiem)?$/i,
  /^alle\s*akzeptieren$/i,
  /^akzeptieren$/i,
  /^zustimmen$/i,
  /^tout\s*accepter$/i,
  /^accepter$/i,
  /^j'accepte$/i,
  /^aceptar\s*(todo|todas)?$/i,
];

export async function dismissConsentModal(page: Page): Promise<string | null> {
  await page.waitForTimeout(CONSENT_WAIT_MS);

  for (const selector of KNOWN_SELECTORS) {
    const result = await tryClickSelector(page, selector);
    if (result) return result;
  }

  const iframeResult = await tryConsentIframes(page);
  if (iframeResult) return iframeResult;

  const heuristicResult = await tryHeuristicTextMatch(page);
  if (heuristicResult) return heuristicResult;

  return null;
}

async function tryClickSelector(
  pageOrFrame: Page | Frame,
  selector: string
): Promise<string | null> {
  try {
    const el = await pageOrFrame.$(selector);
    if (!el) return null;

    const visible = await el.isVisible();
    if (!visible) return null;

    await el.click();
    await pageOrFrame.waitForTimeout(DISMISS_WAIT_MS);
    return `Dismissed consent modal via selector: ${selector}`;
  } catch {
    return null;
  }
}

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

      for (const selector of KNOWN_SELECTORS) {
        const result = await tryClickSelector(frame, selector);
        if (result) return result + ` (inside ${iframeSel})`;
      }

      const hResult = await tryHeuristicInFrame(frame);
      if (hResult) return hResult + ` (inside ${iframeSel})`;
    } catch {
      continue;
    }
  }

  return null;
}

async function tryHeuristicTextMatch(page: Page): Promise<string | null> {
  return tryHeuristicInFrame(page);
}

async function tryHeuristicInFrame(
  context: Page | Frame
): Promise<string | null> {
  try {
    const result = await context.evaluate((patterns: string[]) => {
      const regexes = patterns.map((p) => new RegExp(p.slice(1, p.lastIndexOf("/")), p.slice(p.lastIndexOf("/") + 1)));

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
  }

  return null;
}
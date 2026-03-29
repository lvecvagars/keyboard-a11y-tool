import { chromium, Browser, Page } from "playwright";

export interface BrowserContext {
  browser: Browser;
  page: Page;
}

/**
 * Launch a headless Chromium browser and navigate to the given URL.
 * Returns both the browser (for cleanup) and the page (for evaluation).
 */
export async function launchAndNavigate(url: string): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    // Standard desktop viewport — consistent bounding box measurements
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  } catch {
    // networkidle timed out — page likely has persistent connections
    // (ads, analytics, websockets). Fall back to domcontentloaded
    // and give scripts a moment to finish.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  return { browser, page };
}
import { chromium, Browser, Page } from "playwright";

export interface BrowserContext {
  browser: Browser;
  page: Page;
}

export async function launchAndNavigate(url: string): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  return { browser, page };
}
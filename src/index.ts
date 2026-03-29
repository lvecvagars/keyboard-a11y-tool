import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("https://example.com");
  console.log("Page title:", await page.title());
  await browser.close();
}

main();
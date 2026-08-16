import { access, constants } from "node:fs/promises";
import puppeteer from "puppeteer-core";

export async function capturePageScreenshot({
  url,
  executablePath = process.env.PUPPETEER_EXECUTABLE_PATH,
  timeoutMs = 45_000,
  launcher = puppeteer
} = {}) {
  if (!url) throw new Error("Screenshot URL is not configured");
  const browserPath = await resolveBrowserPath(executablePath);
  const browser = await launcher.launch({
    executablePath: browserPath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "networkidle0", timeout: timeoutMs });
    await page.waitForSelector(".group-row", { timeout: timeoutMs });
    await page.evaluate(async () => {
      await document.fonts?.ready;
      document.querySelectorAll('.group-toggle[aria-expanded="false"]').forEach((button) => button.click());
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await page.screenshot({ type: "png", fullPage: true, captureBeyondViewport: true });
  } finally {
    await browser.close();
  }
}

async function resolveBrowserPath(configuredPath) {
  const candidates = [configuredPath, "/usr/bin/chromium-browser", "/usr/bin/chromium"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next common Chromium path.
    }
  }
  throw new Error("Chromium executable was not found");
}

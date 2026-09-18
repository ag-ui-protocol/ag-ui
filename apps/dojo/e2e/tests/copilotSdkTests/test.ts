import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test as base } from "../../test-isolation-helper";

export { expect } from "@playwright/test";

export const test = base.extend<{ captureScreenshot: void }>({
  captureScreenshot: [async ({ page }, use) => {
    await use();
    const root = process.env.DOJO_SCREENSHOT_DIR;
    const match = new URL(page.url()).pathname.match(
      /^\/copilot-sdk-(python|typescript)\/feature\/([a-z_]+)$/,
    );
    if (!root || !match) return;
    const directory = join(root, match[1]);
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${match[2]}.png`), fullPage: true });
  }, { auto: true }],
});

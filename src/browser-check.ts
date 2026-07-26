/**
 * Standalone Chrome connectivity check: `npm run browser:check`.
 *
 * Confirms agentspine can get a Chrome (attach over CDP or launch headless per
 * BROWSER_MODE) and actually drive it — navigates to about:blank and reads its state —
 * without touching the model, the broker, or the loop. Exits 0 on success, 1 on failure.
 */
import { BROWSER_MODE, CHROME_CDP_URL } from "./config.ts";
import { getBrowser, getConnectionVia, openScratchPage } from "./tools/browser.ts";

console.log("agentspine browser check");
console.log(`  BROWSER_MODE   : ${BROWSER_MODE}`);
console.log(`  CHROME_CDP_URL : ${CHROME_CDP_URL}`);

try {
  const browser = await getBrowser();
  const via = getConnectionVia();
  console.log(`  connected via  : ${via}${via === "cdp" ? ` (attached to ${CHROME_CDP_URL})` : " (launched headless)"}`);
  console.log(`  chrome version : ${browser.version()}`);

  const { page, close } = await openScratchPage();
  await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15_000 });
  const state = await page.evaluate(() => document.readyState);
  console.log(`  about:blank    : url=${page.url()} readyState=${state}`);
  await close();
  await browser.close();

  console.log("\n✓ Chrome link OK.");
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n✗ Chrome link FAILED: ${msg}`);
  if (BROWSER_MODE === "cdp") {
    console.error("  BROWSER_MODE=cdp requires a running debugging Chrome. Start one with:");
    console.error(
      '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/agentspine/chrome-profile"',
    );
    console.error("  ...or set BROWSER_MODE=auto to fall back to headless.");
  } else {
    console.error("  Could not launch headless Chrome. Install Google Chrome, or set CHROME_PATH in .env.");
  }
  process.exit(1);
}

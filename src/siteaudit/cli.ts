/**
 * npm run audit -- <url>
 *
 * Audit one page from the command line, under the same policy the `site_audit` tool obeys, and
 * print the report. The report is also saved; the last line says where.
 */
import { loadPolicy } from "../config.ts";
import { runSiteAudit } from "../tools/site-audit.ts";

const url = process.argv[2];
if (!url) {
  console.error("usage: npm run audit -- <url>");
  process.exit(2);
}
const out = await runSiteAudit(url, loadPolicy());
if (!out.ok) {
  console.error(`The audit did not run: ${out.reason}`);
  process.exit(1);
}
console.log(out.report);
console.log(`Saved to ${out.file}`);
process.exit(0);

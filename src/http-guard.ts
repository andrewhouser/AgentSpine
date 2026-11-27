/**
 * Who may call the API when there is no dashboard token (security read of section 15, 2026-11-26).
 *
 * With `DASHBOARD_TOKEN` empty, the server refuses to bind anywhere but loopback, and until now that
 * was the whole defence. It is not enough against a browser: any page you visit can send a plain
 * POST (a form, or `fetch` with `mode: "no-cors"`) to http://127.0.0.1:8787, and the request runs
 * even though the page cannot read the answer. That is enough to approve a waiting action or start a
 * run. A page can also rebind its own name to 127.0.0.1 (DNS rebinding) and then read answers too,
 * because the browser thinks the API is that page's own origin.
 *
 * So, with no token:
 *  - the Host header must be a loopback name. A rebound page sends its own name, so this closes
 *    reading and writing by rebinding, for every method;
 *  - a request that changes something (anything but GET, HEAD, OPTIONS) is refused if the browser says
 *    it came from another site: an Origin that is not a loopback origin (including the "null" origin of
 *    a sandboxed frame or a file), or, with no Origin, `Sec-Fetch-Site: cross-site`.
 *
 * Non-browser clients (the iPhone and Mac apps, curl, the CLI) send no Origin and no Sec-Fetch-Site,
 * so they pass. The web client, served by this same server or by the Vite dev server on another
 * localhost port, sends a loopback Origin, so it passes.
 *
 * With a token set none of this applies: a cross-site page cannot know the token, and the token is
 * what lets the server be reached by a Tailscale name, which would fail the Host rule.
 */

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface GuardInput {
  host: string | undefined;
  method: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
  tokenSet: boolean;
}

/** Why the request is refused, or null when it may go on to the ordinary auth. */
export const crossSiteRefusal = ({ host, method, origin, secFetchSite, tokenSet }: GuardInput): null | string => {
  if (tokenSet) return null;
  if (!LOOPBACK_HOST.test(host ?? "")) {
    return "refused: with no DASHBOARD_TOKEN the API answers only to localhost, and this request named another host";
  }
  if (SAFE_METHODS.has(method.toUpperCase())) return null;
  if (origin !== undefined) {
    return LOOPBACK_ORIGIN.test(origin) ? null : "refused: a request from another site cannot change anything here";
  }
  if (secFetchSite === "cross-site") return "refused: a request from another site cannot change anything here";
  return null;
};

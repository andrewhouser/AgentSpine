/**
 * Fetch a public web page or image, and refuse to be aimed at anything private.
 *
 * Heads-up research follows URLs it found on the open web: search results, then the product
 * pages and image links inside them. Those are attacker-controlled strings. A page that says
 * its image lives at http://192.168.0.145:8080/... or http://127.0.0.1:8787/api/... is trying to
 * make this machine, which sits next to the model host and the dashboard, fetch something on your
 * LAN on its behalf (SSRF). So every connection here is checked, not just the first URL:
 *
 *   - the address is validated at CONNECT time, inside the socket's own DNS lookup, so a name
 *     that resolves to a public address when checked and a private one when connected (DNS
 *     rebinding) is still refused;
 *   - an IP-literal host skips DNS entirely, so it is checked up front;
 *   - every redirect hop is run through the same checks;
 *   - the body is capped while streaming, so a hostile server cannot fill memory.
 *
 * No dependency: node:http(s) lets us own the lookup, which is the whole point. `fetch` does not.
 * Nothing here throws; a refusal is a `{ ok: false, reason }`, because "could not fetch that
 * page" is an ordinary outcome of research and must not abort it.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

const v4 = (ip: string): null | number[] => {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
};

/** Expand an IPv6 literal to eight 16-bit groups, or null if it is not one. */
const v6groups = (ip: string): null | number[] => {
  let s = ip.toLowerCase().split("%")[0];
  if (!net.isIPv6(s)) return null;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const q = v4(tail[1]);
    if (!q) return null;
    s = s.replace(tail[1], `${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`);
  }
  const [head, rest] = s.split("::");
  const a = head ? head.split(":") : [];
  const b = rest !== undefined && rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - a.length - b.length;
  const groups = [...a, ...Array(Math.max(0, fill)).fill("0"), ...b].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
};

const publicV4 = (p: number[]): boolean => {
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-net, private, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, including cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};

/** True only for an address on the public internet. Anything unparseable is not public. */
export const isPublicAddress = (ip: string): boolean => {
  const four = v4(ip);
  if (four) return publicV4(four);
  const g = v6groups(ip);
  if (!g) return false;
  // IPv4-mapped (::ffff:a.b.c.d): judge the embedded v4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
    return publicV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x64 && g[1] === 0xff9b) return false; // NAT64 can reach private v4
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return false; // ::/96
  return true;
};

export interface GetOpts {
  /** Accept this content type, else stop after the headers. Default: any. */
  accept?: (contentType: string) => boolean;
  /** Test seam: which addresses may be connected to. Default `isPublicAddress`. Never set in production code. */
  allow?: (ip: string) => boolean;
  /** Longest body kept, in bytes. */
  maxBytes?: number;
  maxRedirects?: number;
  /** What to do past maxBytes: keep what arrived (a page's head holds its metadata) or give up (an image is useless cut short). */
  onOverflow?: "fail" | "truncate";
  timeoutMs?: number;
}

export type GetResult =
  | { body: Buffer; contentType: string; ok: true; status: number; truncated: boolean; url: string }
  | { ok: false; reason: string };

const UA = "Mozilla/5.0 (compatible; AgentSpine/1.0; personal assistant)";

/** A `lookup` for http(s).request that only ever yields addresses `allow` approves. */
const guardedLookup =
  (allow: (ip: string) => boolean): net.LookupFunction =>
  (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return (callback as any)(err);
      const ok = (addrs as dns.LookupAddress[]).filter((a) => allow(a.address));
      if (!ok.length) return (callback as any)(new Error(`refused: ${hostname} resolves to a non-public address`));
      if ((options as any)?.all) return (callback as any)(null, ok);
      return (callback as any)(null, ok[0].address, ok[0].family);
    });
  };

const once = (opts: GetOpts, url: URL, redirectsLeft: number): Promise<GetResult> =>
  new Promise((resolve) => {
    const allow = opts.allow ?? isPublicAddress;
    const maxBytes = opts.maxBytes ?? 1_500_000;
    let settled = false;
    const done = (r: GetResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    if (url.protocol !== "http:" && url.protocol !== "https:") return done({ ok: false, reason: `unsupported scheme ${url.protocol}` });
    if (url.username || url.password) return done({ ok: false, reason: "credentials in a URL are refused" });
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // An IP literal never reaches the socket's lookup, so it is judged here.
    if (net.isIP(host) && !allow(host)) return done({ ok: false, reason: `refused: ${host} is not a public address` });

    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        headers: { Accept: "text/html,image/*;q=0.8,*/*;q=0.5", "Accept-Encoding": "gzip, deflate, br", "Accept-Language": "en-US,en;q=0.9", "User-Agent": UA },
        lookup: guardedLookup(allow),
        method: "GET",
        timeout: opts.timeoutMs ?? 12_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          if (redirectsLeft <= 0) return done({ ok: false, reason: "too many redirects" });
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            return done({ ok: false, reason: "bad redirect" });
          }
          return void once(opts, next, redirectsLeft - 1).then(done);
        }
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
        if (status < 200 || status >= 300) {
          res.resume();
          return done({ ok: false, reason: `HTTP ${status}` });
        }
        if (opts.accept && !opts.accept(contentType)) {
          res.destroy();
          return done({ ok: false, reason: `unwanted content type ${contentType || "(none)"}` });
        }

        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const source: NodeJS.ReadableStream =
          enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        source.on("data", (c: Buffer) => {
          if (settled) return;
          size += c.length;
          if (size > maxBytes) {
            if (opts.onOverflow === "fail") {
              req.destroy();
              return done({ ok: false, reason: `larger than ${maxBytes} bytes` });
            }
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            truncated = true;
            req.destroy();
            return done({ body: Buffer.concat(chunks), contentType, ok: true, status, truncated, url: url.toString() });
          }
          chunks.push(c);
        });
        source.on("end", () => done({ body: Buffer.concat(chunks), contentType, ok: true, status, truncated, url: url.toString() }));
        source.on("error", (e: Error) => done({ ok: false, reason: `read failed: ${e.message}` }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, reason: "timed out" });
    });
    req.on("error", (e) => done({ ok: false, reason: e.message }));
    req.end();
  });

/** GET a public URL. Never throws. */
export const safeGet = async (rawUrl: string, opts: GetOpts = {}): Promise<GetResult> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  try {
    return await once(opts, url, opts.maxRedirects ?? 3);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
};

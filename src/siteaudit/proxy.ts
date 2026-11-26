/**
 * The proxy the site audit's Chrome is pointed at (PLAN-open-work section 14, U3, added 2026-11-26).
 *
 * Why it exists. The audit checked a host's address and then let Chrome connect, and Chrome looked the name up
 * again for itself. A host whose DNS answer changed between the two (public for the check, 192.168.x.x for
 * Chrome) got a request onto this network. Checking harder does not close that: the only fix is for the code
 * that judges the address to be the code that connects to it.
 *
 * So Chrome is given this proxy and resolves nothing. For every request, plain or tunnelled (HTTPS and
 * WebSockets arrive as CONNECT), the proxy opens the socket itself with `guardedLookup` as the socket's own
 * lookup: the address that passed `allow` is the address connected to, and a name that resolves to anything
 * else is refused with a 403. It listens on 127.0.0.1 on a port the system picks, for the length of one audit.
 *
 * It is not a general proxy and does not try to be: no caching, no auth, no keep-alive tuning. It carries one
 * page load and is closed. What it does not see: traffic Chrome sends without a proxy at all, which today is
 * WebRTC's UDP. That is a blind packet, not a request with an answer, and is left as a known limit.
 */
import type dns from "node:dns";
import http from "node:http";
import net from "node:net";

import { guardedLookup } from "../headsup/research/net.ts";

export interface GuardProxy {
  close: () => Promise<void>;
  /** How many connections were refused, for the tests. */
  refused: () => number;
  /** `http://127.0.0.1:<port>`, for Chrome's proxy setting. */
  url: string;
}

/** Hop-by-hop headers a proxy consumes and does not pass on. */
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "upgrade"]);

const CONNECT_TIMEOUT_MS = 15_000;

const hostAndPort = (authority: string, fallbackPort: number): null | { host: string; port: number } => {
  try {
    const u = new URL(`http://${authority}`);
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = Number(u.port || fallbackPort);
    return host && port > 0 && port < 65536 ? { host, port } : null;
  } catch {
    return null;
  }
};

export const startGuardProxy = async (allow: (ip: string) => boolean, resolve?: typeof dns.lookup): Promise<GuardProxy> => {
  let refused = 0;
  const sockets = new Set<net.Socket>();
  const lookup = guardedLookup(allow, resolve);
  /** An IP literal never reaches a socket's lookup, so it is judged here. */
  const literalRefused = (host: string): boolean => net.isIP(host) !== 0 && !allow(host);

  const server = http.createServer((req, res) => {
    // A plain http:// request: Chrome sends the whole address as the request target.
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (target.protocol !== "http:" || !host || literalRefused(host)) {
      refused++;
      res.writeHead(403).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v != null && !HOP.has(k.toLowerCase())) headers[k] = v;
    const upstream = http.request(
      { headers, host, lookup, method: req.method, path: `${target.pathname}${target.search}`, port: Number(target.port || 80), timeout: CONNECT_TIMEOUT_MS },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (v != null && !HOP.has(k.toLowerCase())) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("timed out")));
    upstream.on("error", (err) => {
      if (/^refused:/.test(err.message)) refused++;
      if (!res.headersSent) res.writeHead(/^refused:/.test(err.message) ? 403 : 502);
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS and WebSockets: a tunnel to host:port. The proxy never sees inside it, and does not need to.
  server.on("connect", (req, client: net.Socket, head) => {
    const to = hostAndPort(req.url ?? "", 443);
    const refuse = (code: string): void => {
      client.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
    };
    client.on("error", () => {});
    if (!to || literalRefused(to.host)) {
      refused++;
      return refuse("403 Forbidden");
    }
    const upstream = net.connect({ host: to.host, lookup, port: to.port });
    sockets.add(upstream);
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error("timed out")));
    let open = false;
    upstream.once("connect", () => {
      open = true;
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (err) => {
      if (/^refused:/.test(err.message)) refused++;
      // Before the tunnel opened, Chrome is still waiting for an answer and gets one. After, there is only the pipe to cut.
      if (!open) refuse(/^refused:/.test(err.message) ? "403 Forbidden" : "502 Bad Gateway");
      else client.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      if (open) client.destroy();
    });
    client.on("close", () => upstream.destroy());
  });

  // A request to upgrade over plain http is a WebSocket Chrome did not tunnel. It is not carried.
  server.on("upgrade", (_req, socket) => {
    refused++;
    socket.destroy();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    close: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
    refused: () => refused,
    url: `http://127.0.0.1:${port}`,
  };
};

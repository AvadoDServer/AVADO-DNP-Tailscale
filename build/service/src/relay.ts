/**
 * Tailscale Serve and Funnel only forward to this machine, so they point at this relay on
 * 127.0.0.1, which passes MCP requests on to AI Connect's agent-only port. Only the MCP paths go
 * through: /mcp and /k/<key>/mcp. Everything else (the AI Connect page, its key management, any
 * other app or the Admin) answers 404 here, so a public Funnel address exposes nothing else.
 *
 * Before anything is passed on, the relay makes sure it talks to AI Connect: an MCP request
 * carries the assistant's AI Connect key, and an old address could belong to another app by now.
 *  1. It finds AI Connect by its container name (config.mcpUpstream). Docker's own DNS on the AVADO
 *     network answers that name only while the AI Connect container exists, which is how DAppNode
 *     packages find each other. (The *.my.ava.do names come from the box's DNS, which can keep an
 *     old address after an app is removed: seen on the test box.)
 *  2. It asks that address for /identity, without the key or any header of the request, and needs
 *     AI Connect's fixed package name in the answer.
 *  3. Only then it forwards the request, to that same address.
 * Otherwise the assistant gets "AI Connect is not installed or not running on this AVADO."
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import { isIP } from "node:net";
import type { Logger } from "./log.js";
import { errorMessage } from "./log.js";

export const AI_CONNECT_NAME = "mcp.avado.dnp.dappnode.eth";
const NOT_THERE = "AI Connect is not installed or not running on this AVADO.";

export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/mcp/" || /^\/k\/[A-Za-z0-9_-]{1,200}\/mcp\/?$/.test(pathname);
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);

export interface RelayOptions {
  /** name -> IPv4 address (default: the system resolver, i.e. Docker's DNS) */
  lookup?: (hostname: string) => Promise<string>;
  identityTimeoutMs?: number;
}

/** GET http://<ip>:<port>/identity and check the package name. Never sends anything of the request. */
function isAiConnect(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: "/identity", headers: { Accept: "application/json" }, timeout: timeoutMs, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(false);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
        if (body.length > 4096) req.destroy();
      });
      res.on("end", () => {
        try {
          resolve((JSON.parse(body) as { name?: unknown }).name === AI_CONNECT_NAME);
        } catch {
          resolve(false);
        }
      });
      res.on("error", () => resolve(false));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

export function createRelay(upstream: string, logger: Logger, opts: RelayOptions = {}): http.RequestListener {
  const target = new URL(upstream);
  const port = Number(target.port || 80);
  const lookup = opts.lookup ?? (async (name: string) => (isIP(name) ? name : (await dnsLookup(name, { family: 4 })).address));
  const identityTimeoutMs = opts.identityTimeoutMs ?? 3_000;
  let warned = false;

  const notThere = (res: http.ServerResponse): void => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: NOT_THERE }, id: null }));
  };

  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://relay").pathname;
    } catch {
      pathname = "";
    }
    if (!isMcpPath(pathname) || !["POST", "GET", "DELETE"].includes(req.method ?? "")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      res.end("Only AVADO AI Connect's MCP endpoint (/mcp) is shared here.");
      return;
    }
    void (async (): Promise<void> => {
      let ip: string;
      try {
        ip = await lookup(target.hostname);
      } catch {
        return notThere(res);
      }
      if (!(await isAiConnect(ip, port, identityTimeoutMs))) {
        if (!warned) logger.warn(`AI Connect did not answer at ${ip}:${port}; nothing was passed on`);
        warned = true;
        return notThere(res);
      }
      warned = false;
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
      headers.host = target.host;
      const up = http.request({ host: ip, port, method: req.method, path: pathname, headers, timeout: 300_000 }, (upRes) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
      });
      up.on("timeout", () => up.destroy(new Error("timed out")));
      up.on("error", (e) => {
        logger.warn(`relay to AI Connect failed: ${errorMessage(e)}`);
        notThere(res);
      });
      req.pipe(up);
    })();
  };
}

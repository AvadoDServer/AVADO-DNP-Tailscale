/**
 * Tailscale Serve and Funnel only forward to this machine, so they point at this relay on
 * 127.0.0.1, which passes MCP requests on to AI Connect's agent-only port. Only the MCP paths go
 * through: /mcp and /k/<key>/mcp, and (AI Connect 0.2.0) the sign-in of its Connect button:
 * the OAuth documents under /.well-known/ and /oauth/* (registration, the authorize redirect, the
 * token endpoint and the "Approve on your AVADO" waiting page). Everything else (the AI Connect
 * page, its key management, any other app or the Admin) answers 404 here, so a public Funnel
 * address exposes nothing else. The approval itself only ever happens on the AI Connect page,
 * which is not reachable here.
 *
 * The box's Tailscale name (the Host Tailscale Serve was asked for) is passed on as
 * X-Forwarded-Host, so AI Connect can name its sign-in address (the OAuth issuer) correctly.
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

/** AI Connect's sign-in (OAuth) paths; the query string is kept only for these. */
export const SIGN_IN_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/wait",
  "/oauth/wait/status",
  "/oauth/connect.js",
  "/oauth/theme.css",
  "/oauth/base.css",
  "/oauth/style.css",
  "/oauth/favicon.png",
]);

export function isSignInPath(pathname: string): boolean {
  return SIGN_IN_PATHS.has(pathname);
}

function plainName(raw: string | string[] | undefined): string | null {
  const host = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim().toLowerCase().replace(/:443$/, "");
  if (!host || host.length > 253 || isIP(host)) return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

/**
 * The name Tailscale Serve answered for (the box's Tailscale name): its Host header, which Serve
 * keeps, or else the X-Forwarded-Host it adds. Null when neither is a plain host name.
 */
export function publicHost(req: http.IncomingMessage): string | null {
  return plainName(req.headers.host) ?? plainName(req.headers["x-forwarded-host"]);
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
    let search = "";
    try {
      const u = new URL(req.url ?? "/", "http://relay");
      pathname = u.pathname;
      search = u.search;
    } catch {
      pathname = "";
    }
    const mcp = isMcpPath(pathname);
    const signIn = !mcp && isSignInPath(pathname);
    if ((!mcp && !signIn) || !(mcp ? ["POST", "GET", "DELETE"] : ["POST", "GET", "OPTIONS"]).includes(req.method ?? "")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
      res.end("Only AVADO AI Connect's MCP endpoint (/mcp) and its sign-in are shared here.");
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
      // never a made-up X-Forwarded-Host from outside: only the Host Tailscale Serve answered for
      delete headers["x-forwarded-host"];
      const name = publicHost(req);
      if (name) headers["x-forwarded-host"] = name;
      const up = http.request({ host: ip, port, method: req.method, path: signIn ? pathname + search.slice(0, 4096) : pathname, headers, timeout: 300_000 }, (upRes) => {
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

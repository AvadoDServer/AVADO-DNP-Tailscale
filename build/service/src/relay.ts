/**
 * Tailscale Serve and Funnel only forward to this machine, so they point at this relay on
 * 127.0.0.1, which passes MCP requests on to AI Connect's agent-only port. Only the MCP paths go
 * through: /mcp and /k/<key>/mcp. Everything else (the AI Connect page, its key management, any
 * other app or the Admin) answers 404 here, so a public Funnel address exposes nothing else.
 */
import http from "node:http";
import type { Logger } from "./log.js";
import { errorMessage } from "./log.js";

export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/mcp/" || /^\/k\/[A-Za-z0-9_-]{1,200}\/mcp\/?$/.test(pathname);
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);

export function createRelay(upstream: string, logger: Logger): http.RequestListener {
  const target = new URL(upstream);
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
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    headers.host = target.host;
    const up = http.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || 80, method: req.method, path: pathname, headers, timeout: 300_000 },
      (upRes) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
      },
    );
    up.on("timeout", () => up.destroy(new Error("timed out")));
    up.on("error", (e) => {
      logger.warn(`relay to AI Connect failed: ${errorMessage(e)}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: "AI Connect is not installed or not running on this AVADO." }, id: null }));
      } else res.destroy();
    });
    req.pipe(up);
  };
}

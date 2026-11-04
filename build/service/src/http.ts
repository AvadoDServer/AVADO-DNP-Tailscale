import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import path from "node:path";
import QRCode from "qrcode";
import { isAuthKey, type Config } from "./config.js";
import { checkCsrf, isSafeMethod } from "./csrf.js";
import { isAllowedHost } from "./host.js";
import { errorMessage, type Logger } from "./log.js";
import type { Status, Tailscale } from "./tailscale.js";

export const PAGE_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "font-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self' http://my.ava.do https://my.ava.do",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

const sendError = (res: ServerResponse, status: number, message: string) => sendJson(res, status, { error: message });

function loadStaticFiles(dir: string) {
  const files = new Map<string, { type: string; body: Buffer }>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    const type = MIME[path.extname(name).toLowerCase()];
    const file = path.join(dir, name);
    if (!type || name.startsWith(".") || !statSync(file).isFile()) continue;
    files.set(`/${name}`, { type, body: readFileSync(file) });
  }
  const index = files.get("/index.html");
  if (index) files.set("/", index);
  return files;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) throw new SyntaxError("too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const v = JSON.parse(raw) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * What other apps on the box may read (AI Connect shows the Tailscale address on its page):
 * no login link, no IP addresses.
 */
export function publicStatus(s: Status): Record<string, unknown> {
  return {
    state: s.state,
    dnsName: s.dnsName,
    mcpShared: s.mcpShared,
    mcpUrl: s.mcpUrl,
    funnel: s.funnel,
    publicMcpUrl: s.publicMcpUrl,
  };
}

/** True when the request came from the Tailscale page itself (it sends X-Avado-Request). */
function fromPage(req: IncomingMessage): boolean {
  return req.headers["x-avado-request"] === "1";
}

export function createApp(config: Config, logger: Logger, ts: Tailscale): RequestListener {
  const files = loadStaticFiles(config.publicDir);
  let qrFor: { url: string; svg: string } | null = null;

  const qr = async (url: string | null) => {
    if (!url) return null;
    if (qrFor?.url !== url) qrFor = { url, svg: await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) };
    return `data:image/svg+xml;base64,${Buffer.from(qrFor.svg).toString("base64")}`;
  };

  return (req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "Method not allowed");
        const f = files.get(pathname);
        if (!f) return sendError(res, 404, "Not found");
        res.writeHead(200, {
          "Content-Type": f.type,
          "Content-Length": f.body.length,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": PAGE_CSP,
        });
        res.end(req.method === "HEAD" ? undefined : f.body);
        return;
      }
      if (!isAllowedHost(req.headers.host, config.allowedHostnames)) return sendError(res, 421, "This page only answers requests addressed to your AVADO");
      const csrf = checkCsrf(req);
      if (csrf) return sendError(res, 403, csrf);

      if (pathname === "/api/status") {
        if (!isSafeMethod(req.method)) return sendError(res, 405, "Use GET");
        const s = await ts.status();
        // The full status (with the login link) only for the page; other apps get the short form.
        if (!fromPage(req)) return sendJson(res, 200, publicStatus(s));
        return sendJson(res, 200, {
          ...s,
          qr: await qr(s.authUrl),
          hostname: config.hostname,
          subnet: config.avadoSubnet,
          dnsServer: config.dnsServer,
          ownLoginServer: config.loginServer !== null,
          authKeyInSettings: config.authKey !== null,
          packageVersion: config.version,
        });
      }

      if (req.method !== "POST") return sendError(res, 405, "Use POST");
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const on = body.on === true;
      try {
        if (pathname === "/api/login") {
          if (typeof body.authKey === "string" && body.authKey.trim() !== "") {
            const key = body.authKey.trim();
            if (!isAuthKey(key)) return sendError(res, 400, "This does not look like a Tailscale auth key. It starts with tskey-auth-.");
            await ts.loginWithKey(key, "page");
          } else await ts.login(body.offerRoute !== false);
        }
        else if (pathname === "/api/logout") await ts.logout();
        else if (pathname === "/api/route") await ts.setRoute(on);
        else if (pathname === "/api/exit-node") await ts.setExitNode(on);
        else if (pathname === "/api/share-mcp") await ts.shareMcp(on);
        else if (pathname === "/api/funnel") {
          // the page asks the owner to confirm with the exact words; a stray request cannot switch it on
          if (on && body.confirm !== "share on the internet") return sendError(res, 400, "Please confirm on the page first.");
          await ts.setFunnel(on);
        } else return sendError(res, 404, "Unknown API route");
      } catch (e) {
        return sendError(res, 409, errorMessage(e));
      }
      logger.info(`${pathname} ${JSON.stringify({ on })}`);
      return sendJson(res, 200, await ts.status(true));
    })().catch((e: unknown) => {
      logger.error(`request failed: ${errorMessage(e)}`);
      if (!res.headersSent) sendError(res, 500, "Internal error");
      else res.destroy();
    });
  };
}

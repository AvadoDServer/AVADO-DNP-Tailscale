/**
 * HTTPS for the page, with the box's *.my.ava.do certificate.
 *
 * Chrome's "Always use secure connections" (on by default) tries https://tailscale.my.ava.do first
 * when an owner types the http address. A page that does not answer on port 443 then shows "This
 * site doesn't support a secure connection". So the page also answers on 443, with the certificate
 * the Admin (https://admin.my.ava.do), Vaultwarden and AI Connect use: the box's DAPPMANAGER serves
 * its current copy at http://dappmanager.my.ava.do (iso.ava.do is the second source).
 *
 * - Used only when it is for *.my.ava.do, valid for at least another hour and matches its key.
 *   Until there is one, the page is http only and it is checked again every 5 minutes; after that
 *   once a day. Nothing here ever stops the page; http works exactly as before.
 * - Same rules as lib/https.mjs (Starknet, Aztec), avadotls.py (the Python packages) and AI
 *   Connect's certs.ts.
 * - Only on the container's AVADO network address, never on all addresses: tailscaled answers
 *   Tailscale Serve and Funnel on the box's Tailscale address, port 443, with its own certificate,
 *   and needs that port there for itself.
 */
import { X509Certificate, createPrivateKey } from "node:crypto";
import type { RequestListener } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { errorMessage, type Logger } from "./log.js";

export const SOURCES = ["http://dappmanager.my.ava.do", "http://iso.ava.do"];
export const RETRY_MS = 5 * 60 * 1000;
export const REFRESH_MS = 24 * 60 * 60 * 1000;
const MIN_LEFT_MS = 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The container's IPv4 address on the AVADO network (not loopback, not Tailscale's 100.64.0.0/10). */
export function avadoNetworkAddress(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  for (const [name, list] of Object.entries(ifaces)) {
    if (name.startsWith("tailscale")) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [x, y] = a.address.split(".").map(Number);
      if (x === 100 && y! >= 64 && y! < 128) continue;
      return a.address;
    }
  }
  return null;
}

/** "valid until" text for a usable pair; throws with the reason otherwise. */
export function checkPair(cert: string, key: string, now = Date.now()): string {
  const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(cert);
  if (!first) throw new Error("no certificate in the file");
  const leaf = new X509Certificate(first[0]);
  const names = (leaf.subjectAltName ?? "").split(/,\s*/);
  if (!names.includes("DNS:*.my.ava.do")) throw new Error(`the certificate is not for *.my.ava.do (${leaf.subjectAltName ?? "no names"})`);
  if (Date.parse(leaf.validFrom) > now) throw new Error(`the certificate is valid only from ${leaf.validFrom}`);
  if (Date.parse(leaf.validTo) - now < MIN_LEFT_MS) throw new Error(`the certificate ends ${leaf.validTo}`);
  if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error("the key does not belong to the certificate");
  return leaf.validTo;
}

async function download(fetchImpl: FetchLike, url: string): Promise<string> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error("too large");
  return body;
}

/**
 * Keeps the box's *.my.ava.do certificate. onChange(watcher) runs when a new one is in place; it
 * may return false (for example: the port is taken) to be called again next round.
 */
export class CertWatcher {
  cert: string | null = null;
  key: string | null = null;
  validTo: string | null = null;
  server: https.Server | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private said: string | null = null;

  constructor(
    private readonly onChange: (w: CertWatcher) => boolean | Promise<boolean>,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly sources: string[] = SOURCES,
  ) {}

  /** true when a usable certificate is in place (new or the same). */
  async refresh(): Promise<boolean> {
    const problems: string[] = [];
    for (const base of this.sources) {
      let cert: string, key: string, validTo: string;
      try {
        [cert, key] = await Promise.all([download(this.fetchImpl, `${base}/my.ava.do.crt`), download(this.fetchImpl, `${base}/my.ava.do.key`)]);
        validTo = checkPair(cert, key);
      } catch (e) {
        problems.push(`${base}: ${errorMessage(e)}`);
        continue;
      }
      this.said = null;
      if (cert === this.cert && key === this.key) return true;
      this.cert = cert;
      this.key = key;
      this.validTo = validTo;
      let applied: boolean;
      try {
        applied = (await this.onChange(this)) !== false;
      } catch (e) {
        this.logger.warn(`HTTPS: could not use the new certificate: ${errorMessage(e)}`);
        applied = false;
      }
      if (!applied) this.cert = this.key = null; // try again next round
      return applied;
    }
    const text = problems.join("; ");
    if (text !== this.said) {
      this.logger.warn(`HTTPS: no usable *.my.ava.do certificate yet, http only for now (${text})`);
      this.said = text;
    }
    return false;
  }

  /** Every 5 minutes until there is a certificate, then daily. */
  start(): this {
    const loop = async () => {
      let ok = false;
      try {
        ok = await this.refresh();
      } catch (e) {
        this.logger.warn(`HTTPS: certificate check failed: ${errorMessage(e)}`);
      }
      this.timer = setTimeout(loop, ok ? REFRESH_MS : RETRY_MS);
      this.timer.unref?.();
    };
    void loop();
    return this;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.server?.close();
  }
}

/** Serves the page's request handler on port 443 once the certificate is there. */
export function serveHttps(
  handler: RequestListener,
  opts: { port: number; host: string; logger: Logger; fetchImpl?: FetchLike; sources?: string[] },
): CertWatcher {
  const onChange = (w: CertWatcher): boolean | Promise<boolean> => {
    if (w.server) {
      w.server.setSecureContext({ cert: w.cert!, key: w.key! });
      opts.logger.info(`HTTPS: certificate renewed, valid until ${w.validTo}`);
      return true;
    }
    const server = https.createServer({ cert: w.cert!, key: w.key!, minVersion: "TLSv1.2" }, handler);
    server.headersTimeout = 30_000;
    server.requestTimeout = 120_000;
    server.maxConnections = 64;
    server.on("tlsClientError", () => {}); // plain http on 443, a scanner, a closed tab
    return new Promise<boolean>((resolve) => {
      const refused = (err: NodeJS.ErrnoException) => {
        opts.logger.warn(`HTTPS: cannot open port ${opts.port} (${err.code ?? errorMessage(err)}); the page works over http`);
        resolve(false);
      };
      server.once("error", refused);
      server.listen(opts.port, opts.host, () => {
        server.off("error", refused);
        server.on("error", (err) => opts.logger.warn(`HTTPS: ${errorMessage(err)}`));
        w.server = server;
        opts.logger.info(`page (https) listening on ${opts.host}:${(server.address() as AddressInfo).port}, certificate valid until ${w.validTo}`);
        resolve(true);
      });
    });
  };
  return new CertWatcher(onChange, opts.logger, opts.fetchImpl, opts.sources).start();
}

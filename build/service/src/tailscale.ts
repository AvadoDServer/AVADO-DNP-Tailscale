/**
 * Runs tailscaled and drives it with the tailscale CLI. Every command line is fixed here: the page
 * only chooses on/off, nothing from a request is ever passed to a command.
 *
 * tailscaled runs with userspace networking: no /dev/net/tun, no privileges, no routes or
 * firewall rules on the box. ZeroTier Remote Access and the box's DNS are not touched.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { errorMessage, redact, type Logger } from "./log.js";

export type State = "starting" | "needs-login" | "logging-in" | "running" | "stopped" | "error";

export interface Status {
  state: State;
  /** Shown only on the Tailscale page itself (never passed on to other apps). */
  authUrl: string | null;
  dnsName: string | null;
  ips: string[];
  tailnet: string | null;
  /** The AVADO network is offered to the tailnet (advertised) */
  routeOffered: boolean;
  /** ... and the owner approved it in the Tailscale admin console */
  routeApproved: boolean;
  mcpShared: boolean;
  funnel: boolean;
  mcpUrl: string | null;
  publicMcpUrl: string | null;
  /** The last message from a Serve/Funnel/login command, for the page (e.g. "enable HTTPS first: <link>"). */
  notice: string | null;
  version: string | null;
}

export type Exec = (args: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

export interface TailscaleDeps {
  exec: Exec;
  /** Starts `tailscale up` without waiting for it (it only returns once logged in). */
  spawnUp(args: string[]): { kill(): void };
}

export function defaultDeps(config: Config): TailscaleDeps {
  const base = ["--socket", config.socket];
  return {
    exec: (args, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        execFile(config.tailscaleBin, [...base, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) reject(Object.assign(new Error(String(stderr || err.message).trim()), { stdout, stderr }));
          else resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    spawnUp: (args) => {
      const child = spawn(config.tailscaleBin, [...base, ...args], { stdio: "ignore" });
      child.on("error", () => {});
      return { kill: () => child.kill("SIGTERM") };
    },
  };
}

/** The arguments of each operation. Kept in one place so the tests can check them. */
export function commands(config: Config) {
  const relay = `http://127.0.0.1:${config.relayPort}`;
  return {
    up: (offerRoute: boolean) => [
      "up",
      "--reset",
      `--hostname=${config.hostname}`,
      // keep the container on the box's DNS (bind), and take no routes from the tailnet
      "--accept-dns=false",
      "--accept-routes=false",
      `--advertise-routes=${offerRoute ? config.avadoSubnet : ""}`,
      "--timeout=600s",
    ],
    logout: ["logout"],
    routes: (on: boolean) => ["set", `--advertise-routes=${on ? config.avadoSubnet : ""}`],
    serveOn: ["serve", "--bg", "--yes", "--https=443", relay],
    serveOff: ["serve", "--https=443", "off"],
    funnelOn: ["funnel", "--bg", "--yes", "--https=443", relay],
    funnelOff: ["funnel", "--https=443", "off"],
    status: ["status", "--json"],
    prefs: ["debug", "prefs"],
    serveStatus: ["serve", "status", "--json"],
  };
}

interface TsStatus {
  BackendState?: string;
  AuthURL?: string;
  Version?: string;
  TailscaleIPs?: string[];
  Self?: { DNSName?: string; TailscaleIPs?: string[]; PrimaryRoutes?: string[] };
  CurrentTailnet?: { Name?: string } | null;
}

interface ServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

/** Pulls the first https://login.tailscale.com/... or https://... link out of a CLI message. */
export function linkIn(text: string): string | null {
  const m = /https:\/\/[^\s"')]+/.exec(text);
  return m ? m[0] : null;
}

export class Tailscale {
  private daemon: ChildProcess | null = null;
  private stopping = false;
  private backoffMs = 5_000;
  private up: { kill(): void } | null = null;
  private notice: string | null = null;
  private routeWanted = true;
  private cache: { at: number; status: Status } | null = null;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly deps: TailscaleDeps = defaultDeps(config),
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts tailscaled and keeps it running. */
  startDaemon(): void {
    const dir = path.join(this.config.stateDir, "tailscale");
    mkdirSync(dir, { recursive: true });
    const child = spawn(this.config.tailscaledBin, ["--tun=userspace-networking", `--statedir=${dir}`, `--socket=${this.config.socket}`, "--port=41641"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.daemon = child;
    const forward = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split("\n")) if (line.trim()) process.stdout.write(`tailscaled: ${redact(line)}\n`);
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.on("error", (e) => this.logger.error(`cannot start tailscaled: ${errorMessage(e)}`));
    child.on("exit", (code, signal) => {
      this.daemon = null;
      if (this.stopping) return;
      this.logger.warn(`tailscaled stopped (${signal ?? code}); starting it again in ${this.backoffMs / 1000} s`);
      setTimeout(() => this.startDaemon(), this.backoffMs).unref();
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    });
    setTimeout(() => (this.backoffMs = 5_000), 120_000).unref();
  }

  stopDaemon(): Promise<void> {
    this.stopping = true;
    this.up?.kill();
    const d = this.daemon;
    if (!d) return Promise.resolve();
    return new Promise((resolve) => {
      d.once("exit", () => resolve());
      d.kill("SIGTERM");
      setTimeout(resolve, 4000).unref();
    });
  }

  /** One change at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    this.cache = null;
    return run;
  }

  async status(fresh = false): Promise<Status> {
    if (!fresh && this.cache && this.now() - this.cache.at < 2_000) return this.cache.status;
    const cmd = commands(this.config);
    let ts: TsStatus | null = null;
    try {
      ts = JSON.parse((await this.deps.exec(cmd.status, 10_000)).stdout) as TsStatus;
    } catch (e) {
      // `tailscale status` exits non-zero while logged out but still prints JSON
      const out = (e as { stdout?: string }).stdout;
      try {
        ts = out ? (JSON.parse(out) as TsStatus) : null;
      } catch {
        ts = null;
      }
    }
    const backend = ts?.BackendState ?? "";
    let state: State =
      !ts ? (this.daemon ? "starting" : "error") : backend === "Running" ? "running" : backend === "NeedsLogin" || backend === "NoState" ? "needs-login" : backend === "Starting" ? "starting" : "stopped";
    if (state === "needs-login" && this.up) state = "logging-in";
    const dnsName = ts?.Self?.DNSName ? ts.Self.DNSName.replace(/\.$/, "") : null;
    const routeApproved = (ts?.Self?.PrimaryRoutes ?? []).includes(this.config.avadoSubnet);
    let routeOffered = this.routeWanted;
    if (ts) {
      try {
        const prefs = JSON.parse((await this.deps.exec(cmd.prefs, 10_000)).stdout) as { AdvertiseRoutes?: string[] | null };
        routeOffered = (prefs.AdvertiseRoutes ?? []).includes(this.config.avadoSubnet);
      } catch {
        /* keep what was last asked for */
      }
    }

    let mcpShared = false;
    let funnel = false;
    if (state === "running") {
      try {
        const serve = JSON.parse((await this.deps.exec(cmd.serveStatus, 10_000)).stdout || "{}") as ServeStatus;
        const relay = `http://127.0.0.1:${this.config.relayPort}`;
        for (const [hostPort, web] of Object.entries(serve.Web ?? {})) {
          if (!hostPort.endsWith(":443")) continue;
          if (Object.values(web.Handlers ?? {}).some((h) => (h.Proxy ?? "").replace(/\/+$/, "") === relay)) {
            mcpShared = true;
            funnel = serve.AllowFunnel?.[hostPort] === true;
          }
        }
      } catch {
        /* no serve config yet */
      }
    }
    const mcpUrl = mcpShared && dnsName ? `https://${dnsName}/mcp` : null;
    const status: Status = {
      state,
      authUrl: state === "needs-login" || state === "logging-in" ? ts?.AuthURL || null : null,
      dnsName,
      ips: ts?.Self?.TailscaleIPs ?? ts?.TailscaleIPs ?? [],
      tailnet: ts?.CurrentTailnet?.Name ?? null,
      routeOffered,
      routeApproved,
      mcpShared,
      funnel,
      mcpUrl,
      publicMcpUrl: funnel ? mcpUrl : null,
      notice: this.notice,
      version: ts?.Version ?? null,
    };
    if (state === "running" && this.up) {
      this.up.kill();
      this.up = null;
    }
    this.cache = { at: this.now(), status };
    return status;
  }

  login(offerRoute = true): Promise<void> {
    return this.serial(async () => {
      this.routeWanted = offerRoute;
      this.notice = null;
      this.up?.kill();
      this.up = this.deps.spawnUp(commands(this.config).up(offerRoute));
      // `tailscale up` ends by itself after 10 minutes (--timeout); forget it then
      const handle = this.up;
      setTimeout(() => {
        if (this.up === handle) this.up = null;
      }, 610_000).unref();
    });
  }

  logout(): Promise<void> {
    return this.serial(async () => {
      this.up?.kill();
      this.up = null;
      this.notice = null;
      await this.run(commands(this.config).logout, "log out");
    });
  }

  setRoute(on: boolean): Promise<void> {
    return this.serial(async () => {
      this.routeWanted = on;
      await this.run(commands(this.config).routes(on), on ? "offer the AVADO network" : "stop offering the AVADO network");
    });
  }

  shareMcp(on: boolean): Promise<void> {
    return this.serial(async () => {
      const c = commands(this.config);
      if (on) await this.run(c.serveOn, "share AI Connect in your tailnet");
      else {
        // switching Serve off also ends Funnel for that port
        await this.run(c.funnelOff, "stop sharing on the internet").catch(() => {});
        await this.run(c.serveOff, "stop sharing AI Connect");
      }
    });
  }

  setFunnel(on: boolean): Promise<void> {
    return this.serial(async () => {
      const c = commands(this.config);
      if (on) await this.run(c.funnelOn, "share AI Connect on the internet");
      else {
        await this.run(c.funnelOff, "stop sharing on the internet");
        // keep AI Connect in the tailnet
        await this.run(c.serveOn, "share AI Connect in your tailnet");
      }
    });
  }

  private async run(args: string[], what: string): Promise<void> {
    try {
      const { stdout, stderr } = await this.deps.exec(args, 30_000);
      const msg = `${stdout}\n${stderr}`;
      // Serve/Funnel print a link when the tailnet must allow something first (HTTPS certificates, Funnel)
      const link = /enable|visit|approve|allow/i.test(msg) ? linkIn(msg) : null;
      this.notice = link ? `Tailscale needs one more setting in your account first. Open ${link}, allow it, then try again.` : null;
    } catch (e) {
      const msg = errorMessage(e);
      const link = linkIn(msg);
      this.notice = link
        ? `Tailscale needs one more setting in your account first. Open ${link}, allow it, then try again.`
        : `Could not ${what}: ${redact(msg).slice(0, 300)}`;
      this.logger.warn(`${args.slice(0, 2).join(" ")}: ${redact(msg)}`);
      throw new Error(this.notice);
    }
  }
}

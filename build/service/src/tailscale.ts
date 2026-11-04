/**
 * Runs tailscaled and drives it with the tailscale CLI. Every command line is fixed here: the page
 * only chooses on/off (and may hand over an auth key, which goes to tailscale in a file, never on
 * the command line), nothing else from a request is ever passed to a command.
 *
 * tailscaled runs with userspace networking: no /dev/net/tun, no privileges, no routes or
 * firewall rules on the box. It still works as a subnet router: traffic from the owner's devices
 * to the AVADO network (172.33.0.0/16) is answered by tailscaled's own network stack, which opens
 * ordinary connections from this container to the Admin, the apps and the box's DNS. ZeroTier
 * Remote Access and the box's DNS are not touched.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { errorMessage, redact, type Logger } from "./log.js";

export type State = "starting" | "needs-login" | "logging-in" | "needs-approval" | "running" | "stopped" | "error";

export interface Status {
  state: State;
  /** Shown only on the Tailscale page itself (never passed on to other apps). */
  authUrl: string | null;
  dnsName: string | null;
  ips: string[];
  tailnet: string | null;
  /** The AVADO network is offered to the owner's Tailscale devices (advertised) */
  routeOffered: boolean;
  /** ... and the owner approved it in the Tailscale admin console (this box serves it) */
  routeApproved: boolean;
  /** Another device already serves the same network (usually a second AVADO): its name. */
  routeClash: string | null;
  /** This box offers itself as an exit node (off by default) */
  exitNodeOffered: boolean;
  /** ... and the owner allowed it in the Tailscale admin console */
  exitNodeApproved: boolean;
  /** When the box's Tailscale login runs out (null: never, the owner switched key expiry off). */
  keyExpiry: string | null;
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

const EXIT_ROUTES = ["0.0.0.0/0", "::/0"];

export interface UpOptions {
  offerRoute: boolean;
  /** A file holding an auth key: log in without the browser. */
  authKeyFile?: string;
}

/** The arguments of each operation. Kept in one place so the tests can check them. */
export function commands(config: Config) {
  const relay = `http://127.0.0.1:${config.relayPort}`;
  return {
    up: (o: UpOptions) => [
      "up",
      "--reset",
      `--hostname=${config.hostname}`,
      // keep the container on the box's DNS (bind), and take no routes from other devices: a second
      // AVADO offering 172.33.0.0/16 can never pull this box's own network away from it
      "--accept-dns=false",
      "--accept-routes=false",
      `--advertise-routes=${o.offerRoute ? config.avadoSubnet : ""}`,
      ...(config.loginServer ? [`--login-server=${config.loginServer}`] : []),
      ...(o.authKeyFile ? [`--auth-key=file:${o.authKeyFile}`, "--timeout=90s"] : ["--timeout=600s"]),
    ],
    logout: ["logout"],
    /** Both flags every time, so changing one never drops the other. */
    advertise: (route: boolean, exitNode: boolean) => ["set", `--advertise-routes=${route ? config.avadoSubnet : ""}`, `--advertise-exit-node=${exitNode}`],
    serveOn: ["serve", "--bg", "--yes", "--https=443", relay],
    serveOff: ["serve", "--https=443", "off"],
    funnelOn: ["funnel", "--bg", "--yes", "--https=443", relay],
    funnelOff: ["funnel", "--https=443", "off"],
    status: ["status", "--json"],
    prefs: ["debug", "prefs"],
    serveStatus: ["serve", "status", "--json"],
  };
}

interface TsPeer {
  HostName?: string;
  DNSName?: string;
  PrimaryRoutes?: string[] | null;
}

interface TsStatus {
  BackendState?: string;
  AuthURL?: string;
  Version?: string;
  TailscaleIPs?: string[];
  Self?: TsPeer & { TailscaleIPs?: string[]; ExitNodeOption?: boolean; KeyExpiry?: string | null };
  Peer?: Record<string, TsPeer> | null;
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

/**
 * Only a real login link reaches the page (idea from DAppNode's Tailscale status reporter): an
 * https://login.tailscale.com/a/... link, or with an own login server (Headscale) a link on that
 * server. Nothing else is shown, so a confused daemon can never put a foreign link on the page.
 */
export function isLoginLink(url: string, loginServer: string | null): boolean {
  if (url.length > 512 || /[\s"<>\\]/.test(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (loginServer) {
    try {
      return u.origin === new URL(loginServer).origin;
    } catch {
      return false;
    }
  }
  return u.protocol === "https:" && u.host === "login.tailscale.com" && u.pathname.startsWith("/a/") && u.pathname.length > 3;
}

const OWN_SERVER_NO_HTTPS =
  "Sharing AI Connect over HTTPS needs Tailscale's own servers: your own login server (TS_LOGIN_SERVER) gives no HTTPS certificates. With the AVADO network allowed, your devices reach AI Connect at http://mcp.my.ava.do:8000/mcp instead.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a failed `tailscale up --auth-key` said, in plain words. */
function keyProblem(msg: string): string {
  if (/invalid key|not valid|not found|unauthori[sz]ed|expired|key.*(revoked|used)/i.test(msg)) return "Tailscale says the key is not valid (it may have expired, been used already, or been deleted)";
  if (/timeout|timed out|deadline/i.test(msg)) return "Tailscale did not answer in time";
  return redact(msg).slice(0, 200);
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
  ) {
    if (config.authKeyInvalid) {
      this.notice =
        "The auth key in this app's settings (TS_AUTHKEY in the Admin) does not look like a Tailscale key. It starts with tskey-auth-. Fix it there, or use the login button below.";
    }
  }

  /**
   * Removes auth key files a previous run left behind (the app was stopped while a key login was
   * still running): a key must never stay in the volume.
   */
  removeLeftoverKeys(): void {
    let names: string[] = [];
    try {
      names = readdirSync(this.config.stateDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(".authkey-")) continue;
      try {
        rmSync(path.join(this.config.stateDir, name), { force: true });
        this.logger.info("removed an auth key file left from an interrupted login");
      } catch (e) {
        this.logger.warn(`cannot remove a leftover auth key file: ${errorMessage(e)}`);
      }
    }
  }

  /** Starts tailscaled and keeps it running. */
  startDaemon(): void {
    const dir = path.join(this.config.stateDir, "tailscale");
    mkdirSync(dir, { recursive: true });
    this.removeLeftoverKeys();
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

  private async prefs(): Promise<{ route: boolean; exitNode: boolean } | null> {
    try {
      const p = JSON.parse((await this.deps.exec(commands(this.config).prefs, 10_000)).stdout) as { AdvertiseRoutes?: string[] | null };
      const routes = p.AdvertiseRoutes ?? [];
      return { route: routes.includes(this.config.avadoSubnet), exitNode: EXIT_ROUTES.every((r) => routes.includes(r)) };
    } catch {
      return null;
    }
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
    let state: State = !ts
      ? this.daemon
        ? "starting"
        : "error"
      : backend === "Running"
        ? "running"
        : // NoState is only a moment while tailscaled reads its saved identity: not "logged out".
          // A box that really needs a login says NeedsLogin (checked on 1.104.4, fresh and restarted).
          backend === "NeedsLogin"
          ? "needs-login"
          : backend === "NeedsMachineAuth"
            ? "needs-approval"
            : backend === "Starting" || backend === "NoState"
              ? "starting"
              : "stopped";
    if (state === "needs-login" && this.up) state = "logging-in";
    const dnsName = ts?.Self?.DNSName ? ts.Self.DNSName.replace(/\.$/, "") : null;
    const subnet = this.config.avadoSubnet;
    const routeApproved = (ts?.Self?.PrimaryRoutes ?? []).includes(subnet);
    const p = ts ? await this.prefs() : null;
    const routeOffered = p ? p.route : this.routeWanted;
    let routeClash: string | null = null;
    for (const peer of Object.values(ts?.Peer ?? {})) {
      if ((peer.PrimaryRoutes ?? []).includes(subnet)) routeClash = (peer.DNSName || peer.HostName || "another device").split(".")[0] || "another device";
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
    const link = ts?.AuthURL || "";
    const status: Status = {
      state,
      authUrl: (state === "needs-login" || state === "logging-in") && isLoginLink(link, this.config.loginServer) ? link : null,
      dnsName,
      ips: ts?.Self?.TailscaleIPs ?? ts?.TailscaleIPs ?? [],
      tailnet: ts?.CurrentTailnet?.Name ?? null,
      routeOffered,
      routeApproved,
      routeClash: routeOffered && !routeApproved ? routeClash : null,
      exitNodeOffered: p?.exitNode ?? false,
      exitNodeApproved: ts?.Self?.ExitNodeOption === true,
      keyExpiry: state === "running" && ts?.Self?.KeyExpiry ? ts.Self.KeyExpiry : null,
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
    if (state === "running" && this.notice?.startsWith("The auth key")) this.notice = null;
    this.cache = { at: this.now(), status };
    return status;
  }

  /** Browser login: `tailscale up` prints a login link, the page shows it with a QR code. */
  login(offerRoute = true): Promise<void> {
    return this.serial(async () => {
      this.routeWanted = offerRoute;
      this.notice = null;
      this.up?.kill();
      this.up = this.deps.spawnUp(commands(this.config).up({ offerRoute }));
      // `tailscale up` ends by itself after 10 minutes (--timeout); forget it then
      const handle = this.up;
      setTimeout(() => {
        if (this.up === handle) this.up = null;
      }, 610_000).unref();
    });
  }

  /**
   * Login with an auth key (from the page, or TS_AUTHKEY in the app's settings). The key goes to
   * tailscale in a private file that is deleted right after, so it never shows in a process list.
   * The key is not kept: once logged in, the box's identity lives in the state volume.
   */
  loginWithKey(key: string, from: "page" | "settings"): Promise<void> {
    return this.serial(async () => {
      this.up?.kill();
      this.up = null;
      this.notice = null;
      this.routeWanted = true;
      const file = path.join(this.config.stateDir, `.authkey-${randomBytes(6).toString("hex")}`);
      try {
        await writeFile(file, key, { mode: 0o600 });
        await this.deps.exec(commands(this.config).up({ offerRoute: true, authKeyFile: file }), 100_000);
        this.logger.info(`logged in with an auth key (${from === "page" ? "from the page" : "from the app's settings"})`);
      } catch (e) {
        const why = keyProblem(errorMessage(e));
        this.logger.warn(`login with an auth key failed: ${why}`);
        this.notice =
          from === "settings"
            ? `The auth key in this app's settings (TS_AUTHKEY in the Admin) was not accepted: ${why}. Make a new key, or use the login button below.`
            : `That auth key was not accepted: ${why}. Make a new key, or use the login button instead.`;
        throw new Error(this.notice);
      } finally {
        await rm(file, { force: true }).catch(() => {});
      }
    });
  }

  /**
   * TS_AUTHKEY from the app's settings, used only while the box is not logged in yet (like
   * TS_AUTH_ONCE=true in DAppNode's package): after a restart or update the saved identity is kept
   * and the key is not used again.
   */
  async autoLogin(waitMs = 60_000): Promise<void> {
    if (!this.config.authKey) return;
    const until = this.now() + waitMs;
    for (;;) {
      const s = await this.status(true);
      if (s.state === "needs-login") break;
      if (s.state !== "starting" || this.now() > until) return;
      await sleep(1000);
    }
    await this.loginWithKey(this.config.authKey, "settings").catch(() => {});
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
      const p = await this.prefs();
      await this.run(commands(this.config).advertise(on, p?.exitNode ?? false), on ? "offer the AVADO network" : "stop offering the AVADO network");
    });
  }

  setExitNode(on: boolean): Promise<void> {
    return this.serial(async () => {
      const p = await this.prefs();
      await this.run(commands(this.config).advertise(p?.route ?? this.routeWanted, on), on ? "offer this AVADO as an exit node" : "stop offering this AVADO as an exit node");
    });
  }

  shareMcp(on: boolean): Promise<void> {
    return this.serial(async () => {
      const c = commands(this.config);
      if (on) {
        await this.run(c.serveOn, "share AI Connect with your Tailscale devices").catch((e) => {
          if (!this.config.loginServer) throw e;
          // Headscale and other own login servers give no HTTPS certificates, so Serve cannot work there
          this.notice = OWN_SERVER_NO_HTTPS;
          throw new Error(this.notice);
        });
      } else {
        // switching Serve off also ends Funnel for that port
        await this.run(c.funnelOff, "stop sharing on the internet").catch(() => {});
        await this.run(c.serveOff, "stop sharing AI Connect").catch((e) => {
          // already off (nothing was shared): that is what the owner asked for
          if (!/does not exist|nothing to (remove|turn off)/i.test(errorMessage(e))) throw e;
          this.notice = null;
        });
      }
    });
  }

  setFunnel(on: boolean): Promise<void> {
    return this.serial(async () => {
      const c = commands(this.config);
      if (on) await this.run(c.funnelOn, "share AI Connect on the internet");
      else {
        await this.run(c.funnelOff, "stop sharing on the internet");
        // keep AI Connect reachable from the owner's Tailscale devices
        await this.run(c.serveOn, "share AI Connect with your Tailscale devices");
      }
    });
  }

  private async run(args: string[], what: string): Promise<void> {
    try {
      const { stdout, stderr } = await this.deps.exec(args, 30_000);
      const msg = `${stdout}\n${stderr}`;
      // Serve/Funnel print a link when the account must allow something first (HTTPS certificates, Funnel)
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

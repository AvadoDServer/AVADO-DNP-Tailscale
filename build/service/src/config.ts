import { readFileSync } from "node:fs";
import { DEFAULT_ALLOWED_HOSTNAMES } from "./host.js";

export interface Config {
  host: string;
  /** The Tailscale page (http://tailscale.my.ava.do). */
  port: number;
  /** This app's own files (the volume). tailscaled keeps its state in TS_STATE_DIR (containerboot). */
  stateDir: string;
  socket: string;
  tailscaleBin: string;
  /** The box's name in Tailscale (TS_HOSTNAME, as containerboot uses it). */
  hostname: string;
  /**
   * TS_ROUTES, as containerboot uses it: the AVADO network (Admin, apps, the box's DNS at
   * 172.33.1.2), offered to the owner's devices once the owner approves it in Tailscale.
   */
  routes: string[];
  /** The route the page checks (the AVADO network). */
  avadoSubnet: string;
  /** TS_EXTRA_ARGS, as containerboot uses it (default --advertise-exit-node, like DAppNode). */
  extraArgs: string[];
  /** The box's DNS (bind) on the AVADO network: the owner adds it as nameserver in Tailscale. */
  dnsServer: string;
  /**
   * TS_AUTHKEY, entered in the installer (or later under the app's settings). This app logs the box
   * in with it, once, while it is not logged in yet (TS_AUTH_ONCE): the key goes to tailscale in a
   * file, never on a command line, and a rejected key leaves the login link working.
   */
  authKey: string | null;
  /** TS_AUTHKEY is set but is not a key (a typo): shown on the page, never a crash. */
  authKeyInvalid: boolean;
  /** An own control server (Headscale), from --login-server in TS_EXTRA_ARGS. Null: Tailscale's. */
  loginServer: string | null;
  /**
   * AI Connect's agent-only port; Tailscale Serve/Funnel reach it through the local MCP relay. By
   * container name: Docker's own DNS on the AVADO network answers it only while the AI Connect
   * container exists (the *.my.ava.do names can still point at an old address after a removal).
   */
  mcpUpstream: string;
  /** The local relay Tailscale Serve points at (Serve only proxies to this machine). */
  relayPort: number;
  publicDir: string;
  allowedHostnames: string[];
  version: string;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${key} must be a port number`);
  return n;
}

/** Tailscale keys look like tskey-auth-k123-abc; Headscale keys are long hex or hskey-auth-... */
export function isAuthKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{20,200}$/.test(key);
}

function readVersion(env: NodeJS.ProcessEnv): string {
  if (env.PACKAGE_VERSION) return env.PACKAGE_VERSION;
  try {
    return readFileSync(env.PACKAGE_VERSION_FILE || "/usr/src/service/package-version", "utf8").trim() || "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

const CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

/** --login-server=URL or --login-server URL in TS_EXTRA_ARGS. */
function loginServerIn(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--login-server=")) return a.slice("--login-server=".length);
    if (a === "--login-server") return args[i + 1] ?? null;
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hostname = (env.TS_HOSTNAME || "avado").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(hostname)) throw new Error("TS_HOSTNAME must be a simple name like avado");
  const routes = (env.TS_ROUTES ?? "172.33.0.0/16")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  for (const r of routes) if (!CIDR.test(r)) throw new Error("TS_ROUTES must look like 172.33.0.0/16");
  const avadoSubnet = env.AVADO_SUBNET || "172.33.0.0/16";
  const extraArgs = (env.TS_EXTRA_ARGS ?? "--advertise-exit-node").split(/\s+/).filter(Boolean);
  const rawKey = (env.TS_AUTHKEY || env.TS_AUTH_KEY || "").trim();
  const authKey = rawKey && isAuthKey(rawKey) ? rawKey : null;
  const loginServer = (loginServerIn(extraArgs) || "").trim().replace(/\/+$/, "") || null;
  if (loginServer && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(loginServer)) {
    throw new Error("--login-server in TS_EXTRA_ARGS must be a web address like https://headscale.example.com");
  }
  return {
    host: env.HOST || "0.0.0.0",
    port: num(env, "PORT", 80),
    stateDir: env.STATE_DIR || "/data",
    socket: env.TS_SOCKET || "/var/run/tailscale/tailscaled.sock",
    tailscaleBin: env.TAILSCALE_BIN || "tailscale",
    hostname,
    routes,
    avadoSubnet,
    extraArgs,
    dnsServer: env.AVADO_DNS || "172.33.1.2",
    authKey,
    authKeyInvalid: rawKey !== "" && authKey === null,
    loginServer,
    mcpUpstream: (env.MCP_UPSTREAM || "http://DAppNodePackage-mcp.avado.dnp.dappnode.eth:8000").replace(/\/+$/, ""),
    relayPort: num(env, "RELAY_PORT", 8100),
    publicDir: env.PUBLIC_DIR || new URL("../public", import.meta.url).pathname,
    allowedHostnames: [
      ...DEFAULT_ALLOWED_HOSTNAMES,
      ...(env.EXTRA_ALLOWED_HOSTNAMES || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ],
    version: readVersion(env),
  };
}

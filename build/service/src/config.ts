import { readFileSync } from "node:fs";
import { DEFAULT_ALLOWED_HOSTNAMES } from "./host.js";

export interface Config {
  host: string;
  /** The Tailscale page (http://tailscale.my.ava.do). */
  port: number;
  /** Where tailscaled keeps its state (the box's identity in the tailnet). */
  stateDir: string;
  socket: string;
  tailscaleBin: string;
  tailscaledBin: string;
  /** The box's name in the tailnet. */
  hostname: string;
  /**
   * The AVADO network (Admin, apps, the box's DNS at 172.33.1.2). Offered to the tailnet as a subnet
   * route so `my.ava.do` works from the owner's devices once the owner approves it.
   */
  avadoSubnet: string;
  /** The box's DNS (bind) on the AVADO network: the owner adds it in Tailscale for my.ava.do. */
  dnsServer: string;
  /**
   * Optional Tailscale auth key (TS_AUTHKEY, set in the Admin under the app's Settings →
   * Environment variables, Advanced mode). Used once to log in when the box is not logged in yet; the box's identity then stays
   * in the state volume (like DAppNode's TS_AUTH_ONCE=true).
   */
  authKey: string | null;
  /** TS_AUTHKEY is set but is not a key (a typo in the Admin): shown on the page, never a crash. */
  authKeyInvalid: boolean;
  /** Optional own control server (Headscale). Empty: Tailscale's servers. */
  loginServer: string | null;
  /** AI Connect's agent-only port; Tailscale Serve/Funnel reach it through the local MCP relay. */
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hostname = (env.TS_HOSTNAME || "avado").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(hostname)) throw new Error("TS_HOSTNAME must be a simple name like avado");
  const subnet = env.AVADO_SUBNET || "172.33.0.0/16";
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(subnet)) throw new Error("AVADO_SUBNET must look like 172.33.0.0/16");
  const rawKey = (env.TS_AUTHKEY || "").trim();
  const authKey = rawKey && isAuthKey(rawKey) ? rawKey : null;
  const loginServer = (env.TS_LOGIN_SERVER || "").trim().replace(/\/+$/, "") || null;
  if (loginServer && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(loginServer)) {
    throw new Error("TS_LOGIN_SERVER must be a web address like https://headscale.example.com");
  }
  return {
    host: env.HOST || "0.0.0.0",
    port: num(env, "PORT", 80),
    stateDir: env.STATE_DIR || "/data",
    socket: env.TS_SOCKET || "/tmp/tailscaled.sock",
    tailscaleBin: env.TAILSCALE_BIN || "tailscale",
    tailscaledBin: env.TAILSCALED_BIN || "tailscaled",
    hostname,
    avadoSubnet: subnet,
    dnsServer: env.AVADO_DNS || "172.33.1.2",
    authKey,
    authKeyInvalid: rawKey !== "" && authKey === null,
    loginServer,
    mcpUpstream: (env.MCP_UPSTREAM || "http://mcp.my.ava.do:8000").replace(/\/+$/, ""),
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

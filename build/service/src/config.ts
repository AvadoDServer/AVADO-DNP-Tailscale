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
  return {
    host: env.HOST || "0.0.0.0",
    port: num(env, "PORT", 80),
    stateDir: env.STATE_DIR || "/data",
    socket: env.TS_SOCKET || "/tmp/tailscaled.sock",
    tailscaleBin: env.TAILSCALE_BIN || "tailscale",
    tailscaledBin: env.TAILSCALED_BIN || "tailscaled",
    hostname,
    avadoSubnet: subnet,
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

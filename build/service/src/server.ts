import http from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { createLogger, errorMessage } from "./log.js";
import { avadoNetworkAddress, serveHttps } from "./https.js";
import { createRelay } from "./relay.js";
import { Tailscale } from "./tailscale.js";

const config = loadConfig();
const logger = createLogger();
process.on("unhandledRejection", (reason) => logger.error(`unhandled rejection: ${errorMessage(reason)}`));

// tailscaled is run by containerboot next to this app (build/start.sh); this app only talks to it.
const ts = new Tailscale(config, logger);
ts.removeLeftoverKeys();
// The auth key from the installer logs the box in by itself, once (the identity is then kept)
void ts.autoLogin();

const app = createApp(config, logger, ts);
const page = http.createServer(app);
page.requestTimeout = 120_000;
page.headersTimeout = 30_000;
page.maxConnections = 64;

// Serve/Funnel -> 127.0.0.1:relayPort -> AI Connect's agent-only port. Loopback only.
const relay = http.createServer(createRelay(config.mcpUpstream, logger));
relay.requestTimeout = 300_000;

for (const [server, port, host, what] of [
  [page, config.port, config.host, "page"],
  [relay, config.relayPort, "127.0.0.1", "AI Connect relay"],
] as const) {
  server.on("error", (err: NodeJS.ErrnoException) => {
    logger.error(`cannot start the ${what} on port ${port}: ${err.code === "EACCES" ? "not allowed (cap_net_bind_service missing)" : errorMessage(err)}`);
    process.exit(1);
  });
  server.listen(port, host, () => logger.info(`${what} listening on ${host}:${port}`));
}

// The same page on https (port 443) once the box's *.my.ava.do certificate is there; on the AVADO
// network address only (Tailscale Serve and Funnel use port 443 on the Tailscale address).
const httpsHost = config.httpsPort ? (config.httpsHost ?? avadoNetworkAddress()) : null;
if (config.httpsPort && !httpsHost) logger.warn("HTTPS: no AVADO network address found; the page works over http");
const secure = httpsHost ? serveHttps(app, { port: config.httpsPort, host: httpsHost, logger }) : null;

logger.info(
  `AVADO Tailscale page ${config.version} started (offers ${config.routes.join(",") || "no routes"}${config.extraArgs.length ? `, ${config.extraArgs.filter((a) => !a.startsWith("--login-server")).join(" ")}` : ""})` +
    (config.authKey ? "; an auth key was entered at install" : ""),
);

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  secure?.stop();
  ts.stop();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

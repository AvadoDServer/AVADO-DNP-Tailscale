import http from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { createLogger, errorMessage } from "./log.js";
import { createRelay } from "./relay.js";
import { Tailscale } from "./tailscale.js";

const config = loadConfig();
const logger = createLogger();
process.on("unhandledRejection", (reason) => logger.error(`unhandled rejection: ${errorMessage(reason)}`));

const ts = new Tailscale(config, logger);
ts.startDaemon();
// An auth key in the app's settings logs the box in by itself, once (the identity is then kept)
void ts.autoLogin();

const page = http.createServer(createApp(config, logger, ts));
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

logger.info(
  `AVADO Tailscale ${config.version} started (userspace networking, offers ${config.avadoSubnet}; ZeroTier and the box's DNS are not touched)` +
    (config.authKey ? "; an auth key is set in the settings" : ""),
);

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  void ts.stopDaemon().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

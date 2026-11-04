import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createApp, publicStatus } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import { createRelay, isMcpPath } from "../src/relay.js";
import { Tailscale, commands, type TailscaleDeps } from "../src/tailscale.js";

const config = { ...loadConfig({ PACKAGE_VERSION: "0.1.0", STATE_DIR: "/tmp/avado-ts-test" }), publicDir: "public" };
const servers: http.Server[] = [];
after(() => servers.forEach((s) => s.close()));

const RUNNING = {
  BackendState: "Running",
  Version: "1.104.4",
  AuthURL: "",
  Self: { DNSName: "avado.tail1234.ts.net.", TailscaleIPs: ["100.101.102.103", "fd7a::1"], PrimaryRoutes: ["172.33.0.0/16"] },
  CurrentTailnet: { Name: "owner@example.com" },
};
const SERVE_ON = { Web: { "avado.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8100" } } } }, AllowFunnel: {} };
const FUNNEL_ON = { ...SERVE_ON, AllowFunnel: { "avado.tail1234.ts.net:443": true } };

function fake(state: { status: unknown; serve: unknown; prefs?: unknown }) {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  const deps: TailscaleDeps = {
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "status") return { stdout: JSON.stringify(state.status), stderr: "" };
      if (args[0] === "serve" && args[1] === "status") return { stdout: JSON.stringify(state.serve), stderr: "" };
      if (args[0] === "debug") return { stdout: JSON.stringify(state.prefs ?? { AdvertiseRoutes: ["172.33.0.0/16"] }), stderr: "" };
      return { stdout: "", stderr: "" };
    },
    spawnUp: (args) => {
      spawned.push(args);
      return { kill() {} };
    },
  };
  return { ts: new Tailscale(config, silentLogger, deps), calls, spawned };
}

test("tailscaled settings never touch the box's DNS or take routes, and offer only the AVADO network", () => {
  const up = commands(config).up(true);
  assert.ok(up.includes("--accept-dns=false"));
  assert.ok(up.includes("--accept-routes=false"));
  assert.ok(up.includes("--advertise-routes=172.33.0.0/16"));
  assert.ok(up.includes("--hostname=avado"));
  assert.ok(commands(config).up(false).includes("--advertise-routes="));
  assert.ok(!up.some((a) => a.includes("exit-node")));
});

test("Serve and Funnel only ever point at the local AI Connect relay on port 443", () => {
  const c = commands(config);
  assert.deepEqual(c.serveOn, ["serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:8100"]);
  assert.deepEqual(c.funnelOn, ["funnel", "--bg", "--yes", "--https=443", "http://127.0.0.1:8100"]);
});

test("status when logged in: name, address, approved route, AI Connect shared and on the internet", async () => {
  const { ts } = fake({ status: RUNNING, serve: FUNNEL_ON });
  const s = await ts.status(true);
  assert.equal(s.state, "running");
  assert.equal(s.dnsName, "avado.tail1234.ts.net");
  assert.equal(s.routeApproved, true);
  assert.equal(s.routeOffered, true);
  assert.equal(s.mcpShared, true);
  assert.equal(s.funnel, true);
  assert.equal(s.mcpUrl, "https://avado.tail1234.ts.net/mcp");
  assert.equal(s.publicMcpUrl, "https://avado.tail1234.ts.net/mcp");
  assert.equal(s.authUrl, null);
});

test("status before login shows the login link; other apps never get it", async () => {
  const { ts } = fake({ status: { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc123" }, serve: {} });
  const s = await ts.status(true);
  assert.equal(s.state, "needs-login");
  assert.equal(s.authUrl, "https://login.tailscale.com/a/abc123");
  const pub = publicStatus(s);
  assert.equal(JSON.stringify(pub).includes("login.tailscale.com"), false);
  assert.equal("ips" in pub, false);
});

test("login starts `tailscale up` in the background (it returns only once logged in)", async () => {
  const { ts, spawned } = fake({ status: { BackendState: "NeedsLogin" }, serve: {} });
  await ts.login(true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]![0], "up");
  assert.equal((await ts.status(true)).state, "logging-in");
});

test("switching Funnel off keeps AI Connect in the tailnet; switching sharing off ends Funnel too", async () => {
  const a = fake({ status: RUNNING, serve: FUNNEL_ON });
  await a.ts.setFunnel(false);
  assert.deepEqual(a.calls.map((c) => c.join(" ")), ["funnel --https=443 off", "serve --bg --yes --https=443 http://127.0.0.1:8100"]);
  const b = fake({ status: RUNNING, serve: FUNNEL_ON });
  await b.ts.shareMcp(false);
  assert.deepEqual(b.calls.map((c) => c.join(" ")), ["funnel --https=443 off", "serve --https=443 off"]);
});

test("a Serve command that asks to enable HTTPS shows the link on the page", async () => {
  const ts = new Tailscale(config, silentLogger, {
    exec: async (args) => {
      if (args[0] === "serve" && args[1] !== "status") throw Object.assign(new Error("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc"), {});
      return { stdout: JSON.stringify(args[0] === "status" ? RUNNING : {}), stderr: "" };
    },
    spawnUp: () => ({ kill() {} }),
  });
  await assert.rejects(ts.shareMcp(true));
  const s = await ts.status(true);
  assert.match(s.notice ?? "", /https:\/\/login\.tailscale\.com\/f\/serve\?node=abc/);
});

test("the relay passes only the MCP paths on to AI Connect", async () => {
  assert.ok(isMcpPath("/mcp"));
  assert.ok(isMcpPath("/k/avado_abcDEF-123_x/mcp"));
  for (const p of ["/", "/api/state", "/api/tokens", "/index.html", "/k/x/mcp/../../api/state", "/mcpx", "/admin"]) assert.equal(isMcpPath(p), false, p);

  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  servers.push(upstream);
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const relay = http.createServer(createRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, silentLogger));
  servers.push(relay);
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

  const ok = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer avado_x" }, body: "{}" });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${base}/api/state`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.deepEqual(seen, ["POST /mcp Bearer avado_x"]);
});

test("the page API: Funnel cannot be switched on without the confirmation, and needs the page's header", async () => {
  const { ts, calls } = fake({ status: RUNNING, serve: SERVE_ON });
  const server = http.createServer(createApp(config, silentLogger, ts));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = { "Content-Type": "application/json", "X-Avado-Request": "1" };

  assert.equal((await fetch(`${base}/api/funnel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"on":true}' })).status, 403);
  assert.equal((await fetch(`${base}/api/funnel`, { method: "POST", headers: h, body: '{"on":true}' })).status, 400);
  assert.ok(!calls.some((c) => c[0] === "funnel"));
  assert.equal((await fetch(`${base}/api/funnel`, { method: "POST", headers: h, body: JSON.stringify({ on: true, confirm: "share on the internet" }) })).status, 200);
  assert.ok(calls.some((c) => c.join(" ") === "funnel --bg --yes --https=443 http://127.0.0.1:8100"));

  // other apps (no page header) get the short status
  const pub = (await (await fetch(`${base}/api/status`)).json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(pub).sort(), ["dnsName", "funnel", "mcpShared", "mcpUrl", "publicMcpUrl", "state"]);
});

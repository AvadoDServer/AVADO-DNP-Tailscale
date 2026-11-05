import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createApp, publicStatus } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import { createRelay, isMcpPath, isSignInPath } from "../src/relay.js";
import { redact } from "../src/redact.js";
import { Tailscale, commands, dnsSetting, isLoginLink, type TailscaleDeps } from "../src/tailscale.js";

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

test("a login from the page uses the same settings as containerboot: AVADO network, exit node, no tailnet DNS, no routes taken", () => {
  const up = commands(config).up({});
  assert.ok(up.includes("--reset"));
  assert.ok(up.includes("--accept-dns=false"));
  assert.ok(up.includes("--accept-routes=false"));
  assert.ok(up.includes("--advertise-routes=172.33.0.0/16"));
  assert.ok(up.includes("--hostname=avado"));
  // DAppNode's default TS_EXTRA_ARGS
  assert.ok(up.includes("--advertise-exit-node"));
  assert.ok(!up.some((a) => a.includes("auth-key") || a.includes("login-server")));
  // the key goes to tailscale in a file, never on the command line
  assert.ok(commands(config).up({ authKeyFile: "/data/.authkey-x" }).includes("--auth-key=file:/data/.authkey-x"));
  // an own login server (Headscale) comes from TS_EXTRA_ARGS, as with containerboot
  const own = loadConfig({ PACKAGE_VERSION: "0", TS_EXTRA_ARGS: "--advertise-exit-node --login-server=http://172.17.0.1:18080" });
  assert.equal(own.loginServer, "http://172.17.0.1:18080");
  assert.ok(commands(own).up({}).includes("--login-server=http://172.17.0.1:18080"));
  assert.equal(loadConfig({ PACKAGE_VERSION: "0", TS_EXTRA_ARGS: "--login-server http://hs:8080" }).loginServer, "http://hs:8080");
  // the owner can empty TS_ROUTES / TS_EXTRA_ARGS in the Admin
  const none = loadConfig({ PACKAGE_VERSION: "0", TS_ROUTES: "", TS_EXTRA_ARGS: "" });
  assert.deepEqual(none.routes, []);
  assert.ok(commands(none).up({}).includes("--advertise-routes="));
  assert.ok(!commands(none).up({}).includes("--advertise-exit-node"));
  assert.throws(() => loadConfig({ PACKAGE_VERSION: "0", TS_ROUTES: "my network" }), /TS_ROUTES/);
  // AI Connect is found by its container name (Docker's DNS), not by mcp.my.ava.do
  assert.equal(config.mcpUpstream, "http://DAppNodePackage-mcp.avado.dnp.dappnode.eth:8000");
});

test("auth key settings: optional, a typo never stops the app, the default network and DNS are AVADO's", () => {
  assert.equal(config.authKey, null);
  assert.equal(config.avadoSubnet, "172.33.0.0/16");
  assert.equal(config.dnsServer, "172.33.1.2");
  const good = loadConfig({ TS_AUTHKEY: " tskey-auth-kAbC123CNTRL-xyzXYZ0123456789 ", PACKAGE_VERSION: "0" });
  assert.equal(good.authKey, "tskey-auth-kAbC123CNTRL-xyzXYZ0123456789");
  assert.equal(good.authKeyInvalid, false);
  const bad = loadConfig({ TS_AUTHKEY: "my key please", PACKAGE_VERSION: "0" });
  assert.equal(bad.authKey, null);
  assert.equal(bad.authKeyInvalid, true);
  const ts = new Tailscale({ ...config, ...bad, publicDir: "public" }, silentLogger, { exec: async () => ({ stdout: "{}", stderr: "" }), spawnUp: () => ({ kill() {} }) });
  return ts.status(true).then((s) => assert.match(s.notice ?? "", /does not look like a Tailscale key/));
});

test("only a real Tailscale login link (or one on the own login server) reaches the page", () => {
  assert.ok(isLoginLink("https://login.tailscale.com/a/1a2b3c4d", null));
  for (const bad of ["http://login.tailscale.com/a/1a2b", "https://login.tailscale.com/f/serve?x", "https://evil.example/a/1", "https://login.tailscale.com.evil.example/a/1", "https://u:p@login.tailscale.com/a/1", "https://login.tailscale.com/a/"])
    assert.equal(isLoginLink(bad, null), false, bad);
  assert.ok(isLoginLink("http://172.17.0.1:18080/register/abc", "http://172.17.0.1:18080"));
  assert.equal(isLoginLink("https://login.tailscale.com/a/1a2b", "http://172.17.0.1:18080"), false);
});

test("auth keys and login links are hidden in logs", () => {
  const out = redact("up --auth-key=tskey-auth-kAbC123CNTRL-secret0123 failed; visit https://login.tailscale.com/a/abc123 or http://hs:8080/register/mkeyAbc");
  assert.equal(out.includes("tskey-auth-kAbC123"), false);
  assert.equal(out.includes("/a/abc123"), false);
  assert.equal(out.includes("mkeyAbc"), false);
});

test("login with an auth key: the key is handed over in a private file that is deleted afterwards", async () => {
  mkdirSync(config.stateDir, { recursive: true });
  const seen: string[][] = [];
  let fileContent = "";
  const ts = new Tailscale(config, silentLogger, {
    exec: async (args) => {
      seen.push(args);
      const k = args.find((a) => a.startsWith("--auth-key=file:"));
      if (k) {
        const f = k.slice("--auth-key=file:".length);
        fileContent = readFileSync(f, "utf8");
        assert.equal(statSync(f).mode & 0o077, 0, "key file readable by others");
      }
      return { stdout: JSON.stringify(args[0] === "status" ? RUNNING : {}), stderr: "" };
    },
    spawnUp: () => ({ kill() {} }),
  });
  await ts.loginWithKey("tskey-auth-kAbC123CNTRL-secret0123", "page");
  assert.equal(fileContent, "tskey-auth-kAbC123CNTRL-secret0123");
  assert.ok(!seen.flat().some((a) => a.includes("secret0123")), "key on a command line");
  assert.ok(seen.some((a) => a[0] === "up" && a.includes("--advertise-routes=172.33.0.0/16")));
  assert.deepEqual(readdirSync(config.stateDir).filter((f) => f.startsWith(".authkey")), []);
});

test("a rejected auth key leaves a plain message and the browser login still works", async () => {
  mkdirSync(config.stateDir, { recursive: true });
  const ts = new Tailscale(config, silentLogger, {
    exec: async (args) => {
      if (args[0] === "up") throw new Error("backend error: invalid key: API key tskey-auth-kAbC123CNTRL-secret0123 not valid");
      return { stdout: JSON.stringify(args[0] === "status" ? { BackendState: "NeedsLogin" } : {}), stderr: "" };
    },
    spawnUp: () => ({ kill() {} }),
  });
  await assert.rejects(ts.loginWithKey("tskey-auth-kAbC123CNTRL-secret0123", "settings"));
  const s = await ts.status(true);
  assert.match(s.notice ?? "", /entered when installing was not accepted.*not valid/);
  assert.equal((s.notice ?? "").includes("secret0123"), false);
  assert.deepEqual(readdirSync(config.stateDir).filter((f) => f.startsWith(".authkey")), []);
});

test("the key in the settings is used only while the box is not logged in (auth once)", async () => {
  const withKey = { ...config, authKey: "tskey-auth-kAbC123CNTRL-secret0123" };
  for (const [backend, expectUp] of [
    ["NeedsLogin", true],
    ["Running", false],
    // tailscaled says NoState for a moment while it loads the saved identity after a restart:
    // that is not "logged out", the key must not be used again
    ["NoState", false],
  ] as const) {
    const ups: string[][] = [];
    const ts = new Tailscale(withKey, silentLogger, {
      exec: async (args) => {
        if (args[0] === "up") ups.push(args);
        return { stdout: JSON.stringify(args[0] === "status" ? { ...RUNNING, BackendState: backend } : {}), stderr: "" };
      },
      spawnUp: () => ({ kill() {} }),
    });
    await ts.autoLogin(1000);
    assert.equal(ups.length, expectUp ? 1 : 0, backend);
  }
});

test("status: a second AVADO serving the same network, exit node, login expiry, device approval", async () => {
  const clash = {
    ...RUNNING,
    Self: { ...RUNNING.Self, PrimaryRoutes: [], KeyExpiry: "2027-05-03T10:00:00Z", ExitNodeOption: true },
    Peer: { a: { HostName: "avado", DNSName: "avado-1.tail1234.ts.net.", PrimaryRoutes: ["172.33.0.0/16"] }, b: { HostName: "phone", PrimaryRoutes: null } },
  };
  const { ts } = fake({ status: clash, serve: {}, prefs: { AdvertiseRoutes: ["172.33.0.0/16", "0.0.0.0/0", "::/0"] } });
  const s = await ts.status(true);
  assert.equal(s.routeApproved, false);
  assert.equal(s.routeClash, "avado-1");
  assert.equal(s.exitNodeOffered, true);
  assert.equal(s.exitNodeApproved, true);
  assert.equal(s.keyExpiry, "2027-05-03T10:00:00Z");
  const ok = await fake({ status: RUNNING, serve: {} }).ts.status(true);
  assert.equal(ok.routeClash, null);
  assert.equal(ok.exitNodeOffered, false);
  assert.equal(ok.keyExpiry, null);
  assert.equal((await fake({ status: { BackendState: "NeedsMachineAuth" }, serve: {} }).ts.status(true)).state, "needs-approval");
});

test("status: the DNS step is done when the box's DNS is a nameserver (Override on, or only for my.ava.do)", async () => {
  assert.equal(dnsSetting({ DNS: { Resolvers: [{ Addr: "172.33.1.2" }] } }, "172.33.1.2"), "global");
  assert.equal(dnsSetting({ DNS: { Resolvers: [{ Addr: "1.1.1.1" }], Routes: { "my.ava.do": [{ Addr: "172.33.1.2" }] } } }, "172.33.1.2"), "split");
  assert.equal(dnsSetting({ DNS: { FallbackResolvers: [{ Addr: "172.33.1.2:53" }] } }, "172.33.1.2"), "not-override");
  assert.equal(dnsSetting({ DNS: null }, "172.33.1.2"), "none");
  assert.equal(dnsSetting({}, "172.33.1.2"), "none");

  const netmap = { DNS: { Resolvers: [{ Addr: "172.33.1.2" }] } };
  const peers = { ...RUNNING, Peer: { a: { HostName: "phone", Online: true }, b: { HostName: "laptop", Online: false } } };
  const ts = new Tailscale(config, silentLogger, {
    exec: async (args) => ({ stdout: JSON.stringify(args[0] === "status" ? peers : args[0] === "debug" && args[1] === "netmap" ? netmap : {}), stderr: "" }),
    spawnUp: () => ({ kill() {} }),
  });
  const st = await ts.status(true);
  assert.equal(st.dns, "global");
  assert.equal(st.peersOnline, 1);
  // a netmap that cannot be read: unknown, not "not done"
  const broken = new Tailscale(config, silentLogger, {
    exec: async (args) => {
      if (args[0] === "debug" && args[1] === "netmap") throw new Error("no");
      return { stdout: JSON.stringify(args[0] === "status" ? RUNNING : {}), stderr: "" };
    },
    spawnUp: () => ({ kill() {} }),
  });
  assert.equal((await broken.status(true)).dns, null);
});

test("while containerboot starts tailscaled the page says starting, and after 2 minutes without an answer that it is not running", async () => {
  let now = 1_800_000_000_000;
  const ts = new Tailscale(
    config,
    silentLogger,
    {
      exec: async () => {
        throw new Error("failed to connect to local tailscaled");
      },
      spawnUp: () => ({ kill() {} }),
    },
    () => now,
  );
  assert.equal((await ts.status(true)).state, "starting");
  now += 119_000;
  assert.equal((await ts.status(true)).state, "starting");
  now += 2_000;
  assert.equal((await ts.status(true)).state, "error");
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
  await ts.login();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]![0], "up");
  assert.ok(spawned[0]!.includes("--advertise-routes=172.33.0.0/16"));
  assert.ok(spawned[0]!.includes("--advertise-exit-node"));
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

test("switching AI Connect sharing off when nothing is shared is fine; an own login server explains why HTTPS sharing cannot work", async () => {
  const exec = async (args: string[]) => {
    if (args[0] === "serve" && args[2] === "off") throw new Error("error: failed to remove web serve: handler does not exist");
    if (args[0] === "funnel" && args.includes("off")) throw new Error("error: failed to remove web serve: handler does not exist");
    if (args[0] === "serve" && args[1] !== "status") throw new Error("error enabling https feature: error 404 Not Found: 404 page not found:");
    return { stdout: JSON.stringify(args[0] === "status" ? RUNNING : {}), stderr: "" };
  };
  const ts = new Tailscale(config, silentLogger, { exec, spawnUp: () => ({ kill() {} }) });
  await ts.shareMcp(false);
  assert.equal((await ts.status(true)).notice, null);

  const own = new Tailscale({ ...config, loginServer: "http://headscale.example:8080" }, silentLogger, { exec, spawnUp: () => ({ kill() {} }) });
  await assert.rejects(own.shareMcp(true), /needs Tailscale's own servers/);
  assert.match((await own.status(true)).notice ?? "", /mcp\.my\.ava\.do:8000\/mcp/);
});

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

/** A stand-in for AI Connect's agent port (or for another app that took over its address). */
async function fakeUpstream(identity: unknown) {
  const seen: string[] = [];
  const port = await listen((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
    if (req.url === "/identity") {
      res.writeHead(identity === null ? 404 : 200, { "Content-Type": "application/json" });
      res.end(typeof identity === "string" ? identity : JSON.stringify(identity));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  return { port, seen };
}

test("the relay passes only the MCP paths on to AI Connect, after AI Connect said who it is", async () => {
  assert.ok(isMcpPath("/mcp"));
  assert.ok(isMcpPath("/k/avado_abcDEF-123_x/mcp"));
  for (const p of ["/", "/api/state", "/api/tokens", "/index.html", "/k/x/mcp/../../api/state", "/mcpx", "/admin", "/identity"]) assert.equal(isMcpPath(p), false, p);

  const up = await fakeUpstream({ name: "mcp.avado.dnp.dappnode.eth", version: "0.1.0" });
  const names: string[] = [];
  const relayPort = await listen(
    createRelay(`http://DAppNodePackage-mcp.avado.dnp.dappnode.eth:${up.port}`, silentLogger, {
      lookup: async (n) => (names.push(n), "127.0.0.1"),
    }),
  );
  const base = `http://127.0.0.1:${relayPort}`;

  const ok = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer avado_x" }, body: "{}" });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${base}/api/state`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 404);
  // the identity question carries no key; only then the request (with the key) goes through
  assert.deepEqual(up.seen, ["GET /identity ", "POST /mcp Bearer avado_x"]);
  assert.deepEqual(names, ["dappnodepackage-mcp.avado.dnp.dappnode.eth"]); // DNS names do not care about case
});

test("the relay passes AI Connect's sign-in (Connect button) on, with its query and the box's Tailscale name", async () => {
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/oauth/authorize", "/oauth/token", "/oauth/register", "/oauth/wait", "/oauth/wait/status", "/oauth/connect.js"]) {
    assert.ok(isSignInPath(p), p);
  }
  for (const p of ["/oauth", "/oauth/", "/oauth/../api/state", "/.well-known/", "/.well-known/security.txt", "/api/connect/x", "/oauth/x"]) assert.equal(isSignInPath(p), false, p);

  const seen: Array<{ url: string; xfh: string | undefined; host: string | undefined }> = [];
  const port = await listen((req, res) => {
    if (req.url === "/identity") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "mcp.avado.dnp.dappnode.eth", version: "0.2.0" }));
      return;
    }
    seen.push({ url: req.url ?? "", xfh: req.headers["x-forwarded-host"] as string | undefined, host: req.headers.host });
    res.writeHead(303, { Location: "/oauth/wait?r=abc" });
    res.end();
  });
  const relayPort = await listen(createRelay(`http://127.0.0.1:${port}`, silentLogger));
  const send = (path: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: relayPort, path, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
  // Serve keeps the Host it answered for; a made-up X-Forwarded-Host from outside is replaced
  assert.equal(await send("/oauth/authorize?client_id=a&state=s", { Host: "avado.tail1234.ts.net", "X-Forwarded-Host": "evil.example" }), 303);
  assert.deepEqual(seen[0], { url: "/oauth/authorize?client_id=a&state=s", xfh: "avado.tail1234.ts.net", host: `127.0.0.1:${port}` });
  // MCP paths keep dropping the query
  assert.equal(await send("/mcp?x=1", { Host: "avado.tail1234.ts.net" }), 303);
  assert.equal(seen[1]!.url, "/mcp");
  // the AI Connect page and its API stay out of reach
  assert.equal(await send("/api/connect/00000000-0000-4000-8000-000000000000", { Host: "avado.tail1234.ts.net" }), 404);
  assert.equal(seen.length, 2);
});

test("the relay never sends an assistant's key to another app at AI Connect's old address", async () => {
  for (const identity of [{ name: "skaz-starknet-test" }, null, "<html>not json</html>", { version: "0.1.0" }]) {
    const other = await fakeUpstream(identity);
    const relayPort = await listen(createRelay(`http://127.0.0.1:${other.port}`, silentLogger));
    const r = await fetch(`http://127.0.0.1:${relayPort}/mcp`, { method: "POST", headers: { Authorization: "Bearer avado_secret" }, body: "{}" });
    assert.equal(r.status, 502, JSON.stringify(identity));
    assert.match(((await r.json()) as { error: { message: string } }).error.message, /AI Connect is not installed/);
    assert.deepEqual(other.seen, ["GET /identity "], JSON.stringify(identity));
  }
  // AI Connect removed: its container name does not resolve any more
  const relayPort = await listen(
    createRelay("http://DAppNodePackage-mcp.avado.dnp.dappnode.eth:8000", silentLogger, {
      lookup: async () => Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })),
    }),
  );
  const r = await fetch(`http://127.0.0.1:${relayPort}/k/avado_secret/mcp`, { method: "POST", body: "{}" });
  assert.equal(r.status, 502);
  assert.match(((await r.json()) as { error: { message: string } }).error.message, /AI Connect is not installed/);
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

test("the page API: an auth key must look like one; the page gets the DNS address for the guide", async () => {
  mkdirSync(config.stateDir, { recursive: true });
  const { ts, calls } = fake({ status: { BackendState: "NeedsLogin" }, serve: {} });
  const server = http.createServer(createApp(config, silentLogger, ts));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = { "Content-Type": "application/json", "X-Avado-Request": "1" };
  assert.equal((await fetch(`${base}/api/login`, { method: "POST", headers: h, body: JSON.stringify({ authKey: "nope; rm -rf /" }) })).status, 400);
  assert.ok(!calls.some((c) => c[0] === "up"));
  assert.equal((await fetch(`${base}/api/login`, { method: "POST", headers: h, body: JSON.stringify({ authKey: "tskey-auth-kAbC123CNTRL-secret0123" }) })).status, 200);
  assert.ok(calls.some((c) => c[0] === "up" && c.some((a) => a.startsWith("--auth-key=file:"))));
  const full = (await (await fetch(`${base}/api/status`, { headers: { "X-Avado-Request": "1" } })).json()) as Record<string, unknown>;
  assert.equal(full.dnsServer, "172.33.1.2");
  assert.equal(full.subnet, "172.33.0.0/16");
  assert.equal(full.authKeyInSettings, false);
});

test("an auth key file left by an interrupted login is removed at start", () => {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(`${config.stateDir}/.authkey-deadbeef0001`, "tskey-auth-kLEFTOVER-0123456789abcdef", { mode: 0o600 });
  writeFileSync(`${config.stateDir}/keep-me`, "x");
  const { ts } = fake({ status: RUNNING, serve: {} });
  ts.removeLeftoverKeys();
  assert.deepEqual(readdirSync(config.stateDir).filter((f) => f.startsWith(".authkey")), []);
  assert.ok(readdirSync(config.stateDir).includes("keep-me"));
});

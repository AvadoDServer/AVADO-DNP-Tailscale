// https.ts: the page also answers on https with the box's *.my.ava.do certificate, and stays http
// only (never crashes) without a usable one. The pairs below are self-signed test pairs made for
// these tests (valid until 2126); they protect nothing.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { test } from "node:test";
import { avadoNetworkAddress, CertWatcher, checkPair, serveHttps, type FetchLike } from "../src/https.js";
import { silentLogger, type Logger } from "../src/log.js";

const GOOD_CRT = `-----BEGIN CERTIFICATE-----
MIIBejCCASCgAwIBAgIUAi8JlEFN6pZYIUF9hQ3XjCv8sDkwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLKi5teS5hdmEuZG8wIBcNMjYxMTA1MTI1MzQ5WhgPMjEyNjEw
MTIxMjUzNDlaMBYxFDASBgNVBAMMCyoubXkuYXZhLmRvMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEYXPTaSMTySWECRGi0YqT4xqaASeR7ZTnEkP6CA8ypPAew5I6
Ta0oegvRGi3UD0a96Zth6fh1hw/akd43lWuhg6NKMEgwHQYDVR0OBBYEFHNkouNY
fiXN75qJ3pQgVsQ2eDiLMA8GA1UdEwEB/wQFMAMBAf8wFgYDVR0RBA8wDYILKi5t
eS5hdmEuZG8wCgYIKoZIzj0EAwIDSAAwRQIgJmesUpGWeI8GPYxz6AaN6hwAqtL/
C7mOWQWkrx3lfacCIQDMfpqRBttWI94HVRdCX2AHUusaZB5QbXFPV1O13KumOA==
-----END CERTIFICATE-----
`;
const GOOD_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrvH0Mmvgd9HsvSix
Cw5EGK+8GIPsZolheWD4O9gAVn6hRANCAARhc9NpIxPJJYQJEaLRipPjGpoBJ5Ht
lOcSQ/oIDzKk8B7DkjpNrSh6C9EaLdQPRr3pm2Hp+HWHD9qR3jeVa6GD
-----END PRIVATE KEY-----
`;
const OTHER_CRT = `-----BEGIN CERTIFICATE-----
MIIBfzCCASagAwIBAgIUXmJBqNfJn9y9HtrSBJFXE7tQ3h4wCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNKi5leGFtcGxlLmNvbTAgFw0yNjExMDUxMjUzNDlaGA8yMTI2
MTAxMjEyNTM0OVowGDEWMBQGA1UEAwwNKi5leGFtcGxlLmNvbTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABFh11s1NvVaoNK+lQRP111LXxsHvrHVxV1xNUVwBuGWU
tj1pVUTYa30RSrzZiEKl6Yk8o7GQyrJHzT1XzO4ehB2jTDBKMB0GA1UdDgQWBBRZ
Pkxotav9b2xh7LUn7XnULbYA0zAPBgNVHRMBAf8EBTADAQH/MBgGA1UdEQQRMA+C
DSouZXhhbXBsZS5jb20wCgYIKoZIzj0EAwIDRwAwRAIgYlO6QQ43mEnVYEAWMr/p
Z/ucYiA7YAh/CCCMMCzyQAoCIFzekMD8DVmcjtmR8Zb+iN7baUm4QizkgXc8w9hu
ufDR
-----END CERTIFICATE-----
`;
const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQglKCizmOFbrR3akAU
EL3VbklpifuXrL1bQwtLVE9kV4ehRANCAARYddbNTb1WqDSvpUET9ddS18bB76x1
cVdcTVFcAbhllLY9aVVE2Gt9EUq82YhCpemJPKOxkMqyR809V8zuHoQd
-----END PRIVATE KEY-----
`;

const DAPPMANAGER = "http://dappmanager.my.ava.do";

/** Stands in for http://dappmanager.my.ava.do; a missing url is "connection refused". */
function fakeFetch() {
  const files: Record<string, string> = {};
  const fn: FetchLike = async (url) => {
    if (!(url in files)) throw new Error("connection refused");
    return { ok: true, status: 200, text: async () => files[url]! };
  };
  const serve = (cert: string, key: string, base = DAPPMANAGER) => {
    files[`${base}/my.ava.do.crt`] = cert;
    files[`${base}/my.ava.do.key`] = key;
  };
  return { fn, serve, files };
}

function lines(): Logger & { all: string[] } {
  const all: string[] = [];
  return { all, info: (m) => all.push(m), warn: (m) => all.push(m), error: (m) => all.push(m) };
}

function get(port: number, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get({ host: "127.0.0.1", port, path, servername: "tailscale.my.ava.do", ca: GOOD_CRT, headers: { host: "tailscale.my.ava.do" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

async function until(fn: () => unknown): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

const hello: http.RequestListener = (_req, res) => res.end("same page");

test("checkPair: good pair, chain file, wrong name, wrong key, dates, garbage", () => {
  assert.match(checkPair(GOOD_CRT, GOOD_KEY), /2126/);
  assert.match(checkPair(GOOD_CRT + OTHER_CRT, GOOD_KEY), /2126/);
  assert.throws(() => checkPair(OTHER_CRT, OTHER_KEY), /not for \*\.my\.ava\.do/);
  assert.throws(() => checkPair(GOOD_CRT, OTHER_KEY), /key does not belong/);
  const end = Date.parse("Oct 12 12:53:49 2126 GMT");
  assert.throws(() => checkPair(GOOD_CRT, GOOD_KEY, end - 30 * 60 * 1000), /ends/);
  checkPair(GOOD_CRT, GOOD_KEY, end - 2 * 60 * 60 * 1000);
  assert.throws(() => checkPair(GOOD_CRT, GOOD_KEY, 0), /valid only from/);
  assert.throws(() => checkPair("", ""), /no certificate/);
  assert.throws(() => checkPair(GOOD_CRT, "nope"));
});

test("watcher: waits while the DAPPMANAGER is down (says so once), then uses it once; bad copy keeps the old", async () => {
  const f = fakeFetch();
  const log = lines();
  let changes = 0;
  const w = new CertWatcher(() => (changes++, true), log, f.fn);
  assert.equal(await w.refresh(), false);
  assert.equal(await w.refresh(), false);
  assert.equal(log.all.length, 1);
  f.serve(GOOD_CRT, GOOD_KEY);
  assert.equal(await w.refresh(), true);
  assert.equal(await w.refresh(), true);
  assert.equal(changes, 1);
  f.serve(GOOD_CRT, OTHER_KEY);
  assert.equal(await w.refresh(), false);
  assert.equal(w.key, GOOD_KEY);
  const iso = fakeFetch();
  iso.serve(GOOD_CRT, GOOD_KEY, "http://iso.ava.do");
  assert.equal(await new CertWatcher(() => true, silentLogger, iso.fn).refresh(), true);
});

test("the AVADO network address, never loopback or the Tailscale address", () => {
  const v4 = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });
  assert.equal(avadoNetworkAddress({ lo: [v4("127.0.0.1", true)], tailscale0: [v4("100.101.102.103")], eth0: [v4("172.33.0.9")] }), "172.33.0.9");
  assert.equal(avadoNetworkAddress({ eth0: [v4("100.64.0.1")] }), null);
  assert.equal(avadoNetworkAddress({ lo: [v4("127.0.0.1", true)] }), null);
});

test("serves the page handler over https, swaps a renewed copy, no listener without one, port in use is no crash", async () => {
  const f = fakeFetch();
  f.serve(GOOD_CRT, GOOD_KEY);
  const port = await freePort();
  const w = serveHttps(hello, { port, host: "127.0.0.1", logger: silentLogger, fetchImpl: f.fn });
  await until(() => w.server);
  assert.deepEqual(await get(port), { status: 200, body: "same page" });
  f.serve(`${GOOD_CRT}\n`, GOOD_KEY);
  assert.equal(await w.refresh(), true);
  assert.deepEqual(await get(port), { status: 200, body: "same page" });
  w.stop();

  const none = await freePort();
  const n = serveHttps(hello, { port: none, host: "127.0.0.1", logger: silentLogger, fetchImpl: fakeFetch().fn });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(n.server, null);
  await assert.rejects(get(none), /ECONNREFUSED/);
  n.stop();

  const busy = net.createServer();
  await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
  const log = lines();
  const b = serveHttps(hello, { port: (busy.address() as AddressInfo).port, host: "127.0.0.1", logger: log, fetchImpl: f.fn });
  await until(() => log.all.some((l) => l.includes("cannot open port")));
  assert.equal(b.server, null);
  b.stop();
  busy.close();
});

# AVADO Tailscale

`tailscale.avado.dnp.dappnode.eth`: free private remote access to the **whole AVADO** with the owner's
own Tailscale account (no AVADO servers, no running cost). Once set up, `http://my.ava.do` and every
app (`http://<app>.my.ava.do`) open on the owner's phone or laptop wherever they are, just like at
home. A plain-language page at http://tailscale.my.ava.do logs the box in and walks the owner through
the few one-time steps in the Tailscale admin console.

It works like DAppNode's Tailscale package (see "What comes from DAppNode" below), adapted to AVADO:
the AVADO network `172.33.0.0/16` is offered as a subnet route by default, and the owner adds the box's
DNS `172.33.1.2` for `my.ava.do` in Tailscale.

## Signing in

Two ways, both on the page:

1. **Login link** (default): press *Add my AVADO to Tailscale*, open the link (or scan the QR code) and
   log in. Only a real `https://login.tailscale.com/a/...` link is ever shown (or, with an own login
   server, a link on that server); other apps reading `/api/status` get a short form without it, and
   it is hidden in the logs.
2. **Auth key**: paste a key from Tailscale → Settings → Keys on the page (the simple way: the key is
   used once and not kept), *or* put it in the app's settings in the Admin (`TS_AUTHKEY`; Advanced
   mode → the app → Settings → Environment variables → *Update environment variables*, which
   restarts the app; the current Admin installer does not show environment values). A key in the
   settings stays readable for anyone with Admin access, like every app setting. A key from the settings is used only while
   the box is not logged in yet (like DAppNode's `TS_AUTH_ONCE=true`); after that the identity is kept
   in the `tailscale` volume and restarts or updates never use the key again. The key goes to
   `tailscale up` in a private file that is deleted right after (never on a command line) and is
   hidden in this app's logs. A rejected or mistyped key never stops the app: the page says so in
   plain words and the login link still works (DAppNode needs the key cleared and a restart for that).

Advanced, not shown in the Admin: `TS_LOGIN_SERVER` (an own control server such as Headscale) and
`TS_HOSTNAME` (default `avado`).

## What the page offers once logged in

| Switch | Default | Command | Effect |
|---|---|---|---|
| Admin and apps | **on** | `tailscale up --advertise-routes=172.33.0.0/16` at login, `tailscale set --advertise-routes=... --advertise-exit-node=...` | offers the AVADO network; the page shows the steps and whether the route is approved |
| AI Connect for my Tailscale devices | off | `tailscale serve --bg --yes --https=443 http://127.0.0.1:8100` | `https://avado.<name>.ts.net/mcp`, real certificate |
| AI Connect on the internet | off | `tailscale funnel --bg --yes --https=443 http://127.0.0.1:8100` | same address, public; plain warning and a confirmation |
| Exit node | off | `tailscale set --advertise-exit-node=true` (keeps the route) | the owner's devices may send their internet traffic through the home connection; plain warning |

The step-by-step guide on the page (plain words, links straight to the right console pages):

1. **Machines** → the AVADO → ⋯ → *Edit route settings* → tick `172.33.0.0/16` (status shown: done / not yet).
2. **DNS** → *Add nameserver* → *Custom* → `172.33.1.2`, *Restrict to domain* `my.ava.do` (split DNS).
3. **Machines** → the AVADO → ⋯ → *Disable key expiry* (otherwise Tailscale logs the box out after
   a few months; the page shows the date).
4. Install Tailscale on the phone or laptop, same account, switch it on (Linux: `tailscale set --accept-routes`).
5. Open `http://my.ava.do`.

**Who can reach the box:** every device in the owner's Tailscale account (Tailscale's default
access rule lets all of them reach approved routes), the same as a device on the home network; the
page says so and asks the owner to add only their own devices and not share the AVADO in Tailscale.

**Two AVADOs in one account** offer the same network and only one can be used at a time (DAppNode
documents the same). The page warns when another device already serves `172.33.0.0/16` and names it.
The box itself never takes routes from others (`--accept-routes=false`), so a second AVADO can never
pull its own network away.

`127.0.0.1:8100` is a relay in this package that passes only `/mcp` and `/k/<key>/mcp` to AI
Connect's agent-only port (`http://mcp.my.ava.do:8000`). Everything else answers 404, so Funnel never
exposes the Admin, other apps or AI Connect's key page. With the AVADO network approved, the owner's
own devices can also reach AI Connect directly at `http://mcp.my.ava.do:8000/mcp`.

## How it runs (userspace subnet router, no privileges)

- Official `tailscale` / `tailscaled` binaries (v1.104.4), copied from `tailscale/tailscale` pinned by
  digest, on the same `node:22.23.2-bookworm-slim` base as AVADO Care and AI Connect.
- `tailscaled --tun=userspace-networking`: **no** privileged mode, no `/dev/net/tun`, no `NET_ADMIN`,
  no routes, no iptables on the box, runs as the `node` user. Subnet routing and the exit node still
  work: tailscaled's own network stack answers traffic for `172.33.0.0/16` and opens ordinary
  connections from this container (apps see the Tailscale container as the sender).
- Why not kernel mode like DAppNode (`/dev/net/tun` + `NET_ADMIN`)? The AVADO DAPPMANAGER's compose
  generator has no `devices`, so kernel mode would need `privileged: true` (like `remoteconnect`).
  The userspace router reached the Admin, WAMP (WebSocket), apps, the IPFS gateway and DNS (UDP) in
  the box test, so there is no reason to give the package more rights. Userspace mode is slower than
  kernel mode for bulk traffic, which does not matter for the Admin and app pages.
- `--accept-dns=false --accept-routes=false`: the container keeps the box's DNS (bind) and takes no
  routes. ZeroTier Remote Access (`remoteconnect`), bind and the box's routing are not touched
  (checked on the test box: host routes, rules and iptables unchanged by the package).
- State in the `tailscale` volume (`/data/tailscale`). No host ports.
- What the owner's Tailscale devices can reach (box test with Headscale): with the route approved,
  everything on `172.33.0.0/16`, including the box itself at `172.33.0.1` (its SSH port answers,
  as it does on the home network and over ZeroTier). Even with the route switched off, userspace
  mode hands connections to the box's own Tailscale address (`100.x.y.z`) to this container's
  local ports: the Tailscale page (port 80) and the AI Connect relay (port 8100, `/mcp` only, an AI
  Connect key is still needed). The box's LAN and other ports of the box are not reachable that
  way. All of this is limited to the owner's Tailscale devices.

## What comes from DAppNode

Studied, not copied: `dappnode/DAppNodePackage-tailscale` has **no licence file**, so it is used as a
reference only and nothing was taken over verbatim. Ideas adapted, in our own code:

- advertise the node's internal network by default (`TS_ROUTES=172.33.0.0/16,...` there; AVADO has
  no `10.20.0.0/24` VPN network, so only `172.33.0.0/16` here);
- optional auth key or browser login; key used only while logged out (`TS_AUTH_ONCE=true`), identity
  in a state volume;
- show only a genuine `https://login.tailscale.com/a/...` login link (their status reporter's rule);
- the user guide from docs.dappnode.io (Access your Dappnode → VPN → Tailscale): approve the subnet
  route in Machines, add the node's DNS as nameserver restricted to its domain (their "Advanced DNS
  configuration", the default here), install the app on the devices, and the "two Dappnodes"
  caveat. AVADO has no setup wizard, so the auth key is an environment value plus a field on the
  page, and the guide lives on the page.

Not taken over: kernel mode (see above), the exit node on by default (DAppNode passes
`--advertise-exit-node`; here it is an opt-in switch), and the reporter container (the page reads
tailscaled directly).

## Build and test

```
cd build/service && yarn install --frozen-lockfile && yarn lint && yarn test   # Node 22
docker buildx build --platform linux/amd64 --load -f build/Dockerfile -t tailscale.avado.dnp.dappnode.eth:0.1.0 .
```

End to end without a Tailscale account: run Headscale (an open-source Tailscale control server) next
to the box, install the package with `TS_LOGIN_SERVER=http://<headscale>` and a Headscale pre-auth key
as `TS_AUTHKEY`, run a second tailscaled as the "phone" in another Docker network with
`--accept-routes --accept-dns`, approve the route with `headscale nodes approve-routes`, and set split
DNS `my.ava.do → 172.33.1.2` in Headscale's config. Serve/Funnel (AI Connect over HTTPS) need real
Tailscale: Headscale has no HTTPS certificates.

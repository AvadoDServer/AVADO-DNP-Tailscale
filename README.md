# AVADO Tailscale

`tailscale.avado.dnp.dappnode.eth`: free private remote access to an AVADO with the owner's own
Tailscale account (no AVADO servers, no running cost). A plain-language page at
http://tailscale.my.ava.do logs the box in (link + QR code), shows its tailnet name and address,
and has switches for the AVADO Admin route, AI Connect in the tailnet, and (off by default)
AI Connect on the internet via Funnel.

## How it runs

- Official `tailscale` / `tailscaled` binaries (v1.104.4), copied from `tailscale/tailscale`
  pinned by digest, on the same `node:22.23.2-bookworm-slim` base as AVADO Care and AI Connect.
- `tailscaled --tun=userspace-networking`: **no** privileged mode, no `/dev/net/tun`, no routes,
  no iptables on the box, runs as the `node` user. ZeroTier Remote Access (`remoteconnect`,
  privileged, 10.10.10.0/24 inside its own container) and the box's DNS (bind) are not touched.
- `tailscale up --accept-dns=false --accept-routes=false`: the container keeps the box's DNS and
  takes no routes from the tailnet (nothing in the tailnet can clash with 172.33.0.0/16).
- State in the `tailscale` volume (`/data/tailscale`).
- No host ports. Direct connections use NAT traversal; otherwise Tailscale's relays.

## What the switches do

| Switch | Command | Effect |
|---|---|---|
| Add my AVADO | `tailscale up --reset --hostname=avado ...` (background) | login link + QR on the page |
| Admin and apps | `tailscale set --advertise-routes=172.33.0.0/16` | offers the AVADO network; the owner approves it once in the Tailscale console and adds DNS `172.33.1.2` for `my.ava.do` (steps on the page) |
| AI Connect in my tailnet | `tailscale serve --bg --yes --https=443 http://127.0.0.1:8100` | `https://avado.<tailnet>.ts.net/mcp`, owner's devices only, real certificate |
| AI Connect on the internet | `tailscale funnel --bg --yes --https=443 http://127.0.0.1:8100` | same address, public; off by default; the page explains the risk and asks to confirm |

`127.0.0.1:8100` is a relay in this package that passes only `/mcp` and `/k/<key>/mcp` to AI
Connect's agent-only port (`http://mcp.my.ava.do:8000`). Everything else answers 404, so Funnel
never exposes the Admin, other apps, or AI Connect's key page. The login link is shown only on this
page: other apps reading `/api/status` get a short form without it, and it is hidden in the logs.

## Build and test

```
cd build/service && yarn install --frozen-lockfile && yarn lint && yarn test   # Node 22
docker buildx build --platform linux/amd64 --load -f build/Dockerfile -t tailscale.avado.dnp.dappnode.eth:0.1.0 .
```

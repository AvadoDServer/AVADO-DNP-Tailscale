# AVADO Tailscale package image.
#
# Build context is the repository root (docker-compose.yml: context ".",
# dockerfile "build/Dockerfile"), so the image can read the package version
# from dappnode_package.json. See /.dockerignore for what is sent.
#
# containerboot, tailscale and tailscaled are the official static binaries,
# copied from the official image pinned by digest. They run on the same node:22
# base as the AI Connect package (shared layers on the box). Node 22.23.4 (security
# release of 2026-10-20), checked 2026-11-04; AVADO Care still pins 22.23.2.

# Base images, pinned by digest (the multi-arch index digest). The tag is only
# a label; the digest decides. Update tag and digest together: get the digest
# with `docker buildx imagetools inspect <image>:<tag>` (the "Digest:" line).
ARG TAILSCALE_IMAGE=tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c
ARG NODE_IMAGE=node:22.23.4-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd
ARG NODE_SLIM_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM --platform=linux/amd64 ${TAILSCALE_IMAGE} AS tailscale

########## Service: install, type-check, test, build
FROM --platform=linux/amd64 ${NODE_IMAGE} AS service
WORKDIR /usr/src/service
COPY build/service/package.json build/service/yarn.lock ./
RUN yarn install --frozen-lockfile
COPY build/service/ ./
# A failing check or test fails the image build.
RUN yarn lint && yarn test
RUN yarn build \
    && yarn install --frozen-lockfile --production --ignore-scripts --prefer-offline \
    && mkdir -p /out \
    && cp -a package.json dist public node_modules /out/

########## Runtime
# Kernel mode, set up like DAppNode's Tailscale package: Tailscale's containerboot runs tailscaled
# with /dev/net/tun (mounted by the manifest) and NET_ADMIN. The iptables tools are for
# TS_DEBUG_FIREWALL_MODE=auto (tailscaled may pick iptables or nftables); all of it happens inside
# this container's own network, never on the box.
FROM --platform=linux/amd64 ${NODE_SLIM_IMAGE}

COPY --from=tailscale /usr/local/bin/containerboot /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates iptables \
    && rm -rf /var/lib/apt/lists/* \
    && command -v setpriv
COPY --from=service /out /usr/src/service
COPY build/start.sh /usr/local/bin/avado-tailscale-start

COPY dappnode_package.json /tmp/dappnode_package.json
RUN node -e 'const v = require("/tmp/dappnode_package.json").version; \
        if (!/^[0-9A-Za-z.+-]+$/.test(v || "")) { console.error("bad package version"); process.exit(1); } \
        require("fs").writeFileSync("/usr/src/service/package-version", v + "\n");' \
    && rm /tmp/dappnode_package.json \
    && test -f /usr/src/service/dist/server.js \
    && test -f /usr/src/service/public/index.html \
    && tailscale version \
    && test -x /usr/local/bin/containerboot && test -x /usr/local/bin/avado-tailscale-start

# containerboot settings, as in DAppNode's package. TS_AUTHKEY, TS_ROUTES, TS_EXTRA_ARGS and
# TS_DEBUG_FIREWALL_MODE are also in the manifest, so the Admin shows them.
ENV TS_STATE_DIR=/data/tailscale \
    TS_SOCKET=/var/run/tailscale/tailscaled.sock \
    TS_USERSPACE=false \
    TS_AUTH_ONCE=true \
    TS_BOOT_TIMEOUT=1h \
    TS_DEBUG_FIREWALL_MODE=auto \
    TS_HOSTNAME=avado \
    TS_ROUTES=172.33.0.0/16 \
    TS_EXTRA_ARGS=--advertise-exit-node \
    NODE_OPTIONS=--max-old-space-size=96 \
    NODE_ENV=production \
    STATE_DIR=/data \
    PUBLIC_DIR=/usr/src/service/public \
    PORT=80
WORKDIR /usr/src/service
EXPOSE 80
CMD ["/usr/local/bin/avado-tailscale-start"]

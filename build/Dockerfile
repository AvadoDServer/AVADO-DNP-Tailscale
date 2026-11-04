# AVADO Tailscale package image.
#
# Build context is the repository root (docker-compose.yml: context ".",
# dockerfile "build/Dockerfile"), so the image can read the package version
# from dappnode_package.json. See /.dockerignore for what is sent.
#
# tailscale and tailscaled are the official static binaries, copied from the
# official image pinned by digest. They run on the same node:22 base as the
# AVADO Care and AI Connect packages (shared layers on the box).

# Base images, pinned by digest (the multi-arch index digest). The tag is only
# a label; the digest decides. Update tag and digest together: get the digest
# with `docker buildx imagetools inspect <image>:<tag>` (the "Digest:" line).
ARG TAILSCALE_IMAGE=tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c
ARG NODE_IMAGE=node:22.23.2-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844
ARG NODE_SLIM_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

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

########## Port 80 without root (same as AVADO Care)
FROM --platform=linux/amd64 ${NODE_SLIM_IMAGE} AS caps
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && setcap cap_net_bind_service=+ep /usr/local/bin/node \
    && getcap /usr/local/bin/node | grep -q cap_net_bind_service

########## Runtime
FROM --platform=linux/amd64 ${NODE_SLIM_IMAGE}

COPY --from=caps /usr/local/bin/node /usr/local/bin/node
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/
# tailscaled checks certificates of Tailscale's servers with the system roots
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=service /out /usr/src/service

COPY dappnode_package.json /tmp/dappnode_package.json
RUN node -e 'const v = require("/tmp/dappnode_package.json").version; \
        if (!/^[0-9A-Za-z.+-]+$/.test(v || "")) { console.error("bad package version"); process.exit(1); } \
        require("fs").writeFileSync("/usr/src/service/package-version", v + "\n");' \
    && rm /tmp/dappnode_package.json \
    && test -f /usr/src/service/dist/server.js \
    && test -f /usr/src/service/public/index.html \
    && tailscale version \
    && mkdir -p /data && chown node:node /data

# No root and no privileges: tailscaled runs with userspace networking (no
# /dev/net/tun, no routes or firewall rules on the box); node may bind port 80.
USER node
ENV NODE_OPTIONS=--max-old-space-size=96 \
    NODE_ENV=production \
    STATE_DIR=/data \
    PUBLIC_DIR=/usr/src/service/public \
    PORT=80
WORKDIR /usr/src/service
EXPOSE 80
CMD ["node", "dist/server.js"]

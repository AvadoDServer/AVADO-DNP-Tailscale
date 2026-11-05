#!/bin/bash
# Starts the two parts of the AVADO Tailscale app (README, "How it works"):
#  - containerboot, Tailscale's own start program for containers, set up as in DAppNode's package:
#    tailscaled in kernel mode with TS_ROUTES, TS_EXTRA_ARGS, TS_AUTH_ONCE and its state in the
#    volume. It does not get the auth key: the page logs in with TS_AUTHKEY itself (in a file, never
#    on a command line), so the login link keeps working when a key is rejected.
#  - the page (node), without any Linux capability except binding port 80, and no way to get one.
# containerboot stops (after stopping tailscaled) when a login fails or nobody logs in within
# TS_BOOT_TIMEOUT; it is started again here, so the page and its message stay. If the page stops,
# everything stops and Docker starts the app again.
set -u
mkdir -p "${TS_STATE_DIR:-/data/tailscale}" "$(dirname "${TS_SOCKET:-/var/run/tailscale/tailscaled.sock}")"

boot_loop() {
  local cb=""
  trap '[ -n "$cb" ] && kill -TERM "$cb" 2>/dev/null; wait; exit 0' TERM INT
  while true; do
    env -u TS_AUTHKEY -u TS_AUTH_KEY containerboot &
    cb=$!
    wait "$cb"
    echo "containerboot stopped (exit $?); starting it again in 5 seconds" >&2
    cb=""
    sleep 5 &
    wait $!
  done
}

boot_loop &
boot=$!
setpriv --no-new-privs --inh-caps=-all --bounding-set=-all,+net_bind_service node /usr/src/service/dist/server.js &
page=$!

stop() {
  kill -TERM "$page" "$boot" 2>/dev/null
  wait
  exit 0
}
trap stop TERM INT

wait -n "$boot" "$page"
code=$?
kill -TERM "$page" "$boot" 2>/dev/null
wait
exit "$code"

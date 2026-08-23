#!/usr/bin/env bash
# Run Traveler on this machine and expose it to the tailnet over HTTPS.
#
# HTTPS rather than a plain LAN address on purpose: geolocation is a secure-context
# API, so "use my position" and the whole Nearby page fail silently over http://.
# Tailscale terminates TLS with a real certificate, which makes them work on a phone.
#
# The server itself stays on loopback. Only Tailscale can reach it.
set -euo pipefail

PORT="${PORT:-3000}"
TS_PORT="${TS_PORT:-8443}"
cd "$(dirname "$0")"

bun run build

cleanup() {
  echo
  echo "Removing the tailnet proxy on :${TS_PORT}"
  tailscale serve --https="${TS_PORT}" off || true
}
trap cleanup EXIT INT TERM

# --https on its own port so any existing `tailscale serve` mapping on / is untouched.
tailscale serve --bg --https="${TS_PORT}" --yes "http://127.0.0.1:${PORT}"

echo
echo "  https://$(tailscale status --json | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//'):${TS_PORT}"
echo
echo "  Tailnet only. Ctrl-C stops the server and removes the proxy."
echo

cd packages/server
NODE_ENV=production HOST=127.0.0.1 PORT="${PORT}" bun src/index.ts

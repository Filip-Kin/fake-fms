#!/usr/bin/env bash
# Start Fake FMS locally and make it reachable at http://10.0.100.5 (the address FTA-Buddy and
# audience-display expect), with no field network. Works on Linux and macOS.
#
# What it does: adds 10.0.100.5 as a loopback alias on your machine (needs sudo, one prompt), then
# builds and starts the container with docker compose. The alias is not persistent across reboots,
# so just re-run this after a restart.
set -euo pipefail
cd "$(dirname "$0")/.."

IP=10.0.100.5

ensure_alias() {
	case "$(uname -s)" in
		Darwin)
			if ifconfig lo0 | grep -q "inet $IP"; then return; fi
			echo ">> Adding loopback alias $IP (sudo)..."
			sudo ifconfig lo0 alias "$IP"
			;;
		Linux)
			if ip addr show lo | grep -q "inet $IP"; then return; fi
			echo ">> Adding loopback alias $IP (sudo)..."
			sudo ip addr add "$IP/32" dev lo
			;;
		*)
			echo "Unsupported OS: $(uname -s). Add $IP to your loopback manually, then run docker compose -f docker-compose.dev.yml up -d --build" >&2
			exit 1
			;;
	esac
}

ensure_alias

echo ">> Building + starting the container..."
docker compose -f docker-compose.dev.yml up -d --build

echo
echo "Fake FMS is up:"
echo "  FMS API + SignalR :  http://10.0.100.5"
echo "  Control console   :  http://10.0.100.5:3010"
echo
echo "Point FTA-Buddy / audience-display at 10.0.100.5 as usual. Stop it with ./scripts/dev-down.sh"

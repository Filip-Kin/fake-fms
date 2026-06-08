#!/usr/bin/env bash
# Stop Fake FMS and remove the 10.0.100.5 loopback alias. Counterpart to dev-up.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

IP=10.0.100.5

echo ">> Stopping the container..."
docker compose -f docker-compose.dev.yml down

case "$(uname -s)" in
	Darwin)
		if ifconfig lo0 | grep -q "inet $IP"; then
			echo ">> Removing loopback alias $IP (sudo)..."
			sudo ifconfig lo0 -alias "$IP"
		fi
		;;
	Linux)
		if ip addr show lo | grep -q "inet $IP"; then
			echo ">> Removing loopback alias $IP (sudo)..."
			sudo ip addr del "$IP/32" dev lo
		fi
		;;
esac

echo ">> Done."

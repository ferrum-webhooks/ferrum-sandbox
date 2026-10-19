#!/usr/bin/env bash
# Runs once when the Codespace is created: system packages, then the Ferrum repositories.
set -euo pipefail
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends postgresql postgresql-client redis-server jq lsof curl >/dev/null
sudo service postgresql stop >/dev/null 2>&1 || true    # Ferrum starts its own private copy on another port
sudo service redis-server stop >/dev/null 2>&1 || true
make setup

#!/usr/bin/env bash
# Download the three Ferrum repositories into ./workspace and install their dependencies.
#   scripts/fetch.sh                      clone from GitHub (versions.env)
#   FERRUM_LOCAL_SRC=/path/to/folder scripts/fetch.sh      copy from a local folder that holds the three repos instead
set -euo pipefail
cd "$(dirname "$0")/.."
. ./versions.env
WS=workspace
mkdir -p "$WS"

get() {   # get NAME REF
  local name=$1 ref=$2
  [ -d "$WS/$name" ] && { echo "$name: already here"; return; }
  if [ -n "${FERRUM_LOCAL_SRC:-}" ]; then
    mkdir -p "$WS/$name"
    tar -C "$FERRUM_LOCAL_SRC/$name" --exclude=.venv --exclude=.git --exclude=__pycache__ --exclude=.env -cf - . | tar -C "$WS/$name" -xf -
  else
    git clone --quiet --depth 1 --branch "$ref" "https://github.com/$FERRUM_OWNER/$name.git" "$WS/$name"
  fi
  echo "$name: ready"
}
get ferrum-webhook-gateway "$GATEWAY_REF"
get ferrum-webhook-worker  "$WORKER_REF"
get infra                  "$INFRA_REF"

for svc in ferrum-webhook-gateway ferrum-webhook-worker; do
  if [ ! -x "$WS/$svc/.venv/bin/python" ]; then
    echo "$svc: installing Python packages (about a minute)"
    python3 -m venv "$WS/$svc/.venv"
    "$WS/$svc/.venv/bin/pip" install --quiet --disable-pip-version-check -r "$WS/$svc/requirements.txt"
  fi
done
"$WS/ferrum-webhook-worker/.venv/bin/pip" install --quiet --disable-pip-version-check requests   # used by the check script
echo "setup done"

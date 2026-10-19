# Sourced by the other scripts. Finds the PostgreSQL programs (Linux keeps them off PATH) and sets common names.
SB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="$SB/workspace/infra/local/stack.sh"
PY="$SB/workspace/ferrum-webhook-worker/.venv/bin/python"
for d in /usr/lib/postgresql/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
export PATH
export GW="${GW:-http://127.0.0.1:8100}"

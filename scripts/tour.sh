#!/usr/bin/env bash
# Guided tour of Ferrum. Each step starts a small receiver, sends events, and shows what happened.
#   scripts/tour.sh          all steps          scripts/tour.sh 2     one step (1-7)
# Needs the stack running (make up). Steps 3 and 5 restart the worker with different timers, then restore it.
set -uo pipefail
. "$(dirname "$0")/env.sh"
J='content-type: application/json'
RPORT=9100 RLOG=/tmp/ferrum-tour-receiver.log
PW="correct-horse-battery"
RECV=""

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { echo "FAILED: $*" >&2; stop_receiver; exit 1; }

new_user() {   # sets AUTH to a fresh account's header
  local email="tour-$(date +%s)-$RANDOM@example.com"
  curl -fs -XPOST "$GW/register" -H "$J" -d "{\"email\":\"$email\",\"password\":\"$PW\"}" >/dev/null || die "register"
  local t; t=$(curl -fs -XPOST "$GW/login" -H "$J" -d "{\"email\":\"$email\",\"password\":\"$PW\"}" | jq -r .access_token) || die "login"
  AUTH="Authorization: Bearer $t"
}
new_hook() {   # sets SECRET; prints nothing
  local r; r=$(curl -fs -XPOST "$GW/webhooks" -H "$AUTH" -H "$J" -d "{\"url\":\"http://127.0.0.1:$RPORT/hook\",\"event_type\":\"order.created\"}") || die "create webhook"
  SECRET=$(echo "$r" | jq -r .secret)
}
start_receiver() {   # start_receiver [ENV=VALUE ...]
  stop_receiver
  : > "$RLOG"
  env WEBHOOK_SECRET="$SECRET" PORT=$RPORT "$@" "$PY" "$SB/workspace/infra/tests/echo_receiver.py" >"$RLOG" 2>&1 &
  RECV=$!; disown "$RECV" 2>/dev/null
  for _ in $(seq 30); do grep -q "echo receiver" "$RLOG" && break; sleep 0.2; done
}
stop_receiver() { [ -n "$RECV" ] && kill "$RECV" 2>/dev/null; RECV=""; return 0; }
send() {   # send [extra curl args]; prints event id
  curl -fs -XPOST "$GW/events" -H "$AUTH" -H "$J" "$@" -d '{"event_type":"order.created","payload":{"order_id":42}}' | jq -r .event_id
}
show_receiver() { grep -E '^\[' "$RLOG" | sed 's/^/   receiver: /'; }
wait_status() {   # wait_status EVENT_ID STATUS SECONDS
  local end=$((SECONDS + $3)) s
  while [ $SECONDS -lt $end ]; do
    s=$(curl -fs "$GW/deliveries/$1" -H "$AUTH" | jq -r '.[0].status')
    [ "$s" = "$2" ] && return 0; sleep 0.5
  done; return 1
}
restart_worker() { env "$@" "$STACK" restart worker >/dev/null; }
trap stop_receiver EXIT

step1() {
  say "1. Send an event and receive a signed delivery"
  new_user; new_hook; start_receiver
  note "The receiver checks the signature with the webhook's secret."
  EV=$(send); note "sent event $EV"
  wait_status "$EV" success 15 || die "not delivered"
  show_receiver
  note "Ferrum's own record:"; curl -fs "$GW/deliveries/$EV" -H "$AUTH" | jq -c '.[0] | {status, attempts: [.attempts[] | {response_code, latency_ms}]}' | sed 's/^/   /'
}
step2() {
  say "2. The receiver fails twice: watch the retries"
  new_user; new_hook; start_receiver FAIL_FIRST=2
  note "Retries wait 5 s, then 10 s (stored in the database, not in a sleeping worker). Takes about 20 s."
  EV=$(send); wait_status "$EV" success 60 || die "never recovered"
  show_receiver
  note "Same message id every time, so a receiver can ignore repeats."
}
step3() {
  say "3. The receiver stays broken: give up, then replay"
  new_user; new_hook; start_receiver FAIL_FIRST=100
  note "Using 1-second retry timers for this step so it takes about 20 s instead of 75 s."
  restart_worker RETRY_BASE_SECONDS=1
  EV=$(send); wait_status "$EV" dead_letter 60 || die "did not reach dead_letter"
  note "After 5 failed attempts the delivery is parked as dead_letter:"
  curl -fs "$GW/deliveries/$EV" -H "$AUTH" | jq -c '.[0] | {status, attempts: [.attempts[].response_code]}' | sed 's/^/   /'
  note "The receiver is fixed. Replaying:"
  start_receiver
  curl -fs -XPOST "$GW/retry/$EV" -H "$AUTH" | jq -c . | sed 's/^/   /'
  wait_status "$EV" success 30 || die "replay did not deliver"
  note "status is now: $(curl -fs "$GW/deliveries/$EV" -H "$AUTH" | jq -r '.[0].status')"
  restart_worker
}
step4() {
  say "4. Sending the same request three times counts once"
  new_user; new_hook; start_receiver
  local k="order-$RANDOM" codes=""
  for _ in 1 2 3; do codes="$codes $(curl -s -o /dev/null -w '%{http_code}' -XPOST "$GW/events" -H "$AUTH" -H "$J" -H "Idempotency-Key: $k" -d '{"event_type":"order.created","payload":{"order_id":42}}')"; done
  note "status codes:$codes   (202 = accepted, 200 = already seen)"
  note "same key, different body: $(curl -s -o /dev/null -w '%{http_code}' -XPOST "$GW/events" -H "$AUTH" -H "$J" -H "Idempotency-Key: $k" -d '{"event_type":"order.created","payload":{"order_id":99}}')   (422 = refused)"
  sleep 2; stop_receiver
  note "one event, one delivery: the receiver got $(grep -c '^\[' "$RLOG") POST"
}
step5() {
  say "5. Crash the worker in the middle of a delivery"
  new_user; new_hook; start_receiver DELAY=30 DELAY_FIRST=1
  note "The receiver holds the first request for 30 s, so the delivery is 'in flight'. Short recovery timers are used."
  local T=(LEASE_SECONDS=3 RECLAIM_IDLE_MS=4000 RECLAIM_INTERVAL_SECONDS=2)
  restart_worker "${T[@]}"
  EV=$(send); sleep 2
  note "killing the worker with kill -9"; "$STACK" kill9 worker; local t0=$SECONDS
  restart_worker "${T[@]}"
  wait_status "$EV" success 40 || die "was not recovered"
  note "a new worker finished it $((SECONDS - t0)) s after the crash. The receiver saw two attempts: the abandoned one and the recovered one:"
  show_receiver
  restart_worker
}
step6() {
  say "6. Webhook URLs pointing at private addresses are refused"
  env ALLOW_PRIVATE_WEBHOOK_TARGETS=false "$STACK" restart gateway >/dev/null
  new_user
  for u in http://169.254.169.254/ http://127.0.0.1:6379/ http://10.0.0.5/ http://localhost/; do
    printf '   %-28s %s\n' "$u" "$(curl -s -XPOST "$GW/webhooks" -H "$AUTH" -H "$J" -d "$(jq -nc --arg u "$u" '{url:$u,event_type:"x"}')" | jq -c .detail)"
  done
  "$STACK" restart gateway >/dev/null
}
step7() {
  say "7. Rate limit"
  env RATE_LIMIT_CAPACITY=5 RATE_LIMIT_REFILL_PER_SEC=1 "$STACK" restart gateway >/dev/null
  new_user
  local codes=""; for _ in $(seq 8); do codes="$codes $(curl -s -o /dev/null -w '%{http_code}' "$GW/webhooks" -H "$AUTH")"; done
  note "8 quick requests:$codes   (429 = slow down)"
  "$STACK" restart gateway >/dev/null
}

curl -fs "$GW/readyz" >/dev/null || { echo "The stack is not running. Start it with: make up" >&2; exit 1; }
case "${1:-all}" in
  all) for s in 1 2 3 4 5 6 7; do step$s; done ;;
  [1-7]) step$1 ;;
  *) echo "usage: $0 [1-7|all]" >&2; exit 2 ;;
esac
stop_receiver
say "Done."

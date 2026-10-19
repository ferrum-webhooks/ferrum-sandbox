// Run with: node site/engine.test.js
const assert = require("assert");
const { Ferrum, sign, verify, checkUrl } = require("./engine.js");

function seeded(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
const make = () => new Ferrum({ rng: seeded(7) });
const run = async (f, secs) => { await f.advance(secs); };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a healthy receiver gets the event once, signed correctly", async () => {
  const f = make(); const r = f.send();
  assert.strictEqual(r.status, 202);
  await run(f, 3);
  assert.strictEqual(f.deliveries[0].status, "success");
  assert.strictEqual(f.receiver.log.length, 1);
  assert.ok(f.receiver.log[0].sigOk);
  assert.strictEqual(f.events[0].status, "delivered");
});

test("signatures verify with the right secret and fail with another", async () => {
  const f = make();
  const h = { "webhook-id": "evt_1", "webhook-timestamp": "100", "webhook-signature": await sign(f.secret, "evt_1", 100, "{}") };
  assert.ok(await verify(f.secret, h, "{}"));
  assert.ok(!(await verify(f.wrongSecret, h, "{}")));
  assert.ok(!(await verify(f.secret, h, "{ }")));
});

test("fail twice then succeed: retries wait about 5 s then 10 s, same message id", async () => {
  const f = make(); f.setReceiver({ mode: "failFirst", failFirst: 2 }); f.send();
  await run(f, 40);
  const d = f.deliveries[0];
  assert.strictEqual(d.status, "success");
  assert.deepStrictEqual(d.attempts.map((a) => a.code), [500, 500, 200]);
  const ts = f.receiver.log.map((l) => l.t);
  assert.ok(ts[1] - ts[0] > 3.5 && ts[1] - ts[0] < 8, `gap1 ${ts[1] - ts[0]}`);
  assert.ok(ts[2] - ts[1] > 7 && ts[2] - ts[1] < 14, `gap2 ${ts[2] - ts[1]}`);
  assert.ok(new Set(f.receiver.log.map((l) => l.event)).size === 1);
});

test("a receiver that never works ends as dead_letter after 5 attempts; replay delivers it", async () => {
  const f = make(); f.setReceiver({ mode: "down" }); const { eventId } = f.send();
  await run(f, 200);
  assert.strictEqual(f.deliveries[0].status, "dead_letter");
  assert.strictEqual(f.deliveries[0].attempts.length, 5);
  assert.strictEqual(f.events[0].status, "failed");
  f.setReceiver({ mode: "ok" });
  assert.strictEqual(f.replay(eventId), 1);
  await run(f, 5);
  assert.strictEqual(f.deliveries[0].status, "success");
  assert.strictEqual(f.events[0].status, "delivered");
});

test("wrong signing secret at the receiver is rejected (401) and retried", async () => {
  const f = make(); f.setReceiver({ wrongSecret: true }); f.send();
  await run(f, 8);
  assert.strictEqual(f.deliveries[0].attempts[0].code, 401);
  assert.strictEqual(f.receiver.log[0].sigOk, false);
});

test("killing the worker mid-delivery: recovered by a new worker after the reclaim delay, receiver sees two attempts", async () => {
  const f = make(); f.setReceiver({ mode: "slow" }); f.send();
  await run(f, 1);
  assert.strictEqual(f.deliveries[0].status, "in_flight");
  f.killWorker(); f.setReceiver({ mode: "ok" });
  await run(f, 60);
  assert.strictEqual(f.deliveries[0].status, "in_flight", "nobody is working, the lease is still held");
  f.startWorker();
  await run(f, 60);
  assert.strictEqual(f.deliveries[0].status, "success");
  assert.strictEqual(f.receiver.log.length, 2);
  assert.ok(f.receiver.log[1].t - f.receiver.log[0].t >= 90);
});

test("the same idempotency key counts once; a different body is refused", async () => {
  const f = make();
  assert.strictEqual(f.send({ key: "k" }).status, 202);
  assert.strictEqual(f.send({ key: "k" }).status, 200);
  assert.strictEqual(f.send({ key: "k", payload: { order_id: 99 } }).status, 422);
  assert.strictEqual(f.events.length, 1);
});

test("the rate limiter answers 429 after a burst and recovers", async () => {
  const f = make(); const codes = [];
  for (let i = 0; i < 14; i++) codes.push(f.send().status);
  assert.deepStrictEqual(codes.slice(0, 10), Array(10).fill(202));
  assert.ok(codes.slice(10).every((c) => c === 429));
  await run(f, 3);
  assert.strictEqual(f.send().status, 202);
});

test("private addresses are refused", () => {
  for (const u of ["http://169.254.169.254/", "http://127.0.0.1:6379/", "http://10.0.0.5/", "http://localhost/", "http://192.168.1.1/", "http://[::1]/", "ftp://example.com/"])
    assert.ok(!checkUrl(u).ok, u);
  for (const u of ["https://example.com/hook", "http://8.8.8.8/x"]) assert.ok(checkUrl(u).ok, u);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("PASS", name); } catch (e) { failed++; console.log("FAIL", name, "\n   ", e.message); }
  }
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();

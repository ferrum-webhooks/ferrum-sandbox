// A small model of Ferrum's delivery pipeline that runs in the browser (and in node, for tests).
// It mirrors the worker's rules: transactional outbox -> relay -> stream -> worker with a lease,
// retries with exponential backoff and jitter, dead letter after 5 attempts, replay, idempotency keys,
// a token-bucket rate limit, and Standard Webhooks signatures (real HMAC-SHA256 via WebCrypto).
// It is a model for learning, not the real service: no network, database or Redis is involved.
(function (root) {
  "use strict";

  const DEFAULTS = {
    maxAttempts: 5, retryBase: 5, retryMax: 3600, jitter: 0.2,
    lease: 60, reclaimIdle: 90, reclaimInterval: 15,
    relayInterval: 0.2, schedulerInterval: 1, readTimeout: 5,
    rateCapacity: 10, rateRefill: 2, step: 0.05,
  };

  // ---- Standard Webhooks signing -------------------------------------------------------------
  const enc = new TextEncoder();
  const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function sign(secret, msgId, timestamp, body) {
    const key = await crypto.subtle.importKey("raw", unb64(secret.replace(/^whsec_/, "")),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${msgId}.${timestamp}.${body}`));
    return "v1," + b64(mac);
  }
  async function verify(secret, headers, body) {
    const want = await sign(secret, headers["webhook-id"], headers["webhook-timestamp"], body);
    return headers["webhook-signature"].split(" ").includes(want);
  }
  function makeSecret(rng) {
    const bytes = Array.from({ length: 24 }, () => Math.floor(rng() * 256));
    return "whsec_" + b64(new Uint8Array(bytes));
  }

  // ---- The private-address check (same rules as the gateway's) --------------------------------
  function checkUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return { ok: false, detail: "not a valid URL" }; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, detail: "only http and https are allowed" };
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
      return { ok: false, detail: "internal hostnames are not allowed" };
    const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])];
      const priv = a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
      if (priv) return { ok: false, detail: "target address is not publicly routable" };
    }
    if (host.includes(":") && (host === "::1" || host === "::" || host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")))
      return { ok: false, detail: "target address is not publicly routable" };
    return { ok: true, detail: "allowed" };
  }

  // ---- The model -----------------------------------------------------------------------------
  class Ferrum {
    constructor(opts = {}) {
      this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
      this.rng = opts.rng || Math.random;
      this.reset();
    }

    reset() {
      this.t = 0;
      this.events = []; this.deliveries = []; this.outbox = []; this.stream = [];
      this.nextId = 1; this.nextDelivery = 1; this.nextEntry = 1;
      this.keys = new Map();
      this.tokens = this.cfg.rateCapacity;
      this.worker = { alive: true, attempts: [] };
      this.receiver = { mode: "ok", failFirst: 2, seen: 0, wrongSecret: false, log: [] };
      this.secret = makeSecret(this.rng);
      this.wrongSecret = makeSecret(this.rng);
      this.log = [];
      this._relayAt = 0; this._schedAt = 0; this._reclaimAt = 0;
      this._note("Ready. One webhook is registered; the worker is running.");
    }

    _note(text, kind = "info") { this.log.push({ t: this.t, kind, text }); if (this.log.length > 400) this.log.shift(); }
    _id() { return "evt_" + Math.floor(this.rng() * 0xffffff).toString(16).padStart(6, "0") + this.nextId.toString(16); }

    // ---- what a client can do (the "API") ----
    send({ key = "", payload = { order_id: 42 } } = {}) {
      const c = this.cfg;
      if (this.tokens < 1) {
        this._note("POST /events -> 429 Too Many Requests (rate limit)", "bad");
        return { status: 429, retryAfter: Math.ceil((1 - this.tokens) / c.rateRefill) };
      }
      this.tokens -= 1;
      const body = JSON.stringify(payload);
      if (key) {
        const seen = this.keys.get(key);
        if (seen && seen.body !== body) { this._note(`POST /events (key ${key}) -> 422, same key with a different body`, "bad"); return { status: 422 }; }
        if (seen) { this._note(`POST /events (key ${key}) -> 200, already accepted as ${seen.eventId}`, "info"); return { status: 200, eventId: seen.eventId, replay: true }; }
      }
      const id = this._id(); this.nextId++;
      const ev = { id, payload: body, status: "pending", createdAt: this.t };
      this.events.push(ev);
      const d = { id: this.nextDelivery++, eventId: id, status: "pending", retries: 0, nextRetryAt: null, lockedUntil: null, attempts: [] };
      this.deliveries.push(d);
      this.outbox.push(d.id);          // saved in the same step as the event
      if (key) this.keys.set(key, { body, eventId: id });
      this._note(`POST /events -> 202 Accepted, ${id} saved with its delivery job`, "ok");
      return { status: 202, eventId: id };
    }

    replay(eventId) {
      let n = 0;
      for (const d of this.deliveries) {
        if (d.eventId === eventId && (d.status === "dead_letter" || d.status === "failed")) {
          Object.assign(d, { status: "pending", retries: 0, nextRetryAt: null, lockedUntil: null });
          this.outbox.push(d.id); n++;
        }
      }
      if (n) this._refreshEvent(eventId);
      this._note(`POST /retry/${eventId} -> replayed ${n} delivery`, n ? "ok" : "info");
      return n;
    }

    killWorker() {
      if (!this.worker.alive) return;
      this.worker.alive = false;
      const lost = this.worker.attempts.length;
      this.worker.attempts = [];
      this._note(lost ? "Worker killed (kill -9) while a delivery was in flight. Nothing was recorded or acknowledged."
        : "Worker stopped.", "bad");
    }
    startWorker() {
      if (this.worker.alive) return;
      this.worker.alive = true; this._reclaimAt = this.t;
      this._note("A new worker started.", "ok");
    }
    setReceiver(patch) { Object.assign(this.receiver, patch); if (patch.mode === "failFirst") this.receiver.seen = 0; }

    // ---- time ----
    async advance(dt) {
      const end = this.t + dt;
      while (this.t < end - 1e-9) {
        this.t = Math.min(this.t + this.cfg.step, end);
        this.tokens = Math.min(this.cfg.rateCapacity, this.tokens + this.cfg.rateRefill * this.cfg.step);
        this._relay(); this._scheduler(); this._reclaim();
        await this._workerLoop();
      }
    }

    _relay() {
      if (this.t < this._relayAt) return;
      this._relayAt = this.t + this.cfg.relayInterval;
      while (this.outbox.length) {
        const did = this.outbox.shift();
        this.stream.push({ id: this.nextEntry++, deliveryId: did, owner: null, claimedAt: null });
      }
    }
    _scheduler() {
      if (this.t < this._schedAt) return;
      this._schedAt = this.t + this.cfg.schedulerInterval;
      for (const d of this.deliveries)
        if (d.status === "retrying" && d.nextRetryAt <= this.t) { d.status = "pending"; this.outbox.push(d.id); }
    }
    _reclaim() {
      if (!this.worker.alive || this.t < this._reclaimAt) return;
      this._reclaimAt = this.t + this.cfg.reclaimInterval;
      for (const e of this.stream)
        if (e.owner && this.t - e.claimedAt >= this.cfg.reclaimIdle) {
          e.owner = null;
          this._note(`A live worker noticed message ${e.id} sat unacknowledged for ${this.cfg.reclaimIdle} s and took it over`, "ok");
        }
    }

    _claim(d) {
      if (d.status === "pending" || (d.status === "in_flight" && d.lockedUntil < this.t)) {
        d.status = "in_flight"; d.lockedUntil = this.t + this.cfg.lease; return "claimed";
      }
      return d.status === "in_flight" ? "busy" : "skipped";
    }

    async _workerLoop() {
      if (!this.worker.alive) return;
      // finish attempts whose time has come
      const due = this.worker.attempts.filter((a) => a.doneAt <= this.t);
      this.worker.attempts = this.worker.attempts.filter((a) => a.doneAt > this.t);
      for (const a of due) this._commit(a);
      // take new messages
      for (const e of this.stream) {
        if (e.owner || !this.worker.alive) continue;
        const d = this.deliveries.find((x) => x.id === e.deliveryId);
        const res = this._claim(d);
        if (res === "skipped") { this.stream = this.stream.filter((x) => x !== e); continue; }
        e.owner = "w"; e.claimedAt = this.t;
        if (res === "busy") continue;           // another worker holds a live lease: do not ack
        await this._attempt(e, d);
      }
    }

    async _attempt(entry, d) {
      const ev = this.events.find((x) => x.id === d.eventId);
      const n = d.retries + 1;
      const body = JSON.stringify({ id: ev.id, type: "order.created", data: JSON.parse(ev.payload) });
      const ts = Math.floor(this.t);
      const headers = { "webhook-id": ev.id, "webhook-timestamp": String(ts), "webhook-signature": await sign(this.secret, ev.id, ts, body) };
      const r = this.receiver;
      r.seen += 1;
      const sigOk = await verify(r.wrongSecret ? this.wrongSecret : this.secret, headers, body);
      let code, latency, error = null;
      if (!sigOk) { code = 401; latency = 0.03; error = "HTTP 401"; }
      else if (r.mode === "down") { code = 500; latency = 0.04; error = "HTTP 500"; }
      else if (r.mode === "failFirst" && r.seen <= r.failFirst) { code = 500; latency = 0.04; error = "HTTP 500"; }
      else if (r.mode === "slow") { code = null; latency = this.cfg.readTimeout; error = "ReadTimeout"; }
      else { code = 200; latency = 0.03 + this.rng() * 0.05; }
      r.log.push({ t: this.t, event: ev.id, attempt: n, sigOk, code, signature: headers["webhook-signature"].slice(0, 22) + "…" });
      this._note(`Attempt ${n} for ${ev.id} sent, signed (webhook-id ${ev.id})`, "info");
      this.worker.attempts.push({ entry, d, n, code, error, doneAt: this.t + latency, latency });
    }

    _commit(a) {
      const { d, n, code, error, latency } = a, c = this.cfg;
      const ok = code !== null && code >= 200 && code < 300;
      d.retries = n; d.lockedUntil = null;
      d.attempts.push({ n, code, ms: Math.round(latency * 1000), error });
      if (ok) { d.status = "success"; d.nextRetryAt = null; this._note(`Attempt ${n} for ${d.eventId}: ${code} -> delivered`, "ok"); }
      else if (n >= c.maxAttempts) { d.status = "dead_letter"; d.nextRetryAt = null; this._note(`Attempt ${n} for ${d.eventId}: ${error} -> giving up, parked as dead_letter`, "bad"); }
      else {
        const base = Math.min(c.retryBase * 2 ** (n - 1), c.retryMax);
        const delay = base * (1 + (this.rng() * 2 - 1) * c.jitter);
        d.status = "retrying"; d.nextRetryAt = this.t + delay;
        this._note(`Attempt ${n} for ${d.eventId}: ${error} -> retry scheduled in ${delay.toFixed(1)} s`, "warn");
      }
      this._refreshEvent(d.eventId);
      this.stream = this.stream.filter((x) => x !== a.entry);   // acknowledge only after recording
    }

    _refreshEvent(eventId) {
      const ev = this.events.find((x) => x.id === eventId);
      const ds = this.deliveries.filter((x) => x.eventId === eventId);
      const open = ds.some((x) => !["success", "dead_letter", "cancelled"].includes(x.status));
      ev.status = open ? "processing" : ds.some((x) => x.status === "dead_letter") ? "failed" : "delivered";
    }
  }

  const api = { Ferrum, sign, verify, checkUrl, DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FerrumModel = api;
})(typeof self !== "undefined" ? self : globalThis);

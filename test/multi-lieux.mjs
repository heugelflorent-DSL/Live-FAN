// Deux lives en parallèle (2 lieux) : chaque chrono (clé de liaison) alimente SON direct bassin, sans fuite vers l'autre
import worker from "../src/worker.js";
import { PoolRoom } from "../src/pool.js";
const kv = new Map();
const KV = { get: async (k, t) => { const v = kv.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } };
const rooms = {};
const room = (n) => rooms[n] || (rooms[n] = (() => { const ctx = { storage: { m: {}, async get(k) { return this.m[k]; }, async put(k, v) { this.m[k] = v; }, async list() { return new Map(); }, async delete() {} }, blockConcurrencyWhile: (f) => f(), getWebSockets: () => [], acceptWebSocket() {} }; return new PoolRoom(ctx, {}); })());
const POOL = { idFromName: (n) => n, get: (n) => ({ fetch: (r) => room(n).fetch(r) }) };
const env = { ADMIN_PASSWORD: "pw", KV, POOL, ASSETS: { fetch: async () => new Response("index") } };
globalThis.caches = { default: { match: async () => null, put: async () => {}, delete: async () => {} } };
const call = (p, m = "GET", body, h = {}) => worker.fetch(new Request("https://x" + p, { method: m, body: body && JSON.stringify(body), headers: { "x-admin-key": "pw", ...h } }), env, { waitUntil: () => {} });
let bad = 0; const ok = (c, msg) => { console.log(c ? "OK " : "KO ", msg); if (!c) bad++; };
const A = (await (await call("/api/admin/events", "POST", { name: "Lieu A" })).json()).id, B = (await (await call("/api/admin/events", "POST", { name: "Lieu B" })).json()).id;
console.log("lives", A, B);
for (const id of [A, B]) await call("/api/config?e=" + id, "PUT", { comps: [], published: true, live: "bassin" });
const KA = "SD-ABCD-EFGH-JKLM-NPQR", KB = "SD-STUV-WXYZ-2345-6789";
console.log((await (await call("/api/admin/pair?e=" + A, "PUT", { token: KA })).json()), (await (await call("/api/admin/pair?e=" + B, "PUT", { token: KB })).json()));
const relay = (key, b) => call("/api/relay/event", "POST", b, { "x-relay-token": key, "x-admin-key": "" });
const rA = await relay(KA, { k: "ready", event: 11, heat: 1, laps: 2, lanes: 6 }), rB = await relay(KB, { k: "ready", event: 99, heat: 7, laps: 4, lanes: 8 });
console.log(rA.status, rB.status);
await relay(KA, [{ k: "start", ts: 1000 }, { k: "finish", lane: 3, lap: 2, t: 61.2, rank: 1 }]);
await relay(KB, [{ k: "start", ts: 5000 }, { k: "split", lane: 5, lap: 1, t: 29.9, rank: 1 }]);
const sA = await (await call("/api/pool/state?e=" + A)).json(), sB = await (await call("/api/pool/state?e=" + B)).json();
console.log("A", JSON.stringify(sA).slice(0, 160)); console.log("B", JSON.stringify(sB).slice(0, 160));
ok(sA.heat && sA.heat.event === 11 && sA.heat.heat === 1, "A : épreuve 11 série 1");
ok(sB.heat && sB.heat.event === 99 && sB.heat.heat === 7, "B : épreuve 99 série 7");
ok(!JSON.stringify(sA).includes("29.9") && !JSON.stringify(sB).includes("61.2"), "aucun temps de A chez B ni de B chez A");
ok(Object.keys(rooms).sort().join() === ["bassin:" + A, "bassin:" + B].sort().join() || Object.keys(rooms).length >= 2, "deux salles distinctes : " + Object.keys(rooms).join(", "));
// mauvaise clé : refusée
const x = await relay("SD-AAAA-AAAA-AAAA-AAAA", { k: "ready", event: 1, heat: 1 }); ok(x.status === 409 || x.status === 401, "clé inconnue refusée (" + x.status + ")");
// déplacer une clé d'un live à l'autre ne mélange pas les salles
await call("/api/admin/pair?e=" + B, "PUT", { token: KA });
await relay(KA, { k: "ready", event: 55, heat: 2 });
const sB2 = await (await call("/api/pool/state?e=" + B)).json(), sA2 = await (await call("/api/pool/state?e=" + A)).json();
ok(sB2.heat.event === 55 && sA2.heat.event === 11, "clé déplacée vers B : B suit, A garde sa série");
console.log(bad ? "ÉCHECS : " + bad : "tout est séparé"); process.exit(bad ? 1 : 0);

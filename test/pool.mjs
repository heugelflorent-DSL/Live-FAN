// Test de la salle « Bassin » avec un faux stockage et de faux WebSockets
import { PoolRoom } from "../src/pool.js";
const sent = []; const ws = { send: (m) => sent.push(m) };
const ctx = { storage: { m: {}, async get(k) { return this.m[k]; }, async put(k, v) { this.m[k] = v; } }, blockConcurrencyWhile: (f) => f(), getWebSockets: () => [ws], acceptWebSocket() {} };
const r = new PoolRoom(ctx, {}); await new Promise((x) => setTimeout(x, 10));
const post = (b) => r.fetch(new Request("https://pool/event", { method: "POST", body: JSON.stringify(b) })).then((x) => x.json());
console.log(await post({ k: "ready", event: 12, heat: 3, laps: 4, lanes: 8 }));
console.log(await post([{ k: "start", ts: 1000 }, { k: "react", lane: 4, t: 0.68 }, { k: "split", lane: 4, lap: 2, t: 31.12, rank: 1 }, { k: "finish", lane: 4, lap: 4, t: 65.85, rank: 1 }, { k: "end" }]));
console.log(await post({ k: "ready", event: 12, heat: 4 }));
const st = JSON.parse(sent.at(-1)); console.log(st.heat.event, st.heat.heat, st.heat.status, "prev:", st.prev.heat, JSON.stringify(st.prev.lanes));
console.log(await post({ k: "bogus" }));

// Compétition avec finales (pages Live FFN réduites dans test/finales, structure réelle de liveffn.com)
import fs from "fs"; import worker from "../src/worker.js";
const F = (n) => fs.readFileSync(new URL(`./finales/${n}`, import.meta.url), "utf8");
const kv = new Map();
const env = { ADMIN_PASSWORD: "pw", KV: { get: async (k, t) => { const v = kv.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => kv.delete(k) }, ASSETS: { fetch: async () => new Response("x") } };
globalThis.caches = { default: { match: async () => null, put: async () => {}, delete: async () => {} } };
let phase = "matin";
globalThis.fetch = async (u) => { const s = String(u);
  const body = s.includes("resultats") ? (s.includes("epreuve=3") ? F(phase === "matin" ? "res-canet-3-matin.html" : "res-canet-3.html") : "<html></html>")
    : s.includes("epr_id=3") && s.includes("typ_id=12") && phase !== "avant" ? F("heats-canet-finB.html") : s.includes("epr_id") ? "<html></html>" : F("prog-canet.html");
  return new Response(new TextEncoder().encode(body)); };
const req = (p, m = "GET", body) => worker.fetch(new Request("https://x" + p, { method: m, body: body && JSON.stringify(body), headers: { "x-admin-key": "pw" } }), env, { waitUntil: () => {} });
await req("/api/config", "PUT", { comps: ["90961"], published: true });
const show = async (lbl) => { const st = await (await req("/api/state")).json(); const c = st.data.comps["90961"];
  console.log("==", lbl); for (const k of Object.keys(c.events).sort()) { const e = c.events[k]; if (!/^3\b|^3-/.test(k)) continue;
    console.log(k.padEnd(13), "départ:", (e.heats || []).flatMap((h) => h.lanes.map((l) => l.lane + " " + l.name)).join(", ") || "—", "| résultats:", (e.results?.rows || []).map((r) => r.place + " " + r.name + (r.qual ? " " + r.qual : "")).join(", ") || "—", e.doneAt ? "✓" : ""); } return c; };
await req("/api/rescrape", "POST", { scope: "all", what: "all" }); for (let i = 0; i < 4; i++) await req("/api/refresh", "POST");
await show("après les séries, finales pas encore publiées");
phase = "soir"; await req("/api/rescrape", "POST", { scope: "all", what: "all" }); for (let i = 0; i < 4; i++) await req("/api/refresh", "POST");
const c = await show("après les finales");
const ok = c.events["3-12-671780"].results.rows[0].name === "MARTIN Lalie" && c.events["3-11-0"].results.rows.length === 2 && c.events["3"].results.rows.length === 7 && c.events["3-12-671780"].heats[0].lanes.length === 2;
console.log("finales OK", ok);

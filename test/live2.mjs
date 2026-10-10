import fs from "fs"; import { createRequire } from "module"; import { parseLive } from "../src/ffn.js";
const require = createRequire(import.meta.url); const { JSDOM } = require("jsdom"); const fx = require("./fixture.cjs");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const live0 = { at: Date.now(), ...parseLive(fs.readFileSync(new URL("./live-fixture.html", import.meta.url), "utf8")) }; const LV = { "93220": { ...live0, cur: { ...live0.cur, title: "200 Nage Libre Messieurs Séries (2/2)", event: "200 Nage Libre Messieurs Séries", heat: 2, of: 2 } }, "93222": { ...live0, cur: { ...live0.cur, title: "100 Papillon Dames Séries (1/1)", event: "100 Papillon Dames Séries", heat: 1, of: 1 }, next: null } };
const today = new Date(); const M = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
const cfg = { ...fx.config, live: "ffn" }; const data = JSON.parse(JSON.stringify(fx.data));
for (const id of cfg.comps) { data.comps[id] = data.comps[id] || {}; data.comps[id].meta = { ...(data.comps[id].meta || {}), date: `Du Vendredi ${Math.max(1,today.getDate()-1)} au Dimanche ${today.getDate()} ${M[today.getMonth()]} ${today.getFullYear()}` }; }
const d = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://x.test/", beforeParse(w) {
  w.scrollTo = () => {}; w.fetch = async (u) => ({ ok: true, status: 200, json: async () => u === "/api/state" ? { published: true, config: cfg, data, now: Date.now() } : String(u).startsWith("/api/live") ? LV[String(u).split("c=")[1]] || live0 : {} }); } });
const w = d.window, q = (s) => w.document.querySelector(s); const errs = []; w.addEventListener("error", (e) => errs.push(e.message));
await new Promise((r) => setTimeout(r, 300));
const b = q("[data-view=live]"); console.log("tab visible", !b.hidden); b.click(); await new Promise((r) => setTimeout(r, 200));
const sp = q("#pub-body [data-sp]"); sp && sp.click(); await new Promise((r) => setTimeout(r, 50));
const t = q("#pub-body").textContent.replace(/\s+/g, " "); console.log(t.slice(0, 700)); console.log("splits table", !!q("#pub-body .sptab"), "errors", errs);
for (const bad of ["undefined", "NaN", "null"]) if (t.includes(bad)) console.log("BAD", bad);
process.exit(0);

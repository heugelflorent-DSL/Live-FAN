import fs from "fs"; import { createRequire } from "module"; import { parseLive } from "../src/ffn.js"; import { PoolRoom } from "../src/pool.js";
const require = createRequire(import.meta.url); const { JSDOM } = require("jsdom"); const fx = require("./fixture.cjs");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const live0 = { at: Date.now(), ...parseLive(fs.readFileSync(new URL("./live-fixture.html", import.meta.url), "utf8")) }; const LV = { "93220": { ...live0, cur: { ...live0.cur, title: "200 Nage Libre Messieurs Séries (2/2)", event: "200 Nage Libre Messieurs Séries", heat: 2, of: 2 } }, "93222": { ...live0, cur: { ...live0.cur, title: "100 Papillon Dames Séries (1/1)", event: "100 Papillon Dames Séries", heat: 1, of: 1 }, next: null } };
const today = new Date(); const M = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
const cfg = { ...fx.config, live: "bassin" }; const data = JSON.parse(JSON.stringify(fx.data));
for (const id of cfg.comps) { data.comps[id] = data.comps[id] || {}; data.comps[id].meta = { ...(data.comps[id].meta || {}), date: `Du Vendredi ${Math.max(1,today.getDate()-1)} au Dimanche ${today.getDate()} ${M[today.getMonth()]} ${today.getFullYear()}` }; }
const d = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://x.test/", beforeParse(w) {
  w.scrollTo = () => {}; w.WebSocket = class { constructor() { this.readyState = 1; setTimeout(() => this.onmessage({ data: JSON.stringify({ type: "state", now: Date.now(), relayAt: Date.now(), heat: { event: 3, heat: 1, status: "running", start: Date.now() - 31000, lanes: { 3: { rt: 0.66, last: 2, laps: { 2: { t: 30.12, rank: 1 } } }, 4: { rt: 0.7, last: 4, laps: { 4: { t: 61.2, rank: 1 } }, fin: { t: 61.2, rank: 1 } } } } }) }), 100); } send() {} close() {} }; w.fetch = async (u) => ({ ok: true, status: 200, json: async () => u === "/api/state" ? { published: true, config: cfg, data, now: Date.now() } : String(u).startsWith("/api/live") ? LV[String(u).split("c=")[1]] || live0 : {} }); } });
const w = d.window, q = (s) => w.document.querySelector(s); const errs = []; w.addEventListener("error", (e) => errs.push(e.message));
await new Promise((r) => setTimeout(r, 300));

const room=new PoolRoom({blockConcurrencyWhile:f=>f(),storage:{get:async()=>null,put:async()=>{}},getWebSockets:()=>[]},{});await new Promise(r=>setTimeout(r,10));
const sent=[];w.eval("simSend=async l=>window.__sent.push(...l)");w.__sent=sent;const timers=[];w.setTimeout=(fn,ms)=>{timers.push([ms,fn]);return timers.length};
w.eval("state.live='bassin'");w.eval("simFill()");const sel=w.document.querySelector("#sim-heat");console.log("options",sel.options.length,sel.options[2]&&sel.options[2].text);sel.value="2";w.eval("simRun()");
timers.sort((a,b)=>a[0]-b[0]);const snaps=[];for(const [ms,fn] of timers){fn();for(const e of sent.splice(0))room.apply(e);snaps.push([ms,JSON.parse(JSON.stringify(room.s))])}
console.log("steps",timers.length,"last",timers.at(-1)[0]/1000+"s");
const show=(st)=>{w.eval("POOL="+JSON.stringify({...st,now:Date.now(),relayAt:Date.now()})+";state.view='live';state.admin=false;render()");return w.document.querySelector("#pub-body").textContent.replace(/\s+/g," ").slice(0,330)};
const h0=snaps[0][1].heat;console.log("A",show(snaps[0][1]));
const mid=snaps.find(x=>x[1].heat&&Object.values(x[1].heat.lanes).some(L=>L.last)&&!Object.values(x[1].heat.lanes).some(L=>L.fin));if(mid){mid[1].heat.start=Date.now()-mid[0]+5000;console.log("B",show(mid[1]))}
console.log("C",show(snaps.at(-1)[1]));
const b = q("[data-view=live]"); console.log("tab visible", !b.hidden); b.click(); await new Promise((r) => setTimeout(r, 200));
const sp = q("#pub-body [data-sp]"); sp && sp.click(); await new Promise((r) => setTimeout(r, 50));
const t = q("#pub-body").textContent.replace(/\s+/g, " "); console.log(t.slice(0, 700)); console.log("splits table", !!q("#pub-body .sptab"), "errors", errs);
for (const bad of ["undefined", "NaN", "null"]) if (t.includes(bad)) console.log("BAD", bad);
process.exit(0);

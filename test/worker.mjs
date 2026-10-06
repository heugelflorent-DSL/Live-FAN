// Test du Worker avec un faux Live FFN et un faux KV
import worker, { cycle } from "../src/worker.js";
const kv = new Map(); let writes = 0;
const env = { ADMIN_PASSWORD: "pw", KV: { get: async (k, t) => { const v = kv.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { writes++; kv.set(k, v); } },
  ASSETS: { fetch: async () => new Response("index") } };
globalThis.caches = { default: { match: async () => null, put: async () => {}, delete: async () => {} } };
const prog = `<div class="lieu"> CERNAY </div> <div class="titre"> Interclubs U13 - 25 m </div> <div class="date"> Le Dimanche 15 Mars 2026 </div>
<h6><a href="#">R&eacute;union N&deg; 1 : Dimanche 15 Mars 2026</a></h6><div><ul class="reunion"><li class="debutEpreuve">Les horaires sont donnés à titre indicatif<br><br>Ouverture des portes : 08h30</li>
<li class="survol"> <span class="time">09h50</span> - <span class="tooltip" onclick=" afficheEpreuve('x','/programme.php?'+'competition=93222&langue=fra','&cat_id='+0+'&epr_id='+'47'+'&typ_id='+60+'&num_epreuve='+0,'c',0);"> 4x50 Nage Libre Dames Séries <b> 1 série / 2 participantes <br/> Cliquez</b></span> </li>
<li class="EventNonSportif">Fin de la réunion</li></ul></div>`;
const heats = `<table class="tableau"><tbody><tr><td colspan="5" class="prgTitre"> 4x50 Nage Libre Dames - Séries - (1/1) </td><td class="prgTime">09h50</td></tr><tr><td colspan="6"></td></tr>
<tr class="survol "><td><img src="ico_plot_4.png"/></td><td>A Gaia</td><td>2013</td><td>FRA</td><td><span class="tooltip">DAUPHINS DE ST-LOUIS<b><nobr>DAUPHINS</nobr></b></span></td><td class="temps">02:10.00</td></tr>
<tr class="survol "><td></td><td>B Anae</td><td>2013</td><td>FRA</td><td></td><td></td></tr>
<tr class="survol "><td><img src="ico_plot_5.png"/></td><td>C Erine</td><td>2013</td><td>FRA</td><td><span class="tooltip">SR COLMAR<b>x</b></span></td><td class="temps">02:12.00</td></tr></tbody></table>`;
const res = `<table class="tableau"><tr><td colspan="11" class="epreuve"> 4x50 Nage Libre Dames - Séries </td></tr><tr><td colspan="10"></td></tr>
<tr class="survol"><td class="place">1.</td><td><a href="x&iuf=1">A Gaia</a></td><td>2013</td><td>FRA</td><td><a href="x&structure=502">DAUPHINS DE ST-LOUIS</a></td><td class="temps"><a href="#" class="tooltip">02:09.72<b><table class="split"><tr><td class="distance">50 m : </td><td class="split">31.58</td><td class="lap">(31.58)</td></tr></table></b></a></td><td class="reaction"></td><td class="tempsRelayeur">(31.58)</td><td class="reaction"></td><td class="points">948 pts</td><td class="qualification"></td><td class="rem"></td></tr>
<tr class="survol"><td class="place"></td><td><a href="x&iuf=2">B Anae</a></td><td>2013</td><td>FRA</td><td></td><td class="temps"></td><td class="reaction"></td><td class="tempsRelayeur">(32.00)</td><td></td><td></td><td></td><td></td></tr>
<tr class="survol"><td class="place">---</td><td><a href="x&iuf=3">C Erine</a></td><td>2013</td><td>FRA</td><td><a href="x">SR COLMAR</a></td><td class="temps_sans_tps_passage"><a href="#" class="tooltip">DSQ<b><nobr>Disqualifié</nobr></b></a></td><td></td><td class="tempsRelayeur"></td><td></td><td class="points">---</td><td></td><td></td></tr></table><div id="boxLegende">`;
let calls = 0;
globalThis.fetch = async (u) => { calls++; const s = String(u); const body = s.includes("resultats") ? res : s.includes("epr_id") ? heats : prog; return new Response(new TextEncoder().encode(body)); };
const req = (p, m = "GET", body, key = "pw") => worker.fetch(new Request("https://x" + p, { method: m, body: body && JSON.stringify(body), headers: { "x-admin-key": key } }), env, { waitUntil: () => {} });
console.log("bad pw", (await req("/api/admin/state", "GET", null, "no")).status);
console.log("put cfg", await (await req("/api/config", "PUT", { comps: ["93222"], published: true })).json());
console.log("refresh", await (await req("/api/refresh", "POST")).json());
const st = await (await req("/api/state")).json();
const c = st.data.comps["93222"]; const e = c.events[47];
console.log("meta", c.meta, "heats", JSON.stringify(e.heats[0].lanes.map((l) => [l.lane, l.name, l.club, l.entry, (l.members || []).length])));
console.log("res", e.results.rows.map((r) => [r.place, r.team, r.time, r.status, r.points, r.relay && r.relay.length, r.splits.length]), "doneAt", !!e.doneAt);
const w0 = writes; await cycle(env); await cycle(env, { force: true }); console.log("writes on unchanged runs", writes - w0, "fetch calls", calls);
console.log("rescrape", await (await req("/api/rescrape", "POST", { scope: "all", what: "all" })).json());

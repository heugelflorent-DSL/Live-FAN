/* Records institutionnels (FFN extraNat) → public/records.json
   - records de France toutes catégories et par année d'âge (12 à 18 ans), du Grand Est et des 10 départements du Grand Est, bassins 25 et 50 m ;
   - clubs de chaque département (lus dans les rankings départementaux) : sert à savoir de quel département est un nageur.
   Lancé chaque semaine par .github/workflows/records.yml (jamais par le serveur : trop lourd pour l'offre gratuite).
   © Mat-et-Flo */
import { writeFileSync } from "node:fs";
const EXT = "https://ffn.extranat.fr/webffn";
const DEPS = { "08": [1666, "Ardennes"], "10": [1602, "Aube"], "51": [1675, "Marne"], "52": [1651, "Haute-Marne"], "54": [1652, "Meurthe-et-Moselle"], "55": [1617, "Meuse"], "57": [1653, "Moselle"], "67": [1668, "Bas-Rhin"], "68": [1622, "Haut-Rhin"], "88": [1684, "Vosges"] };
const GE = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unesc = (s) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&egrave;/g, "è").replace(/&eacute;/g, "é").replace(/&amp;/g, "&");
const txt = (h) => unesc(String(h || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const toSec = (t) => { const m = String(t || "").match(/(?:(\d+):)?(\d+):(\d+)\.(\d+)/); return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100 : null; };
/* « 50 NL », « 100 Dos », « 50 Bra. », « 200 4 N. » → « 50 NL », « 100 DOS », « 50 BRA », « 200 4N » (comme evKey côté page) ; relais ignorés */
function evKey(name) {
  const n = String(name || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const d = +(n.match(/^(\d+)/) || [])[1]; if (!d || /^\d+\s*X/.test(n)) return null;
  const s = /4\s*N/.test(n) ? "4N" : /\bNL\b|NAGE LIBRE/.test(n) ? "NL" : /\bDOS\b/.test(n) ? "DOS" : /BRA/.test(n) ? "BRA" : /PAP/.test(n) ? "PAP" : null;
  return s ? d + " " + s : null;
}
async function get(url, body) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": "SwimDirect/1.0 (records hebdo)" }, body } : { headers: { "User-Agent": "SwimDirect/1.0 (records hebdo)" } });
      if (r.ok) return await r.text(); console.error("HTTP", r.status, url);
    } catch (e) { console.error("échec", url, e.message); }
    await sleep(3000 * (i + 1));
  }
  return null;
}
/* page de records : sections Dames / Messieurs, une ligne par épreuve (temps, détenteur, club, date) */
function parseRecords(html) {
  const out = []; const parts = html.split(/<thead/i).slice(1);
  for (const p of parts) {
    const head = p.slice(0, p.indexOf("</thead>")); const sex = /venus|Dames/i.test(head) ? "F" : /mars|Messieurs/i.test(head) ? "M" : null; if (!sex) continue;
    const body = p.slice(p.indexOf("</thead>")); const rows = body.split(/<tr[\s>]/i).slice(1); /* pas de coupe à </tbody> : chaque ligne a son propre tbody */
    for (const r of rows) {
      const th = r.match(/<th[^>]*scope=["']row["'][^>]*>([\s\S]*?)<\/th>/i); if (!th) continue;
      const k = evKey(txt(th[1])); if (!k) continue;
      const tds = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      const t = toSec(txt(tds[0])); if (t == null) continue;
      const who = txt(tds[1]).replace(/\s+FRA$/, ""); const ym = who.match(/\((\d{4})\//);
      const dm = txt(tds[3]).match(/(\d{2})\/(\d{2})\/(\d{4})/);
      out.push({ sex, k, t, who: who.replace(/\s*\(.*$/, "").trim(), y: ym ? +ym[1] : undefined, club: txt(tds[2]) || undefined, d: dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : undefined });
    }
  }
  return out;
}
const rec = {}; let pages = 0, fails = 0;
async function records(niv, zon, zkey, cat) {
  for (const bas of [25, 50]) {
    const html = await get(`${EXT}/nat_records.php?idact=nat&idniv=${niv}&idzon=${zon || ""}&idbas=${bas}&idsex=&idcat=${cat || ""}`); pages++;
    if (!html) { fails++; continue; }
    const L = parseRecords(html); if (!L.length) console.error("aucun record :", zkey, cat || "TC", bas);
    for (const x of L) { const { sex, k, ...v } = x; rec[[zkey, cat || "TC", bas, sex, k].join("|")] = v; }
    await sleep(800);
  }
}
await records(3, "", "FR");
for (let a = 12; a <= 18; a++) await records(3, "", "FR", a);
await records(4, GE, "GE");
for (const [code, [zon]] of Object.entries(DEPS)) await records(5, zon, code);

/* clubs de chaque département : rankings départementaux (50 et 100 NL, Dames et Messieurs, 25 m, saison en cours et précédente) */
const clubs = {}; const y = new Date().getMonth() >= 8 ? new Date().getFullYear() + 1 : new Date().getFullYear();
for (const [code, [zon]] of Object.entries(DEPS)) {
  for (const sai of [y, y - 1]) for (const [sex, eprs] of [[1, [1, 2]], [2, [51, 52]]]) for (const epr of eprs) {
    const html = await get(`${EXT}/nat_rankings.php`, `idact=nat&go=epr&idsai=${sai}&idbas=25&idepr=${epr}&idsex=${sex}&iddep=${zon}&idcat=`); pages++;
    if (!html) { fails++; continue; }
    for (const m of html.matchAll(/ffn-clb="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) { const n = txt(m[2]); if (n && !clubs[n]) clubs[n] = code; }
    await sleep(800);
  }
}
const n = Object.keys(rec).length;
if (n < 200 || fails > pages / 4) { console.error(`Trop peu de records (${n}) ou trop d'échecs (${fails}/${pages}) : fichier non remplacé.`); process.exit(1); }
const zones = { FR: "France", GE: "Grand Est", ...Object.fromEntries(Object.entries(DEPS).map(([c, [, nm]]) => [c, nm])) };
writeFileSync("public/records.json", JSON.stringify({ at: new Date().toISOString(), zones, rec, clubs }));
console.log(`${n} records, ${Object.keys(clubs).length} clubs, ${pages} pages lues (${fails} échecs).`);

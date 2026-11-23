/* Génère public/demo/state.json et mpp.json : une compétition « vitrine » à partir d'un vrai état du site, anonymisée
   (noms, clubs, licences remplacés par des valeurs inventées ; pièces jointes retirées).
   Usage : node scripts/make-demo.mjs etat.json mpp.json */
import fs from "fs";
const [sf, mf] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(sf, "utf8")), mp = JSON.parse(fs.readFileSync(mf, "utf8"));
const NOM = "ARNOUX BAUDRY BELLEC BERTIN BLANCHET BOUVIER BRIAND CARON CHEVALLIER COLAS COMBES DELMAS DUCHENE ESTEVE FABRE FAURE GAILLARD GARNIER GIRARD GUERIN HAMEL HUBERT JOUBERT LACROIX LAMBERT LEBLANC LEGRAND LEMOINE LUCAS MARCHAND MASSON MEUNIER MOREL NAVARRO OLLIVIER PAGES PELLETIER PERRET PICARD POIRIER RAYNAUD RENARD ROCHE ROUSSEAU SALMON SIMONET TESSIER THIBAUT VALLET VASSEUR VERDIER WEBER".split(" ");
const PREF = "Alix Anna Camille Chloé Clara Emma Eva Inès Jade Léa Lina Lola Lou Lucie Maé Manon Nina Océane Rose Sarah Zoé Jeanne Mila Élise Romane".split(" "), PREM = "Adam Axel Baptiste Eliott Gabin Hugo Jules Léo Louis Maxime Nathan Noé Noah Oscar Paul Sacha Théo Tom Armand Basile Ethan Lucas Yanis".split(" ");
const CLUBS = ["AQUAVILLE NATATION", "CN DU VAL DE RIVIÈRE", "DAUPHINS DE LA PLAINE", "ÉTOILE DES EAUX VIVES", "ALPES AQUA CLUB", "NAUTIC CLUB DU LAC", "SQUALES DU RHIN", "OTARIES DE LA VALLÉE", "NATATION DES TROIS FRONTIÈRES", "CN DES CIGOGNES", "AQUA SPORT HAUT-VALLON", "RAYONS D'EAU", "TRITONS DU PLATEAU", "NAGEURS DU MOULIN", "CERCLE NAUTIQUE DES VOSGES", "BLEU MARINE NATATION", "ESPADONS DE L'EST", "COURANT VIF CLUB", "ONDINES ET TRITONS", "LAGON CLUB", "VAGUE D'ARGENT"];
const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647 })();
const clubMap = new Map(), nameMap = new Map(), iufMap = new Map(), used = new Set();
const raw = JSON.stringify(st);
for (const c of new Set([...raw.matchAll(/"club":"([^"]+)"/g)].map((m) => m[1]))) clubMap.set(c, CLUBS[clubMap.size % CLUBS.length] + (clubMap.size >= CLUBS.length ? " 2" : ""));
const sexOf = new Map(); for (const x of Object.values(st.data.comps)) for (const e of Object.values(x.events || {})) { const t = (e.results && e.results.title) || "", g = /Dames/.test(t) ? "F" : /Messieurs/.test(t) ? "M" : ""; if (g) for (const r of e.results.rows || []) sexOf.set(r.name, g) }
const fakeName = (orig) => { if (nameMap.has(orig)) return nameMap.get(orig); const L = sexOf.get(orig) === "M" ? PREM : PREF; let n, k = 0; do { n = NOM[Math.floor(rnd() * NOM.length)] + " " + L[Math.floor(rnd() * L.length)] } while (used.has(n) && ++k < 500); used.add(n); nameMap.set(orig, n); return n };
const fakeIuf = (o) => { o = String(o); if (!iufMap.has(o)) iufMap.set(o, String(9000000 + iufMap.size * 7 + 1)); return iufMap.get(o) };
/* nageurs : toute chaîne « NOM Prénom » associée à un champ name, + licences */
const swNames = new Set([...raw.matchAll(/"name":"([A-ZÀ-Ý][A-ZÀ-Ý' -]+ [A-ZÀ-Ý][^"]*)"/g)].map((m) => m[1]));
const evNames = new Set([...raw.matchAll(/"name":"(\d+ [^"]+)"/g)].map((m) => m[1]));
let out = raw;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const n of swNames) if (!evNames.has(n)) out = out.split(`"${n}"`).join(`"${fakeName(n)}"`);
out = out.replace(/"iuf":"?(\d+)"?/g, (m, i) => (m.includes('"iuf":"') ? `"iuf":"${fakeIuf(i)}"` : `"iuf":${fakeIuf(i)}`));
for (const [c, f] of clubMap) out = out.split(`"${c}"`).join(`"${f}"`);
const d = JSON.parse(out);
const c = d.config;
c.name = "Ta future compétition"; c.org = "Ton club · Ta ligue"; c.theme = "alsace"; c.color = ""; c.published = true; c.live = "bassin"; c.testMode = true; c.infos = []; delete c.progLogo; c.progLock = false;
for (const x of Object.values(d.data.comps)) { x.meta = { ...x.meta, name: "Ta future compétition", city: "VILLE-SUR-BASSIN", date: "Samedi 21 et Dimanche 22 Novembre 2026" }; for (const e of Object.values(x.events || {})) delete e.heatsSrc; delete x.entryList; }
d.data.queue = []; d.data.log = []; d.data.error = null; d.demo = true;
/* records perso : clés « NOM Prénom|année » */
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const byNorm = new Map([...nameMap].map(([o, f]) => [norm(o), f]));
const sw = {};
for (const [k, v] of Object.entries(mp.sw)) { const i = k.lastIndexOf("|"), n = k.slice(0, i), y = k.slice(i + 1); const f = byNorm.get(n); if (!f) continue; if (v.iuf) v.iuf = fakeIuf(v.iuf); sw[norm(f) + "|" + y] = v }
fs.mkdirSync("public/demo", { recursive: true });
fs.writeFileSync("public/demo/state.json", JSON.stringify(d)); fs.writeFileSync("public/demo/mpp.json", JSON.stringify({ at: mp.at, sw }));
console.log("nageurs", nameMap.size, "clubs", clubMap.size, "state", JSON.stringify(d).length, "mpp", JSON.stringify({ sw }).length);

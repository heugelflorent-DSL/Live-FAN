// Records personnels (MPP) d'un nageur sur FFN Extranat, avec les passages quand ils ont été saisis.
// Une seule lecture par nageur, étalée dans le temps ; rien pendant les courses.
export const EXT = "https://ffn.extranat.fr/webffn";
const toSec = (t) => { const m = String(t || "").match(/^(?:(\d+):)?(\d+):(\d+)\.(\d+)$/); if (!m) return null; return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100; };
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&amp;/g, "&");
// « 200 NL » → { d: 200, s: "NL" } ; s ∈ NL, DOS, BRA, PAP, 4N
export function normEvent(name) {
  const n = String(name || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const d = +(n.match(/^(\d+)/) || [])[1]; if (!d || /^\d+\s*X/.test(n)) return null;
  const s = /4\s*N/.test(n) ? "4N" : /\bNL\b|NAGE LIBRE/.test(n) ? "NL" : /\bDOS\b/.test(n) ? "DOS" : /BRA/.test(n) ? "BRA" : /PAP/.test(n) ? "PAP" : null;
  return s ? d + " " + s : null;
}
// { 25: { "200 NL": { t, sp: [[50, 33.67], …] } }, 50: { … } } — la première ligne de chaque épreuve est la meilleure perf du bassin
export function parseMpp(html) {
  const out = {}; const parts = html.split(/Bassin\s*:\s*(?=\d+\s*m)/i);
  for (const part of parts.slice(1)) {
    const pool = +part.match(/^(\d+)/)[1]; const o = (out[pool] = out[pool] || {});
    const re = /<th[^>]*scope=["']row["'][^>]*>([^<]+)<\/th>([\s\S]*?)<\/tr>/g; let m;
    while ((m = re.exec(part))) {
      const k = normEvent(m[1].trim()); if (!k || o[k]) continue;
      const row = m[2]; const tip = row.match(/data-tippy-content=(['"])([\s\S]*?)\1/);
      const rest = tip ? row.replace(tip[0], "") : row;
      const time = toSec((rest.match(/(\d{2}:\d{2}\.\d{2})/) || [])[1]); if (time == null) continue;
      const sp = [];
      if (tip) { const t = unesc(tip[2]); const r2 = /(\d+)\s*m\s*:\s*<\/td>\s*<td[^>]*>([\d:.]+)<\/td>/g; let x; while ((x = r2.exec(t))) { const c = toSec(x[2]); if (c != null) sp.push([+x[1], c]); } }
      sp.sort((a, b) => a[0] - b[0]);
      // date de la performance (jj/mm/aaaa) : sert à repérer un record établi pendant la compétition elle-même
      const dm = rest.replace(/<[^>]+>/g, " ").match(/(\d{2})\/(\d{2})\/(\d{4})/); const d = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : undefined;
      o[k] = sp.length > 1 ? { t: time, sp, d } : { t: time, d };
    }
  }
  return out;
}
const fold = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
// Le Live FFN abrège les noms longs : « LOYNTON-FERRAND S. », « LECONTE-DEROUBAIX E.M. ».
// On cherche alors le nom seul, puis on garde le nageur de la bonne année dont le prénom a les mêmes initiales.
export function splitInitials(name) {
  // initiales avec point (« S. », « E.M. ») ou lettres seules en fin de nom (« BORGHOL M A », « LABEJOF ENGEL A »)
  const m = String(name || "").trim().match(/^(.*?)\s+((?:\p{L}\.[\s-]?)+)$/u) || String(name || "").trim().match(/^(.*?\p{L}{2,})((?:\s+\p{L}){1,3})$/u);
  return m ? { base: m[1].trim(), ini: fold(m[2]).replace(/[^A-Z]/g, "") } : { base: String(name || "").trim(), ini: "" };
}
export function pickIuf(list, name, year) {
  const { base, ini } = splitInitials(name);
  const hit = (Array.isArray(list) ? list : []).filter((x) => {
    const ind = String(x.ind || ""); if (year && !ind.includes("(" + year + ")")) return false;
    if (!ini) return true;
    const fn = fold(ind.slice(0, ind.indexOf("(")).trim()); const b = fold(base); if (!fn.startsWith(b)) return false;
    const parts = fn.slice(b.length).trim().split(/[\s-]+/).filter(Boolean); return parts.map((p) => p[0]).join("").startsWith(ini);
  });
  return hit.length === 1 ? hit[0].iuf : null; // ambigu ou introuvable : on s'abstient
}
export async function findIuf(name, year) {
  const get = async (q) => { const r = await fetch(`${EXT}/_recherche.php?go=ind&idrch=${encodeURIComponent(q)}`, { headers: { "User-Agent": "SwimDirect/1.0" } }); if (!r.ok) throw new Error("Extranat " + r.status); return r.json().catch(() => []); };
  const { base, ini } = splitInitials(name);
  const first = pickIuf(await get(base), name, year); if (first || ini || !year) return first;
  // 2e essai (nom complet introuvable : prénom composé, orthographe…) : nom de famille seul, même année, prénom qui commence pareil
  const t = String(name || "").trim().split(/\s+/); if (t.length < 2) return null;
  for (let k = t.length - 1; k >= 1; k--) {
    const last = t.slice(0, k).join(" "), fn = fold(t.slice(k).join(" ")); if (last.length < 3) continue;
    const hit = (await get(last)).filter((x) => { const ind = String(x.ind || ""); if (!ind.includes("(" + year + ")")) return false; const nm = fold(ind.slice(0, ind.indexOf("(")).trim()); if (!nm.startsWith(fold(last))) return false; const f = nm.slice(fold(last).length).trim(); return f && (f.startsWith(fn.slice(0, 3)) || fn.startsWith(f.slice(0, 3))); });
    if (hit.length === 1) return hit[0].iuf; if (hit.length > 1) return null;
    break; // une seule requête de plus par nageur
  }
  return null;
}
export async function fetchMpp(iuf) {
  const r = await fetch(`${EXT}/nat_recherche.php?idact=nat`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": "SwimDirect/1.0" }, body: new URLSearchParams({ idact: "nat", idrch_id: String(iuf), idiuf: String(iuf), idopt: "mpp" }) });
  if (!r.ok) throw new Error("Extranat " + r.status);
  return parseMpp(await r.text());
}

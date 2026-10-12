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
      o[k] = sp.length > 1 ? { t: time, sp } : { t: time };
    }
  }
  return out;
}
export async function findIuf(name, year) {
  const r = await fetch(`${EXT}/_recherche.php?go=ind&idrch=${encodeURIComponent(name)}`, { headers: { "User-Agent": "SchwimmeDirect/1.0" } });
  if (!r.ok) throw new Error("Extranat " + r.status);
  const list = await r.json().catch(() => []);
  const hit = (Array.isArray(list) ? list : []).filter((x) => !year || String(x.ind || "").includes("(" + year + ")"));
  return hit.length === 1 ? hit[0].iuf : null; // ambigu ou introuvable : on s'abstient
}
export async function fetchMpp(iuf) {
  const r = await fetch(`${EXT}/nat_recherche.php?idact=nat`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": "SchwimmeDirect/1.0" }, body: new URLSearchParams({ idact: "nat", idrch_id: String(iuf), idiuf: String(iuf), idopt: "mpp" }) });
  if (!r.ok) throw new Error("Extranat " + r.status);
  return parseMpp(await r.text());
}

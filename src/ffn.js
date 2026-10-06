// Lecture des pages du Live FFN (liveffn.com) — sans DOM, compatible Cloudflare Workers et navigateur.
export const BASE = "https://www.liveffn.com/cgi-bin";

export function decode(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("iso-8859-1").decode(buf); }
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", deg: "°", raquo: "»", laquo: "«", ccedil: "ç", eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", icirc: "î", ocirc: "ô", ucirc: "û", uuml: "ü", euml: "ë", iuml: "ï" };
export function text(h) {
  return String(h || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}
const one = (s) => text(s).replace(/\s+/g, " ").trim();
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");

// "1:14.30" | "02:30.87" | "31.58" -> secondes
export function toSec(t) {
  if (!t) return null;
  const m = String(t).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return (m[1] ? +m[1] * 60 : 0) + +m[2];
}

// Découpe <tr>…</tr> et <td>…</td> d'un fragment (tables imbriquées gérées pour les passages)
function rows(html) {
  const out = []; let i = 0;
  while (true) {
    const s = html.indexOf("<tr", i); if (s < 0) break;
    let depth = 0, j = s;
    while (true) {
      const o = html.indexOf("<tr", j + 1), c = html.indexOf("</tr>", j + 1);
      if (c < 0) { j = html.length; break; }
      if (o >= 0 && o < c) { depth++; j = o; } else { if (depth === 0) { j = c; break; } depth--; j = c; }
    }
    out.push(html.slice(s, j + 5)); i = j + 5;
  }
  return out;
}
function cells(tr) {
  const out = []; const inner = tr.replace(/^<tr[^>]*>/, "").replace(/<\/tr>$/, "");
  let i = 0;
  while (true) {
    const s = inner.indexOf("<td", i); if (s < 0) break;
    let depth = 0, j = s;
    while (true) {
      const o = inner.indexOf("<td", j + 1), c = inner.indexOf("</td>", j + 1);
      if (c < 0) { j = inner.length; break; }
      if (o >= 0 && o < c) { depth++; j = o; } else { if (depth === 0) { j = c; break; } depth--; j = c; }
    }
    const raw = inner.slice(s, j + 5);
    const cls = (raw.match(/^<td[^>]*class="([^"]*)"/) || [])[1] || "";
    out.push({ cls, html: raw.replace(/^<td[^>]*>/, "").replace(/<\/td>$/, "") });
    i = j + 5;
  }
  return out;
}

export function parseMeta(html) {
  const g = (c) => one((html.match(new RegExp(`<div class="${c}">([\\s\\S]*?)</div>`)) || [])[1]);
  const titre = g("titre"); const m = titre.match(/^(.*?)\s*-\s*(\d+)\s*m$/);
  return { city: g("lieu"), name: m ? m[1] : titre, pool: m ? m[2] + " m" : "", date: g("date").replace(/^Le\s+/i, "") };
}

// Programme : réunions, ouverture des portes, épreuves (heure, nom, n° FFN, séries, participants) et lignes non sportives
export function parseProgramme(html) {
  html = strip(html);
  const meta = parseMeta(html);
  const reunions = [];
  const parts = html.split(/<h6>/).slice(1);
  for (const p of parts) {
    const head = one((p.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
    const n = +((head.match(/R[ée]union\s*N\D*(\d+)/i) || [])[1] || reunions.length + 1);
    const day = (head.split(":")[1] || "").trim();
    const r = { n, day, doors: null, items: [] };
    const lis = p.match(/<li[\s\S]*?<\/li>/g) || [];
    for (const li of lis) {
      const cls = (li.match(/^<li class="([^"]*)"/) || [])[1] || "";
      if (cls.includes("debutEpreuve")) { const d = text(li).match(/portes\s*:\s*(\d{1,2}h\d{2})/i); if (d) r.doors = d[1]; continue; }
      if (cls.includes("EventNonSportif")) { const t = one(li); if (!/^fin de la r[ée]union$/i.test(t)) r.items.push({ kind: "note", text: t }); continue; }
      const on = li.match(/cat_id='\+(\d+)\+'&epr_id='\+'(\d+)'\+'&typ_id='\+(\d+)\+'&num_epreuve='\+(\d+)/);
      if (!on) continue;
      const time = (li.match(/<span class="time">([^<]*)<\/span>/) || [])[1] || null;
      const tip = li.match(/<span class="tooltip"[^>]*>([\s\S]*?)<b[^>]*>([\s\S]*?)<\/b>/);
      const full = one(tip ? tip[1] : li);
      const info = one(tip ? tip[2] : "");
      const rm = full.match(/^(.*?)\s+(S[ée]ries|Finales?.*|Demi-finales?.*|Barrages?.*|Classement.*)$/i);
      const ns = info.match(/(\d+)\s*s[ée]ries?/i), np = info.match(/(\d+)\s*participant/i);
      r.items.push({ kind: "event", epr: +on[2], cat: +on[1], typ: +on[3], num: +on[4], time: time ? time.trim() : null,
        name: rm ? rm[1] : full, round: rm ? rm[2] : "", nSeries: ns ? +ns[1] : null, nPart: np ? +np[1] : null });
    }
    reunions.push(r);
  }
  return { meta, reunions };
}

// Détail d'une épreuve du programme (appel AJAX) : séries et lignes d'eau
export function parseHeats(html) {
  html = strip(html);
  const heats = []; let cur = null;
  for (const tr of rows(html)) {
    const cs = cells(tr);
    const tit = cs.find((c) => c.cls.includes("prgTitre"));
    if (tit) {
      const t = one(tit.html); const m = t.match(/\((\d+)\s*\/\s*(\d+)\)/);
      const tm = cs.find((c) => c.cls.includes("prgTime"));
      cur = { n: m ? +m[1] : heats.length + 1, of: m ? +m[2] : null, time: tm ? one(tm.html) : null, lanes: [] }; heats.push(cur); continue;
    }
    if (!cur || cs.length < 5) continue;
    const lane = +((cs[0].html.match(/ico_plot_(\d+)/) || [])[1] || 0);
    const timeCell = cs.find((c) => c.cls.includes("temps"));
    const club = one((cs[4].html.match(/<nobr>([\s\S]*?)<\/nobr>/) || [])[1] || (cs[4].html.match(/<span class="tooltip">([^<]*)/) || [])[1] || cs[4].html);
    const entryTxt = timeCell ? one(timeCell.html.replace(/<b[\s\S]*?<\/b>/, "")) : "";
    const sw = { lane, name: one(cs[1].html), year: one(cs[2].html), nat: one(cs[3].html), club, entry: toSec(entryTxt), entryTxt };
    // Relais : les relayeurs suivent la ligne de l'équipe, sans ligne d'eau ni club
    const prev = cur.lanes[cur.lanes.length - 1];
    if (!lane && !club && prev) { (prev.members = prev.members || [{ name: prev.name, year: prev.year }]).push({ name: sw.name, year: sw.year }); continue; }
    cur.lanes.push(sw);
  }
  return heats;
}

function parseSplits(html) {
  const tb = (html.match(/<table class="split">([\s\S]*?)<\/table>/) || [])[1]; if (!tb) return [];
  return rows(tb).map((tr) => {
    const g = (c) => one((tr.match(new RegExp(`<td class="${c}">([\\s\\S]*?)</td>`)) || [])[1]);
    const d = parseInt(g("distance")); const cum = toSec(g("split")); const lap = toSec(g("lap").replace(/[()]/g, ""));
    return d ? { d, cum, lap } : null;
  }).filter(Boolean);
}

// Résultats d'une épreuve : classement, temps, statut, points FFN, passages ; relais avec leurs 4 relayeurs
export function parseResults(html) {
  html = strip(html);
  const start = html.indexOf('<table class="tableau">'); if (start < 0) return { title: "", rows: [] };
  const end = html.indexOf('<div id="boxLegende"', start);
  const tbl = html.slice(start, end > 0 ? end : undefined);
  const out = { title: "", rows: [] }; let last = null;
  for (const tr of rows(tbl)) {
    const cs = cells(tr);
    if (cs.length && cs[0].cls.includes("epreuve")) { out.title = one(cs[0].html); continue; }
    if (!/class="survol/.test(tr.slice(0, 40)) || cs.length < 6) continue;
    const place = one(cs[0].html);
    const a = cs[1].html; const iuf = +((a.match(/iuf=(\d+)/) || [])[1] || 0) || null;
    const name = one(a); const year = one(cs[2].html); const nat = one(cs[3].html);
    const clubHtml = cs[4].html; const club = one(clubHtml); const clubId = +((clubHtml.match(/structure=(\d+)/) || [])[1] || 0) || null;
    const tcell = cs.find((c) => c.cls.startsWith("temps") && !c.cls.includes("Relayeur"));
    const relayLeg = cs.find((c) => c.cls === "tempsRelayeur");
    const ptsCell = cs.find((c) => c.cls === "points");
    const tlabel = tcell ? one((tcell.html.match(/^(?:<a[^>]*>)?([^<]*)/) || [])[1]) : "";
    const reason = tcell ? one((tcell.html.match(/<nobr>([\s\S]*?)<\/nobr>/) || [])[1] || "") : "";
    const legSec = relayLeg ? toSec(one(relayLeg.html).replace(/[()]/g, "")) : null;
    const relayEv = /^\s*\d+\s*x\s*\d+/i.test(out.title);
    if (relayEv && !place && last) { (last.relay = last.relay || []).push({ name, iuf, year, nat, leg: legSec }); continue; }
    const isTime = /^\d/.test(tlabel);
    const row = {
      place: /^\d+\.$/.test(place) ? parseInt(place) : null,
      name, iuf, year, nat, club, clubId,
      time: isTime ? toSec(tlabel) : null, timeTxt: tlabel,
      status: isTime ? null : (tlabel || null), reason: isTime ? null : reason || null,
      points: ptsCell ? (parseInt(one(ptsCell.html)) || null) : null,
      splits: tcell ? parseSplits(tcell.html) : [],
    };
    if (relayEv) row.relay = [{ name, iuf, year, nat, leg: legSec }];
    out.rows.push(row); last = row;
  }
  // Relais : le nom de l'équipe est le club (numéroté s'il y a plusieurs équipes du même club)
  const byClub = {};
  for (const r of out.rows) if (r.relay) { byClub[r.club] = (byClub[r.club] || 0) + 1; r.teamNo = byClub[r.club]; }
  for (const r of out.rows) if (r.relay) r.team = byClub[r.club] > 1 ? `${r.club} ${r.teamNo}` : r.club;
  return out;
}

// --- Récupération polie : une requête à la fois, délai entre deux pages, recul en cas d'erreur ---
export const UA = "SchwimmeDirect/1.0";
export async function get(url, { delay = 400, tries = 3 } = {}) {
  let wait = 2000;
  for (let i = 0; i < tries; i++) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9", Accept: "text/html" } });
    if (res.ok) return decode(await res.arrayBuffer());
    if (res.status === 403 || res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, wait)); wait *= 3; continue; }
    throw new Error(`HTTP ${res.status} sur ${url}`);
  }
  throw new Error(`Live FFN indisponible (${url})`);
}
export const urls = {
  programme: (c) => `${BASE}/programme.php?competition=${c}&langue=fra`,
  heats: (c, e) => `${BASE}/programme.php?competition=${c}&langue=fra&cat_id=${e.cat}&epr_id=${e.epr}&typ_id=${e.typ}&num_epreuve=${e.num}`,
  results: (c, epr) => `${BASE}/resultats.php?competition=${c}&langue=fra&go=epreuve&epreuve=${epr}`,
  home: (c) => `${BASE}/index.php?competition=${c}&langue=fra`,
};

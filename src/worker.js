// Swim Direct — serveur Cloudflare : API, stockage KV, récupération programmée du Live FFN.
export { PoolRoom } from "./pool.js";
export { StatsRoom } from "./stats.js";
import { get as getDirect, urls, parseEntries, parseLive, parseProgramme, parseHeats, parseResults } from "./ffn.js";
import { normEvent, findIuf, fetchMpp } from "./extranat.js";
import { euEnv } from "./eu.js";

const BUDGET = 15;            // pages Live FFN lues au maximum par passage (le reste attend le passage suivant)
const PROG_EVERY = 30 * 60e3; // programme relu toutes les 30 min
const HEATS_EVERY = 10 * 60e3; // séries relues toutes les 10 min tant que la réunion n'a pas commencé

export const DEFAULT_CONFIG = {
  name: "", comps: [], order: {}, lines: {}, starts: {}, gap: 40, timing: "elec", delay: {},
  rankings: [], infos: [], published: false, live: "off", scrape: { every: 2, onlyLive: true },
};

// ---------- heure de Paris ----------
const TZ = "Europe/Paris";
function parisParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
function parisEpoch(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = parisParts(new Date(guess));
  const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - guess;
  return guess - off;
}
const MONTHS = { janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12 };
function compDate(meta) {
  // 1er jour de compétition : « Du Jeudi 29 Octobre au Dimanche 1er Novembre 2026 » → 29 octobre 2026 (« 1 er » avec espace aussi)
  const t = (meta?.date || "").toLowerCase(); const all = [...t.matchAll(/(\d{1,2})(?:\s*er)?\s+([a-zéèûô]+)(?:\s+(\d{4}))?/g)].filter((x) => MONTHS[x[2]]);
  const last = [...all].reverse().find((x) => x[3]); if (!last) return null;
  const f = all[0]; let y = +(f[3] || last[3]); const mo = MONTHS[f[2]];
  if (!f[3] && mo > MONTHS[last[2]]) y--; // du 28 décembre au 2 janvier 2027
  const d0 = all.length === 1 && t.match(/du\s+(?:[a-zé]+\s+)?(\d{1,2})(?:\s*er)?\s+au\b/); // « Du 7 au 8 Novembre 2026 »
  if (d0) { const d = +d0[1]; if (d > +f[1]) return mo === 1 ? { y: y - 1, m: 12, d } : { y, m: mo - 1, d }; return { y, m: mo, d }; }
  return { y, m: mo, d: +f[1] };
}
const hToMin = (t) => { const m = String(t || "").match(/(\d{1,2})h(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };

// ---------- stockage ----------
// Plusieurs événements : « main » garde les clés historiques, les autres ont leurs propres clés
export const kk = (base, ev) => (ev && ev !== "main" ? `${base}:${ev}` : base);
const EV_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
let EVC = { at: 0, list: null };
async function listEvents(env) { if (EVC.list && Date.now() - EVC.at < 60e3) return EVC.list; const l = (await env.KV.get("events", "json")) || []; EVC = { at: Date.now(), list: l }; return l; }
async function load(env, ev = "main") {
  const [c, d] = await Promise.all([env.KV.get(kk("config", ev), "json"), env.KV.get(kk("data", ev), "json")]);
  return { config: { ...DEFAULT_CONFIG, ...(c || {}) }, data: d || { comps: {}, queue: [], log: [] } };
}
async function saveData(env, data, before, ev = "main") {
  const s = JSON.stringify(data);
  if (s !== before) await env.KV.put(kk("data", ev), s);
}

// ---------- récupération ----------
function expected(ev) {
  const lanes = (ev.heats || []).reduce((a, h) => a + h.lanes.length, 0);
  return lanes || ev.nPart || 0;
}
function eventsOf(comp) {
  return (comp.reunions || []).flatMap((r) => r.items.filter((i) => i.kind === "event").map((i) => ({ ...i, key: i.key || String(i.epr), reunion: r.n })));
}
function reuDone(c, r) { const evs = (r.items || []).filter((i) => i.kind === "event" && !i.provisional); return evs.length > 0 && evs.every((i) => c.events?.[i.key || String(i.epr)]?.doneAt); }
// direct : de 30 min avant la 1re course d'une réunion jusqu'à ses derniers résultats (2 h après la dernière épreuve au plus)
function liveOpen(c, now) {
  if (!c || !c.reunions) return true;
  for (const r of c.reunions) {
    const dt = compDate({ date: r.day }) || compDate(c.meta); if (!dt || reuDone(c, r)) continue;
    const evs = r.items.filter((i) => i.kind === "event" && i.time); const first = hToMin(evs[0]?.time), last = hToMin(evs[evs.length - 1]?.time); if (first == null) continue;
    const day = parisEpoch(dt.y, dt.m, dt.d); if (now >= day + (first - 30) * 60e3 && now <= day + ((last ?? first) + 120) * 60e3) return true;
  }
  return false;
}
function windowOpen(cfg, data, now) {
  if (!cfg.scrape?.onlyLive) return true;
  for (const id of cfg.comps) {
    const c = data.comps[id]; const dt0 = c && compDate(c.meta);
    if (!dt0) return true; // pas encore de programme : on le récupère
    for (const r of c.reunions || []) {
      // date de la réunion elle-même (« Du Samedi 17 au Dimanche 18 Octobre » : la date générale ne donne que le 18)
      const dt = compDate({ date: r.day }) || dt0;
      if (reuDone(c, r)) continue; // réunion terminée (tous les résultats lus) : plus rien à suivre jusqu'à la suivante
      const evs = r.items.filter((i) => i.kind === "event" && i.time);
      const first = hToMin(r.doors) ?? hToMin(evs[0]?.time); const last = hToMin(evs[evs.length - 1]?.time);
      if (first == null) continue;
      const a = parisEpoch(dt.y, dt.m, dt.d) + (first - 30) * 60e3;
      const b = parisEpoch(dt.y, dt.m, dt.d) + ((last ?? first) + 120) * 60e3;
      if (now >= a && now <= b) return true;
    }
  }
  return false;
}

// Compétitions terminées : toutes les épreuves ont leurs résultats, ou la journée est passée depuis plus de 3 h
function finished(cfg, data, now) {
  if (!cfg.comps.length) return false;
  return cfg.comps.every((id) => {
    const c = data.comps[id]; if (!c || !c.reunions) return false;
    const evs = eventsOf(c); if (!evs.length) return false;
    if (evs.every((e) => c.events?.[e.key]?.doneAt)) return true;
    const end = endAt(c); if (!end) return false;
    // résultats incomplets : on continue de les chercher jusqu'à 12 h après la dernière épreuve (du dernier jour), puis on s'arrête
    return now > end + 12 * 3600e3;
  });
}
// après la dernière épreuve du programme (résultats encore incomplets) : on relit les résultats manquants
function pastEnd(cfg, data, now) {
  return cfg.comps.some((id) => { const c = data.comps[id]; const end = c && c.reunions ? endAt(c) : 0; return !!end && now > end; });
}
// heure de la dernière épreuve de la compétition, le jour de sa réunion (compétitions sur plusieurs jours)
function endAt(c) {
  let end = 0;
  for (const r of c.reunions || []) {
    const dt = compDate({ date: r.day }) || compDate(c.meta); if (!dt) continue;
    const last = Math.max(0, ...(r.items || []).filter((i) => i.kind === "event").map((i) => hToMin(i.time) ?? 0));
    end = Math.max(end, parisEpoch(dt.y, dt.m, dt.d) + last * 60e3);
  }
  return end;
}

// Fréquence de relecture du programme : le programme officiel sort en général 3 à 4 jours avant
function progEvery(c, now) {
  // pas encore de programme complet (absent ou provisoire) : on réessaie toutes les 3 h jusqu'à l'avoir
  const evs = (c?.reunions || []).flatMap((r) => r.items.filter((i) => i.kind === "event"));
  // engagements en cours : rien ne bouge avant la publication de la liste des engagés → on attend ce jour-là (sinon 1 fois par jour)
  if (c?.entriesOpen) {
    if (c.entryList) { const [y, m, d] = c.entryList.split("-").map(Number); const at = parisEpoch(y, m, d, 6); if (now < at) return Math.max(3 * 3600e3, at - (c.progAt || 0)); return 3 * 3600e3; }
    return 24 * 3600e3;
  }
  if (!evs.length || evs.some((e) => e.provisional)) return 3 * 3600e3;
  const dt = compDate({ date: c.reunions?.[0]?.day }) || compDate(c.meta); if (!dt) return 24 * 3600e3; // 1er jour de compétition
  const days = (parisEpoch(dt.y, dt.m, dt.d) - now) / 864e5;
  if (days > 0) return 24 * 3600e3;    // programme obtenu : une relecture par jour jusqu'au début de la compétition
  // jour de compétition : finales du soir pas encore cliquables (liste de départ pas publiée) → programme relu toutes les 30 min
  // dès la première réunion du jour commencée, jusqu'à ce qu'elles le soient (les qualifiés sont alors confirmés)
  const today = (c.reunions || []).filter((r) => { const d = compDate({ date: r.day }); if (!d) return false; const t = parisEpoch(d.y, d.m, d.d); return now >= t && now < t + 864e5; });
  if (today.some((r) => r.items.some((i) => i.soon))) { const st = Math.min(...today.map((r) => { const d = compDate({ date: r.day }); const m = hToMin(r.items.find((i) => i.kind === "event" && i.time)?.time); return m == null ? Infinity : parisEpoch(d.y, d.m, d.d) + m * 60e3; })); if (now >= st) return 30 * 60e3; }
  return Infinity;                     // jours de compétition : voir progDue (environ 3 lectures par réunion)
}
// Jours de compétition : pour chaque réunion, environ 3 lectures du programme entre l'ouverture des portes
// et 20 min avant la 1re course (dernières modifications d'horaires possibles), puis plus rien.
function progDue(c, now) { return (c?.reunions || []).some((r) => reuDue(c, r, now, c.progAt)); }
// avant le jour de la réunion (séries publiées à l'avance : relues une fois par jour)
function evStartAt(c, ev) { const r = (c.reunions || []).find((x) => x.n === ev.reunion); const dt = compDate({ date: r?.day }) || compDate(c.meta); const m = hToMin(ev.time); return dt && m != null ? parisEpoch(dt.y, dt.m, dt.d) + m * 60e3 : null; }
function beforeDay(c, r, now) { const dt = compDate({ date: r.day }) || compDate(c.meta); return !!dt && now < parisEpoch(dt.y, dt.m, dt.d); }
// une réunion : vrai si une relecture est due dans sa fenêtre « ouverture des portes → 20 min avant la 1re course »
function reuDue(c, r, now, lastAt) {
  const dt = compDate({ date: r.day }) || compDate(c.meta); if (!dt) return false;
  const evs = r.items.filter((i) => i.kind === "event" && i.time);
  const start = hToMin(evs[0]?.time); if (start == null) return false;
  const day = parisEpoch(dt.y, dt.m, dt.d);
  const b = day + (start - 20) * 60e3, a = Math.min(b - 15 * 60e3, day + (hToMin(r.doors) ?? start - 60) * 60e3);
  if (now < a || now > b) return false;
  const step = Math.max(10 * 60e3, (b - a) / 2); // 3 lectures : aux portes, au milieu, 20 min avant
  return !lastAt || lastAt < a || now - lastAt >= step - 60e3;
}

// finales pas encore publiées : leur liste sort en général à la fin de la réunion du matin → seulement le jour même,
// de 3 h avant leur réunion jusqu'à 20 min avant, une lecture toutes les 40 min au plus (3 à 4 lectures)
function finDue(c, r, now, lastAt) {
  const dt = compDate({ date: r.day }) || compDate(c.meta); if (!dt) return false;
  const start = hToMin(r.items.find((i) => i.kind === "event" && i.time)?.time); if (start == null) return false;
  const day = parisEpoch(dt.y, dt.m, dt.d); const a = day + (start - 180) * 60e3, b = day + (start - 20) * 60e3;
  return now >= a && now <= b && (!lastAt || now - lastAt >= 40 * 60e3);
}
function plan(cfg, data, now, live, LI = {}) {
  const tasks = [];
  for (const id of cfg.comps) {
    const c = data.comps[id];
    if (!c || !c.progAt || now - c.progAt > progEvery(c, now) || progDue(c, now)) tasks.push({ t: "prog", c: id });
    if (!c) continue;
    for (const r of c.reunions || []) {
      const evs = r.items.filter((i) => i.kind === "event").map((i) => ({ ...i, key: i.key || String(i.epr) }));
      const started = evs.some((e) => c.events?.[e.key]?.results?.rows?.length);
      for (const e of evs) {
        if (e.provisional) continue; // programme provisoire : rien d'autre à lire pour l'instant
        if (e.soon) continue; // finale pas encore cliquable : sa page n'existe pas encore
        const st = c.events?.[e.key] || {};
        // finales : la liste de départ est publiée entre les séries et la finale → relue jusqu'à ses résultats
        const fin = e.key !== String(e.epr) && !st.results?.rows?.length;
        // séries : tant qu'elles ne sont pas publiées (pas de couloirs), relues toutes les 3 h ; une fois publiées,
        // seulement 3 fois le jour J (portes → 20 min avant la réunion) pour les forfaits ; finales : relues jusqu'à leur liste de départ
        const pubOf = (x) => (x?.heats || []).some((h) => h.lanes?.some((l) => l.lane > 0));
        const pub = pubOf(st);
        // séries pas encore publiées : seule la 1re épreuve de la réunion sert de témoin (1 page toutes les 3 h) ;
        // dès qu'elle est publiée, les autres épreuves sont lues une fois
        const lead = c.events?.[evs.find((x) => !x.provisional)?.key] || {};
        const waitDue = e === evs.find((x) => !x.provisional) ? now - st.heatsAt > 3 * 3600e3 : pubOf(lead) && st.heatsAt < lead.heatsAt;
        // finale qui vient de devenir cliquable le jour même : sa liste de départ (qualifiés officiels) est lue tout de suite
        const fresh = fin && !pub && !st.heatsAt && !e.soon && !beforeDay(c, r, now);
        const due = fresh || (!st.heatsAt && !fin) || (fin && !pub ? finDue(c, r, now, st.heatsAt) : !started && (pub ? reuDue(c, r, now, st.heatsAt) || (beforeDay(c, r, now) && now - st.heatsAt > 24 * 3600e3) : waitDue));
        if (due) tasks.push({ t: "heats", c: id, epr: e.epr, key: e.key });
      }
      if (!live) continue;
      // épreuves en cours : la première non terminée de la réunion et la suivante
      if (evs.some((e) => e.provisional)) continue;
      const idx = evs.findIndex((e) => !c.events?.[e.key]?.doneAt);
      if (idx < 0) continue;
      // résultats lus seulement quand il y a du nouveau d'après le direct : une série vient de se terminer, ou l'épreuve est finie
      const li = LI[id]; const nrm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      const liIdx = li ? evs.findIndex((e) => nrm(li.event).startsWith(nrm(e.name))) : -1;
      for (const e of evs.slice(idx, idx + 2)) {
        const st = c.events?.[e.key] || {}; const k = evs.indexOf(e);
        if (liIdx < 0) { if (!st.resultsAt || now - st.resultsAt > 10 * 60e3) tasks.push({ t: "res", c: id, epr: e.epr }); continue; } // direct indisponible : au plus une lecture toutes les 10 min
        if (k === liIdx && li.heat > (st.resHeat || 0)) tasks.push({ t: "res", c: id, epr: e.epr, heat: li.heat, key: e.key }); // nouvelle série terminée
        else if ((k < liIdx || (k === liIdx && li.of && li.heat >= li.of)) && !st.doneAt && (!st.resFinalAt || now - st.resFinalAt > 5 * 60e3)) tasks.push({ t: "res", c: id, epr: e.epr, final: 1, key: e.key }); // épreuve finie : classement définitif
      }
    }
  }
  // résultats d'abord, puis programme, puis séries ; une seule lecture par page (tous les tours d'une épreuve sont sur la même page de résultats)
  const rank = { res: 0, prog: 1, heats: 2 }; const seen = new Set();
  // la nuit (22 h → 6 h, heure de Paris), hors live : ni programme ni séries, rien ne bouge à ces heures-là
  const h = +new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(now);
  const night = !live && (h >= 22 || h < 6);
  return tasks.filter((t) => { if (night && t.t !== "res") return false; const k = t.t + "|" + t.c + "|" + (t.t === "heats" ? t.key : t.epr); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => rank[a.t] - rank[b.t]);
}

// Lecture d'une page du Live FFN : passe par le Durable Object « ffn » (une seule adresse de sortie, stable),
// la lecture directe depuis la tâche de chaque minute étant refusée (HTTP 403) par le Live FFN
let ENV = null, LIVEINFO = {};
// lectures refusées : chaque page ratée attend de plus en plus longtemps avant d'être retentée (5, 10, 20, 40 min… jusqu'à 3 h)
const failKey = (ev, t) => t.t + "|" + t.c + "|" + (t.key || t.epr || "");
const failWait = (f, t) => t && t.t === "prog" && f.n >= 3 ? 12 * 3600e3 : Math.min(3 * 3600e3, 5 * 60e3 * 2 ** Math.max(0, f.n - 1)); // programme refusé 3 fois (compétition pas encore publiée) : 2 essais par jour
const HITIP = {}; const LIVEMEMO = {}, LIVEOK = {}, LHSIG = {}, LHMEMO = {}; // mémoire de l'instance (direct)
// dernière série enregistrée par le relais (stockage durable) : relue au plus une fois par minute par instance
async function lastHeat(env, c, now) {
  const m = LHMEMO[c]; if (m && now - m.t < 60e3) return m.v;
  let v = null; try { const all = await (await env.POOL.get(env.POOL.idFromName("ffnlive:" + c)).fetch(new Request("https://pool/lhs"))).json();
    for (const h of all || []) if (h && h.at && (!v || h.at > v.at)) v = h; } catch (e) {}
  if (v && !v.title) v = { ...v, title: v.event + " - Série " + v.heat + (v.of ? "/" + v.of : "") };
  LHMEMO[c] = { t: now, v }; return v;
}
// série affichée en ce moment sur la page « En direct » (lue par le relais, partagée avec les spectateurs)
async function liveInfo(env, config) {
  const out = {};
  for (const c of config.comps) {
    const mm = LIVEMEMO[c]; if (mm && Date.now() - mm.t < 60e3 && mm.body.cur) { if (mm.body.cur.event) out[c] = { event: mm.body.cur.event, heat: mm.body.cur.heat || 0, of: mm.body.cur.of }; continue; }
    try { const b = await (await env.POOL.get(env.POOL.idFromName("ffnlive:" + c)).fetch(new Request("https://pool/ffnlive?u=" + encodeURIComponent(urls.live(c))))).json();
      if (b.raw != null) { const L = parseLive(b.raw); if (L.cur && L.cur.event) out[c] = { event: L.cur.event, heat: L.cur.heat || 0, of: L.cur.of }; } } catch (e) {}
  }
  return out;
}
const RELAY_OK = {}; // dernier relais accepté par compétition (mémoire de l'instance)
const FFN_RELAYS = (c) => { const all = ["ffnlive:" + c, "ffnB:" + c]; const ok = RELAY_OK[c]; return ok ? [ok, ...all.filter((x) => x !== ok)] : all; };
async function get(url, opt = {}) {
  if (!ENV || !ENV.POOL) return getDirect(url, opt);
  if (opt.delay) await new Promise((r) => setTimeout(r, opt.delay));
  // plusieurs relais (Durable Objects) qui peuvent sortir par des adresses différentes : si l'un est refusé (403), on passe au suivant
  const c = (url.match(/competition=(\d+)/) || [])[1] || ""; let err = null;
  for (const n of FFN_RELAYS(c)) {
    let j; try { j = await (await ENV.POOL.get(ENV.POOL.idFromName(n)).fetch(new Request("https://pool/ffnget?u=" + encodeURIComponent(url)))).json(); }
    catch (e) { return getDirect(url, { delay: 0, tries: 1 }); } // relais indisponible (quota) : lecture directe
    if (!j.error) { RELAY_OK[c] = n; return j.raw; }
    err = j.error; if (!/403/.test(err)) break;
  }
  throw new Error(err);
}
async function runTask(task, data, now) {
  const c = (data.comps[task.c] = data.comps[task.c] || { events: {} });
  c.events = c.events || {};
  if (task.t === "prog") {
    const p = parseProgramme(await get(urls.programme(task.c), { delay: 1500 }));
    if (!p.reunions.length) throw new Error(`Programme vide pour la compétition ${task.c}`);
    if (JSON.stringify([p.meta, p.reunions]) !== JSON.stringify([c.meta, c.reunions])) data.dirty = true;
    c.meta = p.meta; c.reunions = p.reunions; c.progAt = now;
    if (p.reunions.some((r) => (r.items || []).some((i) => i.provisional))) {
      try {
        const e = parseEntries(await get(urls.entries(task.c), { delay: 1500 }));
        if (e.days != null) c.entryList = new Date(now + e.days * 864e5).toISOString().slice(0, 10);
        c.entriesOpen = e.open;
      } catch {}
    } else { delete c.entriesOpen; }
    return;
  }
  if (task.t === "heats") {
    const ev = eventsOf(c).find((e) => e.key === (task.key || String(task.epr)));
    if (!ev) return;
    const st = (c.events[ev.key] = c.events[ev.key] || {});
    const hs = parseHeats(await get(urls.heats(task.c, ev), { delay: 1500 })).map((h) => ({ n: h.n, of: h.of, time: h.time, lanes: h.lanes.map(packLane) }));
    if (JSON.stringify(hs) !== JSON.stringify(st.heats || null)) { st.heats = hs; data.dirty = true; }
    st.heatsAt = now; return;
  }
  if (task.t === "res") {
    const evs = eventsOf(c).filter((e) => e.epr === task.epr);
    if (!evs.length) return;
    const r = parseResults(await get(urls.results(task.c, task.epr), { delay: 1500 }));
    // le Live FFN peut renvoyer une autre page quand l'épreuve n'a pas encore de résultats : on vérifie le titre
    const nrm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    for (const ev of evs) {
      const st = (c.events[ev.key] = c.events[ev.key] || {});
      const sec = pickSection(ev, r);
      const res = sec ? { title: sec.title, when: sec.when || "", rows: sec.rows.map(packRow) } : { title: r.title, when: r.when || "", rows: [] };
      if (!res.title || !nrm(res.title).startsWith(nrm(ev.name))) { res.rows = []; delete st.doneAt; }
      if (isSeries(ev)) { const b = (r.sections || []).filter((x) => x.kind === "barrage"); const nb = b.length ? b.map((x) => ({ title: x.title, when: x.when, rows: x.rows.map(packRow) })) : null; if (JSON.stringify(nb) !== JSON.stringify(st.barrages || null)) { if (nb) st.barrages = nb; else delete st.barrages; data.dirty = true; } }
      const n = res.rows.length;
      if (n !== st.nRows) st.changedAt = now;
      if (JSON.stringify(res) !== JSON.stringify(st.results || null)) { st.results = res; data.dirty = true; }
      st.resultsAt = now; st.nRows = n;
      if (task.key === ev.key && task.heat && st.resHeat !== task.heat) { st.resHeat = task.heat; data.dirty = true; }
      if (task.key === ev.key && task.final) { st.resFinalAt = now; data.dirty = true; }
      const exp = expected({ ...ev, heats: st.heats });
      // série finale d'une épreuve au temps (800, 1500) : même page que les séries lentes du matin → pas terminée avant son heure
      const sf = ev.typ === 61 && evs.some((x) => x.typ === 62); const at = sf ? evStartAt(c, ev) : null;
      if (sf && at && now < at + 3 * 60e3) { if (st.doneAt) { delete st.doneAt; data.dirty = true; } continue; }
      if (n && !st.doneAt && (n >= exp || exp === 0)) st.doneAt = now;
    }
  }
}
// stockage compact (10 ms de calcul par passage en offre gratuite) : champs inutiles retirés, passages à plat [d1, t1, d2, t2…]
const strip0 = (o) => { for (const k of Object.keys(o)) if (o[k] == null || o[k] === "" || (Array.isArray(o[k]) && !o[k].length)) delete o[k]; return o; };
export function packRow(r) {
  const sp = []; for (const x of r.splits || []) if (x.d && x.cum != null) sp.push(x.d, x.cum);
  return strip0({ place: r.place, name: r.name, iuf: r.iuf, year: r.year, nat: r.nat && !/^fra$/i.test(r.nat) ? r.nat : null, club: r.club, time: r.time, status: r.status, reason: r.reason, points: r.points, qual: r.qual, team: r.team, hc: r.hc ? 1 : null,
    relay: r.relay ? r.relay.map((m) => strip0({ name: m.name, iuf: m.iuf, year: m.year, leg: m.leg })) : null, sp });
}
export const packLane = (l) => strip0({ lane: l.lane, name: l.name, year: l.year, club: l.club, entry: l.entry, members: l.members });
const isSeries = (e) => !e.typ || e.typ === 60 || e.typ === 62 || e.typ === 61;
// section de la page de résultats qui correspond à un tour du programme
export function pickSection(ev, r) {
  if (!r.sections) return isSeries(ev) || !r.title ? r : null;
  if (isSeries(ev)) return r.sections.find((x) => x.kind === "series") || null;
  const finals = r.sections.filter((x) => x.kind === "final");
  // l'horaire du tour est le repère le plus sûr (« Finale rouge » n'a pas de lettre)
  const hh = (x) => (String(x || "").match(/(\d{1,2})h(\d{2})/) || []).slice(1).join("h");
  const byTime = ev.time ? finals.filter((x) => hh(x.when) && hh(x.when) === hh(ev.time)) : [];
  if (byTime.length === 1) return byTime[0];
  const cand = finals.filter((x) => x.fin === ev.fin);
  if (cand.length <= 1) return cand[0] || null;
  // plusieurs finales A (finales par âge) : on compare les âges / catégories
  const toks = (x) => new Set((String(x || "").match(/u?\d+/gi) || []).map((t) => t.toLowerCase()));
  const want = toks(ev.category); let best = null, bs = 0;
  for (const x of cand) { const have = toks(x.cat); let sc = 0; for (const t of want) if (have.has(t)) sc++; if (sc > bs) { bs = sc; best = x; } }
  return best;
}

// Plannings des lives : pour chacun, ses créneaux de réunion (de 30 min avant les portes à 2 h après la dernière épreuve).
// La tâche de chaque minute s'en sert pour donner la priorité au live en cours, sans avoir à charger les autres.
// Réécrit seulement quand il change (quelques écritures KV par jour).
function liveWins(cfg, data) {
  const out = [];
  if (cfg.scrape?.onlyLive === false) return [[0, 9e15]];
  for (const id of cfg.comps) {
    const c = data.comps[id]; if (!c) continue;
    for (const r of c.reunions || []) {
      const dt = compDate({ date: r.day }) || compDate(c.meta); if (!dt) continue;
      if (reuDone(c, r)) continue;
      const evs = r.items.filter((i) => i.kind === "event" && i.time);
      const first = hToMin(r.doors) ?? hToMin(evs[0]?.time); const last = hToMin(evs[evs.length - 1]?.time); if (first == null) continue;
      const day = parisEpoch(dt.y, dt.m, dt.d); out.push([day + (first - 30) * 60e3, day + ((last ?? first) + 120) * 60e3]);
    }
  }
  return out;
}
async function markHot(env, ev, wins, catchup, done = false) {
  const h = (await env.KV.get("hot", "json")) || {}; const cur = JSON.stringify(h[ev] || null);
  // done : compétition terminée → plus jamais visitée par la tâche de chaque minute (jusqu'à une modification des réglages)
  const nxt = done ? { f: 1 } : wins.length || catchup ? { w: wins, c: catchup ? 1 : 0 } : null;
  if (cur === JSON.stringify(nxt)) return;
  if (nxt) h[ev] = nxt; else delete h[ev];
  await env.KV.put("hot", JSON.stringify(h));
}
// Journal des incidents (lecture du Live FFN ratée, erreur du serveur…) : gardé dans un Durable Object,
// écrit seulement en cas de souci, lisible et copiable depuis l'admin
function logErr(env, ev, src, msg) {
  try { return env.POOL.get(env.POOL.idFromName("journal")).fetch(new Request("https://pool/log", { method: "POST", body: JSON.stringify({ ev, src, msg: String(msg || "").slice(0, 400) }) })).catch(() => {}); } catch (e) { return Promise.resolve(); }
}
export async function cycle(env, { force = false, ev = "main", budget = BUDGET } = {}) {
  ENV = env;
  const { config, data } = await load(env, ev);
  // compétitions retirées de l'événement : leurs données ne servent plus et alourdissent chaque lecture
  let pruned = false;
  for (const id of Object.keys(data.comps || {})) if (!config.comps.includes(id)) { delete data.comps[id]; pruned = true; }
  if (pruned) await saveData(env, data, "", ev);
  const now = Date.now();
  const every = (config.scrape?.every ?? 2) * 60e3;
  if (!force) {
    if (!config.comps.length) return 0;
    if (!every) return 0; // récupération manuelle uniquement
    if (data.lastRun && now - data.lastRun < every - 5e3) return 0;
    // compétitions terminées : plus de synchronisation automatique, seulement à la demande depuis l'admin
    if (finished(config, data, now) && !(data.queue || []).length) {
      if (!data.finished) { data.finished = now; await saveData(env, data, "", ev); } await markHot(env, ev, [], false, true);
      return 0;
    }
  }
  // le Live FFN nous a refusé l'accès (HTTP 403) il y a moins de 90 s : on le laisse souffler avant de réessayer
  // pause qui s'allonge à chaque refus (10 min, 20 min… jusqu'à 2 h, 20 min au plus pendant une réunion) : insister prolonge le blocage
  if (!force && data.block && now < data.block.until) return 0;
  if (data.finished && !finished(config, data, now)) data.finished = null;
  const live = force || windowOpen(config, data, now) || (pastEnd(config, data, now) && !finished(config, data, now));
  if (!force) await markHot(env, ev, finished(config, data, now) ? [] : liveWins(config, data), pastEnd(config, data, now) && !finished(config, data, now));
  data.queue = data.queue || [];
  // file de lectures demandées à la main : abandonnée au bout de 6 h, et la nuit (hors réunion) elle attend le matin
  if (data.queue.length && data.queueAt && now - data.queueAt > 6 * 3600e3) { data.queue = []; data.dirty = true; }
  if (data.queue.length && !force && !live) { const hh = +new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(now); if (hh >= 22 || hh < 6) return 0; }
  let errors = 0, used = 0;
  const seen = new Set();
  // deux tours : le programme lu au premier tour permet de planifier les séries et résultats au second
  // pages refusées : gardées dans les données de l'événement (écrites de toute façon après une erreur), pour survivre aux redémarrages
  const FAILS = (data.fails = data.fails || {});
  for (const k of Object.keys(FAILS)) if (now - FAILS[k].at > 24 * 3600e3) delete FAILS[k];
  for (let round = 0; round < 2 && used < budget && !errors; round++) {
    const fromQueue = data.queue.length > 0;
    if (round === 0 && live && !fromQueue) LIVEINFO = await liveInfo(env, config);
    const tasks = (fromQueue ? data.queue : plan(config, data, now, live, LIVEINFO)).filter((t) => !seen.has(JSON.stringify(t)) && (force || fromQueue || !FAILS[failKey(ev, t)] || now - FAILS[failKey(ev, t)].at >= failWait(FAILS[failKey(ev, t)], t)));
    if (!tasks.length) break;
    const todo = tasks.slice(0, budget - used);
    if (fromQueue) data.queue = data.queue.slice(todo.length);
    for (let ti = 0; ti < todo.length; ti++) {
      const t = todo[ti];
      seen.add(JSON.stringify(t)); used++;
      try { await runTask(t, data, now); if (FAILS[failKey(ev, t)]) { delete FAILS[failKey(ev, t)]; data.dirty = true; } }
      catch (e) {
        const fk = failKey(ev, t); FAILS[fk] = { n: (FAILS[fk]?.n || 0) + 1, at: now };
        errors++; data.error = String(e.message || e); data.errorAt = now;
        await logErr(env, ev, "lecture " + t.t + (t.epr ? " épreuve " + t.epr : "") + " (comp. " + t.c + ")", data.error);
        // Live FFN indisponible : la tâche ratée et les suivantes reviennent dans la file, rien n'est perdu
        if (/HTTP 403/.test(data.error)) { const n = (data.block?.n || 0) + 1; data.block = { n, until: now + Math.min(live ? 20 * 60e3 : 2 * 3600e3, 10 * 60e3 * 2 ** (n - 1)) }; }
        // la tâche ratée revient dans la file (sauf après 3 refus : abandonnée), les suivantes aussi
        if (/indisponible/.test(data.error)) { if (fromQueue) data.queue = [...todo.slice(ti + (FAILS[fk].n >= 3 ? 1 : 0)), ...data.queue]; break; }
      }
    }
  }
  if (!used) return 0;
  data.lastRun = now;
  if (!errors) { data.lastOk = now; data.error = null; if (data.block) { delete data.block; data.dirty = true; } }
  // les horodatages seuls ne justifient pas une écriture KV (1 000 écritures/jour en gratuit) : on écrit si le contenu a changé
  // (repéré pendant la lecture, sans recomparer tout le fichier : trop coûteux pour une grosse compétition)
  const dirty = data.dirty || errors || data.queue.length; delete data.dirty;
  if (dirty || !data.savedAt) { data.savedAt = now; await saveData(env, data, "", ev); }
  return used;
}

// ---------- records personnels (FFN Extranat) ----------
// La veille et pendant la compétition, quelques nageurs par minute : nom + année → licence → meilleures perfs (avec passages).
const mppKey = (name, year) => String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim() + "|" + (year || "");
// nageurs dont on cherche les records (listes de départ + résultats), clé → { name, year, pool, events, iuf }
function mppWant(config, data, ev, now, force) {
  const want = new Map(); // clé nageur → { name, year, pool, events:Set }
  for (const id of config.comps) {
    const c = data.comps[id]; if (!c) continue; let dt = compDate(c.meta); for (const r of c.reunions || []) { const d = compDate({ date: r.day }); if (d && (!dt || Date.UTC(d.y, d.m, d.d) < Date.UTC(dt.y, dt.m, dt.d))) dt = d; } if (!dt) dt = force ? { y: 2000, m: 1, d: 1 } : null; if (!dt) continue; // date lue dans l'en-tête ou les réunions ; lecture forcée : même sans date
    const day = parisEpoch(dt.y, dt.m, dt.d); if (!force && ev !== "test" && (now < day - 5 * 864e5 || now > day + 2 * 864e5)) continue; // l'épreuve test (simulateur) rejoue d'anciennes compétitions : pas de fenêtre de dates
    const pool = +((c.meta?.pool || "").match(/\d+/) || [25])[0] === 50 ? 50 : 25;
    for (const e of eventsOf(c)) {
      const ek = normEvent(e.name); if (!ek) continue;
      const st = c.events?.[e.key] || {};
      // nageurs des listes de départ, et aussi des résultats (compétition déjà nagée)
      const lanes = [...(st.heats || []).flatMap((h) => h.lanes || []), ...(st.results?.rows || []).filter((r) => !r.relay)];
      for (const l of lanes) {
        if (l.members && !l.relay) { lanes.push(...l.members.slice(1).map((m) => ({ ...m }))); } if (!l.name || (l.members && l.relay) || !l.year) continue; const k = mppKey(l.name, l.year);
        const w = want.get(k) || { name: l.name, year: l.year, pool, events: new Set(), day }; if (day < w.day) w.day = day; if (l.iuf) w.iuf = String(l.iuf); w.events.add(ek); want.set(k, w);
      }
    }
  }
  return want;
}
async function mppStatus(env, ev) {
  const { config, data } = await load(env, ev); const now = Date.now();
  const want = mppWant(config, data, ev, now, true); const store = (await env.KV.get(kk("mpp", ev), "json")) || { sw: {} };
  let done = 0, found = 0, best = 0, err = 0, noRec = 0, notFound = 0; const issues = [];
  for (const k of want.keys()) { const x = store.sw[k]; if (!x || !x.at) continue; if (x.err) { err++; issues.push({ k, why: "err", msg: String(x.err).slice(0, 80) }); continue; } done++; if (x.iuf) found++; const has = x.b && Object.keys(x.b).length; if (has) best++; else if (x.iuf) { noRec++; issues.push({ k, why: "norec" }); } else { notFound++; issues.push({ k, why: "notfound" }); } }
  return { want: want.size, done, left: want.size - done, foundN: found, bestN: best, errN: err, noRecN: noRec, notFoundN: notFound, issues: issues.slice(0, 400) };
}
async function mppStep(env, ev, max = 2, force = false) {
  const { config, data } = await load(env, ev); const now = Date.now();
  // compétition terminée : plus aucune relecture automatique des records, seulement à la demande
  if (!force && finished(config, data, now)) return 0;
  // records lus au plus tard la veille : plus aucune lecture automatique à partir du 1er jour de compétition (écritures économisées)
  if (!force) { let first = Infinity; for (const id of config.comps) { const c = data.comps[id]; for (const r of c?.reunions || []) { const dt = compDate({ date: r.day }) || compDate(c.meta); if (dt) first = Math.min(first, parisEpoch(dt.y, dt.m, dt.d)); } }
    if (now >= first) return 0; }
  const want = mppWant(config, data, ev, now, force);
  if (!want.size) return 0;
  const store = (await env.KV.get(kk("mpp", ev), "json")) || { sw: {} };
  // tâche automatique : au plus une écriture toutes les 10 min par événement (1 000 écritures KV/jour en gratuit, tous événements confondus)
  if (!force && store.at && now - store.at < 10 * 60e3) return 0;
  const empty = (x) => !Object.keys(x.b || {}).length;
  // lecture forcée : on reprend tout de suite les échecs et les nageurs retrouvés sans record
  // un record déjà lu n'est plus relu une fois la compétition commencée : on garde le record d'avant la course
  const stale = (x, w) => !x || (now - x.at > 5 * 864e5 && !(w && now >= w.day && !empty(x) && !x.err)) || (x.err && (force || now - x.at > 3600e3)) || (x.iuf && empty(x) && (force || now - x.at > 3600e3)) || (!x.iuf && (force || now - x.at > 864e5));
  const prio = (x) => (!x ? 0 : x.err ? 1 : empty(x) ? 2 : 3); // jamais lus d'abord, puis échecs, puis sans record, du plus ancien au plus récent
  const todo = [...want.entries()].filter(([k, w]) => stale(store.sw[k], w)).sort(([a], [b]) => prio(store.sw[a]) - prio(store.sw[b]) || (store.sw[a]?.at || 0) - (store.sw[b]?.at || 0)).slice(0, max);
  if (!todo.length) return 0;
  let used = 0;
  for (const [k, w] of todo) {
    try {
      const iuf = w.iuf || store.sw[k]?.iuf || (used++, await findIuf(w.name, w.year));
      let b = {};
      if (iuf) { const all = await fetchMpp(iuf); used++; const p = all[w.pool] || {}; for (const e of w.events) if (p[e]) b[e] = p[e]; }
      store.sw[k] = { iuf: iuf || null, at: now, pool: w.pool, b };
    } catch (e) { store.sw[k] = { iuf: w.iuf || store.sw[k]?.iuf || null, at: now, b: {}, err: String(e.message || e) }; break; } // échec (Extranat) : nouvel essai dans 1 h
  }
  store.at = now; await env.KV.put(kk("mpp", ev), JSON.stringify(store));
  return used;
}

// ---------- API ----------
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });
const same = (k, p) => { if (!p || k.length !== p.length) return false; let d = 0; for (let i = 0; i < p.length; i++) d |= k.charCodeAt(i) ^ p.charCodeAt(i); return d === 0; };
function authed(req, env) { return same(req.headers.get("x-admin-key") || "", env.ADMIN_PASSWORD || ""); }
// relais du Quantum : sa propre clé (secret RELAY_KEY), pour ne pas laisser le mot de passe admin sur le PC du chrono
function relayAuthed(req, env) { return authed(req, env) || same(req.headers.get("x-admin-key") || "", env.RELAY_KEY || ""); }
// accès organisateur : un mot de passe par événement (seule son empreinte salée est gardée)
let ORGC = { at: 0, map: null };
async function orgKeys(env) { if (ORGC.map && Date.now() - ORGC.at < 60e3) return ORGC.map; const m = (await env.KV.get("orgkeys", "json")) || {}; ORGC = { at: Date.now(), map: m }; return m; }
async function sha(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function orgMatch(env, key, ev) { const e = (await orgKeys(env))[ev]; return !!(key && e && same(await sha(e.salt + "|" + key), e.hash)); }
// événement dont le mot de passe organisateur correspond (relais du Quantum sans « --evenement »)
async function orgEventOf(env, key) { if (!key) return null; for (const [ev, e] of Object.entries(await orgKeys(env))) if (same(await sha(e.salt + "|" + key), e.hash)) return ev; return null; }
// chronométrage relié par clé : l'exe du PC du chrono génère une clé, l'organisateur la colle dans l'admin de son live
const SYSK = new Set(["quantum", "ares", "stramatel"]);
const PAIR_RE = /^SD(-[A-Z2-9]{4}){4}$/;
let PAIRC = { at: 0, map: null };
async function pairs(env) { if (PAIRC.map && Date.now() - PAIRC.at < 30e3) return PAIRC.map; const m = (await env.KV.get("pairs", "json")) || {}; PAIRC = { at: Date.now(), map: m }; return m; }
async function pairOf(env, token) { if (!PAIR_RE.test(token || "")) return null; const h = await sha("pair|" + token); return (await pairs(env))[h] ? { h, ...(await pairs(env))[h] } : null; }
// anti-essais en rafale : 10 mauvais mots de passe en 15 min depuis la même adresse = blocage 15 min
async function tooManyFails(req, ok) {
  const ip = req.headers.get("cf-connecting-ip") || "?"; const key = new Request("https://lock.local/" + encodeURIComponent(ip));
  const hit = await caches.default.match(key); const n = hit ? +(await hit.text()) || 0 : 0;
  if (n >= 10) return true;
  if (!ok) await caches.default.put(key, new Response(String(n + 1), { headers: { "cache-control": "max-age=900" } }));
  return false;
}
function publicConfig(cfg) { const { scrape, ...rest } = cfg; return rest; }

async function rescrape(env, scope, what, ev = "main") {
  const { config, data } = await load(env, ev);
  // compétitions retirées de l'événement : leurs données ne servent plus et alourdissent chaque lecture
  let pruned = false;
  for (const id of Object.keys(data.comps || {})) if (!config.comps.includes(id)) { delete data.comps[id]; pruned = true; }
  if (pruned) await saveData(env, data, "", ev);
  const before = JSON.stringify(data);
  const comps = scope?.startsWith("c") ? [scope.slice(1)] : config.comps;
  const reu = scope?.startsWith("r") ? +scope.slice(1) : null;
  const tasks = [];
  for (const id of comps) {
    const c = data.comps[id];
    if (what === "all" && !reu) { data.comps[id] = { events: {} }; tasks.push({ t: "prog", c: id }); }
    else tasks.push({ t: "prog", c: id }); // le programme est toujours relu (nouvelles épreuves, finales, horaires)
    const now = Date.now(), dayOf = (n) => (c?.reunions || []).find((r) => r.n === n);
    const evs = c ? eventsOf(c).filter((e) => !reu || e.reunion === reu) : [];
    // lecture à la demande, économe : pas de page Live FFN qui ne peut pas encore exister (épreuve pas encore cliquable, réunion des jours suivants pour les résultats)
    for (const e of evs.filter((x) => !x.provisional && !x.soon)) {
      const later = dayOf(e.reunion) && beforeDay(c, dayOf(e.reunion), now);
      const st = c.events?.[e.key];
      if (st && (what === "all" || what === "start")) { delete st.heats; delete st.heatsAt; }
      if (st && (what === "all" || what === "res")) { delete st.results; delete st.resultsAt; delete st.doneAt; delete st.nRows; }
      if (what !== "res" && !(e.key !== String(e.epr) && later)) tasks.push({ t: "heats", c: id, epr: e.epr, key: e.key }); // finales : pas avant leur jour
      if (what !== "start" && !later && !tasks.some((t) => t.t === "res" && t.c === id && t.epr === e.epr)) tasks.push({ t: "res", c: id, epr: e.epr });
    }
  }
  data.queue = tasks; data.queueAt = Date.now(); data.savedAt = 0; delete data.block; // demande manuelle : on retente tout de suite, une fois
  await saveData(env, data, before, ev);
  return tasks.length;
}

export default {
  async fetch(req, env, ctx) {
    env = euEnv(env); // données et relais en Europe
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    const ev = url.searchParams.get("e") || "main";
    const KEY = req.headers.get("x-admin-key") || "";
    const ADM = authed(req, env);
    // organisateur : mot de passe propre à cet événement (ou, pour le relais sans événement, à l'événement correspondant)
    const ORG = !ADM && !!KEY && EV_RE.test(ev) && (await orgMatch(env, KEY, ev));
    const RELAYEV = !ADM && KEY && p === "/api/pool/event" && !url.searchParams.get("e") ? await orgEventOf(env, KEY) : null;
    const CAN = ADM || ORG;
    if (KEY && (await tooManyFails(req, CAN || !!RELAYEV || (p === "/api/pool/event" && relayAuthed(req, env)))))
      return json({ error: "Trop d'essais de mot de passe. Réessaie dans 15 minutes." }, 429);
    if (!EV_RE.test(ev)) return json({ error: "Événement inconnu." }, 404);
    if (ev !== "main" && p !== "/api/admin/events" && p !== "/api/hit" && !(await listEvents(env)).some((x) => x.id === ev)) return json({ error: "Événement inconnu." }, 404);
    const ckey = (path) => new Request(url.origin + path + (path.includes("?") ? "&" : "?") + "e=" + ev);

    // lectures publiques gardées en cache (chaque lecture KV compte dans le quota gratuit)
    const EDGE = { "/api/events": 0, "/api/logos": 0, "/api/mpp": 1, "/api/sponsors": 1 };
    const edgeKey = p in EDGE ? (EDGE[p] ? ckey(p) : new Request(url.origin + p)) : null;
    if (edgeKey && req.method === "GET") { const hit = await caches.default.match(edgeKey); if (hit) return hit; }
    const edge = (res) => { if (edgeKey && res.ok) ctx.waitUntil(caches.default.put(edgeKey, res.clone())); return res; };

    // ancienne adresse /e/main : où le live a été déplacé
    if (p === "/api/moved") { const c = (await env.KV.get(kk("config", "main"), "json")) || {}; return json({ to: c.published ? "" : c.movedTo || "" }); }
    // liste publique des événements (pour l'accueil et le partage)
    if (p === "/api/events" && req.method === "GET") {
      const all = [{ id: "main" }, ...(await listEvents(env))];
      const out = [];
      for (const x of all) {
        const c = await env.KV.get(kk("config", x.id), "json"); if (!c || !c.published) continue;
        // page d'accueil : ville, bassin et dates lues dans le texte brut (sans relire tout le fichier de données)
        const raw = (await env.KV.get(kk("data", x.id))) || ""; const metas = [];
        for (const m of raw.matchAll(/"meta":(\{[^{}]*\})/g)) { try { metas.push(JSON.parse(m[1])); } catch (e) {} if (metas.length >= 6) break; }
        out.push({ id: x.id, name: c.name || x.name || "", main: x.id === "main", theme: c.theme || "alsace", color: c.color || "", org: c.org ?? (c.theme && c.theme !== "alsace" ? "" : "Fédération Alsacienne de Natation"), live: c.live || "off",
          comps: metas.map((m) => ({ name: m.name || "", city: m.city || "", pool: m.pool || "", date: m.date || "" })) });
      }
      return edge(json(out, 200, { "cache-control": "public, max-age=60" }));
    }

    if (p === "/api/state" && req.method === "GET") {
      const cache = caches.default; const key = ckey("/api/state");
      const hit = await cache.match(key); if (hit) return hit;
      // le fichier de données est renvoyé tel quel (sans le relire ni le réécrire : trop coûteux pour une grosse compétition)
      const [c0, raw] = await Promise.all([env.KV.get(kk("config", ev), "json"), env.KV.get(kk("data", ev))]);
      const config = { ...DEFAULT_CONFIG, ...(c0 || {}) };
      const now = Date.now();
      const res = config.published
        ? new Response(`{"published":true,"config":${JSON.stringify(publicConfig(config))},"data":${raw || '{"comps":{}}'},"now":${now}}`, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=15" } })
        : json({ published: false, now }, 200, { "cache-control": "public, max-age=15" });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }

    // logiciel du chrono relié par clé de liaison
    const TOKEN = req.headers.get("x-relay-token") || "";
    if (TOKEN && p.startsWith("/api/relay/")) {
      const pr = await pairOf(env, TOKEN);
      if (p === "/api/relay/hello") {
        if (!pr) return json({ linked: false });
        const c = (await env.KV.get(kk("config", pr.ev), "json")) || {};
        return json({ linked: true, ev: pr.ev, name: c.name || pr.ev, url: url.origin + "/e/" + pr.ev, bassin: c.live === "bassin", sys: pr.sys || c.chronoSys || "quantum", now: Date.now() });
      }
      if (!pr) return json({ error: "Clé pas encore reliée à un live." }, 409);
      const room = env.POOL.get(env.POOL.idFromName(pr.ev === "main" ? "bassin" : "bassin:" + pr.ev));
      const ver = encodeURIComponent((req.headers.get("x-chrono-version") || "").slice(0, 20));
      if (p === "/api/relay/event" && req.method === "POST") return room.fetch(new Request("https://pool/event?ver=" + ver, { method: "POST", body: await req.text() }));
      if (p === "/api/relay/log" && req.method === "POST") return room.fetch(new Request("https://pool/log?ver=" + ver + "&day=" + (url.searchParams.get("day") || ""), { method: "POST", body: await req.arrayBuffer() }));
      return json({ error: "Inconnu" }, 404);
    }

    // Direct « Bassin » (Quantum) : salle temps réel. Le relais envoie les événements avec le mot de passe admin.
    if (p.startsWith("/api/pool/")) {
      let rid = ev;
      // le relais sans « --evenement » : le chrono va à l'événement réglé en mode « Bassin » dans l'admin
      if (RELAYEV) rid = RELAYEV;
      else if (p === "/api/pool/event" && !url.searchParams.get("e")) {
        for (const x of [{ id: "main" }, ...(await listEvents(env))]) { const c = await env.KV.get(kk("config", x.id), "json"); if (c && c.live === "bassin") { rid = x.id; break; } }
      }
      const { config } = await load(env, rid);
      const room = env.POOL.get(env.POOL.idFromName(rid === "main" ? "bassin" : "bassin:" + rid));
      if (p === "/api/pool/event") {
        if (!relayAuthed(req, env) && !ORG && !RELAYEV) return json({ error: "Mot de passe incorrect." }, 401);
        if (url.searchParams.get("sim") && !ADM) return adminOnly(); // simulateur : réservé à l'administrateur du site
        return room.fetch(new Request("https://pool/event", { method: "POST", body: await req.text() }));
      }
      if (config.live !== "bassin" && !CAN) return json({ error: "Direct bassin non activé." }, 404);
      if (p === "/api/pool/ws") return room.fetch(new Request("https://pool/ws", req));
      if (p === "/api/pool/state") return room.fetch(new Request("https://pool/state"));
      return json({ error: "Inconnu" }, 404);
    }

    // Direct « Live FFN » : dernière série publiée et série suivante, relues au plus toutes les 30 s (cache)
    if (p === "/api/live" && req.method === "GET") {
      const c = url.searchParams.get("c") || "";
      const { config, data } = await load(env, ev);
      if (!["ffn", "bassin"].includes(config.live) || !config.comps.includes(c) || (!config.published && !CAN)) return json({ error: "Direct non activé." }, 404);
      const now = Date.now();
      // entre deux réunions : le direct est en pause, on ne dérange pas le Live FFN
      if (!liveOpen(data.comps[c], now)) {
        // réunion qui vient de se terminer : la dernière série reste affichée 30 min (copie gardée en mémoire, sans redemander)
        const cc = data.comps[c]; const lastDone = Math.max(0, ...Object.values(cc?.events || {}).map((e) => e.doneAt || 0));
        if (lastDone && now - lastDone < 30 * 60e3 && LIVEOK[c]?.cur?.heat) return json({ ...LIVEOK[c], grace: true }, 200, { "cache-control": "public, max-age=60" });
        // sinon (mémoire de l'instance perdue, résultats pas encore lus) : dernière série gardée par le relais, si elle a moins de 30 min
        const lh = await lastHeat(env, c, now); if (lh && now - lh.at < 30 * 60e3) return json({ at: lh.at, cur: lh, grace: true }, 200, { "cache-control": "public, max-age=60" });
        return json({ at: now, pause: true }, 200, { "cache-control": "public, max-age=60" });
      }
      // mémoire de l'instance : un seul appel au relais toutes les 30 s par instance (le cache Cloudflare ne marche pas sur workers.dev)
      const m = LIVEMEMO[c]; if (m && now - m.t < 30e3) return json(m.body, 200, { "cache-control": "public, max-age=20" });
      let body = null;
      try {
        for (const n of ["ffnlive:" + c, "ffnB:" + c]) { // relais de secours si le premier est refusé par le Live FFN
          const b = await (await env.POOL.get(env.POOL.idFromName(n)).fetch(new Request("https://pool/ffnlive?u=" + encodeURIComponent(urls.live(c))))).json();
          if (!body || (b.raw != null && !b.error) || (body.raw == null && b.raw != null)) body = b;
          if (b.raw != null && !b.error) break;
        }
      } catch (e) { body = { at: now, error: "relais indisponible : " + String(e.message || e).slice(0, 80) }; }
      const heats = body.heats || null;
      if (body.raw != null) { const b0 = body; try { body = { at: b0.at, ...parseLive(b0.raw), ...(b0.error ? { stale: true, staleError: b0.error, fresh: b0.fresh } : {}) }; } catch (e) { body = { at: now, error: String(e.message || e) }; } }
      if ((body.error || body.staleError) && body.fresh) ctx.waitUntil(logErr(env, ev, "direct Live FFN (comp. " + c + ")", body.error || body.staleError));
      if (body.error) {
        if (LIVEOK[c]) body = { ...LIVEOK[c], stale: true, staleError: body.error };
        else { const lh = await lastHeat(env, c, now); if (lh) body = { at: lh.at, cur: lh, stale: true, staleError: body.error }; }
      } else if (!body.cur?.title && LIVEOK[c]?.cur && now - (LIVEOK[c].okAt || 0) < 15 * 60e3) body = { ...body, cur: LIVEOK[c].cur, held: true }; // page du Live FFN vide entre deux épreuves : on garde la dernière série (15 min au plus)
      else LIVEOK[c] = { ...body, okAt: now };
      if (heats) body = { ...body, heats }; else if (m && m.body.heats) body = { ...body, heats: m.body.heats };
      LIVEMEMO[c] = { t: now, body };
      // série en cours avec des temps : gardée (une fois par série) pour le classement provisoire de l'onglet Résultats
      const cur = body.cur; const sig = cur && cur.heat ? cur.event + "|" + cur.heat + "|" + cur.rows.filter((r) => r.time != null).length : "";
      if (sig && sig !== LHSIG[c] && cur.rows.some((r) => r.time != null)) { LHSIG[c] = sig;
        ctx.waitUntil(env.POOL.get(env.POOL.idFromName("ffnlive:" + c)).fetch(new Request("https://pool/lh", { method: "POST", body: JSON.stringify({ event: cur.event, heat: cur.heat, of: cur.of, rows: cur.rows.map(({ rank, ...r }) => r) }) })).catch(() => {})); }
      return json(body, 200, { "cache-control": "public, max-age=20" });
    }
    if (p === "/api/liveheats" && req.method === "GET") { // ancienne page : les séries arrivent maintenant avec /api/live
      const c = url.searchParams.get("c") || ""; const m = LIVEMEMO[c];
      return json((m && m.body.heats) || [], 200, { "cache-control": "public, max-age=60" });
    }

    if (p === "/api/admin/mpp" && req.method === "GET") {
      if (!CAN) return json({ error: "Mot de passe incorrect." }, 401);
      return json(await mppStatus(env, ev));
    }
    if (p === "/api/admin/mpp" && req.method === "POST") {
      if (!ADM) return adminOnly(); // synchronisations manuelles : réservées à l'administrateur du site
      if (!CAN) return json({ error: "Mot de passe incorrect." }, 401);
      const body = await req.json().catch(() => ({}));
      // tout écraser : on oublie les records lus (en gardant les licences retrouvées) pour tout relire sur l'Extranat
      if (body.reset) { const st0 = (await env.KV.get(kk("mpp", ev), "json")) || { sw: {} }; for (const [k, x] of Object.entries(st0.sw)) st0.sw[k] = { iuf: x.iuf || null, at: 0, b: {} }; st0.at = 0; await env.KV.put(kk("mpp", ev), JSON.stringify(st0)); }
      const used = await mppStep(env, ev, 6, true); const store = (await env.KV.get(kk("mpp", ev), "json")) || { sw: {} };
      const all = Object.entries(store.sw);
      // diagnostic : quelques exemples (nom lu, licence trouvée, erreur éventuelle) pour comprendre un échec
      const sample = all.slice(-6).map(([k, x]) => ({ k, iuf: x.iuf, n: Object.keys(x.b || {}).length, err: x.err || null }));
      let probe = null; try { const r = await fetch("https://ffn.extranat.fr/webffn/_recherche.php?go=ind&idrch=" + encodeURIComponent(all.length ? all[all.length - 1][0].split("|")[0] : "LOZAC'H Alienor"), { headers: { "User-Agent": "SwimDirect/1.0" } }); probe = { status: r.status, body: (await r.text()).slice(0, 300) }; } catch (e) { probe = { error: String(e.message || e) }; }
      let probe2 = null; const one = all.find(([, x]) => x.iuf);
      if (one) { try { const r = await fetch("https://ffn.extranat.fr/webffn/nat_recherche.php?idact=nat", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": "SwimDirect/1.0" }, body: new URLSearchParams({ idact: "nat", idrch_id: one[1].iuf, idiuf: one[1].iuf, idopt: "mpp" }) }); const t = await r.text(); probe2 = { status: r.status, len: t.length, bassins: (t.match(/Bassin\s*:\s*\d+/gi) || []).length, rows: (t.match(/scope=["']row["']/g) || []).length, setCookie: r.headers.get("set-cookie") ? 1 : 0 }; } catch (e) { probe2 = { error: String(e.message || e) }; } }
      const st = await mppStatus(env, ev);
      return json({ ok: true, used, ...st, total: all.length, probe2, found: all.filter(([, x]) => x.iuf).length, withBest: all.filter(([, x]) => x.b && Object.keys(x.b).length).length, sample, probe });
    }
    if (p === "/api/mpp" && req.method === "GET") {
      const store = (await env.KV.get(kk("mpp", ev), "json")) || { sw: {} };
      const out = {}; for (const k in store.sw) if (store.sw[k].b && Object.keys(store.sw[k].b).length) out[k] = { iuf: store.sw[k].iuf, b: store.sw[k].b };
      return edge(json({ at: store.at || null, sw: out }, 200, { "cache-control": "public, max-age=300" }));
    }

    // records perso au format tableur (pour le livestream, les coachs…) : un nageur × une épreuve par ligne
    if (p === "/api/records.csv" && req.method === "GET") {
      const [{ config, data }, store] = await Promise.all([load(env, ev), env.KV.get(kk("mpp", ev), "json")]);
      const sw = (store && store.sw) || {}; const who = {};
      for (const id of config.comps) { const c = data.comps[id]; if (!c) continue;
        for (const e of eventsOf(c)) { const st = c.events?.[e.key] || {};
          const lanes = [...(st.heats || []).flatMap((h) => h.lanes || []), ...(st.results?.rows || []).filter((r) => !r.relay)];
          for (const l of lanes) {
            if (l.members && !l.relay) { lanes.push(...l.members.slice(1).map((m) => ({ ...m }))); } if (!l.name || (l.members && l.relay) || !l.year) continue; const k = mppKey(l.name, l.year); if (!who[k] || (l.name.length > who[k].name.length && !/\.$/.test(l.name))) who[k] = { name: l.name, year: l.year, club: l.club || (who[k] && who[k].club) || "" }; } } }
      const f = (t) => { if (t == null) return ""; const m = Math.floor(t / 60), s = t - m * 60; return (m ? m + ":" + s.toFixed(2).padStart(5, "0") : s.toFixed(2)); };
      const q = (x) => { x = String(x ?? ""); return /[";\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
      
      const rows = []; let maxD = 0;
      for (const k in sw) { const x = sw[k]; if (!x.b) continue; const w = who[k] || { name: k.split("|")[0], year: k.split("|")[1] || "", club: "" };
        for (const evk in x.b) { const r = x.b[evk]; const dist = +(evk.match(/^\d+/) || [0])[0]; const sp = {}; for (const p of r.sp || []) if (p[0] < dist) sp[p[0]] = f(p[1]); if (dist > maxD) maxD = dist;
          rows.push([w.name, w.year, w.club, evk, f(r.t), r.d ? r.d.split("-").reverse().join("/") : "", x.iuf || "", sp]); } }
      rows.sort((a, b) => a[0].localeCompare(b[0]) || a[3].localeCompare(b[3]));
      // une colonne par passage (temps cumulés), de 50 m en 50 m jusqu'à 1 450 m : colonnes toujours aux mêmes places, simple à brancher sur une incrustation
      const ds = []; for (let d = 50; d < 1500; d += 50) ds.push(d);
      const lines = [["Nom", "Année", "Club", "Épreuve", "Record perso", "Date du record", "IUF", ...ds.map((d) => "Passage " + d + " m")].join(";")];
      for (const r of rows) { const sp = r.pop(); lines.push([...r, ...ds.map((d) => sp[d] || "")].map(q).join(";")); }
      return new Response("\ufeff" + lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="records-${ev}.csv"`, "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
    }
    // audience sans cookie : une empreinte hachée (IP + navigateur + semaine) par visiteur, rien de lisible n'est gardé
    if (p === "/api/hit" && req.method === "POST") {
      if (!env.STATS) return new Response(null, { status: 204 });
      // au plus une visite comptée toutes les 15 s par adresse (un robot qui mitraille ne coûte plus rien)
      { const ip = req.headers.get("cf-connecting-ip") || ""; const t = Date.now(); if (HITIP[ip] && t - HITIP[ip] < 15e3) return new Response(null, { status: 204 }); HITIP[ip] = t;
        if (Object.keys(HITIP).length > 5000) for (const k in HITIP) if (t - HITIP[k] > 15e3) delete HITIP[k]; }
      let body = {}; try { body = await req.json(); } catch (e) {}
      const path = String(body.p || "/");
      const m = path.match(/^\/e\/([a-z0-9][a-z0-9-]{0,39})/); const where = m ? m[1] : /^\/archives/.test(path) ? "~archives" : "~accueil";
      const now = new Date(); const pp = parisParts(now); const day = `${pp.y}-${String(pp.m).padStart(2, "0")}-${String(pp.d).padStart(2, "0")}`;
      const week = Math.floor((parisEpoch(pp.y, pp.m, pp.d) / 864e5 + 3) / 7); // change chaque lundi
      const raw = `${env.ADMIN_PASSWORD || "x"}|${week}|${req.headers.get("cf-connecting-ip") || ""}|${req.headers.get("user-agent") || ""}`;
      const k = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
      ctx.waitUntil(env.STATS.get(env.STATS.idFromName("stats")).fetch(new Request("https://stats/hit", { method: "POST", body: JSON.stringify({ day, ev: where, k, v: String(body.v || "").slice(0, 12) }) })).catch(() => {}));
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    // partenaires : ceux de tous les lives + ceux de cet événement
    if (p === "/api/sponsors" && req.method === "GET") {
      const [all, one, ta, te] = await Promise.all([env.KV.get("sponsors", "json"), env.KV.get(kk("sponsors", ev), "json"), env.KV.get("toplogo", "json"), env.KV.get("toplogo:ev:" + ev, "json")]);
      return edge(json({ all: all || [], ev: one || [], top: { all: ta, ev: te } }, 200, { "cache-control": "public, max-age=120" }));
    }
    if (p === "/api/logos" && req.method === "GET") {
      const logos = (await env.KV.get("logos", "json")) || {};
      return edge(json(logos, 200, { "cache-control": "public, max-age=300" }));
    }

    if (!CAN) return json({ error: env.ADMIN_PASSWORD ? "Mot de passe incorrect." : "Le mot de passe admin n'est pas encore configuré dans Cloudflare (variable ADMIN_PASSWORD)." }, 401);
    const purge = () => Promise.all([caches.default.delete(ckey("/api/state")), caches.default.delete(new Request(url.origin + "/api/events"))]);

    const adminOnly = () => json({ error: "Réservé à l'administrateur du site." }, 403);
    if (p === "/api/admin/pair") {
      const m = (await env.KV.get("pairs", "json")) || {};
      if (req.method === "GET") return json(Object.entries(m).filter(([, x]) => x.ev === ev).map(([h, x]) => ({ id: h.slice(0, 12), tail: x.tail, at: x.at, sys: x.sys || "quantum" })));
      const body = await req.json().catch(() => ({}));
      if (req.method === "PUT") {
        const t = String(body.token || "").toUpperCase().replace(/\s+/g, "").replace(/^SD-?/, "SD-").replace(/[^A-Z0-9-]/g, "");
        const tok = t.replace(/^SD-/, "").replace(/-/g, "").match(/.{1,4}/g); const norm = tok ? "SD-" + tok.join("-") : "";
        if (!PAIR_RE.test(norm)) return json({ error: "Clé invalide : copie-la telle qu'affichée par le logiciel du chrono (SD-XXXX-XXXX-XXXX-XXXX)." }, 400);
        const h = await sha("pair|" + norm); const was = m[h] && m[h].ev !== ev ? m[h].ev : null;
        m[h] = { ev, at: Date.now(), tail: norm.slice(-4), sys: SYSK.has(body.sys) ? body.sys : "quantum" }; await env.KV.put("pairs", JSON.stringify(m)); PAIRC.at = 0;
        return json({ ok: true, moved: was });
      }
      if (req.method === "PATCH") { if (!SYSK.has(body.sys)) return json({ error: "Type inconnu" }, 400); for (const h of Object.keys(m)) if (h.startsWith(String(body.id || "-")) && m[h].ev === ev) m[h].sys = body.sys; await env.KV.put("pairs", JSON.stringify(m)); PAIRC.at = 0; return json({ ok: true }); }
      if (req.method === "DELETE") { for (const h of Object.keys(m)) if (h.startsWith(String(body.id || "-")) && m[h].ev === ev) delete m[h]; await env.KV.put("pairs", JSON.stringify(m)); PAIRC.at = 0; return json({ ok: true }); }
    }
    if (p === "/api/admin/journal") {
      if (!ADM) return adminOnly(); // journal brut du chrono : réservé à l'administrateur du site
      const room = env.POOL.get(env.POOL.idFromName(ev === "main" ? "bassin" : "bassin:" + ev));
      const d = url.searchParams.get("day");
      try { return await room.fetch(new Request("https://pool/journal" + (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? "?day=" + d : ""))); }
      catch (e) { return json({ error: "Journal indisponible pour le moment (quota Cloudflare du jour atteint ?) : " + String(e.message || e).slice(0, 120) }, 503); }
    }
    // mot de passe organisateur de cet événement (défini par l'administrateur du site)
    if (p === "/api/admin/orgkey") {
      if (!ADM) return adminOnly();
      const m = (await env.KV.get("orgkeys", "json")) || {};
      if (req.method === "GET") return json({ set: !!m[ev] });
      const { pw = "" } = await req.json(); const s2 = String(pw);
      if (s2 && s2.length < 8) return json({ error: "Mot de passe trop court (8 caractères minimum)." }, 400);
      if (s2 && same(s2, env.ADMIN_PASSWORD || "")) return json({ error: "Choisis un mot de passe différent du mot de passe général." }, 400);
      if (s2) { const salt = crypto.randomUUID(); m[ev] = { salt, hash: await sha(salt + "|" + s2) }; } else delete m[ev];
      await env.KV.put("orgkeys", JSON.stringify(m)); ORGC.at = 0;
      return json({ ok: true, set: !!s2 });
    }
    // gestion des événements (créer / renommer / supprimer)
    if (p === "/api/admin/events") {
      const list = await listEvents(env);
      if (req.method === "GET") {
        const out = [];
        for (const x of [{ id: "main", name: "Événement principal" }, ...list]) { if (!ADM && x.id !== ev) continue; const c = await env.KV.get(kk("config", x.id), "json"); if (x.id === "main" && c && c.movedTo && !c.published && !(c.comps || []).length && ev !== "main") continue; out.push({ id: x.id, name: (c && c.name) || x.name || "", published: !!(c && c.published), comps: (c && c.comps) || [] }); }
        return json(out);
      }
      if (!ADM) return adminOnly();
      if (req.method === "POST") {
        const { name = "", comps = [] } = await req.json();
        let base = String(name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "evenement";
        let id = base, i = 2; while (id === "main" || list.some((x) => x.id === id)) id = `${base}-${i++}`;
        list.push({ id, name: String(name).slice(0, 120), createdAt: Date.now() });
        EVC.at = 0; await env.KV.put("events", JSON.stringify(list));
        const cfg = { ...DEFAULT_CONFIG, name: String(name).slice(0, 120), comps: comps.filter((c) => /^\d{3,7}$/.test(String(c))).map(String) };
        await env.KV.put(kk("config", id), JSON.stringify(cfg));
        if (cfg.comps.length) ctx.waitUntil(cycle(env, { force: true, ev: id }));
        await caches.default.delete(new Request(url.origin + "/api/events"));
        return json({ ok: true, id });
      }
      // changer l'adresse publique (/e/…) : réglages, données et records perso sont déplacés sous le nouveau nom
      if (req.method === "PATCH") {
        const { to = "" } = await req.json(); const id = String(to).toLowerCase().trim();
        if (!EV_RE.test(id) || id === "main") return json({ error: "Adresse invalide : lettres minuscules, chiffres et tirets (40 caractères max)." }, 400);
        if (id === ev) return json({ ok: true, id });
        if (list.some((x) => x.id === id)) return json({ error: "Cette adresse est déjà utilisée par un autre événement." }, 400);
        const [c, d, m, sp] = await Promise.all(["config", "data", "mpp", "sponsors"].map((k) => env.KV.get(kk(k, ev))));
        await Promise.all([c && env.KV.put(kk("config", id), c), d && env.KV.put(kk("data", id), d), m && env.KV.put(kk("mpp", id), m), sp && ev !== "main" && env.KV.put(kk("sponsors", id), sp)].filter(Boolean));
        const name = (c && JSON.parse(c).name) || (list.find((x) => x.id === ev) || {}).name || "";
        EVC.at = 0; await env.KV.put("events", JSON.stringify([...list.filter((x) => x.id !== ev), { id, name, createdAt: Date.now() }]));
        { const pm = (await env.KV.get("pairs", "json")) || {}; let ch = false; for (const x of Object.values(pm)) if (x.ev === ev) { x.ev = id; ch = true; } if (ch) { await env.KV.put("pairs", JSON.stringify(pm)); PAIRC.at = 0; } }
        if (ev === "main") await Promise.all([env.KV.put(kk("config", "main"), JSON.stringify({ ...DEFAULT_CONFIG, movedTo: id })), env.KV.delete(kk("data", "main")), env.KV.delete(kk("mpp", "main"))]);
        else await Promise.all(["config", "data", "mpp", "sponsors"].map((k) => env.KV.delete(kk(k, ev))));
        await purge();
        return json({ ok: true, id });
      }
      if (req.method === "DELETE") {
        if (ev === "main") return json({ error: "L'événement principal ne peut pas être supprimé." }, 400);
        EVC.at = 0; await env.KV.put("events", JSON.stringify(list.filter((x) => x.id !== ev)));
        await Promise.all([env.KV.delete(kk("config", ev)), env.KV.delete(kk("data", ev)), env.KV.delete(kk("sponsors", ev))]);
        await purge();
        return json({ ok: true });
      }
    }

    if (p === "/api/admin/state") {
      const { config, data } = await load(env, ev);
      return json({ config, data, now: Date.now(), role: ADM ? "admin" : "org" });
    }
    if (p === "/api/admin/sponsors" && req.method === "PUT") {
      const { scope, list } = await req.json();
      if (scope === "all" && !ADM) return adminOnly();
      if (!Array.isArray(list) || list.length > 24) return json({ error: "Liste invalide (24 logos maximum)." }, 400);
      const clean = [];
      for (const x of list) {
        if (!x || typeof x.img !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(x.img) || x.img.length > 80000) return json({ error: "Image invalide ou trop lourde." }, 400);
        const link = String(x.url || "").trim().slice(0, 300);
        if (link && !/^https?:\/\/[^\s"<>]+$/i.test(link)) return json({ error: "Lien invalide : il doit commencer par http:// ou https://" }, 400);
        clean.push({ name: String(x.name || "").slice(0, 80), url: link, img: x.img, bg: x.bg === "none" ? "none" : "white", role: x.role === "co" ? "co" : "sp" });
      }
      await env.KV.put(scope === "all" ? "sponsors" : kk("sponsors", ev), JSON.stringify(clean));
      await caches.default.delete(ckey("/api/sponsors"));
      return json({ ok: true });
    }
    // logo en haut à gauche : pour tous les lives (administrateur du site) ou pour ce live seulement
    if (p === "/api/admin/toplogo" && req.method === "PUT") {
      const { scope, img, bg } = await req.json();
      if (scope === "all" && !ADM) return adminOnly();
      const key = scope === "all" ? "toplogo" : "toplogo:ev:" + ev;
      if (!img) await env.KV.delete(key);
      else {
        if (typeof img !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 250000) return json({ error: "Image invalide ou trop lourde." }, 400);
        await env.KV.put(key, JSON.stringify({ img, bg: bg === "none" ? "none" : "white" }));
      }
      await caches.default.delete(ckey("/api/sponsors"));
      return json({ ok: true });
    }
    if (p === "/api/logo" && req.method === "PUT") {
      const { club, data } = await req.json();
      if (!club || typeof club !== "string" || club.length > 120) return json({ error: "Club invalide." }, 400);
      if (data != null && (typeof data !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 40000))
        return json({ error: "Image invalide ou trop lourde." }, 400);
      const logos = (await env.KV.get("logos", "json")) || {};
      if (data) logos[club] = data; else delete logos[club];
      await env.KV.put("logos", JSON.stringify(logos));
      await caches.default.delete(new Request(url.origin + "/api/logos"));
      return json({ ok: true });
    }
    if (p === "/api/config" && req.method === "PUT") {
      const body = await req.json();
      const cfg = { ...DEFAULT_CONFIG, ...body };
      const prev = await env.KV.get(kk("config", ev), "json");
      if (!ADM) cfg.scrape = (prev && prev.scrape) || DEFAULT_CONFIG.scrape; // fréquence de lecture du Live FFN : réglée par l'administrateur
      await env.KV.put(kk("config", ev), JSON.stringify(cfg));
      // réglages modifiés : un live marqué terminé est de nouveau suivi (la tâche vérifiera s'il l'est toujours)
      { const h = (await env.KV.get("hot", "json")) || {}; if (h[ev] && h[ev].f) { delete h[ev]; await env.KV.put("hot", JSON.stringify(h)); } }
      // passage en mode « Bassin » : on repart d'un direct vide (les tests chrono d'avant ne s'affichent pas)
      if (cfg.live === "bassin" && (!prev || prev.live !== "bassin"))
        await env.POOL.get(env.POOL.idFromName(ev === "main" ? "bassin" : "bassin:" + ev)).fetch(new Request("https://pool/event", { method: "POST", body: JSON.stringify([{ k: "clear" }]) }));
      await purge();
      // nouvelle compétition : on lance tout de suite la lecture de son programme
      const { data } = await load(env, ev);
      if (cfg.comps.some((id) => !data.comps[id])) ctx.waitUntil(cycle(env, { force: true, ev }).then(purge));
      return json({ ok: true });
    }
    if (p === "/api/refresh" && req.method === "POST") {
      if (!ADM) return adminOnly(); // synchronisations manuelles : réservées à l'administrateur du site
      await cycle(env, { force: true, ev }); await purge();
      const { data } = await load(env, ev);
      return json({ ok: !data.error, lastOk: data.lastOk, error: data.error, queue: (data.queue || []).length });
    }
    if (p === "/api/rescrape" && req.method === "POST") {
      if (!ADM) return adminOnly(); // synchronisations manuelles : réservées à l'administrateur du site
      const { scope = "all", what = "all" } = await req.json();
      const n = await rescrape(env, scope, what, ev);
      await cycle(env, { force: true, ev }); await purge();
      const { data } = await load(env, ev);
      return json({ ok: true, total: n, remaining: (data.queue || []).length, error: data.error });
    }
    // passage en Europe : recopie de l'ancien stockage vers la base UE (puis vidage de l'ancien avec ?purge=1)
    if (p === "/api/admin/migrate-eu") {
      if (!ADM) return adminOnly();
      if (!env.OLDKV || !env.KV.migrateAll) return json({ error: "Base Europe non branchée." }, 400);
      if (req.method !== "POST") return json({ ready: true });
      return json(await env.KV.migrateAll(url.searchParams.get("purge") === "1"));
    }
    if (p === "/api/admin/log") {
      if (!ADM) return adminOnly();
      try { const r = await env.POOL.get(env.POOL.idFromName("journal")).fetch(new Request("https://pool/logs" + (req.method === "DELETE" ? "?clear=1" : ""))); return json(await r.json()); }
      catch (e) { return json({ error: "Journal indisponible pour le moment (quota Cloudflare du jour atteint ?) : " + String(e.message || e).slice(0, 120) }, 503); }
    }
    if (p === "/api/admin/audience") return ADM ? audience(env, url, ev) : adminOnly();
    return json({ error: "Route inconnue" }, 404);
  },

  async scheduled(event, env, ctx) {
    env = euEnv(env);
    // chaque minute : tous les événements à tour de rôle, dans la limite de 45 pages (50 sous-requêtes max en gratuit)
    ctx.waitUntil((async () => {
      const ids = ["main", ...(await listEvents(env)).map((x) => x.id)];
      // un seul événement par minute, à tour de rôle : le temps de calcul gratuit (10 ms) est limité par exécution
      // un live en cours (réunion en cours ou résultats encore attendus) passe en priorité, chaque minute ;
      // les autres lives n'ont que des lectures rares (programme, séries 1 fois par jour) : une minute sur 10 leur suffit
      const now = Date.now(), m = Math.floor(now / 60e3); const H = (await env.KV.get("hot", "json")) || {};
      const hot = ids.filter((x) => H[x] && (H[x].c || (H[x].w || []).some(([a, b]) => now >= a && now <= b)));
      const cold = !hot.length || m % 10 === 0;
      const live = ids.filter((x) => !(H[x] && H[x].f)); // lives terminés / archivés : plus aucune visite
      if (!live.length) return;
      const pool = cold ? live : hot;
      const start = (cold && hot.length ? Math.floor(m / 10) : m) % pool.length;
      let left = BUDGET;
      for (let i = 0; i < 1 && left > 0; i++) {
        const ev = pool[(start + i) % pool.length];
        let used = 0;
        // tâche automatique : 5 pages au plus, espacées de 1,5 s (le Live FFN refuse les rafales)
        try { used = (await cycle(env, { ev, budget: Math.min(5, left) })) || 0; left -= used; } catch (e) { await logErr(env, ev, "tâche de chaque minute", (e && e.stack) || e); /* un événement en erreur ne bloque pas les autres */ }
        // records personnels : seulement quand la relecture du Live FFN n'a rien eu à faire (temps de calcul limité)
        if (!used) { try { await mppStep(env, ev, 4); } catch (e) {} }
      }
    })());
  },
};

// ---------- audience (Cloudflare Web Analytics, lecture seule) ----------
async function audience(env, url, ev = "main") {
  const evOnly = ev && ev !== "main" ? ev : ""; // statistiques d'un seul live (sinon : tout le site)
  const day = (x) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x || ""); return m ? [+m[1], +m[2], +m[3]] : null; };
  const pp = parisParts(); const today = [pp.y, pp.m, pp.d];
  let f = day(url.searchParams.get("from")), t = day(url.searchParams.get("to"));
  const days0 = Math.min(30, Math.max(1, +(url.searchParams.get("days") || 1)));
  if (!f || !t) { t = today; const d0 = new Date(Date.UTC(...today) - (days0 - 1) * 864e5); f = [d0.getUTCFullYear(), d0.getUTCMonth() + 1, d0.getUTCDate()]; }
  const start = new Date(parisEpoch(...f)); const endEx = parisEpoch(t[0], t[1], t[2]) + 864e5; const now = Date.now(); const end = new Date(Math.min(now, endEx));
  const nDays = Math.round((endEx - start.getTime()) / 864e5);
  const iso = (a) => `${a[0]}-${String(a[1]).padStart(2, "0")}-${String(a[2]).padStart(2, "0")}`;
  // personnes différentes / connectés (stockage maison) : même sans jeton Cloudflare
  let own = null;
  if (env.STATS) { try { const r = await env.STATS.get(env.STATS.idFromName("stats")).fetch(new Request(`https://stats/q?from=${iso(f)}&to=${iso(t)}${evOnly ? "&ev=" + encodeURIComponent(evOnly) : ""}`)); if (r.ok) own = await r.json(); } catch (e) {} }
  if (!env.CF_API_TOKEN) return json({ setup: true, own });
  const host = url.hostname;
  const filter = `{datetime_geq: "${start.toISOString()}", datetime_leq: "${end.toISOString()}", requestHost: "${host}"${evOnly ? `, requestPath_like: "/e/${evOnly}%"` : ""}}`;
  const block = (alias, dim, order, ds = "rumPageloadEventsAdaptiveGroups") => `${alias}: ${ds}(limit: 500, filter: ${filter}, orderBy: [${order}]) { count sum { visits } dimensions { ${dim} } }`;
  const gql = async (inner) => {
    const query = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { ${inner} } } }`;
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ query }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors?.length) throw new Error((j.errors && j.errors[0]?.message) || `Cloudflare a répondu ${r.status}`);
    return j.data?.viewer?.accounts?.[0] || {};
  };
  const timeDim = nDays <= 2 ? "datetimeFifteenMinutes" : nDays <= 7 ? "datetimeHour" : "date";
  let a;
  try {
    a = await gql(`${block("total", "date", "date_ASC")}
    ${block("hours", timeDim, timeDim + "_ASC")}
    ${block("devices", "deviceType", "count_DESC")}
    ${block("countries", "countryName", "count_DESC")}
    ${block("browsers", "userAgentBrowser", "count_DESC")}
    ${block("referers", "refererHost", "count_DESC")}`);
  } catch (e) { return json({ error: e.message, own }, 502); }
  // compléments : si Cloudflare refuse un champ, le reste des statistiques s'affiche quand même
  const extra = await Promise.allSettled([
    gql(block("paths", "requestPath", "count_DESC")),
    gql(block("os", "userAgentOS", "count_DESC")),
    gql(`perf: rumPerformanceEventsAdaptiveGroups(limit: 1, filter: ${filter}) { count avg { pageLoadTime } quantiles { pageLoadTimeP50 pageLoadTimeP90 } }`),
  ]);
  const pick = (rows, key) => (rows || []).map((x) => ({ k: x.dimensions[key] || "—", views: x.count, visits: x.sum?.visits || 0 }));
  const tot = (a.total || []).reduce((s, x) => ({ views: s.views + x.count, visits: s.visits + (x.sum?.visits || 0) }), { views: 0, visits: 0 });
  // pages → lives
  const byLive = {};
  for (const x of pick(extra[0].value?.paths, "requestPath")) { const m = String(x.k).match(/^\/e\/([a-z0-9][a-z0-9-]{0,39})/); const k = m ? m[1] : /^\/archives/.test(x.k) ? "~archives" : x.k === "/" ? "~accueil" : null; if (!k) continue; const o = (byLive[k] = byLive[k] || { views: 0, visits: 0 }); o.views += x.views; o.visits += x.visits; }
  const pf = extra[2].value?.perf?.[0];
  const perf = pf && pf.count ? { n: pf.count, avg: pf.avg?.pageLoadTime ?? null, p50: pf.quantiles?.pageLoadTimeP50 ?? null, p90: pf.quantiles?.pageLoadTimeP90 ?? null } : null;
  return json({ days: nDays, from: start.toISOString(), to: end.toISOString(), step: timeDim, ...tot,
    hours: pick(a.hours, timeDim), devices: pick(a.devices, "deviceType"), countries: pick(a.countries, "countryName"),
    browsers: pick(a.browsers, "userAgentBrowser"), referers: pick(a.referers, "refererHost"),
    os: pick(extra[1].value?.os, "userAgentOS"), byLive, perf, own,
    warn: extra.filter((x) => x.status === "rejected").map((x) => x.reason?.message).filter(Boolean) });
}

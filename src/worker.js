// Swim Direct — serveur Cloudflare : API, stockage KV, récupération programmée du Live FFN.
export { PoolRoom } from "./pool.js";
import { get, urls, parseEntries, parseLive, parseProgramme, parseHeats, parseResults } from "./ffn.js";
import { normEvent, findIuf, fetchMpp } from "./extranat.js";

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
  const m = (meta?.date || "").toLowerCase().match(/(\d{1,2})\s+([a-zéèûô]+)\s+(\d{4})/);
  return m && MONTHS[m[2]] ? { y: +m[3], m: MONTHS[m[2]], d: +m[1] } : null;
}
const hToMin = (t) => { const m = String(t || "").match(/(\d{1,2})h(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };

// ---------- stockage ----------
// Plusieurs événements : « main » garde les clés historiques, les autres ont leurs propres clés
export const kk = (base, ev) => (ev && ev !== "main" ? `${base}:${ev}` : base);
const EV_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
async function listEvents(env) { return (await env.KV.get("events", "json")) || []; }
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
function windowOpen(cfg, data, now) {
  if (!cfg.scrape?.onlyLive) return true;
  for (const id of cfg.comps) {
    const c = data.comps[id]; const dt = c && compDate(c.meta);
    if (!dt) return true; // pas encore de programme : on le récupère
    for (const r of c.reunions || []) {
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
    const dt = compDate(c.meta); if (!dt) return false;
    const last = Math.max(...evs.map((e) => hToMin(e.time) ?? 0));
    return now > parisEpoch(dt.y, dt.m, dt.d) + (last + 180) * 60e3;
  });
}

// Fréquence de relecture du programme : le programme officiel sort en général 3 à 4 jours avant
function progEvery(c, now) {
  const dt = c && compDate(c.meta); if (!dt) return PROG_EVERY;
  const days = (parisEpoch(dt.y, dt.m, dt.d) - now) / 864e5;
  if (days > 5) return 24 * 3600e3;   // plus de 5 jours avant : une fois par jour
  if (days > 1) return 3 * 3600e3;    // de 5 jours à la veille : toutes les 3 h
  return PROG_EVERY;                  // veille et jour J : toutes les 30 min
}

function plan(cfg, data, now, live) {
  const tasks = [];
  for (const id of cfg.comps) {
    const c = data.comps[id];
    if (!c || !c.progAt || now - c.progAt > progEvery(c, now)) tasks.push({ t: "prog", c: id });
    if (!c) continue;
    for (const r of c.reunions || []) {
      const evs = r.items.filter((i) => i.kind === "event").map((i) => ({ ...i, key: i.key || String(i.epr) }));
      const started = evs.some((e) => c.events?.[e.key]?.results?.rows?.length);
      for (const e of evs) {
        if (e.provisional) continue; // programme provisoire : rien d'autre à lire pour l'instant
        const st = c.events?.[e.key] || {};
        // finales : la liste de départ est publiée entre les séries et la finale → relue jusqu'à ses résultats
        const fin = e.key !== String(e.epr) && !st.results?.rows?.length;
        if (!st.heatsAt || ((!started || fin) && now - st.heatsAt > HEATS_EVERY)) tasks.push({ t: "heats", c: id, epr: e.epr, key: e.key });
      }
      if (!live) continue;
      // épreuves en cours : la première non terminée de la réunion et la suivante
      if (evs.some((e) => e.provisional)) continue;
      const idx = evs.findIndex((e) => !c.events?.[e.key]?.doneAt);
      if (idx >= 0) for (const e of evs.slice(Math.max(0, idx - 1), idx + 2)) tasks.push({ t: "res", c: id, epr: e.epr });
    }
  }
  // résultats d'abord, puis programme, puis séries ; une seule lecture par page (tous les tours d'une épreuve sont sur la même page de résultats)
  const rank = { res: 0, prog: 1, heats: 2 }; const seen = new Set();
  return tasks.filter((t) => { const k = t.t + "|" + t.c + "|" + (t.t === "heats" ? t.key : t.epr); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => rank[a.t] - rank[b.t]);
}

async function runTask(task, data, now) {
  const c = (data.comps[task.c] = data.comps[task.c] || { events: {} });
  c.events = c.events || {};
  if (task.t === "prog") {
    const p = parseProgramme(await get(urls.programme(task.c)));
    if (!p.reunions.length) throw new Error(`Programme vide pour la compétition ${task.c}`);
    if (JSON.stringify([p.meta, p.reunions]) !== JSON.stringify([c.meta, c.reunions])) data.dirty = true;
    c.meta = p.meta; c.reunions = p.reunions; c.progAt = now;
    if (p.reunions.some((r) => (r.items || []).some((i) => i.provisional))) {
      try {
        const e = parseEntries(await get(urls.entries(task.c)));
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
    const hs = parseHeats(await get(urls.heats(task.c, ev))).map((h) => ({ n: h.n, of: h.of, time: h.time, lanes: h.lanes.map(packLane) }));
    if (JSON.stringify(hs) !== JSON.stringify(st.heats || null)) { st.heats = hs; data.dirty = true; }
    st.heatsAt = now; return;
  }
  if (task.t === "res") {
    const evs = eventsOf(c).filter((e) => e.epr === task.epr);
    if (!evs.length) return;
    const r = parseResults(await get(urls.results(task.c, task.epr)));
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
      const exp = expected({ ...ev, heats: st.heats });
      if (n && !st.doneAt && (n >= exp || exp === 0)) st.doneAt = now;
    }
  }
}
// stockage compact (10 ms de calcul par passage en offre gratuite) : champs inutiles retirés, passages à plat [d1, t1, d2, t2…]
const strip0 = (o) => { for (const k of Object.keys(o)) if (o[k] == null || o[k] === "" || (Array.isArray(o[k]) && !o[k].length)) delete o[k]; return o; };
export function packRow(r) {
  const sp = []; for (const x of r.splits || []) if (x.d && x.cum != null) sp.push(x.d, x.cum);
  return strip0({ place: r.place, name: r.name, iuf: r.iuf, year: r.year, club: r.club, time: r.time, status: r.status, reason: r.reason, points: r.points, qual: r.qual, team: r.team,
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

export async function cycle(env, { force = false, ev = "main", budget = BUDGET } = {}) {
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
      if (!data.finished) { data.finished = now; await saveData(env, data, "", ev); }
      return 0;
    }
  }
  if (data.finished && !finished(config, data, now)) data.finished = null;
  const live = force || windowOpen(config, data, now);
  data.queue = data.queue || [];
  let errors = 0, used = 0;
  const seen = new Set();
  // deux tours : le programme lu au premier tour permet de planifier les séries et résultats au second
  for (let round = 0; round < 2 && used < budget && !errors; round++) {
    const fromQueue = data.queue.length > 0;
    const tasks = (fromQueue ? data.queue : plan(config, data, now, live)).filter((t) => !seen.has(JSON.stringify(t)));
    if (!tasks.length) break;
    const todo = tasks.slice(0, budget - used);
    if (fromQueue) data.queue = data.queue.slice(todo.length);
    for (const t of todo) {
      seen.add(JSON.stringify(t)); used++;
      try { await runTask(t, data, now); }
      catch (e) { errors++; data.error = String(e.message || e); data.errorAt = now; if (/indisponible/.test(data.error)) break; }
    }
  }
  if (!used) return 0;
  data.lastRun = now;
  if (!errors) { data.lastOk = now; data.error = null; }
  // les horodatages seuls ne justifient pas une écriture KV (1 000 écritures/jour en gratuit) : on écrit si le contenu a changé
  // (repéré pendant la lecture, sans recomparer tout le fichier : trop coûteux pour une grosse compétition)
  const dirty = data.dirty || errors || data.queue.length; delete data.dirty;
  if (dirty || !data.savedAt || now - data.savedAt > 10 * 60e3) { data.savedAt = now; await saveData(env, data, "", ev); }
  return used;
}

// ---------- records personnels (FFN Extranat) ----------
// La veille et pendant la compétition, quelques nageurs par minute : nom + année → licence → meilleures perfs (avec passages).
const mppKey = (name, year) => String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim() + "|" + (year || "");
// nageurs dont on cherche les records (listes de départ + résultats), clé → { name, year, pool, events, iuf }
function mppWant(config, data, ev, now, force) {
  const want = new Map(); // clé nageur → { name, year, pool, events:Set }
  for (const id of config.comps) {
    const c = data.comps[id]; if (!c) continue; const dt = compDate(c.meta); if (!dt) continue;
    const day = parisEpoch(dt.y, dt.m, dt.d); if (!force && ev !== "test" && (now < day - 5 * 864e5 || now > day + 2 * 864e5)) continue; // l'épreuve test (simulateur) rejoue d'anciennes compétitions : pas de fenêtre de dates
    const pool = +((c.meta?.pool || "").match(/\d+/) || [25])[0] === 50 ? 50 : 25;
    for (const e of eventsOf(c)) {
      const ek = normEvent(e.name); if (!ek) continue;
      const st = c.events?.[e.key] || {};
      // nageurs des listes de départ, et aussi des résultats (compétition déjà nagée)
      const lanes = [...(st.heats || []).flatMap((h) => h.lanes || []), ...(st.results?.rows || []).filter((r) => !r.relay)];
      for (const l of lanes) {
        if (!l.name || l.members || !l.year) continue; const k = mppKey(l.name, l.year);
        const w = want.get(k) || { name: l.name, year: l.year, pool, events: new Set(), day }; if (day < w.day) w.day = day; if (l.iuf) w.iuf = String(l.iuf); w.events.add(ek); want.set(k, w);
      }
    }
  }
  return want;
}
async function mppStatus(env, ev) {
  const { config, data } = await load(env, ev); const now = Date.now();
  const want = mppWant(config, data, ev, now, true); const store = (await env.KV.get(kk("mpp", ev), "json")) || { sw: {} };
  let done = 0, found = 0, best = 0, err = 0, noRec = 0, notFound = 0;
  for (const k of want.keys()) { const x = store.sw[k]; if (!x) continue; if (x.err) { err++; continue; } done++; if (x.iuf) found++; const has = x.b && Object.keys(x.b).length; if (has) best++; else if (x.iuf) noRec++; else notFound++; }
  return { want: want.size, done, left: want.size - done, foundN: found, bestN: best, errN: err, noRecN: noRec, notFoundN: notFound };
}
async function mppStep(env, ev, max = 2, force = false) {
  const { config, data } = await load(env, ev); const now = Date.now();
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
    else if (!c) tasks.push({ t: "prog", c: id });
    const evs = c ? eventsOf(c).filter((e) => !reu || e.reunion === reu) : [];
    for (const e of evs.filter((x) => !x.provisional)) {
      const st = c.events?.[e.key];
      if (st && (what === "all" || what === "start")) { delete st.heats; delete st.heatsAt; }
      if (st && (what === "all" || what === "res")) { delete st.results; delete st.resultsAt; delete st.doneAt; delete st.nRows; }
      if (what !== "res") tasks.push({ t: "heats", c: id, epr: e.epr, key: e.key });
      if (what !== "start" && !tasks.some((t) => t.t === "res" && t.c === id && t.epr === e.epr)) tasks.push({ t: "res", c: id, epr: e.epr });
    }
  }
  data.queue = tasks; data.savedAt = 0;
  await saveData(env, data, before, ev);
  return tasks.length;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (req.headers.has("x-admin-key") && (await tooManyFails(req, authed(req, env) || (p === "/api/pool/event" && relayAuthed(req, env)))))
      return json({ error: "Trop d'essais de mot de passe. Réessaie dans 15 minutes." }, 429);
    const ev = url.searchParams.get("e") || "main";
    if (!EV_RE.test(ev)) return json({ error: "Événement inconnu." }, 404);
    if (ev !== "main" && p !== "/api/admin/events" && !(await listEvents(env)).some((x) => x.id === ev)) return json({ error: "Événement inconnu." }, 404);
    const ckey = (path) => new Request(url.origin + path + (path.includes("?") ? "&" : "?") + "e=" + ev);

    // liste publique des événements (pour l'accueil et le partage)
    if (p === "/api/events" && req.method === "GET") {
      const all = [{ id: "main" }, ...(await listEvents(env))];
      const out = [];
      for (const x of all) {
        const c = await env.KV.get(kk("config", x.id), "json"); if (!c || !c.published) continue;
        // page d'accueil : ville, bassin et dates lues dans le texte brut (sans relire tout le fichier de données)
        const raw = (await env.KV.get(kk("data", x.id))) || ""; const metas = [];
        for (const m of raw.matchAll(/"meta":(\{[^{}]*\})/g)) { try { metas.push(JSON.parse(m[1])); } catch (e) {} if (metas.length >= 6) break; }
        out.push({ id: x.id, name: c.name || x.name || "", main: x.id === "main", theme: c.theme || "alsace", org: c.org ?? (c.theme && c.theme !== "alsace" ? "" : "Fédération Alsacienne de Natation"), live: c.live || "off",
          comps: metas.map((m) => ({ name: m.name || "", city: m.city || "", pool: m.pool || "", date: m.date || "" })) });
      }
      return json(out, 200, { "cache-control": "public, max-age=60" });
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

    // Direct « Bassin » (Quantum) : salle temps réel. Le relais envoie les événements avec le mot de passe admin.
    if (p.startsWith("/api/pool/")) {
      let rid = ev;
      // le relais sans « --evenement » : le chrono va à l'événement réglé en mode « Bassin » dans l'admin
      if (p === "/api/pool/event" && !url.searchParams.get("e")) {
        for (const x of [{ id: "main" }, ...(await listEvents(env))]) { const c = await env.KV.get(kk("config", x.id), "json"); if (c && c.live === "bassin") { rid = x.id; break; } }
      }
      const { config } = await load(env, rid);
      const room = env.POOL.get(env.POOL.idFromName(rid === "main" ? "bassin" : "bassin:" + rid));
      if (p === "/api/pool/event") {
        if (!relayAuthed(req, env)) return json({ error: "Mot de passe incorrect." }, 401);
        return room.fetch(new Request("https://pool/event", { method: "POST", body: await req.text() }));
      }
      if (config.live !== "bassin" && !authed(req, env)) return json({ error: "Direct bassin non activé." }, 404);
      if (p === "/api/pool/ws") return room.fetch(new Request("https://pool/ws", req));
      if (p === "/api/pool/state") return room.fetch(new Request("https://pool/state"));
      return json({ error: "Inconnu" }, 404);
    }

    // Direct « Live FFN » : dernière série publiée et série suivante, relues au plus toutes les 30 s (cache)
    if (p === "/api/live" && req.method === "GET") {
      const c = url.searchParams.get("c") || "";
      const { config } = await load(env, ev);
      if (!["ffn", "bassin"].includes(config.live) || !config.comps.includes(c) || (!config.published && !authed(req, env))) return json({ error: "Direct non activé." }, 404);
      const cache = caches.default; const key = new Request(url.origin + "/api/live?c=" + c);
      const hit = await cache.match(key); if (hit) return hit;
      let body;
      try { body = { at: Date.now(), ...parseLive(await get(urls.live(c), { delay: 0, tries: 1 })) }; }
      catch (e) { body = { at: Date.now(), error: String(e.message || e) }; }
      // page absente (direct pas commencé) : on ne redemande pas au Live FFN avant 10 min
      const res = json(body, 200, { "cache-control": `public, max-age=${body.error ? 600 : 30}` });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }

    if (p === "/api/admin/mpp" && req.method === "GET") {
      if (!authed(req, env)) return json({ error: "Mot de passe incorrect." }, 401);
      return json(await mppStatus(env, ev));
    }
    if (p === "/api/admin/mpp" && req.method === "POST") {
      if (!authed(req, env)) return json({ error: "Mot de passe incorrect." }, 401);
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
      return json({ at: store.at || null, sw: out }, 200, { "cache-control": "public, max-age=300" });
    }

    // partenaires : ceux de tous les lives + ceux de cet événement
    if (p === "/api/sponsors" && req.method === "GET") {
      const [all, one] = await Promise.all([env.KV.get("sponsors", "json"), env.KV.get(kk("sponsors", ev), "json")]);
      return json({ all: all || [], ev: one || [] }, 200, { "cache-control": "public, max-age=60" });
    }
    if (p === "/api/logos" && req.method === "GET") {
      const logos = (await env.KV.get("logos", "json")) || {};
      return json(logos, 200, { "cache-control": "public, max-age=300" });
    }

    if (!authed(req, env)) return json({ error: env.ADMIN_PASSWORD ? "Mot de passe incorrect." : "Le mot de passe admin n'est pas encore configuré dans Cloudflare (variable ADMIN_PASSWORD)." }, 401);
    const purge = () => Promise.all([caches.default.delete(ckey("/api/state")), caches.default.delete(new Request(url.origin + "/api/events"))]);

    // gestion des événements (créer / renommer / supprimer)
    if (p === "/api/admin/events") {
      const list = await listEvents(env);
      if (req.method === "GET") {
        const out = [];
        for (const x of [{ id: "main", name: "Événement principal" }, ...list]) { const c = await env.KV.get(kk("config", x.id), "json"); out.push({ id: x.id, name: (c && c.name) || x.name || "", published: !!(c && c.published), comps: (c && c.comps) || [] }); }
        return json(out);
      }
      if (req.method === "POST") {
        const { name = "", comps = [] } = await req.json();
        let base = String(name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "evenement";
        let id = base, i = 2; while (id === "main" || list.some((x) => x.id === id)) id = `${base}-${i++}`;
        list.push({ id, name: String(name).slice(0, 120), createdAt: Date.now() });
        await env.KV.put("events", JSON.stringify(list));
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
        await Promise.all([c && env.KV.put(kk("config", id), c), d && env.KV.put(kk("data", id), d), m && env.KV.put(kk("mpp", id), m), sp && env.KV.put(kk("sponsors", id), sp)].filter(Boolean));
        const name = (c && JSON.parse(c).name) || (list.find((x) => x.id === ev) || {}).name || "";
        await env.KV.put("events", JSON.stringify([...list.filter((x) => x.id !== ev), { id, name, createdAt: Date.now() }]));
        if (ev === "main") await Promise.all([env.KV.put(kk("config", "main"), JSON.stringify({ ...DEFAULT_CONFIG })), env.KV.delete(kk("data", "main")), env.KV.delete(kk("mpp", "main"))]);
        else await Promise.all(["config", "data", "mpp", "sponsors"].map((k) => env.KV.delete(kk(k, ev))));
        await purge();
        return json({ ok: true, id });
      }
      if (req.method === "DELETE") {
        if (ev === "main") return json({ error: "L'événement principal ne peut pas être supprimé." }, 400);
        await env.KV.put("events", JSON.stringify(list.filter((x) => x.id !== ev)));
        await Promise.all([env.KV.delete(kk("config", ev)), env.KV.delete(kk("data", ev)), env.KV.delete(kk("sponsors", ev))]);
        await purge();
        return json({ ok: true });
      }
    }

    if (p === "/api/admin/state") {
      const { config, data } = await load(env, ev);
      return json({ config, data, now: Date.now() });
    }
    if (p === "/api/admin/sponsors" && req.method === "PUT") {
      const { scope, list } = await req.json();
      if (!Array.isArray(list) || list.length > 24) return json({ error: "Liste invalide (24 logos maximum)." }, 400);
      const clean = [];
      for (const x of list) {
        if (!x || typeof x.img !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(x.img) || x.img.length > 80000) return json({ error: "Image invalide ou trop lourde." }, 400);
        const link = String(x.url || "").trim().slice(0, 300);
        if (link && !/^https?:\/\/[^\s"<>]+$/i.test(link)) return json({ error: "Lien invalide : il doit commencer par http:// ou https://" }, 400);
        clean.push({ name: String(x.name || "").slice(0, 80), url: link, img: x.img });
      }
      await env.KV.put(scope === "all" ? "sponsors" : kk("sponsors", ev), JSON.stringify(clean));
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
      await env.KV.put(kk("config", ev), JSON.stringify(cfg));
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
      await cycle(env, { force: true, ev }); await purge();
      const { data } = await load(env, ev);
      return json({ ok: !data.error, lastOk: data.lastOk, error: data.error, queue: (data.queue || []).length });
    }
    if (p === "/api/rescrape" && req.method === "POST") {
      const { scope = "all", what = "all" } = await req.json();
      const n = await rescrape(env, scope, what, ev);
      await cycle(env, { force: true, ev }); await purge();
      const { data } = await load(env, ev);
      return json({ ok: true, total: n, remaining: (data.queue || []).length, error: data.error });
    }
    if (p === "/api/admin/audience") return audience(env, url);
    return json({ error: "Route inconnue" }, 404);
  },

  async scheduled(event, env, ctx) {
    // chaque minute : tous les événements à tour de rôle, dans la limite de 45 pages (50 sous-requêtes max en gratuit)
    ctx.waitUntil((async () => {
      const ids = ["main", ...(await listEvents(env)).map((x) => x.id)];
      // un seul événement par minute, à tour de rôle : le temps de calcul gratuit (10 ms) est limité par exécution
      const start = Math.floor(Date.now() / 60e3) % ids.length;
      let left = BUDGET;
      for (let i = 0; i < 1 && left > 0; i++) {
        const ev = ids[(start + i) % ids.length];
        let used = 0;
        try { used = (await cycle(env, { ev, budget: Math.min(BUDGET, left) })) || 0; left -= used; } catch (e) { /* un événement en erreur ne bloque pas les autres */ }
        // records personnels : seulement quand la relecture du Live FFN n'a rien eu à faire (temps de calcul limité)
        if (!used) { try { await mppStep(env, ev, 4); } catch (e) {} }
      }
    })());
  },
};

// ---------- audience (Cloudflare Web Analytics, lecture seule) ----------
async function audience(env, url) {
  if (!env.CF_API_TOKEN) return json({ setup: true });
  const days = Math.min(30, Math.max(1, +(url.searchParams.get("days") || 1)));
  const host = url.hostname;
  const now = new Date();
  const start = days === 1 ? new Date(parisEpoch(...Object.values(parisParts(now)).slice(0, 3))) : new Date(now.getTime() - days * 864e5);
  const filter = `{datetime_geq: "${start.toISOString()}", datetime_leq: "${now.toISOString()}", requestHost: "${host}"}`;
  const block = (alias, dim, order) => `${alias}: rumPageloadEventsAdaptiveGroups(limit: 200, filter: ${filter}, orderBy: [${order}]) { count sum { visits } dimensions { ${dim} } }`;
  const query = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) {
    ${block("total", "date", "date_ASC")}
    ${block("hours", "datetimeHour", "datetimeHour_ASC")}
    ${block("devices", "deviceType", "count_DESC")}
    ${block("countries", "countryName", "count_DESC")}
    ${block("browsers", "userAgentBrowser", "count_DESC")}
    ${block("referers", "refererHost", "count_DESC")}
  } } }`;
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) return json({ error: (j.errors && j.errors[0]?.message) || `Cloudflare a répondu ${r.status}` }, 502);
  const a = j.data?.viewer?.accounts?.[0] || {};
  const pick = (rows, key) => (rows || []).map((x) => ({ k: x.dimensions[key] || "—", views: x.count, visits: x.sum?.visits || 0 }));
  const tot = (a.total || []).reduce((t, x) => ({ views: t.views + x.count, visits: t.visits + (x.sum?.visits || 0) }), { views: 0, visits: 0 });
  return json({ days, from: start.toISOString(), ...tot,
    hours: pick(a.hours, "datetimeHour"), devices: pick(a.devices, "deviceType"), countries: pick(a.countries, "countryName"),
    browsers: pick(a.browsers, "userAgentBrowser"), referers: pick(a.referers, "refererHost") });
}

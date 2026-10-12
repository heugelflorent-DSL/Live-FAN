// Schwimme Direct — serveur Cloudflare : API, stockage KV, récupération programmée du Live FFN.
export { PoolRoom } from "./pool.js";
import { get, urls, parseEntries, parseLive, parseProgramme, parseHeats, parseResults } from "./ffn.js";

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
  return (comp.reunions || []).flatMap((r) => r.items.filter((i) => i.kind === "event").map((i) => ({ ...i, reunion: r.n })));
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
    if (evs.every((e) => c.events?.[e.epr]?.doneAt)) return true;
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
      const evs = r.items.filter((i) => i.kind === "event");
      const started = evs.some((e) => c.events?.[e.epr]?.results?.rows?.length);
      for (const e of evs) {
        if (e.provisional) continue; // programme provisoire : rien d'autre à lire pour l'instant
        const st = c.events?.[e.epr] || {};
        if (!st.heatsAt || (!started && now - st.heatsAt > HEATS_EVERY)) tasks.push({ t: "heats", c: id, epr: e.epr });
      }
      if (!live) continue;
      // épreuves en cours : la première non terminée de la réunion et la suivante
      if (evs.some((e) => e.provisional)) continue;
      const idx = evs.findIndex((e) => !c.events?.[e.epr]?.doneAt);
      if (idx >= 0) for (const e of evs.slice(Math.max(0, idx - 1), idx + 2)) tasks.push({ t: "res", c: id, epr: e.epr });
    }
  }
  // résultats d'abord, puis programme, puis séries
  const rank = { res: 0, prog: 1, heats: 2 };
  return tasks.sort((a, b) => rank[a.t] - rank[b.t]);
}

async function runTask(task, data, now) {
  const c = (data.comps[task.c] = data.comps[task.c] || { events: {} });
  c.events = c.events || {};
  if (task.t === "prog") {
    const p = parseProgramme(await get(urls.programme(task.c)));
    if (!p.reunions.length) throw new Error(`Programme vide pour la compétition ${task.c}`);
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
  const ev = eventsOf(c).find((e) => e.epr === task.epr);
  if (!ev) return;
  const st = (c.events[task.epr] = c.events[task.epr] || {});
  if (task.t === "heats") {
    st.heats = parseHeats(await get(urls.heats(task.c, ev))); st.heatsAt = now; return;
  }
  if (task.t === "res") {
    const r = parseResults(await get(urls.results(task.c, task.epr)));
    // le Live FFN peut renvoyer une autre page quand l'épreuve n'a pas encore de résultats : on vérifie le titre
    const nrm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!r.title || !nrm(r.title).startsWith(nrm(ev.name))) { r.rows = []; delete st.doneAt; }
    const n = r.rows.length;
    if (n !== st.nRows) st.changedAt = now;
    st.results = r; st.resultsAt = now; st.nRows = n;
    const exp = expected({ ...ev, heats: st.heats });
    if (n && !st.doneAt && (n >= exp || exp === 0)) st.doneAt = now;
  }
}

export async function cycle(env, { force = false, ev = "main", budget = BUDGET } = {}) {
  const { config, data } = await load(env, ev);
  const before = JSON.stringify(data);
  const now = Date.now();
  const every = (config.scrape?.every ?? 2) * 60e3;
  if (!force) {
    if (!config.comps.length) return 0;
    if (!every) return 0; // récupération manuelle uniquement
    if (data.lastRun && now - data.lastRun < every - 5e3) return 0;
    // compétitions terminées : plus de synchronisation automatique, seulement à la demande depuis l'admin
    if (finished(config, data, now) && !(data.queue || []).length) {
      if (!data.finished) { data.finished = now; await saveData(env, data, JSON.stringify({}), ev); }
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
  const strip = (s) => s.replace(/"(lastRun|lastOk|progAt|heatsAt|resultsAt)":\d+,?/g, "");
  if (strip(JSON.stringify(data)) !== strip(before) || !data.savedAt || now - data.savedAt > 10 * 60e3) {
    data.savedAt = now; await saveData(env, data, before, ev);
  }
  return used;
}

// ---------- API ----------
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });
function authed(req, env) {
  const k = req.headers.get("x-admin-key") || "";
  const p = env.ADMIN_PASSWORD || "";
  if (!p || k.length !== p.length) return false;
  let d = 0; for (let i = 0; i < p.length; i++) d |= k.charCodeAt(i) ^ p.charCodeAt(i);
  return d === 0;
}
function publicConfig(cfg) { const { scrape, ...rest } = cfg; return rest; }

async function rescrape(env, scope, what, ev = "main") {
  const { config, data } = await load(env, ev);
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
      const st = c.events?.[e.epr];
      if (st && (what === "all" || what === "start")) { delete st.heats; delete st.heatsAt; }
      if (st && (what === "all" || what === "res")) { delete st.results; delete st.resultsAt; delete st.doneAt; delete st.nRows; }
      if (what !== "res") tasks.push({ t: "heats", c: id, epr: e.epr });
      if (what !== "start") tasks.push({ t: "res", c: id, epr: e.epr });
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
    const ev = url.searchParams.get("e") || "main";
    if (!EV_RE.test(ev)) return json({ error: "Événement inconnu." }, 404);
    if (ev !== "main" && p !== "/api/admin/events" && !(await listEvents(env)).some((x) => x.id === ev)) return json({ error: "Événement inconnu." }, 404);
    const ckey = (path) => new Request(url.origin + path + (path.includes("?") ? "&" : "?") + "e=" + ev);

    // liste publique des événements (pour l'accueil et le partage)
    if (p === "/api/events" && req.method === "GET") {
      const all = [{ id: "main" }, ...(await listEvents(env))];
      const out = [];
      for (const x of all) { const c = await env.KV.get(kk("config", x.id), "json"); if (c && c.published) out.push({ id: x.id, name: c.name || x.name || "", main: x.id === "main" }); }
      return json(out, 200, { "cache-control": "public, max-age=60" });
    }

    if (p === "/api/state" && req.method === "GET") {
      const cache = caches.default; const key = ckey("/api/state");
      const hit = await cache.match(key); if (hit) return hit;
      const { config, data } = await load(env, ev);
      const body = config.published
        ? { published: true, config: publicConfig(config), data: { comps: data.comps, lastOk: data.lastOk }, now: Date.now() }
        : { published: false, now: Date.now() };
      const res = json(body, 200, { "cache-control": "public, max-age=15" });
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
        if (!authed(req, env)) return json({ error: "Mot de passe incorrect." }, 401);
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
      const res = json(body, 200, { "cache-control": "public, max-age=30" });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
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
      if (req.method === "DELETE") {
        if (ev === "main") return json({ error: "L'événement principal ne peut pas être supprimé." }, 400);
        await env.KV.put("events", JSON.stringify(list.filter((x) => x.id !== ev)));
        await Promise.all([env.KV.delete(kk("config", ev)), env.KV.delete(kk("data", ev))]);
        await purge();
        return json({ ok: true });
      }
    }

    if (p === "/api/admin/state") {
      const { config, data } = await load(env, ev);
      return json({ config, data, now: Date.now() });
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
      const start = Math.floor(Date.now() / 60e3) % ids.length;
      let left = 45;
      for (let i = 0; i < ids.length && left > 0; i++) {
        const ev = ids[(start + i) % ids.length];
        try { left -= (await cycle(env, { ev, budget: Math.min(BUDGET, left) })) || 0; } catch (e) { /* un événement en erreur ne bloque pas les autres */ }
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

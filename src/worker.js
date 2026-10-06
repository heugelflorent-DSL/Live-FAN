// Live FAN — serveur Cloudflare : API, stockage KV, récupération programmée du Live FFN.
import { get, urls, parseProgramme, parseHeats, parseResults } from "./ffn.js";

const BUDGET = 15;            // pages Live FFN lues au maximum par passage (le reste attend le passage suivant)
const PROG_EVERY = 30 * 60e3; // programme relu toutes les 30 min
const HEATS_EVERY = 10 * 60e3; // séries relues toutes les 10 min tant que la réunion n'a pas commencé

export const DEFAULT_CONFIG = {
  name: "", comps: [], order: {}, lines: {}, starts: {}, gap: 40, timing: "elec", delay: {},
  rankings: [], infos: [], published: false, scrape: { every: 2, onlyLive: true },
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
async function load(env) {
  const [c, d] = await Promise.all([env.KV.get("config", "json"), env.KV.get("data", "json")]);
  return { config: { ...DEFAULT_CONFIG, ...(c || {}) }, data: d || { comps: {}, queue: [], log: [] } };
}
async function saveData(env, data, before) {
  const s = JSON.stringify(data);
  if (s !== before) await env.KV.put("data", s);
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

function plan(cfg, data, now, live) {
  const tasks = [];
  for (const id of cfg.comps) {
    const c = data.comps[id];
    if (!c || !c.progAt || now - c.progAt > PROG_EVERY) tasks.push({ t: "prog", c: id });
    if (!c) continue;
    for (const r of c.reunions || []) {
      const evs = r.items.filter((i) => i.kind === "event");
      const started = evs.some((e) => c.events?.[e.epr]?.results?.rows?.length);
      for (const e of evs) {
        const st = c.events?.[e.epr] || {};
        if (!st.heatsAt || (!started && now - st.heatsAt > HEATS_EVERY)) tasks.push({ t: "heats", c: id, epr: e.epr });
      }
      if (!live) continue;
      // épreuves en cours : la première non terminée de la réunion et la suivante
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
    c.meta = p.meta; c.reunions = p.reunions; c.progAt = now; return;
  }
  const ev = eventsOf(c).find((e) => e.epr === task.epr);
  if (!ev) return;
  const st = (c.events[task.epr] = c.events[task.epr] || {});
  if (task.t === "heats") {
    st.heats = parseHeats(await get(urls.heats(task.c, ev))); st.heatsAt = now; return;
  }
  if (task.t === "res") {
    const r = parseResults(await get(urls.results(task.c, task.epr)));
    const n = r.rows.length;
    if (n !== st.nRows) st.changedAt = now;
    st.results = r; st.resultsAt = now; st.nRows = n;
    const exp = expected({ ...ev, heats: st.heats });
    if (n && !st.doneAt && (n >= exp || exp === 0)) st.doneAt = now;
  }
}

export async function cycle(env, { force = false } = {}) {
  const { config, data } = await load(env);
  const before = JSON.stringify(data);
  const now = Date.now();
  const every = (config.scrape?.every ?? 2) * 60e3;
  if (!force) {
    if (!config.comps.length) return;
    if (!every) return; // récupération manuelle uniquement
    if (data.lastRun && now - data.lastRun < every - 5e3) return;
  }
  const live = force || windowOpen(config, data, now);
  data.queue = data.queue || [];
  let errors = 0, used = 0;
  const seen = new Set();
  // deux tours : le programme lu au premier tour permet de planifier les séries et résultats au second
  for (let round = 0; round < 2 && used < BUDGET && !errors; round++) {
    const fromQueue = data.queue.length > 0;
    const tasks = (fromQueue ? data.queue : plan(config, data, now, live)).filter((t) => !seen.has(JSON.stringify(t)));
    if (!tasks.length) break;
    const todo = tasks.slice(0, BUDGET - used);
    if (fromQueue) data.queue = data.queue.slice(todo.length);
    for (const t of todo) {
      seen.add(JSON.stringify(t)); used++;
      try { await runTask(t, data, now); }
      catch (e) { errors++; data.error = String(e.message || e); data.errorAt = now; if (/indisponible/.test(data.error)) break; }
    }
  }
  if (!used) return;
  data.lastRun = now;
  if (!errors) { data.lastOk = now; data.error = null; }
  // les horodatages seuls ne justifient pas une écriture KV (1 000 écritures/jour en gratuit) : on écrit si le contenu a changé
  const strip = (s) => s.replace(/"(lastRun|lastOk|progAt|heatsAt|resultsAt)":\d+,?/g, "");
  if (strip(JSON.stringify(data)) !== strip(before) || !data.savedAt || now - data.savedAt > 10 * 60e3) {
    data.savedAt = now; await saveData(env, data, before);
  }
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

async function rescrape(env, scope, what) {
  const { config, data } = await load(env);
  const before = JSON.stringify(data);
  const comps = scope?.startsWith("c") ? [scope.slice(1)] : config.comps;
  const reu = scope?.startsWith("r") ? +scope.slice(1) : null;
  const tasks = [];
  for (const id of comps) {
    const c = data.comps[id];
    if (what === "all" && !reu) { data.comps[id] = { events: {} }; tasks.push({ t: "prog", c: id }); }
    else if (!c) tasks.push({ t: "prog", c: id });
    const evs = c ? eventsOf(c).filter((e) => !reu || e.reunion === reu) : [];
    for (const e of evs) {
      const st = c.events?.[e.epr];
      if (st && (what === "all" || what === "start")) { delete st.heats; delete st.heatsAt; }
      if (st && (what === "all" || what === "res")) { delete st.results; delete st.resultsAt; delete st.doneAt; delete st.nRows; }
      if (what !== "res") tasks.push({ t: "heats", c: id, epr: e.epr });
      if (what !== "start") tasks.push({ t: "res", c: id, epr: e.epr });
    }
  }
  data.queue = tasks; data.savedAt = 0;
  await saveData(env, data, before);
  return tasks.length;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);

    if (p === "/api/state" && req.method === "GET") {
      const cache = caches.default; const key = new Request(url.origin + "/api/state");
      const hit = await cache.match(key); if (hit) return hit;
      const { config, data } = await load(env);
      const body = config.published
        ? { published: true, config: publicConfig(config), data: { comps: data.comps, lastOk: data.lastOk }, now: Date.now() }
        : { published: false, now: Date.now() };
      const res = json(body, 200, { "cache-control": "public, max-age=15" });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }

    if (!authed(req, env)) return json({ error: env.ADMIN_PASSWORD ? "Mot de passe incorrect." : "Le mot de passe admin n'est pas encore configuré dans Cloudflare (variable ADMIN_PASSWORD)." }, 401);
    const purge = () => caches.default.delete(new Request(url.origin + "/api/state"));

    if (p === "/api/admin/state") {
      const { config, data } = await load(env);
      return json({ config, data, now: Date.now() });
    }
    if (p === "/api/config" && req.method === "PUT") {
      const body = await req.json();
      const cfg = { ...DEFAULT_CONFIG, ...body };
      await env.KV.put("config", JSON.stringify(cfg));
      await purge();
      // nouvelle compétition : on lance tout de suite la lecture de son programme
      const { data } = await load(env);
      if (cfg.comps.some((id) => !data.comps[id])) ctx.waitUntil(cycle(env, { force: true }).then(purge));
      return json({ ok: true });
    }
    if (p === "/api/refresh" && req.method === "POST") {
      await cycle(env, { force: true }); await purge();
      const { data } = await load(env);
      return json({ ok: !data.error, lastOk: data.lastOk, error: data.error, queue: (data.queue || []).length });
    }
    if (p === "/api/rescrape" && req.method === "POST") {
      const { scope = "all", what = "all" } = await req.json();
      const n = await rescrape(env, scope, what);
      await cycle(env, { force: true }); await purge();
      const { data } = await load(env);
      return json({ ok: true, total: n, remaining: (data.queue || []).length, error: data.error });
    }
    if (p === "/api/admin/audience") return audience(env, url);
    return json({ error: "Route inconnue" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cycle(env));
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

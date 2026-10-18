// Audience « maison » : personnes différentes, connectés en ce moment, onglets regardés, pic de connectés,
// temps passé et visiteurs qui reviennent — sans cookie.
// Chaque visiteur est représenté par une empreinte (IP + navigateur + semaine, hachée avec un secret) :
// rien de lisible n'est stocké, et l'empreinte change chaque semaine.
const DAY = 864e5, NOW_WIN = 6 * 60e3, SESSION_GAP = 30 * 60e3, SLOT = 5 * 60e3;
const TABS = new Set(["home", "live", "prog", "res", "pod", "rank", "part", "pick", "archives"]);

export class StatsRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; const q = (s) => ctx.storage.sql.exec(s);
    q("CREATE TABLE IF NOT EXISTS u (day TEXT, ev TEXT, k TEXT, PRIMARY KEY (day, ev, k))");
    // « en ce moment » : gardé dans le stockage (la mémoire est vidée quand l'objet s'endort entre deux visites)
    q("CREATE TABLE IF NOT EXISTS seen (k TEXT, ev TEXT, at INTEGER, PRIMARY KEY (k, ev))");
    q("CREATE TABLE IF NOT EXISTS now2 (k TEXT PRIMARY KEY, ev TEXT, v TEXT, at INTEGER)");
    q("CREATE TABLE IF NOT EXISTS tabs (day TEXT, v TEXT, k TEXT, PRIMARY KEY (day, v, k))");
    q("CREATE TABLE IF NOT EXISTS conc (day TEXT, slot INTEGER, n INTEGER, PRIMARY KEY (day, slot))");
    q("CREATE TABLE IF NOT EXISTS vis (day TEXT, k TEXT, first INTEGER, last INTEGER, dur INTEGER, sess INTEGER, PRIMARY KEY (day, k))");
    // mêmes mesures, live par live (depuis le 18/10/2026 : avant, seuls les totaux tous lives confondus existent)
    q("CREATE TABLE IF NOT EXISTS tabs_e (day TEXT, ev TEXT, v TEXT, k TEXT, PRIMARY KEY (day, ev, v, k))");
    q("CREATE TABLE IF NOT EXISTS conc_e (day TEXT, ev TEXT, slot INTEGER, n INTEGER, PRIMARY KEY (day, ev, slot))");
    q("CREATE TABLE IF NOT EXISTS vis_e (day TEXT, ev TEXT, k TEXT, first INTEGER, last INTEGER, dur INTEGER, sess INTEGER, PRIMARY KEY (day, ev, k))");
  }
  sql(s, ...a) { return this.ctx.storage.sql.exec(s, ...a); }
  async fetch(req) {
    const url = new URL(req.url); const now = Date.now();
    if (url.pathname === "/hit" && req.method === "POST") {
      const { day, ev, k, v } = await req.json();
      if (!day || !ev || !k) return new Response("bad", { status: 400 });
      const tab = TABS.has(v) ? v : null;
      // Économie d'écritures (quota gratuit de 100 000 lignes / jour) :
      // « connectés en ce moment » et le pic restent en mémoire ; seul ce qui doit durer va dans la base,
      // et une seule fois par visiteur et par jour (sauf le temps passé, mis à jour au plus toutes les 10 min).
      const live = (this.live = this.live || new Map()); live.set(k, { ev, v: tab, at: now });
      const mem = (this.mem = this.mem || new Map()); const mk = day + "|" + k; const m = mem.get(mk);
      if (!m) {
        const ins = "INSERT OR IGNORE INTO u (day, ev, k) VALUES (?, ?, ?)";
        this.sql(ins, day, ev, k); this.sql(ins, day, "*", k);
      } else if (!m.evs.has(ev)) this.sql("INSERT OR IGNORE INTO u (day, ev, k) VALUES (?, ?, ?)", day, ev, k);
      const st = m || { evs: new Set(), tabs: new Set(), saved: 0 }; st.evs.add(ev); mem.set(mk, st);
      if (tab && !st.tabs.has(tab)) { st.tabs.add(tab); this.sql("INSERT OR IGNORE INTO tabs (day, v, k) VALUES (?, ?, ?)", day, tab, k); }
      // par live : onglets et temps passé (une ligne par visiteur, par jour et par live)
      const ek = day + "|" + ev + "|" + k; const es = (this.memE = this.memE || new Map()).get(ek) || { tabs: new Set(), vis: null, saved: 0 }; this.memE.set(ek, es);
      if (tab && !es.tabs.has(tab)) { es.tabs.add(tab); this.sql("INSERT OR IGNORE INTO tabs_e (day, ev, v, k) VALUES (?, ?, ?, ?)", day, ev, tab, k); }
      if (!es.vis) es.vis = this.sql("SELECT first, last, dur, sess FROM vis_e WHERE day = ? AND ev = ? AND k = ?", day, ev, k).toArray()[0] || null;
      if (!es.vis) { es.vis = { first: now, last: now, dur: 0, sess: 1 }; this.sql("INSERT OR IGNORE INTO vis_e (day, ev, k, first, last, dur, sess) VALUES (?, ?, ?, ?, ?, 0, 1)", day, ev, k, now, now); es.saved = now; }
      else { const ns = now - es.vis.last > SESSION_GAP; if (ns) es.vis.sess++; else es.vis.dur += now - es.vis.last; es.vis.last = now;
        if (ns || now - es.saved > 10 * 60e3) { es.saved = now; this.sql("UPDATE vis_e SET last = ?, dur = ?, sess = ? WHERE day = ? AND ev = ? AND k = ?", now, es.vis.dur, es.vis.sess, day, ev, k); } }
      if (this.memE.size > 20000) this.memE.clear();
      // temps passé : une nouvelle visite commence après 30 min sans signe de vie
      if (!st.vis) st.vis = this.sql("SELECT first, last, dur, sess FROM vis WHERE day = ? AND k = ?", day, k).toArray()[0] || null;
      if (!st.vis) { st.vis = { first: now, last: now, dur: 0, sess: 1 }; this.sql("INSERT OR IGNORE INTO vis (day, k, first, last, dur, sess) VALUES (?, ?, ?, ?, 0, 1)", day, k, now, now); st.saved = now; }
      else { const newSess = now - st.vis.last > SESSION_GAP; if (newSess) st.vis.sess++; else st.vis.dur += now - st.vis.last; st.vis.last = now;
        if (newSess || now - st.saved > 10 * 60e3) { st.saved = now; this.sql("UPDATE vis SET last = ?, dur = ?, sess = ? WHERE day = ? AND k = ?", now, st.vis.dur, st.vis.sess, day, k); } }
      // pic de connectés : calculé en mémoire, écrit au plus une fois par tranche de 5 minutes
      for (const [x, y] of live) if (now - y.at > NOW_WIN) live.delete(x);
      const slot = Math.floor(now / SLOT) * SLOT; this.peak = this.peak && this.peak.slot === slot ? this.peak : { slot, n: 0, w: 0 };
      if (live.size > this.peak.n) this.peak.n = live.size;
      // pic par live (en mémoire, écrit au plus une fois par minute et par live)
      { const nEv = [...live.values()].filter((y) => y.ev === ev).length; const pe = (this.peakE = this.peakE || new Map()); let x = pe.get(ev); if (!x || x.slot !== slot) { x = { slot, n: 0, w: 0 }; pe.set(ev, x); }
        if (nEv > x.n) x.n = nEv; if (x.n > x.w && (!x.at || now - x.at > 60e3)) { x.w = x.n; x.at = now; this.sql("INSERT INTO conc_e (day, ev, slot, n) VALUES (?, ?, ?, ?) ON CONFLICT (day, ev, slot) DO UPDATE SET n = MAX(n, excluded.n)", day, ev, slot, x.n); } }
      if (this.peak.n > this.peak.w && (!this.peak.at || now - this.peak.at > 60e3)) { this.peak.w = this.peak.n; this.peak.at = now;
        this.sql("INSERT INTO conc (day, slot, n) VALUES (?, ?, ?) ON CONFLICT (day, slot) DO UPDATE SET n = MAX(n, excluded.n)", day, slot, this.peak.n); }
      if (mem.size > 20000) mem.clear();
      if (!this.cleaned || now - this.cleaned > DAY) {
        this.cleaned = now; const old = new Date(now - 400 * DAY).toISOString().slice(0, 10);
        for (const t of ["u", "tabs", "conc", "vis", "tabs_e", "conc_e", "vis_e"]) this.sql(`DELETE FROM ${t} WHERE day < ?`, old);
        this.sql("DELETE FROM seen"); this.sql("DELETE FROM now2");
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/q") {
      const from = url.searchParams.get("from"), to = url.searchParams.get("to"); const E = url.searchParams.get("ev") || "";
      if (E) return Response.json(this.qEv(E, from, to, now));
      const uniq = {}; for (const r of this.sql("SELECT ev, COUNT(DISTINCT k) AS n FROM u WHERE day >= ? AND day <= ? GROUP BY ev", from, to)) uniq[r.ev] = r.n;
      const days = this.sql("SELECT day, COUNT(DISTINCT k) AS n FROM u WHERE ev = '*' AND day >= ? AND day <= ? GROUP BY day ORDER BY day", from, to).toArray();
      const nowBy = {}; const nowAll = new Set(); const tabsNow = {};
      for (const [k, y] of this.live || []) if (now - y.at <= NOW_WIN) { nowAll.add(k); nowBy[y.ev] = (nowBy[y.ev] || 0) + 1; if (y.v) tabsNow[y.v] = (tabsNow[y.v] || 0) + 1; }
      const tabs = {}; for (const r of this.sql("SELECT v, COUNT(DISTINCT k) AS n FROM tabs WHERE day >= ? AND day <= ? GROUP BY v", from, to)) tabs[r.v] = r.n;
      const conc = this.sql("SELECT slot, n FROM conc WHERE day >= ? AND day <= ? ORDER BY slot", from, to).toArray();
      const peak = conc.reduce((m, x) => (x.n > (m ? m.n : 0) ? x : m), null);
      const v = this.sql("SELECT COUNT(*) AS people, SUM(dur) AS dur, SUM(sess) AS sess, SUM(CASE WHEN sess > 1 THEN 1 ELSE 0 END) AS back FROM vis WHERE day >= ? AND day <= ?", from, to).toArray()[0] || {};
      // revenus un autre jour (même semaine, même empreinte)
      const multi = this.sql("SELECT COUNT(*) AS n FROM (SELECT k FROM vis WHERE day >= ? AND day <= ? GROUP BY k HAVING COUNT(*) > 1)", from, to).toArray()[0];
      const people = uniq["*"] || 0;
      const time = { avgMs: v.people ? Math.round((v.dur || 0) / v.people) : 0, perVisitMs: v.sess ? Math.round((v.dur || 0) / v.sess) : 0, visits: v.sess || 0, back: people ? Math.min(people, (v.back || 0) + (multi ? multi.n : 0)) : 0 };
      return Response.json({ uniq, days, now: { all: nowAll.size, by: nowBy, tabs: tabsNow }, tabs, conc, peak, time });
    }
    return new Response("not found", { status: 404 });
  }
  // statistiques d'un seul live
  qEv(E, from, to, now) {
    const uniq = {}; for (const r of this.sql("SELECT COUNT(DISTINCT k) AS n FROM u WHERE ev = ? AND day >= ? AND day <= ?", E, from, to)) uniq[E] = uniq["*"] = r.n;
    const days = this.sql("SELECT day, COUNT(DISTINCT k) AS n FROM u WHERE ev = ? AND day >= ? AND day <= ? GROUP BY day ORDER BY day", E, from, to).toArray();
    const nowBy = {}; let all = 0; const tabsNow = {};
    for (const [, y] of this.live || []) if (now - y.at <= NOW_WIN && y.ev === E) { all++; nowBy[E] = (nowBy[E] || 0) + 1; if (y.v) tabsNow[y.v] = (tabsNow[y.v] || 0) + 1; }
    const tabs = {}; for (const r of this.sql("SELECT v, COUNT(DISTINCT k) AS n FROM tabs_e WHERE ev = ? AND day >= ? AND day <= ? GROUP BY v", E, from, to)) tabs[r.v] = r.n;
    const conc = this.sql("SELECT slot, n FROM conc_e WHERE ev = ? AND day >= ? AND day <= ? ORDER BY slot", E, from, to).toArray();
    const peak = conc.reduce((m, x) => (x.n > (m ? m.n : 0) ? x : m), null);
    const v = this.sql("SELECT COUNT(*) AS people, SUM(dur) AS dur, SUM(sess) AS sess, SUM(CASE WHEN sess > 1 THEN 1 ELSE 0 END) AS back FROM vis_e WHERE ev = ? AND day >= ? AND day <= ?", E, from, to).toArray()[0] || {};
    const multi = this.sql("SELECT COUNT(*) AS n FROM (SELECT k FROM vis_e WHERE ev = ? AND day >= ? AND day <= ? GROUP BY k HAVING COUNT(*) > 1)", E, from, to).toArray()[0];
    const people = uniq["*"] || 0;
    const time = { avgMs: v.people ? Math.round((v.dur || 0) / v.people) : 0, perVisitMs: v.sess ? Math.round((v.dur || 0) / v.sess) : 0, visits: v.sess || 0, back: people ? Math.min(people, (v.back || 0) + (multi ? multi.n : 0)) : 0 };
    return { ev: E, since: "2026-10-18", uniq, days, now: { all, by: nowBy, tabs: tabsNow }, tabs, conc, peak, time };
  }
}

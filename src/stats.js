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
  }
  sql(s, ...a) { return this.ctx.storage.sql.exec(s, ...a); }
  async fetch(req) {
    const url = new URL(req.url); const now = Date.now();
    if (url.pathname === "/hit" && req.method === "POST") {
      const { day, ev, k, v } = await req.json();
      if (!day || !ev || !k) return new Response("bad", { status: 400 });
      const tab = TABS.has(v) ? v : null;
      const ins = "INSERT OR IGNORE INTO u (day, ev, k) VALUES (?, ?, ?)";
      this.sql(ins, day, ev, k); this.sql(ins, day, "*", k);
      this.sql("INSERT INTO seen (k, ev, at) VALUES (?, ?, ?) ON CONFLICT (k, ev) DO UPDATE SET at = excluded.at", k, ev, now);
      this.sql("INSERT INTO now2 (k, ev, v, at) VALUES (?, ?, ?, ?) ON CONFLICT (k) DO UPDATE SET ev = excluded.ev, v = excluded.v, at = excluded.at", k, ev, tab, now);
      if (tab) this.sql("INSERT OR IGNORE INTO tabs (day, v, k) VALUES (?, ?, ?)", day, tab, k);
      // temps passé : une nouvelle visite commence après 30 min sans signe de vie
      const r = this.sql("SELECT last FROM vis WHERE day = ? AND k = ?", day, k).toArray()[0];
      if (!r) this.sql("INSERT INTO vis (day, k, first, last, dur, sess) VALUES (?, ?, ?, ?, 0, 1)", day, k, now, now);
      else if (now - r.last > SESSION_GAP) this.sql("UPDATE vis SET last = ?, sess = sess + 1 WHERE day = ? AND k = ?", now, day, k);
      else this.sql("UPDATE vis SET dur = dur + ?, last = ? WHERE day = ? AND k = ?", now - r.last, now, day, k);
      // pic de connectés : maximum par tranche de 5 minutes
      const n = this.sql("SELECT COUNT(*) AS n FROM now2 WHERE at >= ?", now - NOW_WIN).toArray()[0].n;
      this.sql("INSERT INTO conc (day, slot, n) VALUES (?, ?, ?) ON CONFLICT (day, slot) DO UPDATE SET n = MAX(n, excluded.n)", day, Math.floor(now / SLOT) * SLOT, n);
      // ménage : connexions inactives, et données de plus de 400 jours
      if (!this.swept || now - this.swept > 10 * 60e3) { this.swept = now; this.sql("DELETE FROM seen WHERE at < ?", now - 30 * 60e3); this.sql("DELETE FROM now2 WHERE at < ?", now - 30 * 60e3); }
      if (!this.cleaned || now - this.cleaned > DAY) {
        this.cleaned = now; const old = new Date(now - 400 * DAY).toISOString().slice(0, 10);
        for (const t of ["u", "tabs", "conc", "vis"]) this.sql(`DELETE FROM ${t} WHERE day < ?`, old);
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/q") {
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      const uniq = {}; for (const r of this.sql("SELECT ev, COUNT(DISTINCT k) AS n FROM u WHERE day >= ? AND day <= ? GROUP BY ev", from, to)) uniq[r.ev] = r.n;
      const days = this.sql("SELECT day, COUNT(DISTINCT k) AS n FROM u WHERE ev = '*' AND day >= ? AND day <= ? GROUP BY day ORDER BY day", from, to).toArray();
      const nowBy = {}; const nowAll = new Set();
      for (const r of this.sql("SELECT k, ev FROM seen WHERE at >= ?", now - NOW_WIN)) { nowBy[r.ev] = (nowBy[r.ev] || 0) + 1; nowAll.add(r.k); }
      const tabsNow = {}; for (const r of this.sql("SELECT v, COUNT(*) AS n FROM now2 WHERE at >= ? AND v IS NOT NULL GROUP BY v", now - NOW_WIN)) tabsNow[r.v] = r.n;
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
}

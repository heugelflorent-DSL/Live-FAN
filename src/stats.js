// Audience « maison » : personnes différentes et connectés en ce moment, sans cookie.
// Chaque visiteur est représenté par une empreinte (IP + navigateur + semaine, hachée avec un secret) :
// rien de lisible n'est stocké, et l'empreinte change chaque semaine.
const DAY = 864e5;

export class StatsRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS u (day TEXT, ev TEXT, k TEXT, PRIMARY KEY (day, ev, k))");
    // « en ce moment » : gardé dans le stockage (la mémoire est vidée quand l'objet s'endort entre deux visites)
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS seen (k TEXT, ev TEXT, at INTEGER, PRIMARY KEY (k, ev))");
  }
  async fetch(req) {
    const url = new URL(req.url); const now = Date.now();
    if (url.pathname === "/hit" && req.method === "POST") {
      const { day, ev, k } = await req.json();
      if (!day || !ev || !k) return new Response("bad", { status: 400 });
      const ins = "INSERT OR IGNORE INTO u (day, ev, k) VALUES (?, ?, ?)";
      this.ctx.storage.sql.exec(ins, day, ev, k);
      this.ctx.storage.sql.exec(ins, day, "*", k);
      this.ctx.storage.sql.exec("INSERT INTO seen (k, ev, at) VALUES (?, ?, ?) ON CONFLICT (k, ev) DO UPDATE SET at = excluded.at", k, ev, now);
      // ménage : connexions inactives, et données de plus de 400 jours (une fois par jour environ)
      if (!this.swept || now - this.swept > 10 * 60e3) { this.swept = now; this.ctx.storage.sql.exec("DELETE FROM seen WHERE at < ?", now - 30 * 60e3); }
      if (!this.cleaned || now - this.cleaned > DAY) { this.cleaned = now; const old = new Date(now - 400 * DAY).toISOString().slice(0, 10); this.ctx.storage.sql.exec("DELETE FROM u WHERE day < ?", old); }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/q") {
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      const rows = this.ctx.storage.sql.exec("SELECT ev, COUNT(DISTINCT k) AS n FROM u WHERE day >= ? AND day <= ? GROUP BY ev", from, to).toArray();
      const days = this.ctx.storage.sql.exec("SELECT day, COUNT(DISTINCT k) AS n FROM u WHERE ev = '*' AND day >= ? AND day <= ? GROUP BY day ORDER BY day", from, to).toArray();
      const nowBy = {}; const nowAll = new Set();
      for (const r of this.ctx.storage.sql.exec("SELECT k, ev FROM seen WHERE at >= ?", now - 6 * 60e3)) { nowBy[r.ev] = (nowBy[r.ev] || 0) + 1; nowAll.add(r.k); }
      const uniq = {}; for (const r of rows) uniq[r.ev] = r.n;
      return Response.json({ uniq, days, now: { all: nowAll.size, by: nowBy } });
    }
    return new Response("not found", { status: 404 });
  }
}

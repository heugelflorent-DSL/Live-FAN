// Direct « Bassin » : une salle temps réel (Durable Object) alimentée par le relais branché sur le Quantum.
// Le relais envoie chaque événement (série prête, départ, réaction, passage, arrivée, fin officielle) ;
// les spectateurs reçoivent l'état complet par WebSocket. Le chrono tourne sur chaque téléphone à partir de l'heure de départ.

const empty = () => ({ heat: null, prev: null, hist: {}, updatedAt: 0, relayAt: 0 });
// séries terminées gardées pour l'affichage des « séries précédentes » de l'épreuve en cours
const archive = (s, h) => {
  if (!h || h.event == null || !h.heat || !Object.values(h.lanes || {}).some((L) => L.fin)) return;
  s.hist = s.hist || {};
  s.hist[h.event + "-" + h.heat] = { event: h.event, heat: h.heat, key: h.key || null, title: h.title || "", names: h.names || {}, lanes: h.lanes, start: h.start, doneAt: h.doneAt || Date.now(), sim: !!h.sim };
  const ks = Object.keys(s.hist); if (ks.length > 80) for (const k of ks.sort((a, b) => s.hist[a].doneAt - s.hist[b].doneAt).slice(0, ks.length - 80)) delete s.hist[k];
};

export class PoolRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.s = null;
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get("s")) || empty(); });
  }
  // l'historique complet reste ici : on n'envoie que les séries de l'épreuve en cours (message léger, envoyé souvent)
  snapshot() {
    const { hist, ...rest } = this.s; const ev = this.s.heat && this.s.heat.event;
    const h = {}; for (const k in hist || {}) if (ev != null && hist[k].event === ev) h[k] = hist[k];
    return JSON.stringify({ type: "state", now: Date.now(), ...rest, hist: h });
  }
  broadcast() { const msg = this.snapshot(); for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch {} } }

  apply(ev) {
    const s = this.s; const t = Date.now();
    const ensure = () => (s.heat = s.heat || { event: null, heat: null, status: "ready", start: null, lanes: {}, at: t });
    const lane = (n) => { const h = ensure(); return (h.lanes[n] = h.lanes[n] || { laps: {} }); };
    switch (ev.k) {
      case "ready": // nouvelle série au départ : la précédente devient « dernière série »
        if (s.heat && (s.heat.event !== ev.event || s.heat.heat !== ev.heat)) { if (s.heat.start) (archive(s, s.heat), s.prev = s.heat); }
        if (!s.heat || s.heat.event !== ev.event || s.heat.heat !== ev.heat || s.heat.status === "done")
          s.heat = { event: ev.event, heat: ev.heat, laps: ev.laps || null, lanesUsed: ev.lanes || null, status: "ready", start: null, lanes: {}, at: t };
        break;
      case "start": { if (s.heat && s.heat.status === "done") { (archive(s, s.heat), s.prev = s.heat); s.heat = null; } const h = ensure(); h.start = ev.srv || (ev.ts && ev.sent ? t - Math.max(0, ev.sent - ev.ts) : ev.ts || t); h.status = "running"; h.lanes = {}; break; }
      case "clock": { // temps de course du Quantum : recale l'heure de départ (sans retour en arrière visible de plus de 0,3 s)
        if (!ev.rt) return false;
        // départ manqué (relais redémarré en pleine course) : le temps de course suffit pour reprendre le direct
        if (!s.heat || s.heat.status === "ready" || (s.heat.status === "done" && ev.rt < 30)) { if (s.heat && s.heat.status === "done") { (archive(s, s.heat), s.prev = s.heat); s.heat = null; } const h0 = ensure(); h0.status = "running"; h0.start = null; }
        const h = s.heat; if (h.status !== "running") return false;
        const st = (ev.srv || t - Math.max(0, (ev.sent || ev.ts) - ev.ts)) - ev.rt * 1000;
        if (!h.start || Math.abs(st - h.start) > 100) h.start = Math.round(st); else return false;
        break;
      }
      case "react": { const l = lane(ev.lane); if (l) l.rt = ev.t; break; }
      case "split": { const l = lane(ev.lane); if (l) { l.laps[ev.lap] = { t: ev.t, rank: ev.rank || null, dist: ev.dist || null, edited: !!ev.edited }; l.last = ev.lap; } break; }
      case "finish": { const l = lane(ev.lane); if (l) { l.laps[ev.lap] = { t: ev.t, rank: ev.rank || null, dist: ev.dist || null, edited: !!ev.edited }; l.last = ev.lap; l.fin = { t: ev.t, rank: ev.rank || null }; } break; }
      case "end": if (s.heat) { s.heat.status = "done"; s.heat.doneAt = s.heat.doneAt || t; } break;
      case "heat": { // noms et résultats envoyés par le Quantum (série chargée, puis officielle)
        const fresh = ev.stat !== "O" && ev.stat !== "F"; // liste de départ (W) : série (re)mise au départ
        const same = s.heat && ((s.heat.event === ev.event && s.heat.heat === ev.heat && !(fresh && s.heat.status === "done")) || (s.heat.event == null && s.heat.status !== "done"));
        if (same) { s.heat.event = ev.event; s.heat.heat = ev.heat; }
        if (!same) { if (s.heat && s.heat.start) (archive(s, s.heat), s.prev = s.heat); s.heat = { event: ev.event, heat: ev.heat, status: "ready", start: null, lanes: {}, at: t }; }
        const h = s.heat; h.sim = !!ev.sim; h.key = ev.key || null; h.comp = ev.comp || h.comp || ""; h.title = ev.title || h.title; h.heats = ev.heats || h.heats; h.laps = ev.laps || h.laps;
        h.names = {}; for (const l of ev.lanes || []) if (l.name) h.names[l.lane] = { name: l.name, club: l.club, born: l.born };
        if (ev.stat === "O" || ev.stat === "F") { h.status = "done"; h.doneAt = h.doneAt || t; h.official = true; for (const l of ev.lanes || []) if (l.time) { const L = (h.lanes[l.lane] = h.lanes[l.lane] || { laps: {} }); L.fin = { t: l.time, rank: l.rank }; } }
        if (h.official) archive(s, h);
        break;
      }
      case "clear": this.s = empty(); break;
      case "ping": break;
      default: return false;
    }
    this.s.updatedAt = t; this.s.relayAt = t;
    return true;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/ws")) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket attendu", { status: 426 });
      const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(this.snapshot());
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname.endsWith("/event") && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const list = Array.isArray(body) ? body : body ? [body] : [];
      let n = 0; for (const ev of list.slice(0, 50)) if (ev && typeof ev === "object" && this.apply(ev)) n++;
      if (n) { await this.ctx.storage.put("s", this.s); this.broadcast(); }
      return Response.json({ ok: true, applied: n, spectators: this.ctx.getWebSockets().length, now: Date.now() });
    }
    return new Response(this.snapshot(), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  webSocketMessage(ws, msg) { if (msg === "ping") ws.send("pong"); else if (typeof msg === "string" && msg.startsWith("t:")) ws.send(JSON.stringify({ type: "time", id: msg.slice(2, 40), now: Date.now() })); }
  webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch {} }
}

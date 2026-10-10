// Direct « Bassin » : une salle temps réel (Durable Object) alimentée par le relais branché sur le Quantum.
// Le relais envoie chaque événement (série prête, départ, réaction, passage, arrivée, fin officielle) ;
// les spectateurs reçoivent l'état complet par WebSocket. Le chrono tourne sur chaque téléphone à partir de l'heure de départ.

const empty = () => ({ heat: null, prev: null, updatedAt: 0, relayAt: 0 });

export class PoolRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.s = null;
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get("s")) || empty(); });
  }
  snapshot() { return JSON.stringify({ type: "state", now: Date.now(), ...this.s }); }
  broadcast() { const msg = this.snapshot(); for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch {} } }

  apply(ev) {
    const s = this.s; const t = Date.now();
    const lane = (n) => { const h = s.heat; if (!h) return null; return (h.lanes[n] = h.lanes[n] || { laps: {} }); };
    switch (ev.k) {
      case "ready": // nouvelle série au départ : la précédente devient « dernière série »
        if (s.heat && (s.heat.event !== ev.event || s.heat.heat !== ev.heat)) { if (s.heat.start) s.prev = s.heat; }
        if (!s.heat || s.heat.event !== ev.event || s.heat.heat !== ev.heat || s.heat.status === "done")
          s.heat = { event: ev.event, heat: ev.heat, laps: ev.laps || null, lanesUsed: ev.lanes || null, status: "ready", start: null, lanes: {}, at: t };
        break;
      case "start": if (s.heat) { s.heat.start = ev.ts || t; s.heat.status = "running"; s.heat.lanes = {}; } break;
      case "react": { const l = lane(ev.lane); if (l) l.rt = ev.t; break; }
      case "split": { const l = lane(ev.lane); if (l) { l.laps[ev.lap] = { t: ev.t, rank: ev.rank || null, edited: !!ev.edited }; l.last = ev.lap; } break; }
      case "finish": { const l = lane(ev.lane); if (l) { l.laps[ev.lap] = { t: ev.t, rank: ev.rank || null, edited: !!ev.edited }; l.last = ev.lap; l.fin = { t: ev.t, rank: ev.rank || null }; } break; }
      case "end": if (s.heat) s.heat.status = "done"; break;
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
      return Response.json({ ok: true, applied: n, spectators: this.ctx.getWebSockets().length });
    }
    return new Response(this.snapshot(), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  webSocketMessage(ws, msg) { if (msg === "ping") ws.send("pong"); }
  webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch {} }
}

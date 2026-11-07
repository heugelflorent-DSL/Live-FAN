import { get as ffnGet } from "./ffn.js";
// Direct « Bassin » : une salle temps réel (Durable Object) alimentée par le relais branché sur le Quantum.
// Le relais envoie chaque événement (série prête, départ, réaction, passage, arrivée, fin officielle) ;
// les spectateurs reçoivent l'état complet par WebSocket. Le chrono tourne sur chaque téléphone à partir de l'heure de départ.

const empty = () => ({ heat: null, prev: null, hist: {}, updatedAt: 0, relayAt: 0 });
/* autre compétition ouverte dans le Quantum pendant la réunion (courses des remplaçants…) : gardée à part, jamais confondue avec les vraies séries */
function isExtra(s, comp) { comp = String(comp || "").trim(); if (!comp) return false; if (/rempla/i.test(comp)) return true; return !!(s.mainComp && comp !== s.mainComp); }
// séries terminées gardées pour l'affichage des « séries précédentes » de l'épreuve en cours
const archive = (s, h) => {
  if (!h || h.event == null || !h.heat || !Object.values(h.lanes || {}).some((L) => L.fin)) return;
  s.hist = s.hist || {};
  const extra = isExtra(s, h.comp);
  s.hist[(extra ? "x:" + h.comp + ":" : "") + h.event + "-" + h.heat] = { extra, event: h.event, heat: h.heat, key: h.key || null, title: h.title || "", comp: h.comp || "", names: h.names || {}, lanes: h.lanes, start: h.start, doneAt: h.doneAt || Date.now(), sim: !!h.sim };
  const ks = Object.keys(s.hist); if (ks.length > 250) for (const k of ks.sort((a, b) => s.hist[a].doneAt - s.hist[b].doneAt).slice(0, ks.length - 250)) delete s.hist[k];
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
        // départ rappelé (2e départ aux interclubs) : la même série est remise au départ avant toute arrivée → chrono figé, on attend le nouveau départ
        else if (s.heat && s.heat.status === "running" && !Object.values(s.heat.lanes).some((l) => l.fin)) { s.heat.status = "ready"; s.heat.start = null; s.heat.lanes = {}; s.heat.at = t; s.heat.recall = true; break; }
        if (!s.heat || s.heat.event !== ev.event || s.heat.heat !== ev.heat || s.heat.status === "done")
          s.heat = { event: ev.event, heat: ev.heat, laps: ev.laps || null, lanesUsed: ev.lanes || null, status: "ready", start: null, lanes: {}, at: t };
        break;
      case "start": { /* Quantum sans message de fin : la série précédente a des arrivées → elle est terminée, ce départ est celui de la série suivante (sinon : départ rappelé) */ if (s.heat && s.heat.status === "running" && Object.values(s.heat.lanes).some((l) => l.fin)) { s.heat.status = "done"; s.heat.doneAt = s.heat.doneAt || t; } if (s.heat && s.heat.status === "done") { (archive(s, s.heat), s.prev = s.heat); s.heat = null; } const h = ensure(); h.start = ev.srv || (ev.ts && ev.sent ? t - Math.max(0, ev.sent - ev.ts) : ev.ts || t); h.status = "running"; h.lanes = {}; h.recall = false; if (h.heat == null) { const p = s.prev; const near = p && p.event != null && p.doneAt && t - p.doneAt < 30 * 60000 && !(p.heats && (p.heat || 1) >= +p.heats); if (h.event == null && near) { h.event = p.event; h.key = p.key || null; h.title = p.title || ""; h.comp = p.comp || ""; h.heats = p.heats; h.laps = p.laps; } h.heat = near && p.event === h.event ? (p.heat || 1) + 1 : 1; h.heatGuess = true; } /* Quantum sans numéro de série : série suivante de la même épreuve */ break; }
      case "clock": { // temps de course du Quantum : recale l'heure de départ (sans retour en arrière visible de plus de 0,3 s)
        if (!ev.rt) return false;
        if (s.heat && s.heat.recall) return false; // départ rappelé : le chrono du Quantum peut encore tourner, on attend le vrai nouveau départ
        // départ manqué (relais redémarré en pleine course) : le temps de course suffit pour reprendre le direct
        if (!s.heat || s.heat.status === "ready" || (s.heat.status === "done" && ev.rt < 30)) { if (s.heat && s.heat.status === "done") { (archive(s, s.heat), s.prev = s.heat); s.heat = null; } const h0 = ensure(); h0.status = "running"; h0.start = null; }
        const h = s.heat; if (h.status !== "running") return false;
        const st = (ev.srv || t - Math.max(0, (ev.sent || ev.ts) - ev.ts)) - ev.rt * 1000;
        if (!h.start || Math.abs(st - h.start) > 100) h.start = Math.round(st); else return false;
        break;
      }
      case "fix": { /* admin : « la série dans l'eau est celle-ci » (Quantum qui n'annonce ni l'épreuve ni la série) ; les départs suivants enchaînent à partir d'elle */
        const h = s.heat; if (!h) return false; h.event = ev.event != null ? ev.event : h.event; h.heat = ev.heat || 1; h.key = ev.key || null; h.title = ev.title || ""; h.comp = ev.comp || h.comp || ""; h.heats = null; h.names = {}; h.heatGuess = true; h.sim = false; break; }
      case "react": { const l = lane(ev.lane); if (l) l.rt = ev.t; break; }
      case "split": { const l = lane(ev.lane); if (l) { l.laps[ev.lap] = { t: ev.t, rank: ev.rank || null, dist: ev.dist || null, edited: !!ev.edited }; l.last = ev.lap; } break; }
      case "finish": { const l = lane(ev.lane); if (l) { l.laps[ev.lap] = { t: ev.t, rank: ev.rank || null, dist: ev.dist || null, edited: !!ev.edited }; l.last = ev.lap; l.fin = { t: ev.t, rank: ev.rank || null }; } break; }
      case "end": if (s.heat) { s.heat.status = "done"; s.heat.doneAt = s.heat.doneAt || t; } break;
      case "heat": { // noms et résultats envoyés par le Quantum (série chargée, puis officielle)
        const fresh = ev.stat !== "O" && ev.stat !== "F"; // liste de départ (W) : série (re)mise au départ
        const same = s.heat && ((s.heat.event === ev.event && (s.heat.heat === ev.heat || (ev.heat == null && s.heat.heatGuess)) && !(fresh && s.heat.status === "done")) || (s.heat.event == null && s.heat.status !== "done"));
        if (same) { s.heat.event = ev.event; if (ev.heat != null) { s.heat.heat = ev.heat; s.heat.heatGuess = false; } }
        // départ rappelé : liste de départ (SL) renvoyée pour la série en cours, aucune arrivée, plus de 3 s après le départ → chrono figé jusqu'au nouveau départ
        if (same && ev.msg === "SL" && s.heat.status === "running" && s.heat.start && t - s.heat.start > 3000 && !Object.values(s.heat.lanes).some((l) => l.fin)) { s.heat.status = "ready"; s.heat.start = null; s.heat.lanes = {}; s.heat.recall = true; }
        if (!same) { if (s.heat && s.heat.start) (archive(s, s.heat), s.prev = s.heat); s.heat = { event: ev.event, heat: ev.heat, status: "ready", start: null, lanes: {}, at: t }; }
        if (ev.comp && !ev.sim && !/rempla/i.test(ev.comp) && !s.mainComp) s.mainComp = String(ev.comp).trim();
        const h = s.heat; h.sim = !!ev.sim; h.key = ev.key || null; h.comp = ev.comp || h.comp || ""; h.extra = isExtra(s, h.comp); h.title = ev.title || h.title; h.heats = ev.heats || h.heats; h.laps = ev.laps || h.laps;
        h.names = {}; for (const l of ev.lanes || []) if (l.name) h.names[l.lane] = { name: l.name, club: l.club, born: l.born, ...(Array.isArray(l.sw) && l.sw.length ? { sw: l.sw.slice(0, 8).map((x) => String(x).slice(0, 60)) } : {}) };
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
    // séries terminées vues sur la page « En direct » du Live FFN : gardées pour un classement provisoire dans Résultats
    if (url.pathname.endsWith("/lh") && req.method === "POST") {
      const b = await req.json().catch(() => null); if (!b || !b.event || !b.heat || !Array.isArray(b.rows)) return new Response("bad", { status: 400 });
      const key = "lh:" + String(b.event).toLowerCase().replace(/\s+/g, " ").trim() + "|" + String(b.heat).padStart(3, "0");
      const val = { event: b.event, heat: b.heat, of: b.of || null, rows: b.rows.slice(0, 12) };
      const old = await this.ctx.storage.get(key);
      if (JSON.stringify(old && { event: old.event, heat: old.heat, of: old.of, rows: old.rows }) !== JSON.stringify(val)) await this.ctx.storage.put(key, { ...val, at: Date.now() });
      return new Response(null, { status: 204 });
    }
    /* journal du site (sans « day ») ; le journal du chrono (avec « day ») est traité plus bas */
    if (url.pathname.endsWith("/log") && req.method === "POST" && !url.searchParams.get("day")) {
      const b = await req.json().catch(() => ({})); const now = Date.now();
      await this.ctx.storage.put("lg:" + String(now).padStart(14, "0") + Math.random().toString(36).slice(2, 5), { t: now, ev: b.ev || "", src: b.src || "", msg: b.msg || "" });
      // 300 lignes au plus
      if (Math.random() < 0.1) { const ks = [...(await this.ctx.storage.list({ prefix: "lg:" })).keys()]; if (ks.length > 300) await this.ctx.storage.delete(ks.slice(0, ks.length - 300).slice(0, 128)); }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/logs")) {
      const all = await this.ctx.storage.list({ prefix: "lg:" });
      if (url.searchParams.get("clear")) { const ks = [...all.keys()]; for (let i = 0; i < ks.length; i += 128) await this.ctx.storage.delete(ks.slice(i, i + 128)); return Response.json([]); }
      return Response.json([...all.values()].slice(-300).reverse());
    }
    // page « En direct » du Live FFN, lue une seule fois pour tous les spectateurs (tous centres Cloudflare confondus)
    if (url.pathname.endsWith("/ffnlive")) {
      const now = Date.now(); const u = url.searchParams.get("u");
      const c = this.fl || (this.fl = { at: 0, raw: null, err: null, errAt: 0 });
      const heats = async () => [...(await this.ctx.storage.list({ prefix: "lh:" })).values()];
      if (c.raw != null && now - c.at < 40e3) return Response.json({ at: c.at, raw: c.raw, heats: await heats() });
      // refus du Live FFN : on attend 30 s, puis 60 s, puis 2 min au plus entre deux essais (retour à la normale dès qu'il répond)
      const pause = /403/.test(c.err || "") ? Math.min(120e3, 30e3 * 2 ** Math.max(0, (c.fails || 1) - 1)) : 20e3;
      if (c.errAt && now - c.errAt < pause) return Response.json(c.raw != null ? { at: c.at, raw: c.raw, error: c.err } : { at: now, error: c.err });
      if (this.flBusy) { await this.flBusy; return Response.json(c.raw != null ? { at: c.at, raw: c.raw } : { at: now, error: c.err || "lecture en cours" }); }
      let fresh = false;
      this.flBusy = (async () => {
        try { c.raw = await ffnGet(u, { delay: 0, tries: 1 }); c.at = Date.now(); c.err = null; c.errAt = 0; c.fails = 0; }
        catch (e) { c.err = String(e.message || e); c.errAt = Date.now(); c.fails = (c.fails || 0) + 1; fresh = true; }
      })();
      await this.flBusy; this.flBusy = null;
      if (c.err && c.raw == null) return Response.json({ at: now, error: c.err, fresh });
      return Response.json({ at: c.at, raw: c.raw, heats: await heats(), ...(c.err ? { error: c.err, fresh } : {}) });
    }
    if (url.pathname.endsWith("/ffnget")) {
      try { return Response.json({ raw: await ffnGet(url.searchParams.get("u"), { delay: 0, tries: 2 }) }); }
      catch (e) { return Response.json({ error: String(e.message || e) }); }
    }
    if (url.pathname.endsWith("/lhs")) {
      const all = await this.ctx.storage.list({ prefix: "lh:" });
      return Response.json([...all.values()]);
    }
    if (url.pathname.endsWith("/ws")) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket attendu", { status: 426 });
      const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(this.snapshot());
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // journal brut du chrono (tout ce que lit le relais), compressé, gardé 14 jours : pour analyser un souci après coup
    if (url.pathname.endsWith("/log") && req.method === "POST") {
      const day = url.searchParams.get("day") || ""; const raw = await req.arrayBuffer();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !raw.byteLength || raw.byteLength > 120000) return new Response("bad", { status: 400 });
      const now = Date.now(); await this.ctx.storage.put(`j:${day}:${String(now).padStart(14, "0")}`, raw);
      this.s.relayAt = now; this.s.journalAt = now;
      // version du logiciel du chrono (affichée dans l'admin : à jour ou non)
      const ver = url.searchParams.get("ver"); if (ver && this.s.chronoVer !== ver) { this.s.chronoVer = ver; await this.ctx.storage.put("s", this.s); }
      this.s.chronoAt = now;
      if (!this.jclean || now - this.jclean > 3600e3) { this.jclean = now; const old = new Date(now - 14 * 864e5).toISOString().slice(0, 10);
        const ks = [...(await this.ctx.storage.list({ prefix: "j:", end: "j:" + old })).keys()]; for (let i = 0; i < ks.length; i += 128) await this.ctx.storage.delete(ks.slice(i, i + 128)); }
      return Response.json({ ok: true });
    }
    // messages du logiciel du chrono (texte lisible, à copier-coller) : chaque morceau gzip est décompressé à part
    // toutes les séries terminées (temps d'arrivée seulement) : classement provisoire des équipes
    if (url.pathname.endsWith("/hist")) {
      const out = []; const all = { ...(this.s.hist || {}) };
      const h = this.s.heat; if (h && h.event != null && h.heat && Object.values(h.lanes || {}).some((L) => L.fin)) all[(isExtra(this.s, h.comp) ? "x:" + h.comp + ":" : "") + h.event + "-" + h.heat] = h;
      for (const x of Object.values(all)) { if (x.sim) continue; const fin = {}; for (const n in x.lanes || {}) if (x.lanes[n].fin && x.lanes[n].fin.t != null) fin[n] = x.lanes[n].fin.t; const laps = {}; for (const n in x.lanes || {}) { const L = x.lanes[n].laps || {}; const ks = Object.keys(L).map(Number).sort((a, b) => a - b); if (ks.length) laps[n] = ks.map((k) => [k, L[k].t, L[k].dist || null]); }
        out.push({ extra: isExtra(this.s, x.comp) || !!x.extra, event: x.event, heat: x.heat, key: x.key || null, title: x.title || "", comp: x.comp || "", names: x.names || {}, fin, laps, start: x.start || null, doneAt: x.doneAt || null }); }
      return Response.json({ now: Date.now(), heats: out }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname.endsWith("/applog")) {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const all = await this.ctx.storage.list({ prefix: "j:" + day + ":" }); const lines = [];
      for (const [, v] of all) {
        try { const txt = await new Response(new Blob([v]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
          for (const l of txt.split("\n")) { if (!l.includes('"app"')) continue; try { const r = JSON.parse(l); if (r.app) lines.push({ t: r.ts, v: r.v || "", m: r.app }); } catch (e) {} } } catch (e) {}
      }
      return Response.json({ day, lines: lines.slice(-3000) });
    }
    if (url.pathname.endsWith("/journal")) {
      const day = url.searchParams.get("day");
      const all = await this.ctx.storage.list({ prefix: "j:" });
      if (!day) { const days = {}; for (const [k, v] of all) { const d = k.slice(2, 12); days[d] = (days[d] || 0) + v.byteLength; } return Response.json({ days }); }
      // morceaux compressés (gzip) mis bout à bout : un seul fichier .jsonl.gz lisible tel quel
      const parts = [...all].filter(([k]) => k.startsWith("j:" + day + ":")).map(([, v]) => new Uint8Array(v));
      const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
      return new Response(out, { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="journal-chrono-${day}.jsonl.gz"` } });
    }
    if (url.pathname.endsWith("/event") && req.method === "POST") {
      { const ver = url.searchParams.get("ver"); if (ver) { this.s.chronoVer = ver; this.s.chronoAt = Date.now(); } }
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

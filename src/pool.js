import { get as ffnGet } from "./ffn.js";
// Direct « Bassin » : une salle temps réel (Durable Object) alimentée par le relais branché sur le Quantum.
// Le relais envoie chaque événement (série prête, départ, réaction, passage, arrivée, fin officielle) ;
// les spectateurs reçoivent l'état complet par WebSocket. Le chrono tourne sur chaque téléphone à partir de l'heure de départ.

import { empty, applyEvent, isExtra } from "./poolcore.js";
const POOLCORE_VER = "2026-11-22-podium"; // version du moteur (vérifier qu'un déploiement a bien redémarré la salle)
import { pushNotify, evSig, compClose } from "./push.js";
import { euEnv } from "./eu.js";

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
    return JSON.stringify({ type: "state", now: Date.now(), core: POOLCORE_VER, ...rest, hist: h });
  }
  broadcast() { const msg = this.snapshot(); for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch {} } }

  apply(ev) { return applyEvent(this.s, ev, Date.now()); }

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
        const rt = {}; for (const n in x.lanes || {}) if (x.lanes[n].rt > 0) rt[n] = x.lanes[n].rt;
        out.push({ extra: isExtra(this.s, x.comp), event: x.event, heat: x.heat, key: x.key || null, title: x.title || "", comp: x.comp || "", names: x.names || {}, fin, laps, rt, start: x.start || null, doneAt: x.doneAt || null }); }
      return Response.json({ now: Date.now(), relayAt: this.s.relayAt || 0, heats: out }, { headers: { "cache-control": "no-store" } });
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
      const snap = () => { const h = this.s.heat; return h ? { st: h.status, e: h.event, h: h.heat, of: h.heats, t: h.title || "", c: h.comp || "", sim: !!h.sim } : null; };
      const b0 = snap();
      let n = 0; for (const ev of list.slice(0, 50)) if (ev && typeof ev === "object" && this.apply(ev)) n++;
      if (n) { await this.ctx.storage.put("s", this.s); this.broadcast(); }
      /* temps de course du Quantum (toutes les 2 s) : relayé tel quel aux écrans, sans écriture, pour que le chrono affiché suive celui du Quantum */
      { const c = list.filter((e) => e && e.k === "clock" && e.rt > 0).pop(), h = this.s.heat;
        if (c && h && h.status === "running" && !h.recall) { const msg = JSON.stringify({ type: "rt", rt: c.rt, e: h.event, h: h.heat, start: h.start }); for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch {} } } }
      /* notifications push des épreuves suivies : départ de la 1re série, résultats à la fin de la dernière série (titre du Quantum → signature de l'épreuve) */
      const live = url.searchParams.get("ev"), b1 = snap();
      if (live && b1 && !b1.sim && b1.t) {
        const m = (f) => f.sig === evSig(b1.t) && compClose(f.comp, b1.c);
        const started = b1.st === "running" && (!b0 || b0.st !== "running" || b0.e !== b1.e || b0.h !== b1.h) && (b1.h || 1) === 1;
        const ended = b1.st === "done" && (!b0 || b0.st !== "done" || b0.h !== b1.h) && b1.of && (b1.h || 1) >= +b1.of;
        if (started) this.ctx.waitUntil(pushNotify(euEnv(this.env), live, m, { title: "▶ C'est parti : " + b1.t, body: "L'épreuve commence" + (b1.c ? " · " + b1.c : "") }).catch(() => {}));
        if (ended) this.ctx.waitUntil(pushNotify(euEnv(this.env), live, m, { title: "✓ Terminé : " + b1.t, body: "Dernière série terminée, résultats en cours de publication" }).catch(() => {}));
      }
      return Response.json({ ok: true, applied: n, spectators: this.ctx.getWebSockets().length, now: Date.now() });
    }
    return new Response(this.snapshot(), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  webSocketMessage(ws, msg) { if (msg === "ping") ws.send("pong"); else if (typeof msg === "string" && msg.startsWith("t:")) ws.send(JSON.stringify({ type: "time", id: msg.slice(2, 40), now: Date.now() })); }
  webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch {} }
}

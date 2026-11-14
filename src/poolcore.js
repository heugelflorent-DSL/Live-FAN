// Logique du direct « Bassin » partagée : le serveur (Durable Object) et l'écran géant local (servi par le logiciel du chrono)
// appliquent exactement les mêmes règles aux événements du Quantum.
export const empty = () => ({ heat: null, prev: null, hist: {}, updatedAt: 0, relayAt: 0 });
/* autre compétition ouverte dans le Quantum : rangée à part (jamais mélangée avec les séries de la compétition principale) */
/* même compétition sur plusieurs réunions : le Quantum préfixe « R1 », « R2 »… → comparé sans ce préfixe */
export const compKey = (c) => String(c || "").trim().replace(/^(?:R|Réunion\s*)\d+\s*[-:·]?\s*/i, "").toLowerCase();
export function isExtra(s, comp) { comp = String(comp || "").trim(); return !!(comp && s.mainComp && compKey(comp) !== compKey(s.mainComp)); } /* le site décide si elle compte (2 compétitions sur le live) ou non (rattrapage) */
// séries terminées gardées pour l'affichage des « séries précédentes » de l'épreuve en cours
export const archive = (s, h) => {
  if (!h || h.event == null || !h.heat || !Object.values(h.lanes || {}).some((L) => L.fin)) return;
  s.hist = s.hist || {};
  const extra = isExtra(s, h.comp);
  s.hist[(extra ? "x:" + h.comp + ":" : "") + h.event + "-" + h.heat] = { extra, event: h.event, heat: h.heat, key: h.key || null, title: h.title || "", comp: h.comp || "", names: h.names || {}, lanes: h.lanes, start: h.start, doneAt: h.doneAt || Date.now(), sim: !!h.sim };
  const ks = Object.keys(s.hist); if (ks.length > 250) for (const k of ks.sort((a, b) => s.hist[a].doneAt - s.hist[b].doneAt).slice(0, ks.length - 250)) delete s.hist[k];
};
export function applyEvent(s, ev, t) {
    t = t || Date.now();
    const ensure = () => (s.heat = s.heat || { event: null, heat: null, status: "ready", start: null, lanes: {}, at: t });
    const lane = (n) => { const h = ensure(); return (h.lanes[n] = h.lanes[n] || { laps: {} }); };
    /* horloge du PC du chrono → horloge du serveur : écart minimal observé (décalage d'horloge + transit le plus court).
       Le temps de transit d'un envoi (réseau de la piscine, parfois 2-3 s) ne retarde donc plus l'heure de départ. */
    /* pas de remise à zéro brutale (elle faisait sauter le chrono de 1-3 s) : l'écart remonte très lentement (dérive d'horloge du PC, 50 ppm max) et redescend dès qu'un envoi plus rapide arrive */
    if (ev.sent && ev.ts) { const d = t - ev.sent; if (s.skew == null || Math.abs(d - s.skew) > 120000) { s.skew = d; } else { const up = s.skew + Math.max(0, t - (s.skewAt || t)) * 5e-5; s.skew = Math.min(up, d); } s.skewAt = t; }
    const pcT = (ts) => (ts && s.skew != null && ev.sent && Math.abs(t - ev.sent - s.skew) < 30000 ? ts + s.skew : null);
    switch (ev.k) {
      case "ready": // nouvelle série au départ : la précédente devient « dernière série »
        const otherC = !!(ev.comp && s.heat && s.heat.comp && compKey(ev.comp) !== compKey(s.heat.comp));
        if (s.heat && (otherC || s.heat.event !== ev.event || s.heat.heat !== ev.heat)) { if (s.heat.start) (archive(s, s.heat), s.prev = s.heat); }
        // départ rappelé (2e départ aux interclubs) : la même série est remise au départ avant toute arrivée → chrono figé, on attend le nouveau départ
        else if (s.heat && s.heat.status === "running" && !Object.values(s.heat.lanes).some((l) => l.fin)) { s.heat.status = "ready"; s.heat.start = null; s.heat.lanes = {}; s.heat.at = t; s.heat.recall = true; break; }
        if (!s.heat || otherC || s.heat.event !== ev.event || s.heat.heat !== ev.heat || s.heat.status === "done")
          s.heat = { event: ev.event, heat: ev.heat, comp: ev.comp || "", laps: ev.laps || null, lanesUsed: ev.lanes || null, status: "ready", start: null, lanes: {}, at: t };
        break;
      case "start": { /* Quantum sans message de fin : la série précédente a des arrivées → elle est terminée, ce départ est celui de la série suivante (sinon : départ rappelé) */ if (s.heat && s.heat.status === "running" && Object.values(s.heat.lanes).some((l) => l.fin)) { s.heat.status = "done"; s.heat.doneAt = s.heat.doneAt || t; } if (s.heat && s.heat.status === "done") { (archive(s, s.heat), s.prev = s.heat); s.heat = null; } const h = ensure(); h.start = ev.srv || pcT(ev.ts) || (ev.ts && ev.sent ? t - Math.max(0, ev.sent - ev.ts) : ev.ts || t); h.status = "running"; h.lanes = {}; h.recall = false; if (h.heat == null) { const p = s.prev; const near = p && p.event != null && p.doneAt && t - p.doneAt < 30 * 60000 && !(p.heats && (p.heat || 1) >= +p.heats); if (h.event == null && near) { h.event = p.event; h.key = p.key || null; h.title = p.title || ""; h.comp = p.comp || ""; h.heats = p.heats; h.laps = p.laps; } h.heat = near && p.event === h.event ? (p.heat || 1) + 1 : 1; h.heatGuess = true; } /* Quantum sans numéro de série : série suivante de la même épreuve */ break; }
      case "clock": { // temps de course du Quantum : recale l'heure de départ (sans retour en arrière visible de plus de 0,3 s)
        if (!ev.rt) return false;
        if (s.heat && s.heat.recall) return false; // départ rappelé : le chrono du Quantum peut encore tourner, on attend le vrai nouveau départ
        // départ manqué (relais redémarré en pleine course) : le temps de course suffit pour reprendre le direct
        if (!s.heat || s.heat.status === "ready" || (s.heat.status === "done" && ev.rt < 30)) { if (s.heat && s.heat.status === "done") { (archive(s, s.heat), s.prev = s.heat); s.heat = null; } const h0 = ensure(); h0.status = "running"; h0.start = null; }
        const h = s.heat; if (h.status !== "running") return false;
        const st = (ev.srv || pcT(ev.ts) || t - Math.max(0, (ev.sent || ev.ts) - ev.ts)) - ev.rt * 1000;
        if (!h.start || Math.abs(st - h.start) > 100) h.start = Math.round(st); else return false;
        break;
      }
      case "fix": { /* admin : « la série dans l'eau est celle-ci » (Quantum qui n'annonce ni l'épreuve ni la série) ; les départs suivants enchaînent à partir d'elle */
        const h = s.heat; if (!h) return false; h.event = ev.event != null ? ev.event : h.event; h.heat = ev.heat || 1; h.key = ev.key || null; h.title = ev.title || ""; h.comp = ev.comp || h.comp || ""; h.heats = null; h.names = {}; h.heatGuess = true; h.sim = false; break; }
      case "react": { const l = lane(ev.lane); if (l) l.rt = ev.t; break; }
      /* plaque (Type T) prioritaire sur les boutons de secours (« poires », Type 1-3) : un temps de poire ne remplace jamais celui de la plaque, quel que soit l'ordre d'arrivée */
      case "split": case "finish": { const l = lane(ev.lane); if (!l) break; const old = l.laps[ev.lap]; if (old && !old.edited && ev.edited) break;
        /* temps impossible : plus long que le temps écoulé depuis le départ (+10 s de marge), ex. appui parasite sur la plaque → ignoré, le vrai temps arrive ensuite */
        { const h0 = s.heat; if (h0 && h0.start && ev.t > (t - h0.start) / 1000 + 10) break; }
        l.laps[ev.lap] = { t: ev.t, rank: ev.rank || (old && old.rank) || null, dist: ev.dist || null, edited: !!ev.edited }; l.last = Math.max(l.last || 0, ev.lap);
        if (ev.k === "finish") { l.fin = { t: ev.t, rank: ev.rank || (l.fin && l.fin.rank) || null }; s.heat.finAt = t; } break; }
      case "end": if (s.heat) { s.heat.status = "done"; s.heat.doneAt = s.heat.doneAt || t; } break;
      case "heat": { // noms et résultats envoyés par le Quantum (série chargée, puis officielle)
        const fresh = ev.stat !== "O" && ev.stat !== "F"; // liste de départ (W) : série (re)mise au départ
        /* même numéro d'épreuve et de série mais autre compétition du Quantum : c'est une autre série (sinon temps et classement de la précédente restent affichés) */
        const sameC = !ev.comp || !s.heat || !s.heat.comp || compKey(ev.comp) === compKey(s.heat.comp);
        const same = s.heat && sameC && ((s.heat.event === ev.event && (s.heat.heat === ev.heat || (ev.heat == null && s.heat.heatGuess)) && !(fresh && s.heat.status === "done")) || (s.heat.event == null && s.heat.status !== "done"));
        if (same) { s.heat.event = ev.event; if (ev.heat != null) { s.heat.heat = ev.heat; s.heat.heatGuess = false; } }
        // départ rappelé : liste de départ (SL) renvoyée pour la série en cours, aucune arrivée, plus de 3 s après le départ → chrono figé jusqu'au nouveau départ
        if (same && ev.msg === "SL" && s.heat.status === "running" && s.heat.start && t - s.heat.start > 3000 && !Object.values(s.heat.lanes).some((l) => l.fin)) { s.heat.status = "ready"; s.heat.start = null; s.heat.lanes = {}; s.heat.recall = true; }
        if (!same) { if (s.heat && s.heat.start) (archive(s, s.heat), s.prev = s.heat); s.heat = { event: ev.event, heat: ev.heat, status: "ready", start: null, lanes: {}, at: t }; }
        if (ev.comp && !ev.sim && !s.mainComp) s.mainComp = String(ev.comp).trim();
        const h = s.heat; h.sim = !!ev.sim; h.key = ev.key || null; h.comp = ev.comp || h.comp || ""; h.extra = isExtra(s, h.comp); h.title = ev.title || h.title; h.heats = ev.heats || h.heats; h.laps = ev.laps || h.laps;
        h.names = {}; for (const l of ev.lanes || []) if (l.name) h.names[l.lane] = { name: l.name, club: l.club, born: l.born, ...(Array.isArray(l.sw) && l.sw.length ? { sw: l.sw.slice(0, 12).map((x) => String(x).slice(0, 60)) } : {}) };
        if (ev.stat === "O" || ev.stat === "F") { h.status = "done"; h.doneAt = h.doneAt || t; h.official = true; for (const l of ev.lanes || []) if (l.time) { const L = (h.lanes[l.lane] = h.lanes[l.lane] || { laps: {} }); L.fin = { t: l.time, rank: l.rank }; } }
        if (h.official) archive(s, h);
        break;
      }
      case "clear": for (const k of Object.keys(s)) delete s[k]; Object.assign(s, empty()); break;
      /* écran choisi depuis le logiciel du chrono : évacuation, cérémonie, compte à rebours, pause… ; « normal » rend la main au direct */
      case "screen": s.screen = ev.mode && ev.mode !== "normal" ? { mode: String(ev.mode).slice(0, 20), at: t, title: String(ev.title || "").slice(0, 120) } : null; break;
      case "tvfmt": s.tvfmt = ev.fmt === "43" || ev.fmt === "169" ? ev.fmt : null; break;
      case "ping": break;
      default: return false;
    }
    /* chronométrage aux poires (une seule par couloir) : si un officiel n'appuie pas, le Quantum n'annonce jamais la fin.
       La série est considérée terminée quand tous les nageurs ont un temps, ou qu'il n'en manque qu'un depuis 20 s,
       ou que la moitié au moins a un temps depuis 60 s. Un temps saisi ensuite (correction du Quantum) est toujours pris. */
    { const h = s.heat; if (h && h.status === "running" && h.finAt) {
        const L = Object.values(h.lanes || {}), nf = L.filter((x) => x.fin).length, nn = Object.keys(h.names || {}).length;
        const tot = Math.max(nn, L.filter((x) => x.fin || x.rt || Object.keys(x.laps || {}).length).length, nf), w = t - h.finAt;
        if ((nn && nf >= tot) || (nf >= tot - 1 && w > 20000) || (nf * 2 >= tot && w > 60000)) { h.status = "done"; h.doneAt = h.doneAt || t; h.autoEnd = true; }
    } }
    s.updatedAt = t; s.relayAt = t;
    return true;
}

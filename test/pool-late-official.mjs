// Résultats officiels tardifs d'une ancienne série pendant une série en cours : ils ne doivent pas prendre la place de la série en cours
import assert from "assert"; import { empty, applyEvent } from "../src/poolcore.js";
const s = empty(); let t = 1_000_000;
const ap = (ev) => applyEvent(s, ev, (t += 1000));
ap({ k: "ready", event: 11, heat: 5, comp: "G_R2", title: "50 m Dos Dames", lanes: 8 });
ap({ k: "start", ts: t });
assert.equal(s.heat.event, 11); assert.equal(s.heat.status, "running");
// validation tardive des résultats de la série 3 du 100 brasse
ap({ k: "heat", event: 22, heat: 3, stat: "O", comp: "G_R2", title: "100 m Brasse Dames", lanes: [{ lane: 1, name: "A", time: 84.3, rank: 2 }, { lane: 2, name: "B", time: 85.6, rank: 3 }] });
assert.equal(s.heat.event, 11, "la série en cours reste la 50 dos"); assert.equal(s.heat.heat, 5); assert.equal(s.heat.status, "running");
assert.ok(s.hist["22-3"], "l'ancienne série est rangée dans l'historique"); assert.equal(s.hist["22-3"].lanes[1].fin.t, 84.3);
// série chargée (prête) : même protection
const s2 = empty(); const ap2 = (ev) => applyEvent(s2, ev, (t += 1000));
ap2({ k: "ready", event: 11, heat: 6, comp: "G_R2", title: "50 m Dos Dames", lanes: 8 });
ap2({ k: "heat", event: 11, heat: 6, stat: "W", comp: "G_R2", title: "50 m Dos Dames", lanes: [{ lane: 1, name: "C" }] });
ap2({ k: "heat", event: 22, heat: 7, stat: "O", comp: "G_R2", title: "100 m Brasse Dames", lanes: [{ lane: 1, name: "D", time: 80, rank: 1 }] });
assert.equal(s2.heat.event, 11); assert.equal(s2.heat.heat, 6); assert.equal(s2.heat.names[1].name, "C"); assert.ok(s2.hist["22-7"]);
// série en cours terminée normalement : ses résultats officiels la valident toujours
ap({ k: "heat", event: 11, heat: 5, stat: "O", comp: "G_R2", title: "50 m Dos Dames", lanes: [{ lane: 1, name: "E", time: 33, rank: 1 }] });
assert.equal(s.heat.event, 11); assert.equal(s.heat.status, "done"); assert.equal(s.heat.official, true);
console.log("ok pool-late-official");

// Hébergement des données en Europe.
// - Réglages et données des lives : base D1 créée avec la juridiction « eu » (stockée et traitée uniquement dans l'UE).
//   Même interface que l'ancien stockage KV (get / put / delete), pour ne rien changer au reste du code.
//   Reprise des anciennes données : une clé absente de la base est lue une fois dans l'ancien KV puis recopiée
//   (une page d'admin recopie tout d'un coup et vide l'ancien stockage).
// - Relais (direct, statistiques, journal, chrono) : objets Durable créés dans la juridiction « eu ».

let READY = null;
const init = (db) => (READY = READY || db.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, del INTEGER NOT NULL DEFAULT 0, at INTEGER)").run().catch((e) => { READY = null; throw e; }));

export class EuKV {
  constructor(db, old) { this.db = db; this.old = old || null; }
  async get(k, type) {
    await init(this.db);
    const row = await this.db.prepare("SELECT v, del FROM kv WHERE k = ?").bind(k).first();
    let v = null;
    if (row) { if (row.del) return null; v = row.v; }
    else if (this.old) { // pas encore recopiée : reprise depuis l'ancien stockage
      v = await this.old.get(k);
      if (v != null) await this.db.prepare("INSERT OR IGNORE INTO kv (k, v, del, at) VALUES (?, ?, 0, ?)").bind(k, v, Date.now()).run();
    }
    if (v == null) return null;
    if (type === "json") { try { return JSON.parse(v); } catch (e) { return null; } }
    return v;
  }
  async put(k, v) {
    await init(this.db);
    await this.db.prepare("INSERT INTO kv (k, v, del, at) VALUES (?, ?, 0, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, del = 0, at = excluded.at").bind(k, typeof v === "string" ? v : String(v), Date.now()).run();
  }
  async delete(k) { // marque supprimée (sinon la reprise ferait revenir l'ancienne valeur)
    await init(this.db);
    await this.db.prepare("INSERT INTO kv (k, v, del, at) VALUES (?, NULL, 1, ?) ON CONFLICT(k) DO UPDATE SET v = NULL, del = 1, at = excluded.at").bind(k, Date.now()).run();
  }
  // recopie complète de l'ancien stockage (admin), puis vidage si demandé
  async migrateAll(purge) {
    await init(this.db);
    if (!this.old) return { copied: 0, kept: 0, purged: 0, left: 0 };
    let cursor, copied = 0, kept = 0, purged = 0; const keys = [];
    do { const r = await this.old.list({ cursor }); for (const x of r.keys) keys.push(x.name); cursor = r.list_complete ? null : r.cursor; } while (cursor);
    for (const k of keys) {
      const row = await this.db.prepare("SELECT 1 AS x FROM kv WHERE k = ?").bind(k).first();
      if (!row) { const v = await this.old.get(k); if (v != null) { await this.db.prepare("INSERT OR IGNORE INTO kv (k, v, del, at) VALUES (?, ?, 0, ?)").bind(k, v, Date.now()).run(); copied++; } }
      else kept++;
    }
    if (purge) for (const k of keys) { await this.old.delete(k); purged++; }
    return { copied, kept, purged, left: purge ? 0 : keys.length };
  }
}

// env « Europe » : stockage D1 (UE) à la place de KV, relais dans la juridiction UE
export function euEnv(env) {
  if (!env || env.__eu) return env;
  const out = Object.create(env);
  out.__eu = true;
  if (env.DB) { out.KV = new EuKV(env.DB, env.KV); out.OLDKV = env.KV; }
  for (const n of ["POOL", "STATS"]) if (env[n] && typeof env[n].jurisdiction === "function") { try { out[n] = env[n].jurisdiction("eu"); } catch (e) { /* essai en local : non pris en charge */ } }
  return out;
}

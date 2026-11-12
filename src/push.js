// Notifications « push » (page fermée) : Web Push standard (RFC 8291 chiffrement aes128gcm + RFC 8292 VAPID), sans bibliothèque.
// Clés : VAPID_PUBLIC (variable, base64url du point P-256 non compressé, 65 octets) et VAPID_PRIVATE (secret, base64url de d, 32 octets).
// Abonnements par live : env.KV clé « push:<live> » = { <id>: { sub, follow: [{ key, name, comp, sig }], at } }.
// © Mat-et-Flo
import { kk } from "./worker.js";

const te = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ub64 = (s) => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

// signature d'une épreuve, la même pour le nom FFN (« 50 Papillon Dames ») et le titre du Quantum (« Dam - 50 m Pap. ») :
// sexe + distance (ou relais 4x50) + nage
export function evSig(name) {
  const t = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const sex = /\b(dames?|filles?|dam)\b/.test(t) ? "F" : /\b(messieurs?|garcons?|mes|mess|hommes?)\b/.test(t) ? "M" : /mixte|mix/.test(t) ? "X" : "";
  const rel = t.match(/(\d)\s*x\s*(\d{2,4})/); const d = rel ? rel[1] + "x" + rel[2] : (t.match(/\b(25|50|100|200|400|800|1500)\b/) || [])[1] || "";
  const st = /4\s*n|4\s*nages|quatre|medley|im\b/.test(t) ? "4N" : /pap|butterfly|fly/.test(t) ? "PA" : /dos|back/.test(t) ? "DO" : /bra|breast/.test(t) ? "BR" : /libre|nl\b|free|crawl/.test(t) ? "NL" : "";
  return sex + "|" + d + "|" + st;
}
const words = (s) => new Set(String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/^(2025|2026|2027|natation|competition)$/.test(w)));
export function compClose(a, b) { if (!a || !b) return true; const A = words(a); for (const w of words(b)) if (A.has(w)) return true; return false; }

async function vapidAuth(env, endpoint) {
  const pub = ub64(env.VAPID_PUBLIC), d = env.VAPID_PRIVATE;
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUB || "https://swim-direct.swim-direct.workers.dev" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(head + "." + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}
const hkdf = async (salt, ikm, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bytes * 8));
async function encrypt(sub, text) {
  const ua = ub64(sub.keys.p256dh), auth = ub64(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(te.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, cat(te.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

export async function pushOne(env, sub, payload) {
  const body = await encrypt(sub, JSON.stringify(payload));
  const r = await fetch(sub.endpoint, { method: "POST", body, headers: { Authorization: await vapidAuth(env, sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high" } });
  return r.status;
}

// envoie à tous les abonnés du live dont une épreuve suivie correspond (match(entry) → true) ; abonnements expirés supprimés
export async function pushNotify(env, ev, match, payload) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return 0;
  const all = (await env.KV.get(kk("push", ev), "json")) || {}; let n = 0, gone = false;
  for (const [id, s] of Object.entries(all)) {
    if (n >= 30) break;
    const hit = match === true ? (s.follow || []).length > 0 : (s.follow || []).find(match);
    if (!hit) continue;
    try { const st = await pushOne(env, s.sub, { ...payload, key: payload.key || (hit && hit.key) || "", url: "/e/" + ev + (payload.key || (hit && hit.key) ? "#prog/" + encodeURIComponent(payload.key || hit.key) : "") }); n++; if (st === 404 || st === 410) { delete all[id]; gone = true; } } catch (e) {}
  }
  if (gone) await env.KV.put(kk("push", ev), JSON.stringify(all));
  return n;
}

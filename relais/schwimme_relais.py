#!/usr/bin/env python3
"""Relais Schwimme Direct — branché sur la sortie série d'un Quantum (protocole OSM6).

Il écoute UNIQUEMENT (il n'envoie jamais rien vers le chronométrage), enregistre tout ce qui passe
dans un journal brut, décode les événements (série prête, départ, réaction, passage, arrivée,
fin officielle) et les transmet au site Schwimme Direct.

Utilisation :
  python schwimme_relais.py --ports                 # liste les ports série
  python schwimme_relais.py --port COM5             # Windows
  python schwimme_relais.py --port /dev/tty.usbserial-XXXX   # Mac
  python schwimme_relais.py --demo                  # simule une course (sans matériel)
  python schwimme_relais.py --replay journal.jsonl  # rejoue un enregistrement
  python schwimme_relais.py --port COM5 --capture   # enregistre seulement, n'envoie rien au site

Mot de passe : celui de l'admin du site, demandé au démarrage (ou variable SCHWIMME_CLE).
"""
import argparse, getpass, json, os, queue, sys, threading, time, urllib.request, urllib.error
from datetime import datetime

SITE = "https://schwimme-direct.natation-alsace.workers.dev"
SOH, STX, EOT, BS, LF, DC2, DC4 = b"\x01", b"\x02", b"\x04", b"\x08", b"\x0a", b"\x12", b"\x14"
ALIVE = SOH + DC2 + b"9" + DC4 + b"TP" + EOT
HEAD = SOH + STX + BS

if sys.stdout is None:  # lancé en arrière-plan (pythonw) : messages dans relais.log
    sys.stdout = sys.stderr = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "relais.log"), "a", encoding="utf-8", buffering=1)
def log(*a): print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)

def to_sec(txt):
    """'  1:05.85' / '00:01:05.85' / '31.12' -> secondes (None si vide)."""
    t = (txt or "").strip()
    if not t or not any(c.isdigit() for c in t): return None
    parts = t.split(":"); sec = 0.0
    try:
        for p in parts[:-1]: sec = sec * 60 + int(p or 0)
        return round(sec * 60 + float(parts[-1]), 2)
    except ValueError: return None

def num(b):
    try: return int(b.decode("ascii").strip() or 0)
    except (ValueError, UnicodeDecodeError): return 0

class Decoder:
    rt_at = 0
    """Assemble les trames OSM6 (deux messages par événement) et produit des événements Schwimme Direct."""
    def __init__(self): self.buf = b""; self.pt1 = None; self.ts1 = None
    def feed(self, data, ts):
        self.buf += data; out = []
        while EOT in self.buf:
            i = self.buf.index(EOT); frame = self.buf[: i + 1]; self.buf = self.buf[i + 1 :]
            j = frame.find(SOH)
            if j < 0: continue
            frame = frame[j:]
            if frame[1:2] == b"{":  # sortie réseau « Tableau Écran » (SCB Sport In The Box) : JSON
                ev = self.decode_json(frame[1:-1], ts)
                if ev: out.append(ev)
                continue
            if frame == ALIVE or not frame.startswith(HEAD): continue
            payload = frame[len(HEAD):-1]
            if payload[:1] == LF:  # 2e partie : couloir, longueur, temps
                if self.pt1 is None: continue
                ev = self.decode(self.pt1, payload, self.ts1); self.pt1 = None
                if ev: out.append(ev)
            else:
                self.pt1, self.ts1 = payload, ts
        if len(self.buf) > 512: self.buf = self.buf[-64:]
        return out
    @staticmethod
    def decode_json(raw, ts):
        """Messages JSON du Quantum (port 26700) : TP=vivant, ST=départ, TK=touche, HO=série (noms, résultats)."""
        try: j = json.loads(raw.decode("utf-8", "replace"))
        except ValueError: return None
        m = j.get("Msg")
        if m == "ST": Decoder.rt_at = ts; return {"k": "start", "ts": int(ts * 1000), "tod": j.get("TS")}
        if m == "RT":  # chrono qui tourne sur le Quantum : recalage du site toutes les 2 s
            rt = to_sec(j.get("RT"))
            if rt is None or rt <= 0 or ts - Decoder.rt_at < 2: return None
            Decoder.rt_at = ts; return {"k": "clock", "ts": int(ts * 1000), "rt": rt}
        if m == "TK":
            ln = j.get("Ln") or 0
            if not ln or j.get("Kind") not in ("I", "F") or not j.get("Time"): return None  # remise à zéro / couloir vide
            t = to_sec(j.get("Time")); rk = int(j.get("Rk") or 0) or None; lap = j.get("Lap") or 0
            dist = int(j.get("Dist") or 0) or None
            kind = "finish" if j.get("Kind") == "F" else "split"
            return {"k": kind, "lane": ln, "lap": lap, "dist": dist, "t": t, "rank": rk, "edited": j.get("Type") not in (None, "T")}
        if m in ("HO", "HS", "SL", "HR"):
            e = j.get("EvHeader") or {}; h = j.get("HeatHeader") or {}
            lanes = [{"lane": x.get("Ln"), "name": x.get("Name") or "", "club": x.get("Club") or "", "born": x.get("Born") or "",
                      "time": to_sec(x.get("Time")), "rank": int(x.get("Rk") or 0) or None, "stat": x.get("Stat")} for x in (j.get("Lanes") or []) if x.get("Ln")]
            title = " ".join(v for v in [e.get("Dist"), e.get("Stroke"), e.get("Cat"), e.get("Round")] if v)
            return {"k": "heat", "msg": m, "event": int(e.get("Number") or 0) or None, "heat": int(h.get("Number") or 0) or None,
                    "heats": e.get("Heats"), "laps": e.get("Laps"), "title": title, "stat": h.get("Stat"), "lanes": lanes}
        return None
    @staticmethod
    def decode(p1, p2, ts):
        A, B, C = p1[0:1], p1[1:2], p1[2:3]
        lanes, laps, event, heat, rank = num(p1[3:5]), num(p1[5:7]), num(p1[7:10]), num(p1[10:12]), num(p1[14:16])
        lane, lap = num(p2[1:2]) or 10 if p2[1:2] == b"0" else num(p2[1:2]), num(p2[2:4])
        st = p2.find(STX); t = to_sec(p2[st + 1 :].decode("ascii", "replace")) if st >= 0 else None
        edited = C in (b"E", b"+", b"-")
        if A == b"0": return {"k": "ready", "event": event, "heat": heat, "laps": laps, "lanes": lanes}
        if A == b"1": return {"k": "end", "event": event, "heat": heat}
        if A == b"2":
            if B == b"S": return {"k": "start", "ts": int(ts * 1000), "event": event, "heat": heat}
            if B == b"R": return {"k": "react", "lane": lane, "t": t}
            if B in (b"I", b"D"): return {"k": "split", "lane": lane, "lap": lap, "t": t, "rank": rank, "edited": edited}
            if B in (b"A", b"B"): return {"k": "finish", "lane": lane, "lap": lap, "t": t, "rank": rank, "edited": edited}
        return None

class Sender(threading.Thread):
    """Envoie les événements au site, groupés, avec nouvelles tentatives si la connexion coupe."""
    def __init__(self, site, key):
        super().__init__(daemon=True); self.q = queue.Queue(); self.site = site.rstrip("/"); self.key = key; self.ev = None; self.off = None  # décalage horloge PC -> site (ms)
    def run(self):
        while True:
            batch = [self.q.get()]
            time.sleep(0.15)
            while not self.q.empty() and len(batch) < 40: batch.append(self.q.get())
            delay = 1
            while True:
                try:
                    req = urllib.request.Request(self.site + "/api/pool/event" + (("?e=" + self.ev) if self.ev else ""), data=json.dumps([dict(e, sent=int(time.time() * 1000), **({"srv": int(e["ts"] + self.off)} if self.off is not None and e.get("ts") else {})) for e in batch]).encode(), method="POST",
                                                 headers={"content-type": "application/json", "x-admin-key": self.key, "user-agent": "SchwimmeRelais/1.0"})
                    t0 = time.time() * 1000
                    with urllib.request.urlopen(req, timeout=8) as r: res = json.loads(r.read() or b"{}")
                    t1 = time.time() * 1000
                    if res.get("now") and t1 - t0 < 1500:  # recalage de l'horloge sur celle du site (aller-retour le plus court)
                        o = res["now"] - (t0 + t1) / 2
                        if self.off is None or t1 - t0 < getattr(self, "rtt", 1e9) + 30: self.off = o; self.rtt = t1 - t0
                    log(f"→ site : {len(batch)} événement(s) envoyé(s) · {res.get('spectators', 0)} spectateur(s) connecté(s)"); break
                except urllib.error.HTTPError as e:
                    if e.code == 401: log("✗ Mot de passe refusé par le site. Relance le relais avec le bon mot de passe admin."); os._exit(2)
                    log(f"✗ Erreur du site ({e.code}), nouvel essai dans {delay}s")
                except Exception as e: log(f"✗ Site injoignable ({e}), nouvel essai dans {delay}s")
                time.sleep(delay); delay = min(delay * 2, 20)

def describe(ev):
    k = ev["k"]
    if k == "ready": return f"Série prête : épreuve {ev['event']}, série {ev['heat']} ({ev['laps']} longueurs, {ev['lanes']} couloirs)"
    if k == "start": return "DÉPART"
    if k == "react": return f"Réaction couloir {ev['lane']} : {ev['t']}"
    if k == "split": return f"Passage couloir {ev['lane']}, longueur {ev['lap']} : {ev['t']} (rang {ev['rank']})"
    if k == "finish": return f"ARRIVÉE couloir {ev['lane']} : {ev['t']} (rang {ev['rank']})"
    if k == "end": return "Fin officielle de la série"
    if k == "heat": return f"Série : épreuve {ev['event']} {ev['title']}, série {ev['heat']} ({ev['msg']}, état {ev['stat']}) · {len(ev['lanes'])} couloirs"
    return k

def run(source, sender, journal):
    dec = Decoder()
    for data, ts in source:
        if journal: journal.write(json.dumps({"ts": ts, "hex": data.hex()}) + "\n"); journal.flush()
        for ev in dec.feed(data, ts):
            if ev["k"] != "clock": log(describe(ev))
            if sender: sender.q.put(ev)

def serial_source(port, settings):
    import serial  # pip install pyserial
    baud, bits, parity, stop = (settings.split(",") + ["9600", "7", "N", "1"])[:4]
    kw = dict(port=port, baudrate=int(baud), bytesize={"7": serial.SEVENBITS, "8": serial.EIGHTBITS}[bits],
              parity={"N": serial.PARITY_NONE, "E": serial.PARITY_EVEN, "O": serial.PARITY_ODD}[parity.upper()],
              stopbits=serial.STOPBITS_ONE if stop == "1" else serial.STOPBITS_TWO, timeout=1)
    while True:
        try:
            with serial.Serial(**kw) as s:
                log(f"Port {port} ouvert ({settings}). En écoute…")
                while True:
                    d = s.read(256)
                    if d: yield d, time.time()
        except Exception as e:
            log(f"✗ Port {port} : {e}. Nouvel essai dans 5 s"); time.sleep(5)

def net_source(spec):
    """Réception réseau : 'udp:26801' (écoute UDP) ou 'tcp:26800' (écoute TCP) ou 'tcp:192.168.1.10:4000' (connexion)."""
    import socket
    kind, *rest = spec.split(":")
    if kind == "udp":
        import select
        socks = []
        for port in rest[-1].split(","):
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try: s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            except OSError: pass
            s.bind(("0.0.0.0", int(port))); socks.append(s)
        log(f"Écoute UDP sur le(s) port(s) {rest[-1]}…")
        while True:
            for s in select.select(socks, [], [])[0]:
                d, addr = s.recvfrom(65535)
                log(f"UDP {addr[0]} → port {s.getsockname()[1]} : {len(d)} octets · {d[:60]!r}")
                yield d, time.time()
    while True:
        try:
            if len(rest) == 2:
                c = socket.create_connection((rest[0], int(rest[1])), timeout=10); log(f"Connecté à {rest[0]}:{rest[1]}")
            else:
                srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("0.0.0.0", int(rest[0]))); srv.listen(1)
                log(f"En attente d'une connexion TCP sur le port {rest[0]}…"); c, addr = srv.accept(); log(f"Connexion de {addr[0]}")
            c.settimeout(None)
            while True:
                d = c.recv(4096)
                if not d: raise ConnectionError("connexion fermée")
                yield d, time.time()
        except Exception as e:
            log(f"✗ Réseau : {e}. Nouvel essai dans 5 s"); time.sleep(5)

def replay_source(path, speed):
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    t0, r0 = time.time(), rows[0]["ts"] if rows else 0
    for r in rows:
        wait = (r["ts"] - r0) / speed - (time.time() - t0)
        if wait > 0: time.sleep(wait)
        yield bytes.fromhex(r["hex"]), time.time()

def frame(p1, p2=None):
    out = HEAD + p1.encode("ascii") + EOT
    if p2 is not None: out += HEAD + LF + p2.encode("ascii") + EOT
    return out

def demo_source(event=1, heat=1, lanes=(1, 2, 3, 4, 5, 6, 7, 8), laps=4):
    """Fausse course de 100 m en bassin de 25 m, au format OSM6, pour tester sans matériel."""
    import random
    def p1(a, b, rank=0): return f"{a}{b} {len(lanes):02d}{laps:02d}{event:03d}{heat:02d}  {rank:02d}"
    def p2(lane, lap, t): m, s = divmod(t, 60); return f"{lane % 10}{lap:02d}" + STX.decode() + f"00:{int(m):02d}:{s:05.2f} "
    yield ALIVE, time.time(); time.sleep(1)
    yield frame(p1("0", " "), p2(0, 0, 0)), time.time(); time.sleep(3)
    yield frame(p1("2", "S"), p2(0, 0, 0)), time.time(); start = time.time()
    speed = {l: random.uniform(14.5, 17.5) for l in lanes}
    time.sleep(0.7)
    for l in lanes: yield frame(p1("2", "R"), p2(l, 0, round(random.uniform(0.6, 0.8), 2))), time.time()
    evs = sorted([(speed[l] * k + random.uniform(-.3, .3), l, k) for l in lanes for k in range(1, laps + 1)])
    for i, (t, l, k) in enumerate(evs):
        while time.time() - start < t: time.sleep(0.05)
        rank = 1 + sum(1 for (t2, l2, k2) in evs[:i] if k2 == k)
        yield frame(p1("2", "A" if k == laps else "I", rank), p2(l, k, round(t, 2))), time.time()
    time.sleep(3); yield frame(p1("1", " "), p2(0, 0, 0)), time.time()

def main():
    ap = argparse.ArgumentParser(description="Relais Schwimme Direct pour Quantum (OSM6)")
    ap.add_argument("--port"); ap.add_argument("--reglages", default="9600,7,N,1", help="vitesse,bits,parité,arrêt (défaut 9600,7,N,1)")
    ap.add_argument("--reseau", help="au lieu d'un port série : udp:PORT, tcp:PORT (écoute) ou tcp:IP:PORT")
    ap.add_argument("--site", default=SITE); ap.add_argument("--evenement", help="identifiant de l'événement (ex. test), sinon l'événement principal"); ap.add_argument("--ports", action="store_true", help="liste les ports série")
    ap.add_argument("--demo", action="store_true"); ap.add_argument("--replay"); ap.add_argument("--vitesse", type=float, default=1.0)
    ap.add_argument("--capture", action="store_true", help="enregistre seulement, sans rien envoyer au site")
    ap.add_argument("--journal", default=None, help="fichier du journal brut (défaut : journal-AAAAMMJJ-HHMM.jsonl)")
    a = ap.parse_args()
    if a.ports:
        from serial.tools import list_ports
        for p in list_ports.comports(): print(p.device, "—", p.description)
        return
    if not (a.port or a.reseau or a.demo or a.replay): ap.print_help(); return
    sender = None
    if not a.capture:
        cle = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cle.txt")
        key = os.environ.get("SCHWIMME_CLE") or (open(cle, encoding="utf-8").read().strip() if os.path.exists(cle) else "") or getpass.getpass("Mot de passe admin du site : ")
        sender = Sender(a.site, key); sender.ev = a.evenement; sender.start()
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "relais.pid"), "w") as f: f.write(str(os.getpid()))
    journal = None
    if a.port or a.reseau:
        name = a.journal or datetime.now().strftime("journal-%Y%m%d-%H%M.jsonl")
        journal = open(name, "a", encoding="utf-8"); log(f"Journal brut : {os.path.abspath(name)}")
    src = demo_source() if a.demo else replay_source(a.replay, a.vitesse) if a.replay else net_source(a.reseau) if a.reseau else serial_source(a.port, a.reglages)
    try: run(src, sender, journal)
    except KeyboardInterrupt: pass
    if sender:
        t = time.time()
        while not sender.q.empty() and time.time() - t < 5: time.sleep(0.2)
    log("Arrêt du relais.")

if __name__ == "__main__": main()

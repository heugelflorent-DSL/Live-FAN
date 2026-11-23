#!/usr/bin/env python3
"""Relais Swim Direct — branché sur la sortie série d'un Quantum (protocole OSM6).

Il écoute UNIQUEMENT (il n'envoie jamais rien vers le chronométrage), enregistre tout ce qui passe
dans un journal brut, décode les événements (série prête, départ, réaction, passage, arrivée,
fin officielle) et les transmet au site Swim Direct.

Utilisation :
  python swim_relais.py --ports                 # liste les ports série
  python swim_relais.py --port COM5             # Windows
  python swim_relais.py --port /dev/tty.usbserial-XXXX   # Mac
  python swim_relais.py --demo                  # simule une course (sans matériel)
  python swim_relais.py --replay journal.jsonl  # rejoue un enregistrement
  python swim_relais.py --port COM5 --capture   # enregistre seulement, n'envoie rien au site

Mot de passe : celui de l'admin du site, demandé au démarrage (ou variable SWIM_CLE).
"""
import argparse, getpass, json, os, queue, re, socket, sys, threading, time, urllib.request, urllib.error
from datetime import datetime

# Certificats HTTPS : ceux embarqués dans le logiciel (certifi) d'abord, puis ceux de Windows en secours.
# Évite « certificate has expired » sur les PC de chronométrage dont Windows n'a pas mis à jour ses certificats racines.
def _install_ssl():
    import ssl
    try:
        import certifi; own = ssl.create_default_context(cafile=certifi.where())
    except Exception: own = None
    sysctx = ssl.create_default_context()
    class H(urllib.request.HTTPSHandler):
        def https_open(self, req):
            if own is not None:
                try: return self.do_open(lambda *a, **k: __import__("http.client").client.HTTPSConnection(*a, **{**k, "context": own}), req)
                except urllib.error.URLError as e:
                    if not isinstance(getattr(e, "reason", None), ssl.SSLError): raise
            return self.do_open(lambda *a, **k: __import__("http.client").client.HTTPSConnection(*a, **{**k, "context": sysctx}), req)
    urllib.request.install_opener(urllib.request.build_opener(H()))
try: _install_ssl()
except Exception: pass

SITE = "https://swim-direct.swim-direct.workers.dev"
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
    """Assemble les trames OSM6 (deux messages par événement) et produit des événements Swim Direct."""
    def __init__(self): self.buf = b""; self.pt1 = None; self.ts1 = None
    def feed(self, data, ts):
        self.buf += data; out = []
        # Omega ARES 21, interface « Splash » (réponses texte lues par splash_source) : blocs commençant par « #SPLASH »
        if self.buf.startswith(b"#SPLASH") or getattr(self, "splash", None):
            if not hasattr(self, "splash"): self.splash = SplashDecoder()
            data, self.buf = self.buf, b""
            return self.splash.feed(data, ts)
        # ALGE TimeManager (sortie « Vidéo », texte ASCII ligne par ligne) : jamais de SOH, lignes finies par CR
        if SOH not in self.buf and (getattr(self, "alge", None) or re.search(rb"(?:^|[\r\n])(?:R\d{6}|START|[IFCM]\d{5}|ID\d)", self.buf)) and (b"\r" in self.buf or b"\n" in self.buf):
            if not hasattr(self, "alge"): self.alge = AlgeDecoder()
            return self.alge.feed(self._take_lines(), ts)
        while EOT in self.buf:
            i = self.buf.index(EOT); frame = self.buf[: i + 1]; self.buf = self.buf[i + 1 :]
            j = frame.find(SOH)
            if j < 0: continue
            frame = frame[j:]
            if frame[1:2] == b"{":  # sortie réseau « Tableau Écran » (SCB Sport In The Box) : JSON
                try: ev = self.decode_json(frame[1:-1], ts)
                except Exception: ev = None  # un message bizarre ne fait plus perdre les autres
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
        # listes de départ du Quantum (SL/HO) : plusieurs Ko, reçues en plusieurs morceaux → ne pas couper le tampon trop tôt
        if len(self.buf) > 4_000_000: self.buf = self.buf[-262144:]
        return out
    def _take_lines(self):
        i = max(self.buf.rfind(b"\r"), self.buf.rfind(b"\n")); lines, self.buf = self.buf[: i + 1], self.buf[i + 1 :]
        return lines
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
            if ln and j.get("Kind") == "R" and j.get("Time"):  # temps de réaction (plot, ou plaque en dos)
                t = to_sec(j.get("Time")); return {"k": "react", "lane": ln, "t": t} if t is not None and 0 < t < 5 else None
            if not ln or j.get("Kind") not in ("I", "F") or not j.get("Time"): return None  # remise à zéro / couloir vide
            t = to_sec(j.get("Time")); rk = int(j.get("Rk") or 0) or None; lap = j.get("Lap") or 0
            dist = int(re.sub(r"\D", "", str(j.get("Dist") or "")) or 0) or None  # « 150* » = passage corrigé
            kind = "finish" if j.get("Kind") == "F" else "split"
            return {"k": kind, "lane": ln, "lap": lap, "dist": dist, "t": t, "rank": rk, "edited": j.get("Type") not in (None, "T"), "corr": "*" in str(j.get("Dist") or "") or j.get("Type") not in (None, "T", "1", "2", "3", 1, 2, 3)}
        if m in ("HO", "HS", "SL", "HR"):
            e = j.get("EvHeader") or {}; h = j.get("HeatHeader") or {}
            lanes = [{"lane": x.get("Ln"), "name": x.get("Name") or "", "club": x.get("Club") or "", "born": x.get("Born") or "",
                      "time": to_sec(x.get("Time")), "rank": int(x.get("Rk") or 0) or None, "stat": x.get("Stat"),
                      "sw": [str(n).strip() for n in (x.get("Swimmers") or []) if n] or None} for x in (j.get("Lanes") or []) if x.get("Ln")]
            title = " ".join(v for v in [e.get("Dist"), e.get("Stroke"), e.get("Cat"), e.get("Round")] if v)
            return {"k": "heat", "msg": m, "event": int(e.get("Number") or 0) or None, "heat": int(h.get("Number") or 0) or None,
                    "heats": e.get("Heats"), "laps": e.get("Laps"), "title": title, "comp": e.get("CompName") or "", "stat": h.get("Stat"), "lanes": lanes}
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


class AlgeDecoder:
    """ALGE TM-SWIM / SwimTime, sortie « Vidéo » (RS232 19200 8N1, ASCII, manuel Swimming System p. 32) :
    R eee hhh  HH:MM:SS.zhtc  chrono qui tourne · START départ · I LL TTT RR temps  passage · F … arrivée ·
    C … temps effacé · M LL TTT  temps  réaction / relais · ID EV/HT/nage/catégorie · B:nom/nation/club (B = couloir)."""
    TIME = re.compile(rb"(\d{1,2})\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})\s*\.\s*(\d[\d ]{0,3})")
    def __init__(self): self.ev = None; self.ht = None; self.names = {}; self.title = ""; self.react = set(); self.rt_at = 0
    @staticmethod
    def t(line):
        m = AlgeDecoder.TIME.search(line)
        if not m: return None
        frac = (m[4].decode().replace(" ", "") + "00")[:2]  # centièmes, tronqués comme en chronométrage officiel
        return round(int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(frac) / 100, 2)
    @staticmethod
    def lane(b):
        n = num(b); return 10 if n == 0 and b.strip() == b"00" else n
    def heat(self):
        return {"k": "heat", "msg": "SL", "event": self.ev, "heat": self.ht, "title": self.title, "comp": "", "stat": "W", "heats": None, "laps": None,
                "lanes": [{"lane": l, "name": x["name"], "club": x["club"], "born": "", "time": None, "rank": None, "stat": None, "sw": None} for l, x in sorted(self.names.items())]}
    def feed(self, data, ts):
        out = []
        for raw in re.split(rb"[\r\n]+", data):
            line = raw.strip(b"\x00 ")
            if not line: continue
            try: ev = self.line(line, ts)
            except Exception: ev = None
            if ev: out += ev if isinstance(ev, list) else [ev]
        return out
    def line(self, L, ts):
        if L.startswith(b"START"):
            self.react = set(); self.rt_at = ts; return {"k": "start", "ts": int(ts * 1000), "event": self.ev, "heat": self.ht}
        m = re.match(rb"ID\s*(\d+)\s*/\s*(\d+)\s*/([^/]*)/?(.*)$", L)
        if m:  # épreuve et série (envoyées par SwimTime) : nouvelle série → liste des nageurs remise à zéro
            ev, ht = int(m[1]), int(m[2])
            if (ev, ht) != (self.ev, self.ht): self.names = {}; self.react = set()
            self.ev, self.ht = ev, ht; self.title = " ".join(x.decode("latin-1").strip() for x in (m[3], m[4]) if x.strip())
            return self.heat()
        m = re.match(rb"(\d{1,2})\s*:([^/]*)/([^/]*)/?(.*)$", L)
        if m and not self.TIME.match(L):  # nageur du couloir B : nom / nation / club
            ln = self.lane(m[1]); name = m[2].decode("latin-1").strip()
            if name: self.names[ln] = {"name": name, "club": m[4].decode("latin-1").strip() or m[3].decode("latin-1").strip()}
            return self.heat() if self.ev is not None else None
        k = L[:1]
        if k == b"R":
            e, h = num(L[1:4]), num(L[4:7])
            if e and (e, h) != (self.ev, self.ht): self.ev, self.ht = e, h; self.names = {}; self.react = set(); return {"k": "ready", "event": e, "heat": h, "laps": None, "lanes": None}
            rt = self.t(L[7:])
            if rt and ts - self.rt_at >= 2: self.rt_at = ts; return {"k": "clock", "ts": int(ts * 1000), "rt": rt}
            return None
        if k in (b"I", b"F", b"C", b"M"):
            ln, lap, rk, tm = self.lane(L[1:3]), num(L[3:6]), num(L[6:8]) or None, self.t(L[6:])
            if k == b"C": return None  # temps effacé : le temps corrigé suit
            if tm is None: return None
            if k == b"M":
                if ln in self.react: return None  # ensuite : temps de prise de relais
                self.react.add(ln); return {"k": "react", "lane": ln, "t": tm}
            return {"k": "finish" if k == b"F" else "split", "lane": ln, "lap": lap, "t": tm, "rank": rk, "edited": False}
        return None

class SplashDecoder:
    """Omega ARES 21 via l'interface « Splash » d'ARES Swimming (fichiers splash_send.txt / splash_receive.txt).
    Chaque bloc reçu : « #SPLASH épreuve phase série longueurs » puis la réponse d'ARES à ASK RESULTS :
      LSTRESULT;épreuve; phase; série; longueur; couloir; côté; rang; temps;  ;
    On n'envoie au site que ce qui a changé (nouvelle série, nouveau toucher)."""
    def __init__(self): self.key = None; self.seen = {}; self.laps = None; self.started = False; self.start_tod = None
    @staticmethod
    def t(v):
        # temps ARES en millièmes de seconde. Au-delà d'une heure, c'est une heure du jour (pas un temps de course) : non converti.
        return round(v / 1000, 2) if 0 < v < 3_600_000 else None
    def rt(self, v):
        # heure du jour (simulateur, et peut-être vrai boîtier) : temps = toucher − départ lu dans ARES
        if v >= 3_600_000 and self.start_tod is not None and 0 < v - self.start_tod < 3_600_000: return round((v - self.start_tod) / 1000, 2)
        return self.t(v)
    def feed(self, data, ts):
        out = []
        for block in data.decode("latin-1", "replace").split("#SPLASH")[1:]:
            if block.startswith("-INFO"): continue
            if block.startswith("-HEAT"):
                hd, _, js = block[5:].partition("\n")
                try:
                    hf = hd.split(); ev, rd, ht = int(hf[0]), int(hf[1]), int(hf[2]); info = json.loads((js or "{}").encode("latin-1", "replace").decode("utf-8", "replace"))
                    if len(hf) > 3 and hf[3].isdigit() and int(hf[3]) > 0: self.laps = int(hf[3])
                except (ValueError, IndexError): continue
                if (ev, rd, ht) != self.key:
                    if self.key: out += self.close()
                    self.key, self.seen, self.started, self.start_tod = (ev, rd, ht), {}, False, None
                    out.append({"k": "ready", "event": ev, "heat": ht + 1, "laps": self.laps, "lanes": None})
                out.append({"k": "heat", "msg": "SL", "event": ev, "heat": ht + 1, "heats": None, "laps": self.laps, "title": info.get("title") or "", "comp": "", "stat": "W",
                            "lanes": [{"lane": x["lane"], "name": x.get("name", ""), "club": x.get("club", ""), "born": x.get("born", ""), "time": None, "rank": None, "stat": None, "sw": None} for x in info.get("lanes") or []]})
                continue
            if block.startswith("-START"):
                f = block[6:].split()
                try: ev, rd, ht, st = int(f[0]), int(f[1]), int(f[2]), int(f[-1])
                except (ValueError, IndexError): continue
                laps = int(f[3]) if len(f) == 5 and f[3].isdigit() and int(f[3]) > 0 else None
                if (ev, rd, ht) != self.key:
                    if self.key: out += self.close()
                    self.key, self.laps = (ev, rd, ht), laps
                    out.append({"k": "ready", "event": ev, "heat": ht + 1, "laps": laps, "lanes": None})
                self.seen = {k: v for k, v in self.seen.items() if v[0] > st}  # nouveau départ : les touches d'avant ne comptent plus
                self.start_tod = st
                lt = time.localtime(ts); now_tod = ((lt.tm_hour * 60 + lt.tm_min) * 60 + lt.tm_sec) * 1000 + int((ts % 1) * 1000)
                late = now_tod - st
                if 0 <= late < 30_000:  # départ qui vient d'être donné (pas un ancien départ resté affiché)
                    self.started = True; out.append({"k": "start", "ts": int(ts * 1000) - late, "event": ev, "heat": ht + 1})
                continue
            lines = block.splitlines(); hd = (lines[0].split() + ["", "", "", ""])[:4]
            try: ev, rd, ht = int(hd[0]), int(hd[1]), int(hd[2])
            except ValueError: continue
            laps = int(hd[3]) if hd[3].isdigit() and int(hd[3]) > 0 else None
            if (ev, rd, ht) != self.key:
                if self.key: out += self.close()
                self.key, self.seen, self.laps, self.started, self.start_tod = (ev, rd, ht), {}, laps, False, None
                out.append({"k": "ready", "event": ev, "heat": ht + 1, "laps": laps, "lanes": None})
            for L in lines[1:]:
                if not L.startswith("LSTRESULT;"): continue
                f = [x.strip() for x in L.split(";")]
                try: lap, lane, rank, raw = int(f[4]), int(f[5]), int(f[7] or 0), int(f[8] or 0)
                except (ValueError, IndexError): continue
                if not lane: continue
                if SPLASH_PLATES == "one":  # plaques d'un seul côté : ARES numérote-t-il 1, 2, 3… (touches) ou 2, 4, 6… (longueurs) ? décidé à la 1re touche de la série
                    if getattr(self, "odd", None) is None or getattr(self, "odd_key", None) != self.key: self.odd, self.odd_key = lap % 2 == 1, self.key
                    if self.odd: lap *= 2  # numéro de touche → numéro de longueur
                if self.seen.get((lane, lap)) == (raw, rank): continue
                if self.start_tod is not None and raw >= 3_600_000 and raw <= self.start_tod: continue  # toucher d'une course précédente
                self.seen[(lane, lap)] = (raw, rank)
                kind = "finish" if self.laps and lap >= self.laps else "split"
                e = {"k": kind, "lane": lane, "lap": lap, "t": self.rt(raw), "rank": rank or None, "edited": False}
                if e["t"] is None: e["tod"] = raw
                elif not self.started:
                    # Splash ne signale pas le départ : au premier toucher, départ recalculé (heure du toucher − temps) pour lancer le chrono
                    self.started = True; out.append({"k": "start", "ts": int((ts - e["t"]) * 1000), "event": ev, "heat": ht + 1})
                out.append(e)
        return out
    def close(self):
        """Série terminée (ARES est passé à la suivante) : le dernier toucher de chaque couloir est l'arrivée."""
        if self.laps: return [{"k": "end", "event": self.key[0], "heat": self.key[2] + 1}]
        last = {}
        for (lane, lap), (raw, rank) in self.seen.items():
            if lap >= last.get(lane, (0,))[0]: last[lane] = (lap, raw, rank)
        out = [{"k": "finish", "lane": ln, "lap": lap, "t": self.rt(raw), "rank": rank or None, "edited": False} for ln, (lap, raw, rank) in sorted(last.items())]
        return out + [{"k": "end", "event": self.key[0], "heat": self.key[2] + 1}]


SPLASH_POOL = 25  # longueur du bassin (m) pour compter les longueurs quand ARES ne les donne pas (réglage « bassin » du logiciel)
SPLASH_PLATES = "both"  # « one » : plaques d'un seul côté (une touche toutes les 2 longueurs)

def splash_laps(data_dir):
    """Nombre de longueurs par distance (LSTLONG.TXT, colonne dont le nom contient « lap ») : {idLen: longueurs}."""
    out = {}
    try:
        rows = [[x.strip().strip('"') for x in L.split(";")] for L in open(os.path.join(data_dir, "LSTLONG.TXT"), encoding="latin-1") if L.strip()]
        head = [h.lower() for h in rows[0]]; col = next((i for i, h in enumerate(head) if "lap" in h), None)
        if col is not None:
            for f in rows[1:]:
                if f and f[0].isdigit() and len(f) > col and f[col].isdigit(): out[int(f[0])] = int(f[col])
        else:  # base de l'extraNat Pocket : « idLong;Longueur;Mlongueur;Relais » → longueurs = distance ÷ longueur du bassin
            mc = next((i for i, h in enumerate(head) if h.startswith("mlong")), None)
            if mc is not None:
                for f in rows[1:]:
                    if f and f[0].isdigit() and len(f) > mc and f[mc].isdigit() and int(f[mc]) % SPLASH_POOL == 0: out[int(f[0])] = int(f[mc]) // SPLASH_POOL
    except (OSError, IndexError): pass
    return out

def splash_races(data_dir):
    """Liste des séries d'ARES (LSTRACE.TXT) : [(épreuve, phase, nb_séries, longueurs)] dans l'ordre du programme."""
    out = []; laps = splash_laps(data_dir)
    try:
        for L in open(os.path.join(data_dir, "LSTRACE.TXT"), encoding="latin-1"):
            f = [x.strip() for x in L.split(";")]
            if len(f) > 2 and f[0].isdigit():
                lid = int(f[3]) if len(f) > 3 and f[3].isdigit() else None
                out.append((int(f[0]), int(f[1] or 0), int(f[2] or 1), laps.get(lid)))
    except OSError: pass
    return out

def splash_ini(ares_dir):
    """Lit SWIMM.INI : (Splash activé ?, dossier de la base ARES)."""
    on, data = False, os.path.join(os.path.splitdrive(ares_dir)[0] + os.sep, "ARESDB", "DB1")
    try:
        for L in open(os.path.join(ares_dir, "SWIMM.INI"), encoding="latin-1"):
            k, _, v = L.strip().partition("=")
            if k == "FileNameForSplashRd": on = True
            if k == "DataPath" and v: data = v
    except OSError: pass
    return on, data

ARES_DIRS = ["C:\\ARES\\SWIMM", "D:\\ARES\\SWIMM", "C:\\Program Files (x86)\\ARES\\SWIMM", "C:\\Program Files\\ARES\\SWIMM"]

def ares_find():
    """Dossier d'ARES Swimming installé sur ce PC (None s'il n'y en a pas)."""
    return next((d for d in ARES_DIRS if os.path.exists(os.path.join(d, "SWIMM.EXE"))), None)

def ares_running():
    """ARES Swimming est-il ouvert ? (Windows : liste des programmes)"""
    if os.name != "nt": return False
    try:
        import subprocess
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq SWIMM.EXE", "/NH"], capture_output=True, text=True, timeout=10, creationflags=0x08000000).stdout
        return "swimm.exe" in out.lower()
    except Exception: return False

def splash_enable(ares_dir):
    """Active l'interface Splash dans SWIMM.INI (enlève « zzz » devant les 2 lignes), avec une copie de sauvegarde.
    Renvoie True si c'est fait (ou déjà fait). Ne touche à rien tant qu'ARES est ouvert (il réécrit son .ini en quittant)."""
    ini = os.path.join(ares_dir, "SWIMM.INI")
    try: txt = open(ini, encoding="latin-1", newline="").read()
    except OSError: return False
    if re.search(r"(?m)^FileNameForSplashRd=", txt) and re.search(r"(?m)^FileNameForSplashWr=", txt): return True
    if ares_running(): return False
    try:
        bak = ini + ".avant-swimdirect"
        if not os.path.exists(bak): open(bak, "w", encoding="latin-1", newline="").write(txt)
        new = re.sub(r"(?m)^zzz(FileNameForSplash(?:Rd|Wr)=)", r"\1", txt)
        if "FileNameForSplashRd=" not in new or not re.search(r"(?m)^FileNameForSplashRd=", new):
            nl = "\r\n" if "\r\n" in txt else "\n"
            add = f"FileNameForSplashRd=\\\\.\\{ares_dir}\\splash_send.txt{nl}FileNameForSplashWr=\\\\.\\{ares_dir}\\splash_receive.txt{nl}"
            new = re.sub(r"(?m)^(\[General\][^\n]*\n)", lambda m: m.group(1) + add, new, count=1) if "[General]" in new else new + nl + "[General]" + nl + add
        open(ini, "w", encoding="latin-1", newline="").write(new)
        log("✓ Liaison Swim Direct activée dans ARES Swimming (copie de l'ancien réglage : SWIMM.INI.avant-swimdirect)")
        return True
    except OSError as e:
        log(f"✗ Impossible de modifier {ini} ({e}) : lance le logiciel en administrateur, ou enlève « zzz » à la main."); return False

_ARES_PID = {}
def ares_start():
    """Heure du départ affichée par ARES dans la liste de la fenêtre de course (« [V]  Start: 14:59:19.84 »).
    Lecture seule des listes Windows d'ARES Swimming (rien n'est envoyé à ARES ni au chronométrage). None si absent / hors Windows."""
    if os.name != "nt": return None
    import ctypes, ctypes.wintypes as wt
    u = ctypes.windll.user32; found = []
    P = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def smt(h, msg, w, l):  # SendMessageTimeout : si ARES est occupé (> 100 ms) on abandonne, sans jamais le bloquer
        r = ctypes.c_size_t(0)
        ok = u.SendMessageTimeoutW(h, msg, w, l, 0x0002 | 0x0008, 100, ctypes.byref(r))  # SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT
        return int(r.value) if ok else -1
    def child(h, l):
        cls = ctypes.create_unicode_buffer(64); u.GetClassNameW(h, cls, 64)
        if cls.value == "ListBox":
            n = smt(h, 0x18B, 0, 0)
            for i in range(min(max(n, 0), 40)):
                ln = smt(h, 0x18A, i, 0)
                if ln <= 0 or ln > 400: continue
                b = ctypes.create_unicode_buffer(ln + 2)
                if smt(h, 0x189, i, b) < 0: continue
                m = re.search(r"\[V\]\s*Start:\s*(\d{1,2}):(\d\d):(\d\d)[.,](\d{1,3})", b.value)
                if m: found.append(m.groups())
        return True
    def top(h, l):
        pid = wt.DWORD(); u.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value == l:
            cls = ctypes.create_unicode_buffer(64); u.GetClassNameW(h, cls, 64)
            if cls.value == "Event":  # fenêtre de course : titre « 2 H 1  M 50 m FR » = épreuve 2, série 1
                t = ctypes.create_unicode_buffer(200); u.GetWindowTextW(h, t, 200)
                m = re.match(r"\s*(\d+)\s*H\s*(\d+)", t.value)
                if m: _ARES_PID["race"] = (int(m.group(1)), int(m.group(2))); _ARES_PID["title"] = t.value
            u.EnumChildWindows(h, P(child), 0)
        return True
    try:
        pid = _ARES_PID.get("pid")
        if not pid or time.time() - _ARES_PID.get("at", 0) > 60:  # n° du processus ARES relu au plus une fois par minute (tasklist est lent)
            import subprocess
            out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq SWIMM.EXE", "/FO", "CSV", "/NH"], capture_output=True, text=True, creationflags=0x08000000).stdout
            m = re.search(r'"SWIMM\.EXE","(\d+)"', out, re.I); pid = int(m.group(1)) if m else None; _ARES_PID.update(pid=pid, at=time.time())
        if not pid: return None
        u.EnumWindows(P(top), pid)
    except Exception: return None
    if not found: return None
    hh, mm, ss, fr = found[-1]; return ((int(hh) * 60 + int(mm)) * 60 + int(ss)) * 1000 + int(fr.ljust(3, "0")[:3])

def splash_titles(data_dir):
    """Nom des épreuves d'ARES (LSTRACE + LSTLONG + LSTSTYLE + LSTCAT) : {(épreuve, phase): « 400 m Nage Libre Dames »}."""
    def rows(name):
        try: return [[x.strip().strip('"').strip() for x in L.split(";")] for L in open(os.path.join(data_dir, name), encoding="latin-1") if L.strip()][1:]
        except OSError: return []
    lg = {f[0]: f for f in rows("LSTLONG.TXT") if f and f[0].isdigit()}
    sty = {f[0]: f[1] for f in rows("LSTSTYLE.TXT") if len(f) > 1}
    cat = {f[1]: f[0] for f in rows("LSTCAT.TXT") if len(f) > 1}
    out = {}
    for f in rows("LSTRACE.TXT"):
        if len(f) < 6 or not f[0].isdigit(): continue
        L = lg.get(f[3]); dist = (L[1] if L else "").replace(" ", " ")
        out[(int(f[0]), int(f[1] or 0))] = " ".join(x for x in [dist, sty.get(f[4], ""), cat.get(f[5], f[5])] if x)
    return out

def splash_starts(data_dir):
    """Listes de départ d'ARES (LSTSTART + LSTCONC) : {(épreuve, phase, série): [{"lane", "name", "club", "born"}]}."""
    conc, out = {}, {}
    try:
        for L in list(open(os.path.join(data_dir, "LSTCONC.TXT"), encoding="latin-1"))[1:]:
            f = [x.strip().strip('"').strip() for x in L.split(";")]
            if len(f) >= 8 and f[0].isdigit(): conc[f[0]] = {"name": f"{f[2]} {f[3]}".strip(), "club": f[7], "born": f[4]}
        for L in list(open(os.path.join(data_dir, "LSTSTART.TXT"), encoding="latin-1"))[1:]:
            f = [x.strip() for x in L.split(";")]
            if len(f) >= 6 and f[0].isdigit() and f[3].isdigit() and f[5] in conc:
                out.setdefault((int(f[0]), int(f[1] or 0), int(f[2] or 0)), []).append({"lane": int(f[3]), **conc[f[5]]})
    except OSError: pass
    return out

def splash_source(ares_dir="C:\\ARES\\SWIMM", period=0.3, stop=lambda: False, status=lambda s: None):
    """Interroge ARES Swimming en boucle par l'interface Splash et renvoie ses réponses (direct ~1 s, sans câble).
    Suit tout seul la série en cours : quand la série suivante reçoit des touchers, on passe dessus."""
    snd, rcv = os.path.join(ares_dir, "splash_send.txt"), os.path.join(ares_dir, "splash_receive.txt")
    told = False
    while not stop() and not splash_enable(ares_dir):  # activation automatique de la liaison (une seule fois par PC)
        status("ferme ARES Swimming une fois, puis rouvre-le")
        if not told: log("⚠ Pour activer la liaison avec Swim Direct : ferme ARES Swimming une fois, puis rouvre-le (réglage fait automatiquement)."); told = True
        time.sleep(3)
    on, data_dir = splash_ini(ares_dir)
    races = splash_races(data_dir); idx, ht = 0, 0
    def heats():  # séries dans l'ordre : (épreuve, phase, série)
        return [(e, r, h, nl) for e, r, n, nl in races for h in range(n)]
    pend = []  # messages qu'ARES écrit de lui-même (STATUS…START au départ), récupérés dans toutes les réponses
    def grab(txt):
        for m in re.finditer(r"STATUS;EVENT=(\d+);ROUND=(\d+);HEAT=(\d+);([A-Z]+)", txt or ""): pend.append((m.groups(), time.time()))
    def ask(e, r, h, timeout=3):
        try: grab(open(rcv, encoding="latin-1").read())  # ce qu'ARES a pu écrire depuis la dernière lecture (sinon perdu à l'effacement)
        except OSError: pass
        try: os.remove(rcv)
        except OSError: pass
        with open(snd, "w", encoding="latin-1", newline="") as f: f.write(f"ASK RESULTS;EVENT={e};ROUND={r};HEAT={h}\r\n")
        t0 = time.time()
        while time.time() - t0 < timeout:
            if not os.path.exists(snd):
                try: txt = open(rcv, encoding="latin-1").read()
                except OSError: txt = ""
                if "SEND RESULTS; END" in txt or "NOT FOUND" in txt: grab(txt); return txt
            time.sleep(0.05)
        return None
    try: os.remove(rcv)  # au lancement : anciens messages d'ARES effacés (un vieux « START » ne doit pas lancer le chrono)
    except OSError: pass
    n = 0; last, last_at = None, 0
    yield f"#SPLASH-INFO dossier={ares_dir} base={data_dir} séries={races}\n".encode("latin-1", "replace"), time.time()  # pour le journal
    # au démarrage : se placer sur la dernière série qui a déjà des temps (logiciel lancé en pleine compétition)
    try: ares_start()
    except Exception: pass
    for i, (e, r, h, _) in enumerate([] if "race" in _ARES_PID else heats()):  # fenêtre de course trouvée : pas besoin d'interroger chaque série
        if stop(): return
        t = ask(e, r, h, timeout=2)
        if t is None: break
        if "LSTRESULT;" in t: idx = i
    last_start = None; active_at = time.time(); forced = None; sent_heat = None; last_status = None
    titles, starts = splash_titles(data_dir), splash_starts(data_dir)
    while not stop():
        H = heats() or [(1, 0, 0, None)]
        idx = min(idx, len(H) - 1); e, r, h, nl = H[idx]
        try: st = ares_start()
        except Exception: st = None
        race = _ARES_PID.pop("race", None)  # série ouverte dans ARES (titre de la fenêtre de course)
        if race:
            find = lambda: next((i for i, x in enumerate(H) if x[0] == race[0] and x[2] == race[1] - 1), None)
            j = find()
            if j is None:  # série inconnue : ARES a peut-être changé de base (autre compétition chargée) → relire SWIMM.INI
                d2 = splash_ini(ares_dir)[1]
                if d2 != data_dir: data_dir = d2; races = splash_races(data_dir) or races; H = heats() or H; titles, starts = splash_titles(data_dir), splash_starts(data_dir); sent_heat = None; log(f"ARES : nouvelle base {data_dir} ({len(races)} épreuves)"); j = find()
            if j is not None:
                forced = None
                if j != idx: idx = j; log(f"ARES : série ouverte = épreuve {H[j][0]}, série {H[j][2] + 1}")
            elif forced != (race[0], 0, race[1] - 1):
                forced = (race[0], 0, race[1] - 1); log(f"ARES : série ouverte = épreuve {race[0]}, série {race[1]} (absente du programme lu, suivie quand même)")
        e, r, h, nl = (forced + (None,)) if forced else H[idx]
        if (e, r, h) != sent_heat:  # nouvelle série suivie : nom de l'épreuve et nageurs lus dans ARES → Swim Direct n'a pas besoin de la même numérotation
            sent_heat = (e, r, h)
            info = {"title": titles.get((e, r), ""), "lanes": starts.get((e, r, h), [])}
            yield f"#SPLASH-HEAT {e} {r} {h} {nl or ''}\n{json.dumps(info, ensure_ascii=False)}\n".encode("utf-8"), time.time()
        if st and st != last_start:
            yield f"#SPLASH-START {e} {r} {h} {nl or ''} {st}\n".encode("latin-1"), time.time()
        last_start = st if st else last_start
        if st and st != getattr(splash_source, "_st", None): splash_source._st, active_at = st, time.time()
        calm = time.time() - active_at > 120
        if calm and n % 3: n += 1; time.sleep(period); continue  # calme depuis 2 min : ARES interrogé 1 fois/s (le départ reste surveillé toutes les 0,3 s)
        txt = ask(e, r, h)
        if txt is None: status("ARES ne répond pas (ARES Swimming ouvert ? Splash activé ?)"); time.sleep(2); races = splash_races(data_dir); continue
        status(f"connecté (ARES Splash, épreuve {e} série {h + 1})")
        while pend:  # ARES annonce lui-même le départ (et d'autres états)
            k, k_at = pend.pop(0)
            if k == last_status: continue
            last_status = k; log(f"ARES : état {k[3]} (épreuve {k[0]}, série {int(k[2]) + 1})")
            if k[3] == "START":
                e, r, h = int(k[0]), int(k[1]), int(k[2]); nl = next((x[3] for x in H if x[:3] == (e, r, h)), nl)
                j = next((i for i, x in enumerate(H) if x[:3] == (e, r, h)), None)
                if j is not None: idx, forced = j, None
                else: forced = (e, r, h)
                if (e, r, h) != sent_heat:
                    sent_heat = (e, r, h); info = {"title": titles.get((e, r), ""), "lanes": starts.get((e, r, h), [])}
                    yield f"#SPLASH-HEAT {e} {r} {h} {nl or ''}\n{json.dumps(info, ensure_ascii=False)}\n".encode("utf-8"), time.time()
                lt = time.localtime(k_at); tod = ((lt.tm_hour * 60 + lt.tm_min) * 60 + lt.tm_sec) * 1000 + int(k_at % 1 * 1000) - int(period * 500)
                if not last_start or abs(tod - last_start) > 3000:  # pas déjà vu dans la fenêtre de course
                    last_start = tod; splash_source._st, active_at = tod, time.time()
                    yield f"#SPLASH-START {e} {r} {h} {nl or ''} {tod}\n".encode("latin-1"), time.time()
        # journal de suivi : seulement les réponses qui changent (+ un signe de vie toutes les 30 s), pas 3 copies par seconde
        if (e, r, h, txt) != last or time.time() - last_at > 30:
            last, last_at = (e, r, h, txt), time.time()
            yield f"#SPLASH {e} {r} {h} {nl or ''}\n{txt}".encode("latin-1"), time.time()
        n += 1
        if n % 5 == 0 and not forced and idx + 1 < len(H):  # la série suivante a commencé ?
            e2, r2, h2, _ = H[idx + 1]; t2 = ask(e2, r2, h2)
            if t2 and "LSTRESULT;" in t2: idx += 1; log(f"ARES : passage à l'épreuve {e2}, série {h2 + 1}")
        if n % 100 == 0:  # toutes les ~30 s : programme relu, et base suivie si une autre compétition a été chargée dans ARES
            d2 = splash_ini(ares_dir)[1]
            if d2 != data_dir: data_dir = d2; idx = 0; forced = None; sent_heat = None; log(f"ARES : nouvelle base {data_dir}")
            races = splash_races(data_dir) or races; titles, starts = splash_titles(data_dir) or titles, splash_starts(data_dir) or starts
        if (e, r, h, txt) != getattr(splash_source, "_prev", None): splash_source._prev, active_at = (e, r, h, txt), time.time()
        time.sleep(period)


class QuantumOut:
    """Sortie réseau « comme un Quantum » (Sport In The Box, port 26700) à partir des événements Swim Direct (ex. ARES lu par Splash).
    Format copié d'un enregistrement réel du Quantum (Interclubs U11, 15/11/2026) : SOH + JSON UTF-8 + EOT ;
    TP chaque seconde, RT toutes les 0,1 s pendant la course, ST au départ, TK aux touches (Kind I/F, Type B), SL/HO en-têtes de série."""
    STROKES = {"FR": "Nage Libre", "NL": "Nage Libre", "BK": "Dos", "DO": "Dos", "BR": "Brasse", "FLY": "Papillon", "BU": "Papillon", "PA": "Papillon", "IM": "4 Nages", "4N": "4 Nages", "ME": "4 Nages"}
    def __init__(self, nlanes=8):
        self.clients = []; self.lock = threading.Lock(); self.nl = nlanes
        self.ev = self.heat = None; self.laps = None; self.start = None; self.running = False; self.res = {}; self.last = {}
    @staticmethod
    def fmt(t, dec=2):
        if t is None: return None
        m, sec = divmod(max(float(t), 0.0), 60)
        return f"{int(m)}:{sec:0{3 + dec}.{dec}f}" if m >= 1 else f"{sec:.{dec}f}"
    def send(self, msg):
        data = b"\x01" + json.dumps(msg, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\x04"
        with self.lock:
            for c in list(self.clients):
                try: c.sendall(data)
                except OSError: self.clients.remove(c)
    def header(self):
        t = (_ARES_PID.get("title") or "").split(); dist = stroke = cat = ""
        m = re.search(r"H\s*\d+\s+([MFWXmfwx])?\s*(\d+)\s*m\s*(\S+)?", _ARES_PID.get("title") or "")
        if m: cat = {"M": "Messieurs", "F": "Dames", "W": "Dames", "X": "Mixte"}.get((m.group(1) or "").upper(), ""); dist = m.group(2) + " m"; stroke = self.STROKES.get((m.group(3) or "").upper(), m.group(3) or "")
        return {"CompName": "", "Number": str(self.ev or ""), "Round": "Séries", "Date": time.strftime("%d/%m/%Y"), "Time": "00:00:01", "Dist": dist, "Stroke": stroke, "Cat": cat,
                "ScbTitle": "", "Heats": None, "Laps": self.laps, "Swimmers": 1, "Records": []}
    def lanes(self, final):
        out = []
        for ln in range(1, self.nl + 1):
            r = self.res.get(ln)
            out.append({"Ln": ln, "Rk": str(r[1]) if final and r and r[1] else None, "Name": None, "ScbName": None, "Nat": None, "Club": None, "Hcp": None, "Cat": None, "Born": None,
                        "Time": self.fmt(r[0]) if final and r else None, "Stat": None, "Note": None, "Swimmers": None})
        return out
    def pool(self):
        m = re.search(r"(\d+)\s*m", _ARES_PID.get("title") or "")
        return int(m.group(1)) // self.laps if m and self.laps else None
    def on(self, e):
        k = e.get("k")
        if k == "ready":
            self.ev, self.heat, self.laps, self.running, self.res, self.last = e.get("event"), e.get("heat"), e.get("laps"), False, {}, {}
            self.send({"Msg": "RT", "RT": "0.0"})
            self.send({"Msg": "SL", "EvHeader": self.header(), "HeatHeader": {"Number": str(self.heat or ""), "Stat": "W"}, "Lanes": self.lanes(False)})
            for ln in range(1, self.nl + 1): self.send({"Msg": "TK", "Ln": ln, "Rk": "0", "Time": None, "Kind": "S", "Type": None, "Dist": None, "Lap": 0, "LT": None, "Stat": ""})
        elif k == "start":
            self.start = (e.get("ts") or time.time() * 1000) / 1000; self.running = True; self.res, self.last = {}, {}
            self.send({"Msg": "ST", "TS": time.strftime("%H:%M:%S", time.localtime(self.start)) + f".{int(self.start % 1 * 100):02d}", "Type": "S"})
        elif k in ("split", "finish") and e.get("t") is not None:
            ln, lap, t = e.get("lane"), e.get("lap") or 0, e.get("t"); pl = self.pool()
            lt = t - self.last[ln] if ln in self.last else None; self.last[ln] = t
            self.send({"Msg": "TK", "Ln": ln, "Rk": str(e.get("rank") or 0), "Time": self.fmt(t), "Kind": "F" if k == "finish" else "I", "Type": "B",
                       "Dist": str(pl * lap) if pl and lap else None, "Lap": lap, "LT": self.fmt(lt) if lt is not None and lap > 1 else None, "Stat": None})
            if k == "finish": self.res[ln] = (t, e.get("rank")); self.running = False
        elif k == "end":
            self.running = False
            self.send({"Msg": "HO", "EvHeader": self.header(), "HeatHeader": {"Number": str(self.heat or ""), "Stat": "O"}, "Lanes": self.lanes(True)})
            self.send({"Msg": "FS", "Fr": "0"})
    def tick_loop(self, stop):
        n = 0
        while not stop():
            if self.running and self.start: self.send({"Msg": "RT", "RT": self.fmt(time.time() - self.start, 1)})
            if n % 10 == 0: self.send({"Msg": "TP", "Sport": "SWM", "Src": "PRY", "Vers": "1.0", "DayTime": time.strftime("%H:%M:%S")})
            n += 1; time.sleep(0.1)
    def serve(self, port, stop, log=print):
        srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("0.0.0.0", port)); srv.listen(8)
        threading.Thread(target=self.tick_loop, args=(stop,), daemon=True).start()
        log(f"Sortie réseau « comme un Quantum » : port {port}")
        while not stop():
            c, a = srv.accept(); log(f"Sortie réseau : {a[0]} connecté")
            with self.lock: self.clients.append(c)


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
                                                 headers={"content-type": "application/json", "x-admin-key": self.key, "user-agent": "SwimRelais/1.0"})
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
        try: evs = dec.feed(data, ts)
        except Exception as e: log(f"✗ Message illisible ignoré : {e}"); dec = Decoder(); continue
        for ev in evs:
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
            c.settimeout(20)  # le Quantum envoie un signe de vie chaque seconde : 20 s de silence = on se reconnecte
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
    ap = argparse.ArgumentParser(description="Relais Swim Direct pour Quantum (OSM6)")
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
        key = os.environ.get("SWIM_CLE") or os.environ.get("SCHWIMME_CLE") or (open(cle, encoding="utf-8").read().strip() if os.path.exists(cle) else "") or getpass.getpass("Clé du relais (RELAY_KEY) ou mot de passe admin du site : ")
        sender = Sender(a.site, key); sender.ev = a.evenement; sender.start()
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "relais.pid"), "w") as f: f.write(str(os.getpid()))
    journal = None
    if a.port or a.reseau:
        here = os.path.dirname(os.path.abspath(__file__))
        for f in os.listdir(here):  # ménage : anciens journaux et lanceurs de test devenus inutiles
            if (f.startswith("journal-") and f.endswith(".jsonl")) or f in ("direct_quantum.bat", "test_quantum.bat", "enregistrer_quantum.bat"):
                try: os.remove(os.path.join(here, f))
                except OSError: pass
        jdir = os.path.join(here, "journaux"); os.makedirs(jdir, exist_ok=True)
        for f in os.listdir(jdir):  # on ne garde que 7 jours d'enregistrements
            fp = os.path.join(jdir, f)
            if f.startswith("journal-") and time.time() - os.path.getmtime(fp) > 7 * 86400:
                try: os.remove(fp)
                except OSError: pass
        name = a.journal or os.path.join(jdir, datetime.now().strftime("journal-%Y%m%d-%H%M.jsonl"))
        journal = open(name, "a", encoding="utf-8"); log(f"Journal brut : {os.path.abspath(name)}")
    src = demo_source() if a.demo else replay_source(a.replay, a.vitesse) if a.replay else net_source(a.reseau) if a.reseau else serial_source(a.port, a.reglages)
    try: run(src, sender, journal)
    except KeyboardInterrupt: pass
    if sender:
        t = time.time()
        while not sender.q.empty() and time.time() - t < 5: time.sleep(0.2)
    log("Arrêt du relais.")

if __name__ == "__main__": main()

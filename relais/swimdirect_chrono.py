#!/usr/bin/env python3
"""Swim Direct · Chrono — logiciel du PC de chronométrage (Quantum, sortie « Sport In The Box »).

- Écoute seulement : il ne renvoie jamais rien vers le chronométrage.
- Génère une clé de liaison (SD-XXXX-XXXX-XXXX-XXXX) : l'organisateur la colle dans l'admin de SON live.
- Envoie les événements décodés (série, départ, passages, arrivées) et le journal brut complet au live relié.
- Garde aussi le journal sur le PC (7 jours).
- Option « passe-plat » : redistribue les données reçues sur un autre port (pour un logiciel vidéo), désactivée par défaut.

Fenêtre par défaut ; « --console » pour le mode texte (tests) :
  SwimDirect-Chrono.exe --console --source 127.0.0.1:26700
  python swimdirect_chrono.py --console --demo --site http://localhost:8787
"""
import argparse, gzip, io, json, os, queue, random, re, socket, sys, threading, time, urllib.error, urllib.request, webbrowser
from datetime import datetime

APP = "Swim Direct · Chrono"
VERSION = "1.4.8"  # à augmenter à chaque nouvelle version (affichée dans le logiciel et dans l'admin du live)
SITE = "https://swim-direct.swim-direct.workers.dev"
ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
HOME = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "SwimDirect-Chrono")
os.makedirs(HOME, exist_ok=True)
if sys.stdout is None:  # exe sans console : messages dans un fichier
    sys.stdout = sys.stderr = open(os.path.join(HOME, "chrono.log"), "a", encoding="utf-8", buffering=1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from swim_relais import Decoder, describe, demo_source  # noqa: E402  (décodage commun avec le relais en ligne de commande)

# ---------- réglages ----------
CFG_PATH = os.path.join(HOME, "reglages.json")
def load_cfg():
    try: c = json.load(open(CFG_PATH, encoding="utf-8"))
    except Exception: c = {}
    if not c.get("token"):
        c["token"] = "SD-" + "-".join("".join(random.SystemRandom().choice(ALPHA) for _ in range(4)) for _ in range(4))
    c.setdefault("source", "127.0.0.1:26700"); c.setdefault("mode", "reseau"); c.setdefault("port", ""); c.setdefault("serial", "9600,7,E,1"); c.setdefault("site", SITE); c.setdefault("forward", "")
    save_cfg(c); return c
def save_cfg(c):
    with open(CFG_PATH, "w", encoding="utf-8") as f: json.dump(c, f, indent=1)

# ---------- écran géant local ----------
# Le PC de l'écran ouvre http://<ce PC>:8765 dans son navigateur : la page vient du site (mise en page toujours à jour,
# gardée en copie pour fonctionner sans Internet) et les temps arrivent directement d'ici par le réseau de la piscine, sans délai.
import http.server, hashlib
LOCAL_PORT = 8765
def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close(); return ip
    except OSError:
        try: return socket.gethostbyname(socket.gethostname())
        except OSError: return "127.0.0.1"

def all_ips():
    """toutes les adresses IPv4 du PC (câble, Wi-Fi…) : l'écran peut être sur n'importe quel réseau"""
    ips = []
    try:
        for x in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            a = x[4][0]
            if not a.startswith(("127.", "169.254.")) and a not in ips: ips.append(a)
    except OSError: pass
    m = lan_ip()
    if m in ips: ips.remove(m)
    return [m] + ips if not m.startswith("127.") else ips or [m]

def open_firewall(port, log):
    """Windows : ouvre une fois pour toutes le port de l'écran local (demande l'accord administrateur la 1re fois)"""
    if os.name != "nt": return
    import subprocess
    name = f"SwimDirect ecran {port}"
    try:
        r = subprocess.run(["netsh", "advfirewall", "firewall", "show", "rule", f"name={name}"], capture_output=True, creationflags=0x08000000)
        if r.returncode == 0: return
        import ctypes
        args = f'advfirewall firewall add rule name="{name}" dir=in action=allow protocol=TCP localport={port} profile=any'
        rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", "netsh", args, None, 0)
        log("🛡 Pare-feu : autorisation de l'écran local demandée (accepte la fenêtre Windows)" if rc > 32 else "⚠ Pare-feu non modifié : les autres PC ne verront peut-être pas l'écran local")
    except Exception as e: log(f"⚠ Pare-feu : vérification impossible ({e})")

class LocalScreen:
    def __init__(self, core):
        self.core = core; self.evs = []; self.lock = threading.Lock(); self.clients = []
        self.cache = os.path.join(HOME, "ecran"); os.makedirs(self.cache, exist_ok=True); self.port = int(core.cfg.get("ecran_port") or LOCAL_PORT); self.ok = False; self.ip = ""; self.ips = []
    def push(self, ev):
        item = {"t": int(time.time() * 1000), "ev": ev}
        with self.lock:
            self.evs.append(item)
            if len(self.evs) > 60000: self.evs = self.evs[-40000:]
            cl = list(self.clients)
        msg = ("data: " + json.dumps(item, ensure_ascii=False) + "\n\n").encode()
        for q in cl:
            try: q.put_nowait(msg)
            except queue.Full: pass
    def live_path(self):
        u = self.core.st.get("url") or ""
        i = u.find("/e/")
        if i >= 0: return u[i:].split("#")[0].split("?")[0]
        m = re.search(r"[?&]e=([\w-]+)", u)
        return "/e/" + m.group(1) if m else ""
    def fetch(self, path):
        """page ou donnée du site ; copie gardée sur le PC pour fonctionner sans Internet"""
        fp = os.path.join(self.cache, hashlib.sha1(path.encode()).hexdigest())
        try:
            req = urllib.request.Request(self.core.cfg["site"].rstrip("/") + path, headers={"user-agent": f"SwimDirectChrono/{VERSION}"})
            with urllib.request.urlopen(req, timeout=6) as r:
                body, ctype = r.read(), r.headers.get("content-type", "application/octet-stream")
            if r.status == 200:
                try:
                    with open(fp, "wb") as f: f.write(ctype.encode() + b"\n" + body)
                except OSError: pass
            return 200, ctype, body
        except urllib.error.HTTPError as e:
            if e.code == 404: return 404, "text/plain", b"introuvable"
        except Exception: pass
        try:
            with open(fp, "rb") as f: ctype, body = f.read().split(b"\n", 1)
            return 200, ctype.decode(), body
        except OSError: return 503, "text/plain; charset=utf-8", "Pas d'Internet et pas encore de copie de cette page sur ce PC.".encode()
    def serve(self):
        me = self
        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *a): pass
            def do_GET(self):
                path = self.path
                if path == "/" or path.startswith("/?"):
                    if not me.live_path():  # pas de live choisi : sinon « / » se redirige vers lui-même (ERR_TOO_MANY_REDIRECTS)
                        return self.out(200, "text/html; charset=utf-8", "<meta charset=utf-8><body style='font:20px system-ui;padding:40px'><h1>Swim Direct · écran local</h1><p>Aucun live choisi dans le logiciel <b>Swim Direct · Chrono</b> sur ce PC.</p><p>Colle l'adresse du live (…/e/nom-du-live) dans le logiciel, puis recharge cette page.</p>".encode())
                    self.send_response(302); self.send_header("location", me.live_path() + "?ecran=local#tv"); self.send_header("content-length", "0"); self.end_headers(); return
                if path.startswith("/local/events"): return self.events()
                if path.startswith("/local/now"):
                    b = json.dumps({"now": int(time.time() * 1000)}).encode(); return self.out(200, "application/json", b)
                code, ctype, body = me.fetch(path)
                if code == 200 and ctype.startswith("text/html"):
                    body = body.replace(b"<head>", b"<head><script>window.SD_LOCAL=1</script>", 1)
                self.out(code, ctype, body)
            def out(self, code, ctype, body):
                self.send_response(code); self.send_header("content-type", ctype); self.send_header("content-length", str(len(body))); self.send_header("cache-control", "no-store"); self.end_headers()
                try: self.wfile.write(body)
                except OSError: pass
            def events(self):
                q = queue.Queue(maxsize=5000)
                with me.lock: back = list(me.evs); me.clients.append(q)
                self.send_response(200); self.send_header("content-type", "text/event-stream"); self.send_header("cache-control", "no-store"); self.send_header("connection", "keep-alive"); self.end_headers()
                try:
                    self.wfile.write(("data: " + json.dumps({"hello": 1, "now": int(time.time() * 1000), "back": back}, ensure_ascii=False) + "\n\n").encode()); self.wfile.flush()
                    while not me.core.stop:
                        try: msg = q.get(timeout=10)
                        except queue.Empty: msg = ("data: " + json.dumps({"now": int(time.time() * 1000)}) + "\n\n").encode()
                        self.wfile.write(msg); self.wfile.flush()
                except OSError: pass
                finally:
                    with me.lock:
                        if q in me.clients: me.clients.remove(q)
        try:
            srv = http.server.ThreadingHTTPServer(("0.0.0.0", self.port), H); srv.daemon_threads = True; self.ok = True
            self.ips = all_ips(); self.ip = self.ips[0]
            self.core.log(f"🖥 Écran géant local : sur le PC de l'écran, ouvrir " + "  ou  ".join(f"http://{a}:{self.port}" for a in self.ips) + f"  (ou http://{socket.gethostname()}:{self.port})")
            if len(self.ips) > 1: self.core.log("   Plusieurs réseaux sur ce PC (câble, Wi-Fi…) : prends l'adresse du réseau où est branché l'écran.")
            threading.Thread(target=open_firewall, args=(self.port, self.core.log), daemon=True).start()
            srv.serve_forever()
        except OSError as e: self.core.log(f"✗ Écran géant local indisponible (port {self.port}) : {e}")

# ---------- moteur ----------
class Core:
    def __init__(self, cfg, on_log=print):
        self.cfg = cfg; self.on_log = on_log; self.paused = False; self.stop = False
        self.q = queue.Queue(maxsize=5000); self.raw = []; self.raw_lock = threading.Lock()
        self.st = {"update": "", "linked": None, "name": "", "url": "", "bassin": None, "quantum": "recherche…", "last": "", "sent": 0, "jsent": 0, "err": "", "occupied": False}
        jdir = os.path.join(HOME, "journaux"); os.makedirs(jdir, exist_ok=True)
        for f in os.listdir(jdir):
            fp = os.path.join(jdir, f)
            if time.time() - os.path.getmtime(fp) > 7 * 86400:
                try: os.remove(fp)
                except OSError: pass
        self.journal = open(os.path.join(jdir, datetime.now().strftime("journal-%Y%m%d-%H%M.jsonl")), "a", encoding="utf-8")
        self.fw_clients = []; self.fw_lock = threading.Lock()
        self.screen = LocalScreen(self)

    def log(self, *a):
        msg = " ".join(str(x) for x in a); ts = time.time()
        self.on_log(datetime.now().strftime("%H:%M:%S") + " " + msg)
        # les messages du logiciel vont aussi dans le journal (avec ceux du chronométrage), pour l'analyse à distance
        try: self.journal.write(json.dumps({"ts": ts, "app": msg, "v": VERSION}, ensure_ascii=False) + "\n"); self.journal.flush()
        except Exception: pass
        with self.raw_lock: self.raw.append({"ts": round(ts, 3), "app": msg, "v": VERSION})

    # requêtes vers le site
    def call(self, path, body=None, ctype="application/json", timeout=10):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        req = urllib.request.Request(self.cfg["site"].rstrip("/") + path, data=data, method="POST" if data is not None else "GET",
                                     headers={"content-type": ctype, "x-relay-token": self.cfg["token"], "x-chrono-version": VERSION, "user-agent": f"SwimDirectChrono/{VERSION}"})
        with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read() or b"{}")

    def hello_loop(self):
        while not self.stop:
            try:
                j = self.call("/api/relay/hello")
                was = self.st["linked"]
                self.st.update(linked=bool(j.get("linked")), name=j.get("name", ""), url=j.get("url", ""), bassin=j.get("bassin"), err="")
                self.apply_sys(j.get("sys"))
                if self.st["linked"] and not was: self.log(f"✓ Relié au live « {self.st['name']} »")
                if self.st["linked"] and j.get("bassin") is False and was is None: self.log("⚠ Sur le site, le mode du direct de ce live n'est pas « Bassin » : les temps sont reçus mais pas affichés au public.")
            except Exception as e:
                if not self.st["err"]: self.log(f"✗ Site injoignable : {e}")
                self.st["err"] = f"site injoignable ({e})"
            self.check_update()
            time.sleep(5 if not self.st["linked"] else 60)

    # type de chronométrage choisi sur la page admin du live : on règle le mode tout seul
    PRESET = {"quantum": ("reseau", None), "ares": ("serie", "9600,7,E,1"), "stramatel": ("serie", "9600,8,N,1"), "alge": ("serie", "19200,8,N,1")}
    NAMES = {"quantum": "Swiss Timing Quantum", "ares": "Omega ARES 21", "stramatel": "Stramatel", "alge": "ALGE TimeManager"}
    def apply_sys(self, sysk):
        if sysk not in self.PRESET or self.cfg.get("sys") == sysk: return
        mode, ser = self.PRESET[sysk]; old = self.cfg.get("mode")
        self.cfg["sys"] = sysk; self.cfg["mode"] = mode
        if ser: self.cfg["serial"] = ser
        save_cfg(self.cfg); self.log(f"Chronométrage choisi sur le site : {self.NAMES[sysk]}" + (" (port série : choisis le port COM dans Réglages)" if mode == "serie" and not self.cfg.get("port") else ""))
        if old != mode: self.restart = True

    # nouvelle version publiée sur le site ?
    def check_update(self, force=False):
        if not force and time.time() - getattr(self, "upd_at", 0) < 3600: return
        self.upd_at = time.time()
        try:
            with http_get(self.cfg["site"].rstrip("/") + "/chrono/version.json?t=" + str(int(time.time())), timeout=10) as r: j = json.loads(r.read())
            latest = str(j.get("version", ""))
            if latest and vtuple(latest) > vtuple(VERSION):
                if self.st.get("update") != latest: self.log(f"Nouvelle version disponible : {latest} (installée : {VERSION})")
                self.st["update"] = latest
            elif force: self.log(f"Vérification : version {VERSION} à jour (dernière publiée : {latest or '?'})")
        except Exception as e:
            if force: self.log(f"✗ Vérification des mises à jour impossible : {e}")

    def send_loop(self):
        while not self.stop:
            batch = [self.q.get()]; time.sleep(0.15)
            while not self.q.empty() and len(batch) < 40: batch.append(self.q.get())
            delay = 1
            while not self.stop:
                if not self.st["linked"]: time.sleep(2); continue
                try:
                    now = int(time.time() * 1000)
                    self.call("/api/relay/event", [dict(e, sent=now) for e in batch]); self.st["sent"] += len(batch); self.st["err"] = ""; break
                except urllib.error.HTTPError as e:
                    if e.code == 409: self.st["linked"] = False; self.log("⚠ La clé n'est plus reliée à un live : colle-la à nouveau dans l'admin du live.")
                    else: self.st["err"] = f"erreur du site ({e.code})"
                except Exception as e: self.st["err"] = f"site injoignable ({e})"
                time.sleep(delay); delay = min(delay * 2, 20)

    def ping_loop(self):
        # signe de vie toutes les 10 s tant que le chronométrage est branché : le site sait que la liaison tient
        # même quand la sortie du Quantum est silencieuse (sinon il afficherait « Liaison coupée » pendant la course)
        while not self.stop:
            time.sleep(10)
            if self.st["linked"] and self.st["quantum"].startswith("connecté") and not self.paused:
                try: self.q.put_nowait({"k": "ping", "ts": time.time()})
                except queue.Full: pass

    def journal_loop(self):
        # journal brut envoyé toutes les 15 s, compressé (gardé 14 jours sur le site pour l'analyse)
        while not self.stop:
            time.sleep(15)
            with self.raw_lock: rows, self.raw = self.raw, []
            if not rows or not self.st["linked"]:
                if rows and not self.st["linked"]:
                    with self.raw_lock: self.raw = rows[-20000:] + self.raw
                continue
            day = datetime.now().strftime("%Y-%m-%d")
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb") as g: g.write("".join(json.dumps(r) + "\n" for r in rows).encode())
            data = buf.getvalue()
            if len(data) > 110000:  # gros paquet : on coupe en deux
                with self.raw_lock: self.raw = rows[len(rows) // 2:] + self.raw
                rows = rows[: len(rows) // 2]; buf = io.BytesIO()
                with gzip.GzipFile(fileobj=buf, mode="wb") as g: g.write("".join(json.dumps(r) + "\n" for r in rows).encode())
                data = buf.getvalue()
            try: self.call(f"/api/relay/log?day={day}", data, "application/gzip", timeout=20); self.st["jsent"] += len(rows)
            except Exception:
                with self.raw_lock: self.raw = rows[-20000:] + self.raw

    def feed(self, data, ts):
        self.journal.write(json.dumps({"ts": ts, "hex": data.hex()}) + "\n"); self.journal.flush()
        with self.raw_lock: self.raw.append({"ts": round(ts, 3), "hex": data.hex()})
        if self.fw_clients: self.forward(data)
        try: evs = self.dec.feed(data, ts)
        except Exception as e: self.log(f"✗ Message illisible ignoré : {e}"); self.dec = Decoder(); return
        for ev in evs:
            if ev["k"] != "clock": self.st["last"] = describe(ev); self.log(self.st["last"])
            if not self.paused:
                try: self.q.put_nowait(ev)
                except queue.Full: pass
                if ev["k"] != "ping": self.screen.push(ev)

    # lecture du chronométrage (sortie réseau Sport In The Box)
    def source_loop(self, demo=False):
        self.dec = Decoder()
        if demo:
            while not self.stop:
                self.st["quantum"] = "démo"
                for d, ts in demo_source(): self.feed(d, ts)
                time.sleep(5)
            return
        while not self.stop:
            self.restart = False
            (self.serial_loop if self.cfg.get("mode") == "serie" else self.net_loop)()
    # « udp:PORT » : écoute les paquets UDP (y compris diffusés) ; « ecoute:PORT » : attend que le chrono se connecte à nous
    def listen_loop(self, kind, port):
        while not self.stop and not self.restart:
            try:
                if kind == "udp":
                    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    s.bind(("", port)); s.settimeout(2)
                    self.st["quantum"] = f"écoute UDP {port}"; self.log(f"✓ En écoute UDP sur le port {port} (attente des données du chronométrage)")
                    seen = None
                    while not self.stop and not self.restart:
                        try: d, a = s.recvfrom(65535)
                        except socket.timeout: continue
                        if a[0] != seen: seen = a[0]; self.st["quantum"] = f"connecté (UDP de {a[0]})"; self.log(f"✓ Données reçues de {a[0]}")
                        self.feed(d, time.time())
                else:
                    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("", port)); srv.listen(2); srv.settimeout(2)
                    self.st["quantum"] = f"en attente sur le port {port}"; self.log(f"✓ En attente que le chronométrage se connecte sur le port {port}")
                    while not self.stop and not self.restart:
                        try: c, a = srv.accept()
                        except socket.timeout: continue
                        c.settimeout(20); self.st["quantum"] = f"connecté ({a[0]})"; self.log(f"✓ Chronométrage connecté depuis {a[0]}")
                        try:
                            while not self.stop and not self.restart:
                                try: d = c.recv(4096)
                                except socket.timeout: continue
                                if not d: break
                                self.feed(d, time.time())
                        except OSError: pass
                        c.close(); self.st["quantum"] = f"en attente sur le port {port}"; self.log("✗ Le chronométrage s'est déconnecté : attente d'une nouvelle connexion…")
            except Exception as e:
                self.st["quantum"] = f"écoute impossible ({e})"; self.log(f"✗ Impossible d'écouter le port {port} ({e}) : pare-feu Windows ou port déjà pris ?"); time.sleep(5)

    def net_loop(self):
        quick = 0
        h0, _, p0 = self.cfg["source"].rpartition(":")
        if h0.lower() in ("udp", "ecoute") and p0.isdigit(): return self.listen_loop("udp" if h0.lower() == "udp" else "tcp", int(p0))
        while not self.stop and not self.restart:
            host, _, port = self.cfg["source"].rpartition(":")
            t0 = time.time()
            try:
                c = socket.create_connection((host or "127.0.0.1", int(port)), timeout=8); c.settimeout(20)
                # silence ≠ coupure : certaines sorties n'envoient rien entre les courses. On garde la connexion
                # (une coupure réelle est vue par recv vide / erreur, et par le keepalive TCP)
                try: c.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
                except OSError: pass
                self.st["quantum"] = f"connecté ({self.cfg['source']})"; self.st["occupied"] = False; self.log(f"✓ Chronométrage trouvé sur {self.cfg['source']}")
                while not self.stop and not self.restart:
                    try: d = c.recv(4096)
                    except socket.timeout: continue
                    if not d: raise ConnectionError("connexion fermée par le chronométrage")
                    self.feed(d, time.time())
            except Exception as e:
                if self.st["quantum"].startswith("connecté"): self.log(f"✗ Liaison avec le chronométrage perdue ({e}) : reconnexion…")
                self.st["quantum"] = f"pas trouvé ({e})"
            # sortie qui ferme tout de suite : probablement déjà prise par la vidéo → on se retire au lieu d'insister
            quick = quick + 1 if time.time() - t0 < 5 else 0
            if quick >= 3:
                self.st["occupied"] = True; self.st["quantum"] = "sortie occupée ?"
                self.log("⚠ La sortie du chronométrage ferme la connexion tout de suite : elle est peut-être réservée à la vidéo. Nouvel essai dans 2 min. Solution : créer une 2e sortie Sport In The Box sur un autre port dans le Quantum, et l'indiquer dans « Réglages ».")
                quick = 0; time.sleep(120)
            else: time.sleep(5)

    # port série (Omega ARES 21 en mode OSM6 : 9600, pair, 7 bits, 1 arrêt ; adaptateur USB-série + câble null-modem)
    def serial_loop(self):
        try: import serial
        except ImportError: self.st["quantum"] = "module série absent"; self.log("✗ Lecture série indisponible (pyserial manquant)"); return
        def pname(x):  # « COM9 — description » → COM9 ; ports virtuels com0com « CNCB0 » → \\.\CNCB0 (Windows)
            x = (x or "").split(" — ")[0].strip()
            return "\\\\.\\" + x if os.name == "nt" and x and not x.upper().startswith("COM") and not x.startswith("\\") else x
        port = pname(self.cfg.get("port"))
        baud, bits, parity, stop = (self.cfg.get("serial", "9600,7,E,1").split(",") + ["9600", "7", "E", "1"])[:4]
        kw = dict(port=port, baudrate=int(baud), bytesize={"7": serial.SEVENBITS, "8": serial.EIGHTBITS}.get(bits, serial.SEVENBITS),
                  parity={"N": serial.PARITY_NONE, "E": serial.PARITY_EVEN, "O": serial.PARITY_ODD}.get(parity.upper(), serial.PARITY_EVEN),
                  stopbits=serial.STOPBITS_TWO if stop == "2" else serial.STOPBITS_ONE, timeout=1)
        while not self.stop and not self.restart:
            if not port: self.st["quantum"] = "aucun port série choisi (Réglages)"; time.sleep(3); port = pname(self.cfg.get("port")); kw["port"] = port; continue
            try:
                with serial.Serial(**kw) as sp:
                    self.st["quantum"] = f"connecté ({port}, {baud},{bits},{parity},{stop})"; self.log(f"✓ Port série {port} ouvert ({baud},{bits},{parity},{stop})")
                    last = time.time()
                    while not self.stop and not self.restart:
                        d = sp.read(256)
                        if d: self.feed(d, time.time()); last = time.time()
                        elif time.time() - last > 30: self.st["quantum"] = f"{port} ouvert, rien reçu depuis 30 s"
            except Exception as e:
                self.st["quantum"] = f"port {port} : {e}"; self.log(f"✗ Port série {port} : {e}"); time.sleep(5)

    # passe-plat optionnel : redistribue à l'identique pour un logiciel vidéo
    def forward_loop(self):
        port = int(self.cfg["forward"])
        srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("0.0.0.0", port)); srv.listen(4)
        self.log(f"Passe-plat actif : données redistribuées sur le port {port}")
        while not self.stop:
            c, a = srv.accept(); self.log(f"Passe-plat : {a[0]} connecté")
            with self.fw_lock: self.fw_clients.append(c)
    def forward(self, data):
        with self.fw_lock:
            for c in list(self.fw_clients):
                try: c.sendall(data)
                except OSError: self.fw_clients.remove(c)

    def start(self, demo=False):
        threading.Thread(target=self.screen.serve, daemon=True).start()
        for f in (self.hello_loop, self.send_loop, self.journal_loop, self.ping_loop): threading.Thread(target=f, daemon=True).start()
        if self.cfg.get("forward"):
            try: threading.Thread(target=self.forward_loop, daemon=True).start()
            except Exception as e: self.log(f"✗ Passe-plat : {e}")
        threading.Thread(target=self.source_loop, args=(demo,), daemon=True).start()

def vtuple(v):
    try: return tuple(int(x) for x in str(v).split("."))
    except ValueError: return (0,)

def http_get(url, timeout=10):
    """Lecture d'une adresse du site avec un nom de logiciel (sans lui, Cloudflare peut refuser « Python-urllib »)."""
    return urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": f"SwimDirectChrono/{VERSION}", "cache-control": "no-cache"}), timeout=timeout)

def self_update(site, log=print):
    """Remplace l'exe par la dernière version publiée sur le site, puis le relance (seulement en exe Windows)."""
    if not getattr(sys, "frozen", False): log("Mise à jour automatique : seulement pour SwimDirect-Chrono.exe"); return False
    exe = sys.executable; new = exe + ".nouveau"; old = exe + ".ancien"
    try:
        with http_get(site.rstrip("/") + "/chrono/SwimDirect-Chrono.exe?t=" + str(int(time.time())), timeout=120) as r, open(new, "wb") as f:
            while True:
                b = r.read(1 << 16)
                if not b: break
                f.write(b)
        if os.path.getsize(new) < 1_000_000: raise ValueError("fichier téléchargé incomplet")
        if os.path.exists(old): os.remove(old)
        os.rename(exe, old); os.rename(new, exe)  # un exe en cours d'exécution peut être renommé (pas écrasé)
        # le nouvel exe doit repartir de zéro : sinon il réutilise le dossier temporaire _MEI de l'ancien (supprimé à sa fermeture) → « base_library.zip introuvable »
        env = {k: v for k, v in os.environ.items() if not k.startswith(("_MEI", "_PYI")) and k not in ("TCL_LIBRARY", "TK_LIBRARY")}
        env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
        import subprocess; subprocess.Popen([exe] + sys.argv[1:], close_fds=True, env=env)
        return True
    except Exception as e:
        log(f"✗ Mise à jour impossible : {e}")
        try:
            if os.path.exists(new): os.remove(new)
            if not os.path.exists(exe) and os.path.exists(old): os.rename(old, exe)
        except OSError: pass
        return False

def startup_update(cfg):
    """Au lancement (avant de se brancher au chrono) : mise à jour automatique si une nouvelle version existe."""
    if not getattr(sys, "frozen", False): return False
    try:
        old = sys.executable + ".ancien"
        if os.path.exists(old): os.remove(old)
    except OSError: pass
    try:
        with http_get(cfg["site"].rstrip("/") + "/chrono/version.json?t=" + str(int(time.time())), timeout=8) as r: latest = str(json.loads(r.read()).get("version", ""))
    except Exception: return False
    return bool(latest and vtuple(latest) > vtuple(VERSION) and self_update(cfg["site"]))

# ---------- fenêtre ----------
def gui(cfg, demo=False, close_after=0):
    import tkinter as tk
    from tkinter import ttk, messagebox
    root = tk.Tk(); root.title(f"{APP} {VERSION}"); root.geometry("920x740"); root.minsize(780, 600)
    NAVY, INK, BG, CARD, LINE = "#0b1e3f", "#13284d", "#eef3f8", "#ffffff", "#d6e1ec"
    BLUE, RED, GREY, GREEN, GOLD = "#06324f", "#d6202f", "#5b7685", "#16a34a", "#f2c94c"
    F = "Segoe UI"
    root.configure(bg=BG)
    logs = []
    core = Core(cfg, on_log=lambda m: logs.append(m))

    def btn(parent, text, cmd, kind="ghost", **kw):
        st = {"primary": (NAVY, "white", "#1d3a6b"), "ghost": (CARD, INK, "#e3ebf3"), "gold": (GOLD, NAVY, "#ffd96b")}[kind]
        b = tk.Button(parent, text=text, command=cmd, bg=st[0], fg=st[1], activebackground=st[2], activeforeground=st[1], relief="flat", bd=0,
                      font=(F, 10, "bold"), padx=14, pady=6, cursor="hand2", highlightthickness=1 if kind == "ghost" else 0, highlightbackground=LINE, **kw)
        b.bind("<Enter>", lambda e: b.config(bg=st[2])); b.bind("<Leave>", lambda e: b.config(bg=b._bg)); b._bg = st[0]
        return b
    def card(parent, title, icon):
        f = tk.Frame(parent, bg=CARD, highlightbackground=LINE, highlightthickness=1)
        h = tk.Frame(f, bg=CARD); h.pack(fill="x", padx=14, pady=(12, 4))
        dot = tk.Label(h, text="●", bg=CARD, fg=GREY, font=(F, 11)); dot.pack(side="left")
        tk.Label(h, text=f"{icon}  {title}", bg=CARD, fg=GREY, font=(F, 9, "bold")).pack(side="left", padx=(4, 0))
        v = tk.Label(f, text="…", bg=CARD, fg=INK, font=(F, 11, "bold"), anchor="w", justify="left", wraplength=210); v.pack(fill="x", padx=14, pady=(0, 12))
        f.dot, f.val = dot, v
        return f

    # ---- en-tête
    head = tk.Frame(root, bg=NAVY); head.pack(fill="x")
    hl = tk.Frame(head, bg=NAVY); hl.pack(side="left", padx=18, pady=12)
    tk.Label(hl, text="Swim Direct · Chrono", fg="white", bg=NAVY, font=(F, 18, "bold")).pack(anchor="w")
    tk.Label(hl, text="Chronométrage en direct sur ton live et sur l'écran géant", fg="#b9c8e4", bg=NAVY, font=(F, 10)).pack(anchor="w")
    hr = tk.Frame(head, bg=NAVY); hr.pack(side="right", padx=18)
    tk.Label(hr, text=f"v{VERSION}", fg=NAVY, bg=GOLD, font=(F, 9, "bold"), padx=8, pady=2).pack(anchor="e", pady=(14, 4))
    tk.Label(hr, text="© Mat-et-Flo", fg=GOLD, bg=NAVY, font=(F, 9, "bold")).pack(anchor="e")
    tk.Frame(root, bg=GOLD, height=3).pack(fill="x")

    # ---- bande mise à jour (cachée quand tout est à jour)
    upd = tk.Frame(root, bg=GOLD)
    updl = tk.Label(upd, text="", bg=GOLD, fg=NAVY, font=(F, 10, "bold")); updl.pack(side="left", padx=12, pady=8)
    def do_update():
        if core.st["sent"] and not messagebox.askyesno(APP, "Mettre à jour maintenant ? Le logiciel va redémarrer (quelques secondes sans envoi). À éviter pendant une course."): return
        updl.config(text="Téléchargement de la nouvelle version…"); root.update()
        if self_update(cfg["site"], core.log): core.stop = True; root.destroy()
        else: updl.config(text="Mise à jour impossible : télécharge-la depuis l'admin du live.")
    bupd = btn(upd, "▶  METTRE À JOUR", do_update, "primary"); bupd.pack(side="right", padx=8, pady=5)

    # ---- grand bandeau d'état : tout va bien, ou ce qu'il faut faire
    hero = tk.Frame(root, bg="#0f5c2e"); hero.pack(fill="x")
    hico = tk.Label(hero, text="✓", bg="#16a34a", fg="white", font=(F, 22, "bold"), width=3, height=1); hico.pack(side="left", padx=(18, 14), pady=14)
    htx = tk.Frame(hero, bg=hero["bg"]); htx.pack(side="left", fill="x", expand=True, pady=12)
    ht = tk.Label(htx, text="Démarrage…", bg=hero["bg"], fg="white", font=(F, 17, "bold"), anchor="w"); ht.pack(fill="x")
    hs = tk.Label(htx, text="", bg=hero["bg"], fg="#d7f5e1", font=(F, 10), anchor="w", justify="left", wraplength=520); hs.pack(fill="x")
    hbtn = btn(hero, "📖 Que faire ?", lambda: show_help(root, tk, ttk, NAVY, INK, BG, CARD, F, tab=hero.tab), "gold"); hero.tab = 0

    # ---- trois étapes numérotées
    steps = tk.Frame(root, bg=BG); steps.pack(fill="both", padx=16, pady=14)
    for i in range(3): steps.columnconfigure(i, weight=1, uniform="c")
    def step(col, n, title):
        f = tk.Frame(steps, bg=CARD, highlightbackground=LINE, highlightthickness=1); f.grid(row=0, column=col, sticky="nsew", padx=(0 if col == 0 else 8, 0))
        h = tk.Frame(f, bg=CARD); h.pack(fill="x", padx=14, pady=(12, 6))
        f.num = tk.Label(h, text=str(n), bg=GREY, fg="white", font=(F, 11, "bold"), width=2); f.num.pack(side="left")
        tk.Label(h, text=title, bg=CARD, fg=INK, font=(F, 12, "bold")).pack(side="left", padx=(8, 0))
        f.val = tk.Label(f, text="…", bg=CARD, fg=INK, font=(F, 11, "bold"), anchor="w", justify="left", wraplength=200); f.val.pack(fill="x", padx=14)
        f.sub = tk.Label(f, text="", bg=CARD, fg=GREY, font=(F, 9), anchor="w", justify="left", wraplength=200); f.sub.pack(fill="x", padx=14, pady=(2, 8))
        f.body = tk.Frame(f, bg=CARD); f.body.pack(fill="both", expand=True, padx=14, pady=(0, 12))
        return f
    cLive, cChrono, cTv = step(0, 1, "Le live"), step(1, 2, "Le chronométrage"), step(2, 3, "L'écran géant")
    # 1 · clé de liaison
    tk.Label(cLive.body, text="Clé à coller dans l'admin du live :", bg=CARD, fg=GREY, font=(F, 9), anchor="w").pack(fill="x")
    tk.Label(cLive.body, text=cfg["token"], bg=CARD, fg=NAVY, font=("Consolas", 12, "bold"), anchor="w").pack(fill="x", pady=(2, 8))
    def copy():
        root.clipboard_clear(); root.clipboard_append(cfg["token"]); bcopy.config(text="Copié ✓"); root.after(2000, lambda: bcopy.config(text="Copier la clé"))
    bcopy = btn(cLive.body, "Copier la clé", copy, "primary"); bcopy.pack(fill="x")
    btn(cLive.body, "Ouvrir le live", lambda: core.st["url"] and webbrowser.open(core.st["url"])).pack(fill="x", pady=(6, 0))
    # 2 · réglages du chronométrage
    def settings():
        w = tk.Toplevel(root); w.title("Réglages"); w.grab_set(); w.resizable(False, False)
        SYS = [("Swiss Timing Quantum (sortie Sport In The Box)", "quantum", "reseau", ""),
               ("Omega ARES 21 (série OSM6 ou réseau)", "ares", None, "9600,7,E,1"),
               ("Stramatel (sortie série, décodage à venir)", "stramatel", "serie", "9600,8,N,1"),
               ("ALGE TimeManager / SwimTime (sortie « Vidéo »)", "alge", "serie", "19200,8,N,1"),
               ("Autre / réglage manuel", "autre", None, "")]
        tk.Label(w, text="Ton chronométrage électronique", font=("Segoe UI", 10, "bold")).grid(row=0, column=0, sticky="w", padx=10, pady=(10, 4))
        sysv = ttk.Combobox(w, width=48, state="readonly", values=[x[0] for x in SYS])
        cur = cfg.get("sys") or ("ares" if cfg.get("mode") == "serie" else "quantum")
        sysv.current(next((i for i, x in enumerate(SYS) if x[1] == cur), 0)); sysv.grid(row=1, column=0, sticky="w", padx=10)
        mode = tk.StringVar(value=cfg.get("mode", "reseau"))
        rb1 = ttk.Radiobutton(w, text="Réseau (adresse:port)", variable=mode, value="reseau"); rb1.grid(row=2, column=0, sticky="w", padx=10, pady=(8, 0))
        f1 = tk.Frame(w); f1.grid(row=3, column=0, sticky="w", padx=30)
        e1 = ttk.Entry(f1, width=26); e1.insert(0, cfg["source"]); e1.pack(side="left")
        tk.Label(f1, text="  ex. 127.0.0.1:26700 · ecoute:4000 · udp:4000", fg=GREY).pack(side="left")
        rb2 = ttk.Radiobutton(w, text="Port série", variable=mode, value="serie"); rb2.grid(row=4, column=0, sticky="w", padx=10, pady=(8, 0))
        f2 = tk.Frame(w); f2.grid(row=5, column=0, sticky="w", padx=30)
        try:
            from serial.tools import list_ports
            ports = [p.device + " — " + (p.description or "") for p in list_ports.comports()]
        except Exception: ports = []
        cb = ttk.Combobox(f2, width=34, values=ports); cb.set(cfg.get("port", "") or (ports[0] if ports else "")); cb.pack(side="left")
        e3 = ttk.Entry(f2, width=12); e3.insert(0, cfg.get("serial", "9600,7,E,1")); e3.pack(side="left", padx=6)
        hint = tk.Label(w, text="", fg=GREY, justify="left"); hint.grid(row=6, column=0, sticky="w", padx=30)
        def pick(_=None):
            name, key, m, ser = SYS[sysv.current()]
            if m: mode.set(m)
            if ser: e3.delete(0, "end"); e3.insert(0, ser)
            if key == "quantum" and ":" not in e1.get(): e1.delete(0, "end"); e1.insert(0, "127.0.0.1:26700")
            st_ = "disabled" if m else "normal"; rb1.config(state=st_); rb2.config(state=st_)
            hint.config(text={"quantum": "Active la sortie « Sport In The Box » dans Quantum (port 26700 par défaut).",
                              "ares": "Série : sortie DH d'ARES Swimming en OSM6 (9600,7,E,1) ; sinon 9600,8,N,1.\nSur le PC ARES : paire de ports virtuels com0com (ex. COM8 ↔ COM9), ou câble null-modem.\nRéseau : IP_ARES:port, ou « ecoute:port » si l'ARES envoie vers ce PC,\nou « udp:port » s'il diffuse en UDP.",
                              "alge": "Sortie « Vidéo » d'ALGE vers le port série (19200,8,N,1).",
                              "stramatel": "Le flux est enregistré dans le journal ; l'affichage en direct\narrivera dès qu'on aura analysé un vrai journal.",
                              "autre": "Choisis toi-même réseau ou série."}[key] + ("\nAucun port listé ? Branche l'adaptateur puis rouvre ces réglages." if m == "serie" and not ports else ""))
        sysv.bind("<<ComboboxSelected>>", pick); pick()
        tk.Label(w, text="Passe-plat pour la vidéo (réseau) : redistribuer sur le port (vide = désactivé)").grid(row=7, column=0, sticky="w", padx=10, pady=(12, 2))
        e2 = ttk.Entry(w, width=10); e2.insert(0, cfg.get("forward", "")); e2.grid(row=8, column=0, sticky="w", padx=10)
        tk.Label(w, text="À n'utiliser que si la vidéo ne peut pas partager la sortie :\nsi ce logiciel est fermé, la vidéo ne reçoit plus rien.", fg=GREY, justify="left").grid(row=9, column=0, sticky="w", padx=10)
        def ok():
            src = e1.get().strip(); fw = e2.get().strip(); port = cb.get().split(" — ")[0].strip(); ser = e3.get().strip().upper().replace(" ", "")
            if mode.get() == "reseau" and (":" not in src or not src.rsplit(":", 1)[1].isdigit()): messagebox.showerror(APP, "Adresse invalide (ex. 127.0.0.1:26700)"); return
            if mode.get() == "serie" and not port: messagebox.showerror(APP, "Choisis le port série"); return
            if mode.get() == "serie" and len(ser.split(",")) != 4: messagebox.showerror(APP, "Réglage série invalide (ex. 9600,7,E,1)"); return
            if fw and not fw.isdigit(): messagebox.showerror(APP, "Port du passe-plat invalide"); return
            cfg.update(sys=SYS[sysv.current()][1], mode=mode.get(), source=src, port=port, serial=ser, forward=fw); save_cfg(cfg); w.destroy()
            messagebox.showinfo(APP, "Réglages enregistrés. Ferme et relance le logiciel pour les appliquer.")
        ttk.Button(w, text="Enregistrer", command=ok).grid(row=10, column=0, sticky="e", padx=10, pady=10)
    btn(cChrono.body, "⚙ Changer de système", settings).pack(side="bottom", fill="x")
    # 3 · écran géant : adresse principale en grand, les autres en petit
    tvbig = tk.Label(cTv.body, text="", bg=NAVY, fg="white", font=("Consolas", 12, "bold"), padx=8, pady=6, anchor="w"); tvbig.pack(fill="x")
    tvb = tk.Frame(cTv.body, bg=CARD); tvb.pack(fill="x", pady=(6, 0))
    def cp_main():
        u = tvbig.cget("text")
        if u: root.clipboard_clear(); root.clipboard_append(u); bcp.config(text="Copié ✓"); root.after(1500, lambda: bcp.config(text="Copier"))
    bcp = btn(tvb, "Copier", cp_main, "primary"); bcp.pack(side="left", fill="x", expand=True)
    btn(tvb, "Ouvrir ici", lambda: tvbig.cget("text") and webbrowser.open(tvbig.cget("text") + "/")).pack(side="left", fill="x", expand=True, padx=(6, 0))
    tvo = tk.Label(cTv.body, text="", bg=CARD, fg=GREY, font=(F, 8), anchor="w", justify="left", wraplength=200); tvo.pack(fill="x", pady=(6, 0))
    def tv_rows():
        ips = core.screen.ips or ([core.screen.ip] if core.screen.ip else [])
        urls = [f"http://{a}:{core.screen.port}" for a in ips] + ([f"http://{socket.gethostname()}:{core.screen.port}"] if ips else [])
        tvbig.config(text=urls[0] if urls and core.screen.ok else "")
        tvo.config(text=("Autres adresses : " + " · ".join(u.replace("http://", "") for u in urls[1:])) if len(urls) > 1 else "")

    # ---- ce qu'affiche l'écran géant (et le direct du site) : choisi ici, « Normal » rend la main au direct
    scr = tk.Frame(root, bg=CARD, highlightbackground=LINE, highlightthickness=1); scr.pack(fill="x", padx=16, pady=(0, 12))
    tk.Label(scr, text="Afficher sur l'écran géant", bg=CARD, fg=INK, font=(F, 12, "bold")).pack(anchor="w", padx=14, pady=(10, 6))
    srow = tk.Frame(scr, bg=CARD); srow.pack(fill="x", padx=14, pady=(0, 12))
    smode = {"v": "normal"}; sbtns = {}
    def show(mode, title=""):
        if mode == "msg":
            from tkinter import simpledialog
            title = simpledialog.askstring(APP, "Message à afficher en grand sur l'écran géant :", parent=root) or ""
            if not title.strip(): return
        ev = {"k": "screen", "mode": mode, "title": title, "ts": time.time()}
        try: core.q.put_nowait(ev)
        except Exception: pass
        try: core.screen.push(ev)
        except Exception: pass
        smode["v"] = mode; core.log("Écran géant : " + {"normal": "direct (normal)", "evac": "évacuation du bassin", "cer": "cérémonie", "count": "compte à rebours", "pause": "pause", "msg": "message « " + title + " »"}[mode])
        for k, b in sbtns.items(): b.config(bg=NAVY if k == mode else BG, fg="white" if k == mode else INK)
    for k, label in (("normal", "▶ Normal (direct)"), ("count", "⏱ Compte à rebours"), ("evac", "🦈 Évacuation"), ("cer", "🏅 Cérémonie"), ("pause", "☕ Pause"), ("msg", "✎ Message…")):
        b = tk.Button(srow, text=label, command=lambda k=k: show(k), bg=NAVY if k == "normal" else BG, fg="white" if k == "normal" else INK, activebackground=GOLD, relief="flat", font=(F, 10, "bold"), padx=10, pady=8, cursor="hand2")
        b.pack(side="left", padx=(0, 6), fill="x", expand=True); sbtns[k] = b

    # ---- barre du bas + détail technique (caché par défaut)
    bar = tk.Frame(root, bg=BG); bar.pack(fill="x", padx=16)
    def pause():
        core.paused = not core.paused; bpause.config(text="▶ Reprendre l'envoi" if core.paused else "⏸ Pause")
    bpause = btn(bar, "⏸ Pause", pause); bpause.pack(side="left")
    btn(bar, "📖 Aide", lambda: show_help(root, tk, ttk, NAVY, INK, BG, CARD, F), "gold").pack(side="left", padx=6)
    tech = tk.Frame(root, bg=BG)
    def toggle():
        if tech.winfo_ismapped(): tech.pack_forget(); btech.config(text="Voir le détail technique")
        else: tech.pack(fill="both", expand=True, padx=16, pady=(10, 14)); btech.config(text="Masquer le détail technique")
    btech = btn(bar, "Voir le détail technique", toggle); btech.pack(side="right")
    def check_now():
        bchk.config(text="Recherche…"); root.update(); core.check_update(force=True)
        bchk.config(text="Nouvelle version !" if core.st.get("update") else "✓ À jour"); root.after(3000, lambda: bchk.config(text="Vérifier les mises à jour"))
    bchk = btn(bar, "Vérifier les mises à jour", check_now); bchk.pack(side="right", padx=(6, 0))
    btn(bar, "Dossier des journaux", lambda: os.startfile(os.path.join(HOME, "journaux")) if hasattr(os, "startfile") else None).pack(side="right", padx=6)
    foot = tk.Label(root, text="", bg=BG, fg=GREY, font=(F, 9), anchor="w"); foot.pack(fill="x", padx=16, pady=(8, 12))
    info = tk.Frame(tech, bg=BG); info.pack(fill="x", pady=(0, 4))
    ilast = tk.Label(info, text="", bg=BG, fg=INK, font=(F, 9), anchor="w"); ilast.pack(side="left")
    isent = tk.Label(info, text="", bg=BG, fg=GREY, font=(F, 9), anchor="e"); isent.pack(side="right")
    txt = tk.Text(tech, height=9, bg=NAVY, fg="#e6f2f8", insertbackground="white", font=("Consolas", 9), relief="flat", padx=10, pady=8, highlightthickness=0)
    txt.pack(fill="both", expand=True)

    def state(c, lvl, text, sub=""):
        c.num.config(bg={"ok": GREEN, "warn": GOLD, "bad": RED}[lvl], fg=NAVY if lvl == "warn" else "white"); c.val.config(text=text, fg=RED if lvl == "bad" else INK); c.sub.config(text=sub)
    def hero_set(lvl, title, sub, tab=0):
        bg, ib, fg2 = {"ok": ("#0f5c2e", GREEN, "#d7f5e1"), "warn": ("#7a4a05", GOLD, "#fdebc8"), "bad": ("#7f1d1d", RED, "#fde2e2")}[lvl]
        for w in (hero, htx, ht, hs): w.config(bg=bg)
        hs.config(fg=fg2); hico.config(text={"ok": "✓", "warn": "!", "bad": "✕"}[lvl], bg=ib, fg=NAVY if lvl == "warn" else "white")
        ht.config(text=title); hs.config(text=sub); hero.tab = tab
        if lvl == "ok": hbtn.pack_forget()
        elif not hbtn.winfo_ismapped(): hbtn.pack(side="right", padx=18)
    def tick():
        s = core.st; q = s["quantum"]; n = len(core.screen.clients)
        lv = "ok" if s["linked"] and not s["err"] else ("bad" if s["linked"] is False or s["err"] else "warn")
        state(cLive, lv, s["name"] if s["linked"] else ("Clé pas encore reliée" if s["linked"] is False else "Connexion au site…"), (f"⚠ {str(s['err'])[:80]}" if s["err"] else ("Les temps partent sur ce live" if s["linked"] else "")))
        cq = "ok" if q.startswith(("connecté", "démo")) else ("warn" if q.startswith(("en attente", "écoute", "recherche")) else "bad")
        state(cChrono, cq, {"quantum": "Swiss Timing Quantum", "ares": "Omega ARES 21", "alge": "ALGE", "stramatel": "Stramatel"}.get(cfg.get("sys") or "quantum", "Chronométrage"), q)
        state(cTv, "ok" if core.screen.ok and n else "warn", (f"{n} écran(s) connecté(s)" if n else "Aucun écran ouvert") if core.screen.ok else "démarrage…", "Sur le PC de l'écran, ouvre :" if core.screen.ok else "")
        tv_rows()
        if lv == "bad" and s["linked"] is False: hero_set("bad", "Relie le logiciel à ton live", "Copie la clé (étape 1) et colle-la dans l'admin du live › Jour J › Chronométrage électronique relié.", 0)
        elif lv != "ok": hero_set("warn" if not s["err"] else "bad", "Le site ne répond pas" if s["err"] else "Connexion au site…", "Vérifie Internet sur ce PC. Le chronométrage et l'écran géant local continuent ; les temps partiront dès le retour de la connexion." if s["err"] else "Quelques secondes…", 6)
        elif cq == "bad": hero_set("bad", "Le chronométrage ne répond pas", f"{q}. Vérifie que le logiciel de chronométrage est ouvert avec une compétition chargée et que sa sortie est active, ou change de système (étape 2).", {"ares": 2, "alge": 3, "stramatel": 4}.get(cfg.get("sys"), 1))
        elif cq == "warn": hero_set("warn", "En attente du chronométrage", f"{q}. Le direct démarre tout seul dès que les données arrivent.", {"ares": 2, "alge": 3, "stramatel": 4}.get(cfg.get("sys"), 1))
        elif core.paused: hero_set("warn", "Envoi en pause", "Les temps ne partent plus sur le site. Bouton « Reprendre l'envoi » en bas.", 0)
        else: hero_set("ok", "Tout fonctionne", "Les temps du chronométrage partent sur le site et sur l'écran géant." + (f"  Dernier : {s['last']}" if s["last"] else ""))
        ilast.config(text="Dernier événement : " + (s["last"] or "—"))
        isent.config(text=("EN PAUSE · " if core.paused else "") + f"{s['sent']} événement(s) envoyé(s) · journal : {s['jsent']}", fg=RED if core.paused else GREY)
        foot.config(text=(f"Nouvelle version {s['update']} disponible" if s.get("update") else f"Logiciel à jour · version {VERSION}") + f" · journal envoyé au site toutes les 15 s · {s['sent']} événement(s) envoyé(s)" + (" · EN PAUSE" if core.paused else ""))
        if s.get("update") and not upd.winfo_ismapped():
            updl.config(text=f"⚠ Nouvelle version {s['update']} disponible (installée : {VERSION})"); upd.pack(fill="x", before=hero)
        while logs:
            txt.insert("end", logs.pop(0) + "\n")
            if int(txt.index("end-1c").split(".")[0]) > 400: txt.delete("1.0", "100.0")
            txt.see("end")
        root.after(500, tick)
    core.start(demo); tick()
    if close_after: root.after(int(close_after * 1000), lambda: (print("fenêtre OK"), setattr(core, "stop", True), root.destroy()))
    root.protocol("WM_DELETE_WINDOW", lambda: (setattr(core, "stop", True), root.destroy()))
    root.mainloop()

# ---- aide intégrée : ce qu'il faut régler, système par système (lisible sans Internet)
AIDE = [
    ("Démarrer", [
        ("h", "En 4 étapes"),
        ("p", "1. Lance Swim Direct · Chrono sur le PC du chronométrage. Si Windows le demande, autorise l'accès au réseau privé."),
        ("p", "2. Dans l'admin du live (site Swim Direct), onglet Jour J › « Chronométrage électronique relié » : colle la CLÉ DE LIAISON affichée ici (bouton « Copier »), puis « Relier »."),
        ("p", "3. Toujours dans l'admin, « Mode du direct » : choisis « Bassin », puis Enregistrer."),
        ("p", "4. Ici, bouton « Réglages » : choisis ton système de chronométrage (onglets suivants)."),
        ("h", "C'est bon quand…"),
        ("p", "• « LIVE RELIÉ » est vert, avec le nom du live.\n• « CHRONOMÉTRAGE » indique « connecté » et les compteurs bougent pendant une course.\n• « ÉCRAN GÉANT » est vert."),
        ("h", "Changer de compétition"),
        ("p", "Une seule clé par PC : dans l'admin de l'ancien live, « Délier », puis relie la clé dans l'admin du nouveau live. Sinon les courses partent dans l'ancien live."),
    ]),
    ("Quantum", [
        ("h", "Swiss Timing Quantum AQ"),
        ("p", "Dans Quantum, active la sortie réseau « Sport In The Box » (format tableau écran). Le logiciel la cherche par défaut sur le port 26700."),
        ("p", "Ici, Réglages : système « Swiss Timing Quantum », connexion réseau. Adresse : 127.0.0.1:26700 si Quantum tourne sur ce PC, sinon l'adresse IP du PC Quantum suivie de :26700."),
        ("h", "Deux compétitions dans Quantum"),
        ("p", "Tu peux passer d'une compétition à l'autre dans Quantum : Swim Direct retrouve la bonne épreuve grâce au nom de la compétition, au nom de l'épreuve et à l'horaire. Garde l'ordre du bassin figé dans l'admin (Programme et horaires)."),
        ("h", "Ça ne marche pas ?"),
        ("p", "• « aucun signal » : vérifie que Quantum est ouvert avec une compétition chargée, et que la sortie est bien sur le port 26700.\n• L'ordre des couloirs dans Quantum (1→8 ou 8→1) ne change rien : chaque temps arrive avec son numéro de couloir."),
    ]),
    ("ARES", [
        ("h", "Omega ARES 21"),
        ("p", "Le vrai direct (chrono qui tourne, passages, touches) arrive en OSM6, uniquement par le port GP de l'IF-ARES. Il faut un adaptateur USB ↔ RS-422/485 : broche 3 → Rx+, broche 7 → Rx−."),
        ("p", "Ici, Réglages : système « Omega ARES 21 », connexion série, le port COM de l'adaptateur, 9600,7,E,1."),
        ("p", "La sortie DH d'ARES Swimming vers le PC ne marche qu'en bi-directionnel et ne donne les temps qu'après la série : pas de direct par ce chemin."),
        ("h", "À ne jamais faire pendant une compétition"),
        ("p", "Ne touche pas à la liaison PC ↔ IF-ARES ni au câble SCB du tableau."),
    ]),
    ("ALGE", [
        ("h", "ALGE TimeManager / SwimTime"),
        ("p", "Utilise la sortie « Vidéo » du TimeManager, reliée en série au PC."),
        ("p", "Ici, Réglages : système « ALGE », connexion série, le port COM, 19200,8,N,1."),
    ]),
    ("Stramatel", [
        ("h", "Stramatel"),
        ("p", "Sortie série du tableau, 9600,8,N,1. Le décodage n'est pas encore terminé : le logiciel enregistre le journal brut pour qu'on puisse l'ajouter."),
    ]),
    ("Écran géant", [
        ("h", "Afficher l'écran géant"),
        ("p", "1. Le PC de l'écran doit être sur le même réseau que ce PC (même box, câble ou Wi-Fi)."),
        ("p", "2. Sur le PC de l'écran, ouvre dans Chrome ou Edge l'adresse affichée dans « Écran géant local » (par exemple http://192.168.1.4:8765). Bouton « Copier » pour la recopier."),
        ("p", "3. Touche F11 pour le plein écran (Fn + F11 sur certains portables)."),
        ("h", "Plein écran automatique (mode kiosque)"),
        ("p", "Crée un raccourci sur le bureau du PC de l'écran avec pour cible :\n\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" --kiosk \"http://ADRESSE:8765/\"\nAlt + F4 pour en sortir."),
        ("h", "Si l'écran n'affiche rien"),
        ("p", "• Page « Aucun live choisi » : relie d'abord la clé dans l'admin (onglet Démarrer).\n• Page injoignable : essaie l'autre adresse de la liste (câble plutôt que Wi-Fi). Le pare-feu est ouvert automatiquement par le logiciel.\n• Tu es sorti de l'écran géant : bouton « 📺 Écran géant » en bas à droite."),
    ]),
    ("Problèmes", [
        ("h", "Les messages et quoi faire"),
        ("p", "• Port COM déjà utilisé : un autre logiciel lit ce port. Ferme-le, ou choisis un autre port dans Réglages.\n• Pas d'Internet : le chronométrage continue, l'écran géant local aussi ; les temps partent sur le site dès que la connexion revient.\n• Nouvelle version : bandeau en haut, « Mettre à jour » (le logiciel redémarre en quelques secondes ; à éviter pendant une course)."),
        ("h", "Envoyer un journal"),
        ("p", "Le journal brut part tout seul sur le site toutes les 15 s. Il est consultable dans l'admin du live (Chronométrage électronique relié)."),
    ]),
]

def show_help(root, tk, ttk, NAVY, INK, BG, CARD, F, tab=0):
    w = tk.Toplevel(root); w.title(f"{APP} · Aide"); w.geometry("760x600"); w.configure(bg=BG)
    tk.Label(w, text="Aide · ce qu'il faut régler", bg=NAVY, fg="white", font=(F, 14, "bold"), anchor="w", padx=16, pady=10).pack(fill="x")
    nb = ttk.Notebook(w); nb.pack(fill="both", expand=True, padx=12, pady=12)
    for title, blocks in AIDE:
        fr = tk.Frame(nb, bg=CARD); nb.add(fr, text=title)
        t = tk.Text(fr, wrap="word", bg=CARD, fg=INK, relief="flat", bd=0, padx=18, pady=14, font=(F, 11), spacing1=2, spacing3=6, cursor="arrow")
        sb = ttk.Scrollbar(fr, orient="vertical", command=t.yview); t.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y"); t.pack(side="left", fill="both", expand=True)
        t.tag_configure("h", font=(F, 13, "bold"), foreground=NAVY, spacing1=12, spacing3=4)
        for kind, txt in blocks: t.insert("end", txt + "\n", kind if kind == "h" else ())
        t.configure(state="disabled")
    try: nb.select(tab)
    except Exception: pass
    tk.Button(w, text="Fermer", command=w.destroy, bg=NAVY, fg="white", relief="flat", font=(F, 10, "bold"), padx=16, pady=6, cursor="hand2").pack(side="right", padx=12, pady=(0, 12))

def main():
    ap = argparse.ArgumentParser(description=APP)
    ap.add_argument("--console", action="store_true", help="mode texte, sans fenêtre")
    ap.add_argument("--demo", action="store_true", help="course simulée, sans chronométrage")
    ap.add_argument("--source", help="sortie réseau du chronométrage, ex. 127.0.0.1:26700")
    ap.add_argument("--port", help="port série, ex. COM3 (ARES 21 en mode OSM6)")
    ap.add_argument("--serie", help="réglages série, ex. 9600,7,E,1")
    ap.add_argument("--site", help="adresse du site (tests)")
    ap.add_argument("--duree", type=float, default=0, help="mode texte : s'arrêter après N secondes (tests)")
    ap.add_argument("--fermer", type=float, default=0, help="fenêtre : se fermer après N secondes (tests)")
    a = ap.parse_args()
    cfg = load_cfg()
    if a.source: cfg["source"] = a.source; cfg["mode"] = "reseau"
    if a.port: cfg["port"] = a.port; cfg["mode"] = "serie"
    if a.serie: cfg["serial"] = a.serie
    if a.site: cfg["site"] = a.site
    if not a.console and not a.demo and startup_update(cfg): return  # nouvelle version installée et relancée
    if not a.console: return gui(cfg, a.demo, a.fermer)
    core = Core(cfg); print(f"{APP} {VERSION} — clé de liaison : {cfg['token']}")
    core.start(a.demo); t0 = time.time()
    try:
        while not a.duree or time.time() - t0 < a.duree: time.sleep(1)
    except KeyboardInterrupt: pass
    core.stop = True; print(json.dumps(core.st, ensure_ascii=False))

if __name__ == "__main__": main()

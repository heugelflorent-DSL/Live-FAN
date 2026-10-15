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
import argparse, gzip, io, json, os, queue, random, socket, sys, threading, time, urllib.error, urllib.request, webbrowser
from datetime import datetime

APP = "Swim Direct · Chrono"
VERSION = "1.3.0"  # à augmenter à chaque nouvelle version (affichée dans le logiciel et dans l'admin du live)
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
    PRESET = {"quantum": ("reseau", None), "ares": ("serie", "9600,7,E,1"), "stramatel": ("serie", "9600,8,N,1")}
    NAMES = {"quantum": "Swiss Timing Quantum", "ares": "Omega ARES 21", "stramatel": "Stramatel"}
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
            with urllib.request.urlopen(self.cfg["site"].rstrip("/") + "/chrono/version.json?t=" + str(int(time.time())), timeout=10) as r: j = json.loads(r.read())
            latest = str(j.get("version", ""))
            if latest and vtuple(latest) > vtuple(VERSION):
                if self.st.get("update") != latest: self.log(f"Nouvelle version disponible : {latest} (installée : {VERSION})")
                self.st["update"] = latest
        except Exception: pass

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
    def net_loop(self):
        quick = 0
        while not self.stop and not self.restart:
            host, _, port = self.cfg["source"].rpartition(":")
            t0 = time.time()
            try:
                c = socket.create_connection((host or "127.0.0.1", int(port)), timeout=8); c.settimeout(20)
                self.st["quantum"] = f"connecté ({self.cfg['source']})"; self.st["occupied"] = False; self.log(f"✓ Chronométrage trouvé sur {self.cfg['source']}")
                while not self.stop and not self.restart:
                    d = c.recv(4096)
                    if not d: raise ConnectionError("connexion fermée par le chronométrage")
                    self.feed(d, time.time())
            except Exception as e:
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
        port = self.cfg.get("port") or ""
        baud, bits, parity, stop = (self.cfg.get("serial", "9600,7,E,1").split(",") + ["9600", "7", "E", "1"])[:4]
        kw = dict(port=port, baudrate=int(baud), bytesize={"7": serial.SEVENBITS, "8": serial.EIGHTBITS}.get(bits, serial.SEVENBITS),
                  parity={"N": serial.PARITY_NONE, "E": serial.PARITY_EVEN, "O": serial.PARITY_ODD}.get(parity.upper(), serial.PARITY_EVEN),
                  stopbits=serial.STOPBITS_TWO if stop == "2" else serial.STOPBITS_ONE, timeout=1)
        while not self.stop and not self.restart:
            if not port: self.st["quantum"] = "aucun port série choisi (Réglages)"; time.sleep(3); port = self.cfg.get("port") or ""; kw["port"] = port; continue
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
        for f in (self.hello_loop, self.send_loop, self.journal_loop): threading.Thread(target=f, daemon=True).start()
        if self.cfg.get("forward"):
            try: threading.Thread(target=self.forward_loop, daemon=True).start()
            except Exception as e: self.log(f"✗ Passe-plat : {e}")
        threading.Thread(target=self.source_loop, args=(demo,), daemon=True).start()

def vtuple(v):
    try: return tuple(int(x) for x in str(v).split("."))
    except ValueError: return (0,)

def self_update(site, log=print):
    """Remplace l'exe par la dernière version publiée sur le site, puis le relance (seulement en exe Windows)."""
    if not getattr(sys, "frozen", False): log("Mise à jour automatique : seulement pour SwimDirect-Chrono.exe"); return False
    exe = sys.executable; new = exe + ".nouveau"; old = exe + ".ancien"
    try:
        with urllib.request.urlopen(site.rstrip("/") + "/chrono/SwimDirect-Chrono.exe?t=" + str(int(time.time())), timeout=120) as r, open(new, "wb") as f:
            while True:
                b = r.read(1 << 16)
                if not b: break
                f.write(b)
        if os.path.getsize(new) < 1_000_000: raise ValueError("fichier téléchargé incomplet")
        if os.path.exists(old): os.remove(old)
        os.rename(exe, old); os.rename(new, exe)  # un exe en cours d'exécution peut être renommé (pas écrasé)
        import subprocess; subprocess.Popen([exe] + sys.argv[1:], close_fds=True)
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
        with urllib.request.urlopen(cfg["site"].rstrip("/") + "/chrono/version.json?t=" + str(int(time.time())), timeout=8) as r: latest = str(json.loads(r.read()).get("version", ""))
    except Exception: return False
    return bool(latest and vtuple(latest) > vtuple(VERSION) and self_update(cfg["site"]))

# ---------- fenêtre ----------
def gui(cfg, demo=False, close_after=0):
    import tkinter as tk
    from tkinter import ttk, messagebox
    root = tk.Tk(); root.title(f"{APP} {VERSION}"); root.geometry("620x560"); root.minsize(520, 460)
    BLUE, RED, GREY = "#06324f", "#d6202f", "#5b7685"
    root.configure(bg="#e9f4f8")
    logs = []
    core = Core(cfg, on_log=lambda m: logs.append(m))

    head = tk.Frame(root, bg=BLUE); head.pack(fill="x")
    tk.Label(head, text="Swim Direct · Chrono", fg="white", bg=BLUE, font=("Segoe UI", 18, "bold")).pack(anchor="w", padx=16, pady=(12, 0))
    tk.Label(head, text="Envoie le chronométrage en direct sur ton live Swim Direct", fg="#cfe6f3", bg=BLUE, font=("Segoe UI", 10)).pack(anchor="w", padx=16, pady=(0, 12))

    box = tk.Frame(root, bg="white", highlightbackground="#c9dde6", highlightthickness=1); box.pack(fill="x", padx=14, pady=12)
    tk.Label(box, text="Clé de liaison — à coller dans l'admin de ton live (Direct → Chronométrage relié)", bg="white", fg=GREY, font=("Segoe UI", 9)).pack(anchor="w", padx=12, pady=(10, 2))
    row = tk.Frame(box, bg="white"); row.pack(fill="x", padx=12, pady=(0, 10))
    tk.Label(row, text=cfg["token"], bg="white", fg=BLUE, font=("Consolas", 20, "bold")).pack(side="left")
    def copy():
        root.clipboard_clear(); root.clipboard_append(cfg["token"]); bcopy.config(text="Copié ✓"); root.after(2000, lambda: bcopy.config(text="Copier"))
    bcopy = ttk.Button(row, text="Copier", command=copy); bcopy.pack(side="right")

    upd = tk.Frame(root, bg="#ffcc29")
    updl = tk.Label(upd, text="", bg="#ffcc29", fg="#3d2c00", font=("Segoe UI", 10, "bold")); updl.pack(side="left", padx=12, pady=6)
    def do_update():
        if core.st["sent"] and not messagebox.askyesno(APP, "Mettre à jour maintenant ? Le logiciel va redémarrer (quelques secondes sans envoi). À éviter pendant une course."): return
        updl.config(text="Téléchargement de la nouvelle version…"); root.update()
        if self_update(cfg["site"], core.log): core.stop = True; root.destroy()
        else: updl.config(text="Mise à jour impossible : télécharge-la depuis l'admin du live.")
    ttk.Button(upd, text="Mettre à jour", command=do_update).pack(side="right", padx=10)
    stat = tk.Frame(root, bg="#e9f4f8"); stat.pack(fill="x", padx=14)
    lines = {}
    for k, lab in (("site", "Live relié"), ("q", "Chronométrage"), ("last", "Dernier événement"), ("sent", "Envoyé")):
        f = tk.Frame(stat, bg="#e9f4f8"); f.pack(fill="x", pady=1)
        tk.Label(f, text=lab, width=17, anchor="w", bg="#e9f4f8", fg=GREY, font=("Segoe UI", 10)).pack(side="left")
        v = tk.Label(f, text="…", anchor="w", bg="#e9f4f8", fg=BLUE, font=("Segoe UI", 10, "bold"), wraplength=420, justify="left"); v.pack(side="left", fill="x"); lines[k] = v

    bar = tk.Frame(root, bg="#e9f4f8"); bar.pack(fill="x", padx=14, pady=8)
    def pause():
        core.paused = not core.paused; bpause.config(text="Reprendre l'envoi" if core.paused else "Pause")
    bpause = ttk.Button(bar, text="Pause", command=pause); bpause.pack(side="left")
    ttk.Button(bar, text="Ouvrir le live", command=lambda: core.st["url"] and webbrowser.open(core.st["url"])).pack(side="left", padx=6)
    def settings():
        w = tk.Toplevel(root); w.title("Réglages"); w.grab_set(); w.resizable(False, False)
        SYS = [("Swiss Timing Quantum (sortie Sport In The Box)", "quantum", "reseau", ""),
               ("Omega ARES 21 (mode OSM6)", "ares", "serie", "9600,7,E,1"),
               ("Stramatel (sortie série, décodage à venir)", "stramatel", "serie", "9600,8,N,1"),
               ("Autre / réglage manuel", "autre", None, "")]
        tk.Label(w, text="Ton chronométrage électronique", font=("Segoe UI", 10, "bold")).grid(row=0, column=0, sticky="w", padx=10, pady=(10, 4))
        sysv = ttk.Combobox(w, width=48, state="readonly", values=[x[0] for x in SYS])
        cur = cfg.get("sys") or ("ares" if cfg.get("mode") == "serie" else "quantum")
        sysv.current(next((i for i, x in enumerate(SYS) if x[1] == cur), 0)); sysv.grid(row=1, column=0, sticky="w", padx=10)
        mode = tk.StringVar(value=cfg.get("mode", "reseau"))
        rb1 = ttk.Radiobutton(w, text="Réseau (adresse:port)", variable=mode, value="reseau"); rb1.grid(row=2, column=0, sticky="w", padx=10, pady=(8, 0))
        f1 = tk.Frame(w); f1.grid(row=3, column=0, sticky="w", padx=30)
        e1 = ttk.Entry(f1, width=26); e1.insert(0, cfg["source"]); e1.pack(side="left")
        tk.Label(f1, text="  ex. 127.0.0.1:26700", fg=GREY).pack(side="left")
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
                              "ares": "Câble null-modem + adaptateur USB-série, ARES en mode OSM6.\nSi rien n'arrive, essaie 9600,8,N,1.",
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
    ttk.Button(bar, text="Réglages", command=settings).pack(side="left")
    ttk.Button(bar, text="Dossier des journaux", command=lambda: os.startfile(os.path.join(HOME, "journaux")) if hasattr(os, "startfile") else None).pack(side="right")

    txt = tk.Text(root, height=10, bg="#06324f", fg="#e6f2f8", font=("Consolas", 9), relief="flat", padx=8, pady=6); txt.pack(fill="both", expand=True, padx=14, pady=(0, 14))

    def tick():
        s = core.st
        lines["site"].config(text=(f"✓ {s['name']}" if s["linked"] else "en attente : colle la clé dans l'admin de ton live" if s["linked"] is False else "connexion au site…") + (f"  ·  ⚠ {s['err']}" if s["err"] else ""),
                             fg=RED if (s["err"] or s["linked"] is False) else BLUE)
        lines["q"].config(text=s["quantum"], fg=RED if not s["quantum"].startswith(("connecté", "démo")) else BLUE)
        lines["last"].config(text=s["last"] or "—")
        if s.get("update") and not upd.winfo_ismapped(): updl.config(text=f"Nouvelle version {s['update']} disponible (installée : {VERSION})"); upd.pack(fill="x", before=stat)
        lines["sent"].config(text=("EN PAUSE · " if core.paused else "") + f"{s['sent']} événement(s) · journal : {s['jsent']} message(s)")
        while logs:
            txt.insert("end", logs.pop(0) + "\n")
            if int(txt.index("end-1c").split(".")[0]) > 400: txt.delete("1.0", "100.0")
            txt.see("end")
        root.after(500, tick)
    core.start(demo); tick()
    if close_after: root.after(int(close_after * 1000), lambda: (print("fenêtre OK"), setattr(core, "stop", True), root.destroy()))
    root.protocol("WM_DELETE_WINDOW", lambda: (setattr(core, "stop", True), root.destroy()))
    root.mainloop()

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

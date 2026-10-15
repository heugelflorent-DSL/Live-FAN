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
VERSION = "1.0"
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
    c.setdefault("source", "127.0.0.1:26700"); c.setdefault("site", SITE); c.setdefault("forward", "")
    save_cfg(c); return c
def save_cfg(c):
    with open(CFG_PATH, "w", encoding="utf-8") as f: json.dump(c, f, indent=1)

# ---------- moteur ----------
class Core:
    def __init__(self, cfg, on_log=print):
        self.cfg = cfg; self.on_log = on_log; self.paused = False; self.stop = False
        self.q = queue.Queue(maxsize=5000); self.raw = []; self.raw_lock = threading.Lock()
        self.st = {"linked": None, "name": "", "url": "", "bassin": None, "quantum": "recherche…", "last": "", "sent": 0, "jsent": 0, "err": "", "occupied": False}
        jdir = os.path.join(HOME, "journaux"); os.makedirs(jdir, exist_ok=True)
        for f in os.listdir(jdir):
            fp = os.path.join(jdir, f)
            if time.time() - os.path.getmtime(fp) > 7 * 86400:
                try: os.remove(fp)
                except OSError: pass
        self.journal = open(os.path.join(jdir, datetime.now().strftime("journal-%Y%m%d-%H%M.jsonl")), "a", encoding="utf-8")
        self.fw_clients = []; self.fw_lock = threading.Lock()

    def log(self, *a): self.on_log(datetime.now().strftime("%H:%M:%S") + " " + " ".join(str(x) for x in a))

    # requêtes vers le site
    def call(self, path, body=None, ctype="application/json", timeout=10):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        req = urllib.request.Request(self.cfg["site"].rstrip("/") + path, data=data, method="POST" if data is not None else "GET",
                                     headers={"content-type": ctype, "x-relay-token": self.cfg["token"], "user-agent": f"SwimDirectChrono/{VERSION}"})
        with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read() or b"{}")

    def hello_loop(self):
        while not self.stop:
            try:
                j = self.call("/api/relay/hello")
                was = self.st["linked"]
                self.st.update(linked=bool(j.get("linked")), name=j.get("name", ""), url=j.get("url", ""), bassin=j.get("bassin"), err="")
                if self.st["linked"] and not was: self.log(f"✓ Relié au live « {self.st['name']} »")
                if self.st["linked"] and j.get("bassin") is False and was is None: self.log("⚠ Sur le site, le mode du direct de ce live n'est pas « Bassin » : les temps sont reçus mais pas affichés au public.")
            except Exception as e: self.st["err"] = f"site injoignable ({e})"
            time.sleep(5 if not self.st["linked"] else 60)

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
        quick = 0
        while not self.stop:
            host, _, port = self.cfg["source"].rpartition(":")
            t0 = time.time()
            try:
                c = socket.create_connection((host or "127.0.0.1", int(port)), timeout=8); c.settimeout(20)
                self.st["quantum"] = f"connecté ({self.cfg['source']})"; self.st["occupied"] = False; self.log(f"✓ Chronométrage trouvé sur {self.cfg['source']}")
                while not self.stop:
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
        tk.Label(w, text="Sortie du chronométrage (adresse:port)").grid(row=0, column=0, sticky="w", padx=10, pady=(10, 2))
        e1 = ttk.Entry(w, width=30); e1.insert(0, cfg["source"]); e1.grid(row=1, column=0, padx=10)
        tk.Label(w, text="Ex. 127.0.0.1:26700 (Sport In The Box sur ce PC)\nou 192.168.1.20:26701 (2e sortie sur un autre PC)", fg=GREY, justify="left").grid(row=2, column=0, sticky="w", padx=10)
        tk.Label(w, text="Passe-plat pour la vidéo : redistribuer sur le port (vide = désactivé)").grid(row=3, column=0, sticky="w", padx=10, pady=(12, 2))
        e2 = ttk.Entry(w, width=10); e2.insert(0, cfg.get("forward", "")); e2.grid(row=4, column=0, sticky="w", padx=10)
        tk.Label(w, text="À n'utiliser que si la vidéo ne peut pas partager la sortie :\nsi ce logiciel est fermé, la vidéo ne reçoit plus rien.", fg=GREY, justify="left").grid(row=5, column=0, sticky="w", padx=10)
        def ok():
            src = e1.get().strip(); fw = e2.get().strip()
            if ":" not in src or not src.rsplit(":", 1)[1].isdigit(): messagebox.showerror(APP, "Adresse invalide (ex. 127.0.0.1:26700)"); return
            if fw and not fw.isdigit(): messagebox.showerror(APP, "Port du passe-plat invalide"); return
            cfg["source"], cfg["forward"] = src, fw; save_cfg(cfg); w.destroy()
            messagebox.showinfo(APP, "Réglages enregistrés. Ferme et relance le logiciel pour les appliquer.")
        ttk.Button(w, text="Enregistrer", command=ok).grid(row=6, column=0, sticky="e", padx=10, pady=10)
    ttk.Button(bar, text="Réglages", command=settings).pack(side="left")
    ttk.Button(bar, text="Dossier des journaux", command=lambda: os.startfile(os.path.join(HOME, "journaux")) if hasattr(os, "startfile") else None).pack(side="right")

    txt = tk.Text(root, height=10, bg="#06324f", fg="#e6f2f8", font=("Consolas", 9), relief="flat", padx=8, pady=6); txt.pack(fill="both", expand=True, padx=14, pady=(0, 14))

    def tick():
        s = core.st
        lines["site"].config(text=(f"✓ {s['name']}" if s["linked"] else "en attente : colle la clé dans l'admin de ton live" if s["linked"] is False else "connexion au site…") + (f"  ·  ⚠ {s['err']}" if s["err"] else ""),
                             fg=RED if (s["err"] or s["linked"] is False) else BLUE)
        lines["q"].config(text=s["quantum"], fg=RED if not s["quantum"].startswith(("connecté", "démo")) else BLUE)
        lines["last"].config(text=s["last"] or "—")
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
    ap.add_argument("--source", help="sortie du chronométrage, ex. 127.0.0.1:26700")
    ap.add_argument("--site", help="adresse du site (tests)")
    ap.add_argument("--duree", type=float, default=0, help="mode texte : s'arrêter après N secondes (tests)")
    ap.add_argument("--fermer", type=float, default=0, help="fenêtre : se fermer après N secondes (tests)")
    a = ap.parse_args()
    cfg = load_cfg()
    if a.source: cfg["source"] = a.source
    if a.site: cfg["site"] = a.site
    if not a.console: return gui(cfg, a.demo, a.fermer)
    core = Core(cfg); print(f"{APP} {VERSION} — clé de liaison : {cfg['token']}")
    core.start(a.demo); t0 = time.time()
    try:
        while not a.duree or time.time() - t0 < a.duree: time.sleep(1)
    except KeyboardInterrupt: pass
    core.stop = True; print(json.dumps(core.st, ensure_ascii=False))

if __name__ == "__main__": main()

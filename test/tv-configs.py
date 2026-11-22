# Captures de l'écran géant dans TOUTES les configurations (à lancer avant chaque push qui touche l'écran géant).
# Usage : python3 test/tv-configs.py etat-api.json etat-bassin.json [dossier-sortie]
#   etat-api.json   : réponse de /api/state?e=<live>
#   etat-bassin.json: {"ready": <état POOL série au départ>, "run": <en course>, "done": <arrivée>} (ex. rejoué depuis un journal chrono)
import json, sys, os
from playwright.sync_api import sync_playwright
st = open(sys.argv[1]).read(); S = json.load(open(sys.argv[2])); out = sys.argv[3] if len(sys.argv) > 3 else "/tmp/tvcfg"; os.makedirs(out, exist_ok=True)
html = open(os.path.join(os.path.dirname(__file__), "..", "public", "index.html")).read()
CONF = {"normal": {}, "grandpitch": {"tvbig": True}, "clair": {"tvlight": True}, "couloirs-inverses": {"tvrev": True},
        "4-3": {"tvfmt": "43"}, "16-9": {"tvfmt": "169"}, "grandpitch-inverse": {"tvbig": True, "tvrev": True}}
SIZES = [(1920, 1080), (1280, 1024), (1024, 768)]
with sync_playwright() as p:
    b = p.chromium.launch()
    for W, H in SIZES:
        pg = b.new_page(viewport={"width": W, "height": H}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        def h(r):
            u = r.request.url
            if "/api/state" in u: r.fulfill(body=st, content_type="application/json")
            elif u.split("?")[0].endswith("/e/x"): r.fulfill(body=html, content_type="text/html")
            elif "/api/" in u: r.fulfill(body="{}", content_type="application/json")
            else: r.fulfill(status=404, body="")
        pg.route("**/*", h); pg.goto("https://sd.test/e/x#tv"); pg.wait_for_timeout(1500)
        pg.evaluate("()=>{window.compWait=()=>'';window.spBetween=()=>'';window.screenOv=()=>'';state.live='bassin'}")
        for cn, c in CONF.items():
            for phase in ("ready", "run", "done"):
                if phase not in S: continue
                pg.evaluate("([s,c])=>{TVLAST=null;POOL={...s,...c,now:Date.now(),relayAt:Date.now()};const el=document.getElementById('tvscreen');if(el){el._html=null}tvRender()}", [S[phase], c])
                pg.wait_for_timeout(400); pg.screenshot(path=f"{out}/{W}x{H}-{cn}-{phase}.png")
        if errs: print(W, H, "ERREURS", errs[:3])
        pg.close()
    b.close()
print("captures dans", out)

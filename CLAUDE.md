# Swim Direct — notes pour Claude

Projet de Florent (et Mat), signé « © Mat-et-Flo ». Résultats et direct de natation à partir du Live FFN et du chronométrage électronique.
Site : https://swim-direct.swim-direct.workers.dev (Cloudflare Worker `swim-direct`). Travailler **en français**.

## Règles de travail (impératives)
- **Jamais de push sans un « go » explicite de Florent** (« go », « push », « push tout », « tu peux déployer »). Regrouper les changements. Si un hook signale des commits non poussés : expliquer qu'on attend le go, ne pas pousser.
- **Simulation visuelle avant toute nouvelle fonctionnalité** (Playwright, capture d'écran vérifiée) : plusieurs bugs n'ont été vus que comme ça.
- Ne jamais écrire « autorisé par la FFN ». Ne pas parler des Interclubs XXL à la FFN.
- **Lire le Live FFN le moins possible** (il bloque en 403). Pas de resynchronisation des Interclubs demandée.
- Les mots de passe et secrets : Florent les tape lui-même, ne jamais les manipuler.
- Commits : `git -c user.name=Claude -c user.email=noreply@anthropic.com commit`, avec les lignes d'attribution demandées par la session.

## Déployer
- `git push origin HEAD:main` → Cloudflare Workers Builds (check « swim-direct ») construit et déploie. Attendre `swim-direct completed success` via `gh api repos/heugelflorent-DSL/Live-FAN/commits/<sha>/check-runs`.
- Le workflow `.github/workflows/chrono-exe.yml` (check « build ») compile l'exe Windows quand `relais/` change et écrit `public/chrono/version.json` → faire `git pull --ff-only` ensuite.
- `scripts/build.mjs` minifie `public/index.html` dans `dist/` et copie `src/poolcore.js` en `dist/poolcore.js`.

## Architecture
- `public/index.html` : toute l'appli (page publique + admin), un seul fichier. Écran géant = `tvScreenHtml`/`tvPick`/`tvRender` (classes `.tv*`). Navigation : `navPush`/`NAVD`. Records perso : `MPP`, `bestOf`. Qualifications : `QUALS`, `qualOf`. Pièces jointes info : morceaux base64 de 1,4 Mo (`fBlob`). Mode écran local : `window.SD_LOCAL` → `localConnect()` (SSE `/local/events`).
- `src/worker.js` : API, synchro Live FFN (file `data.queue`, pause qui s'allonge après un 403, reprise toute seule ; rien la nuit 22h–6h hors compétition), records perso (`mppStep`, `mppWant`).
- `src/eu.js` : `env.KV` est en réalité une base D1 qui ne stocke **que du texte** (~2 Mo par ligne) → binaire en base64 découpé, jamais décodé côté serveur (limite CPU de l'offre gratuite).
- `src/pool.js` + `src/poolcore.js` : direct bassin (Durable Object). `poolcore.applyEvent` est partagé avec l'écran local.
- `src/ffn.js` (pages Live FFN), `src/extranat.js` (records Extranat : `findIuf` puis `fetchMpp`, avec passages).
- `relais/swimdirect_chrono.py` : logiciel « Swim Direct · Chrono » (exe Windows). `VERSION` à augmenter à chaque changement. Lit Quantum (réseau 26700), ARES (série OSM6 ou réseau : `ip:port`, `ecoute:port`, `udp:port`), ALGE, Stramatel ; journal brut envoyé au site toutes les 15 s ; mise à jour automatique ; serveur d'écran local sur le port 8765 (proxy du site + cache disque, pare-feu ouvert automatiquement). Console de régie `/regie` (`relais/regie.html`, commandes `POST /local/cmd` → fenêtre Tk) : pour le PC de l'écran géant en écran étendu, marche sans Internet ; mode d'emploi dans l'aide de l'exe (onglet Écran géant). Décodeurs dans `relais/swim_relais.py`.
- Tests : `test/*.mjs`. Pour tester l'interface Tk en local : `python3.12` + `xvfb-run`.

## Pièges connus
- PyInstaller : au redémarrage après mise à jour, nettoyer les variables `_MEI*`/`_PYI*` (corrigé en 1.4.3).
- Un PC avec câble et Wi-Fi dans la même plage (192.168.1.x) : l'écran local peut être injoignable par la mauvaise carte → utiliser l'adresse du câble.
- L'Extranat semble refuser ou filtrer la recherche de nageurs depuis le serveur (68/68 « introuvables » au meeting masters LLSB de novembre 2026) alors qu'elle marche depuis un navigateur. Les licences venant de la liste des engagés du Live FFN contournent cette recherche. Si la lecture des fiches est bloquée aussi : passer les requêtes Extranat par le logiciel chrono.
- Navigateur : changer seulement le `#` ne recharge pas la page → ajouter `?v=`.

## À suivre
- Omega ARES — **interface Splash** (1.7.0, testée le 16/11/2026 sur un PC du club avec un simulateur d'IF-ARES) : le logiciel chrono tourne SUR le PC ARES, source `splash:C:\ARES\SWIMM`. Il écrit `ASK RESULTS;EVENT=e;ROUND=r;HEAT=h` (série comptée depuis 0) dans `splash_send.txt`, ARES l'efface et ajoute `LSTRESULT;e; r; h; longueur; couloir; côté; rang; temps;` dans `splash_receive.txt` (~1 s après chaque touche). Séries lues dans `LSTRACE.TXT`, longueurs dans `LSTLONG.TXT` (colonne « lap », à vérifier), passage auto à la série suivante. **Départ** (1.7.3) : Splash ne le donne pas → lu en lecture seule dans la liste de la fenêtre de course d'ARES (`[V]  Start: hh:mm:ss.cc`, ListBox via LB_GETTEXT) ; temps = toucher − départ (le simulateur donne l'heure du jour). Validé au simulateur le 16/11/2026 : le chrono part au start. **Sortie réseau « comme un Quantum »** (1.7.7, `QuantumOut`) : port 26700 (`sortie_quantum`, 0 = coupée), format copié d'un journal réel du Quantum (Interclubs U11 du 15/11/2026) ; pas encore testée avec un logiciel tiers. À activer une fois : enlever `zzz` devant `FileNameForSplashRd/Wr` dans `SWIMM.INI` (ARES fermé). À valider sur vraie installation : unité du temps (millièmes de course ? heure du jour ?), colonnes de LSTLONG. Doc complète : document « Protocole ARES » du Projet.
- Omega ARES (test du 11/11/2026 à Schiltigheim, journaux bruts dans l'admin) :
  - OSM6 seulement sur le port GP de l'IF-ARES (RS-422, adaptateur à acheter — refusé pour l'instant par Florent).
  - « DH sur un port série du PC » = Bi-directionnel uniquement : trames `55 AA 00 <seq> FE …` toutes les ~47 s (3 essais), attend une réponse ; temps seulement sur demande après la série (HY-TEK). Protocole inconnu.
  - Piste suivante : boîtier noir (DB9 → USB) qui alimente déjà le PC de l'écran géant ; dupliquer son port COM avec hub4com pour Swim Direct. Relever : prise IF-ARES utilisée (SCB/GP), logiciel d'affichage + port COM, modèle du boîtier, journal pendant une course.
  - Contraintes de Florent : aucun achat, ne jamais toucher au chronométrage (liaison PC↔IF-ARES, câble SCB), ne pas perturber la compétition.
  - Idées notées : bouton « créer les ports com0com » dans l'exe ; message clair quand un port COM est déjà pris.
- Deux grilles de qualification vides (« France U13 », « Nouvelle grille ») : demander avant de supprimer.

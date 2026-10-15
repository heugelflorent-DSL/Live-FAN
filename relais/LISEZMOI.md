# Swim Direct · Chrono (recommandé)

1. Dans l'admin du live (étape « Mode du direct »), clique « Télécharger le logiciel du chrono (Windows) » et copie `SwimDirect-Chrono.exe` sur le PC du chrono.
2. Lance-le (la première fois, Windows peut afficher « Windows a protégé votre ordinateur » : « Informations complémentaires » puis « Exécuter quand même » — le logiciel n'est pas signé).
3. Il affiche une **clé de liaison** `SD-XXXX-XXXX-XXXX-XXXX` : bouton « Copier », puis colle-la dans l'admin de TON live → « Chronométrage relié » → « Relier ».
4. La fenêtre affiche « ✓ nom du live » : tout ce que lit le chronométrage part sur ce live (événements + journal brut complet, gardé 14 jours et téléchargeable depuis l'admin).

Réglages : sortie du chronométrage (défaut `127.0.0.1:26700`, sortie Sport In The Box). Si la vidéo utilise déjà cette sortie et qu'elle n'accepte qu'un seul logiciel, le chrono le détecte et se retire : crée alors une 2e sortie Sport In The Box sur un autre port dans le Quantum et indique-la dans « Réglages ». En dernier recours, option « passe-plat » (redistribue les données à la vidéo sur un autre port).

Deux compétitions en même temps : un PC de chrono = une clé = un live. Rien à régler d'autre.

---

# Relais « Bassin » — Quantum → Swim Direct

Le relais écoute la sortie série du Quantum (protocole **OSM6**) et transmet en direct au site :
série prête, départ, temps de réaction, passages, arrivées et fin officielle.
**Il ne fait qu'écouter** : rien n'est jamais envoyé vers le chronométrage.

## Sans aucun matériel (à essayer en premier)

Le logiciel Quantum tourne sur un PC Windows : on peut lui faire envoyer la sortie OSM6 **dans un port série virtuel**
et lire ce port avec le relais, sur le même PC. Aucun câble, aucun adaptateur.

1. Sur le PC du Quantum, installer **com0com** (gratuit, « Null-modem emulator ») : il crée une paire de ports reliés, par ex. `COM20 ↔ COM21`.
2. Dans Quantum, onglet **I/Os** : ajouter une ligne **« DH OSM6 »** et choisir **COM20** comme port.
3. Lancer le relais sur le même PC : `python swim_relais.py --port COM21`
4. Le PC doit avoir internet (wifi de la piscine ou partage de connexion d'un téléphone).

Si Quantum propose une sortie **réseau** (UDP/TCP) au lieu d'un port série, le relais sait aussi l'écouter :
`python swim_relais.py --reseau udp:4000` (ou `tcp:4000`, ou `tcp:IP:PORT`).

## Matériel (si le PC du Quantum ne peut pas être utilisé)

| Élément | Détail |
|---|---|
| Ordinateur | Portable Windows ou Mac avec internet (4G/wifi), au bord du bassin |
| Adaptateur | **USB → RS-422** (pas RS-232 !) — ex. Moxa UPort 1130, Vscom USB-COM-I (~80 €) |
| Câble | 2 fils suffisent : on ne fait que **recevoir** (Tx+ / Tx− du Quantum vers Rx+ / Rx− de l'adaptateur) |

### Deux façons de se brancher

**A. Sortie série libre du Quantum (le plus propre)**
Dans le logiciel Quantum, onglet **I/Os**, ajouter une ligne **« DH OSM6 »** sur une sortie libre (Serial 1, 2…).
Câble : Quantum broche 3 (Tx−) → Rx− de l'adaptateur, broche 4 (Tx+) → Rx+ (vérifier le brochage dans la notice de l'adaptateur).

**B. Écouter la ligne du Piccolo (sans sortie supplémentaire)**
Le Piccolo est relié au Quantum en **RS-422** et accepte les protocoles Quantum / OSM6.
En RS-422, une sortie peut alimenter plusieurs récepteurs : on peut donc **se mettre en dérivation** sur la paire
Tx+/Tx− qui va vers le Piccolo (répartiteur en Y côté SubD 9 du Quantum, ou boîtier de dérivation),
en ne branchant **que la réception** de l'adaptateur. Le Piccolo continue de fonctionner normalement.
⚠️ Vérifier dans Quantum (I/Os) quel protocole est réglé pour la sortie du Piccolo :
s'il s'agit d'OSM6, le relais le décode directement ; sinon, le relais enregistre tout dans son journal
et on adapte le décodage à partir de cet enregistrement.

## Installation (une fois)

1. Installer Python 3 (python.org), puis : `pip install pyserial`
2. Copier `swim_relais.py` sur l'ordinateur.

## Utilisation

```
python swim_relais.py --ports                  # trouver le port de l'adaptateur
python swim_relais.py --port COM5              # Windows
python swim_relais.py --port /dev/tty.usbserial-XXXX   # Mac
```
La clé du relais (secret RELAY_KEY dans Cloudflare) est demandée au démarrage ; le mot de passe admin fonctionne aussi, mais il vaut mieux ne pas le laisser sur le PC du chrono.
Réglages série par défaut : `9600,7,N,1` (modifiable avec `--reglages 9600,8,N,1`).

Dans l'admin du site : **Direct pendant la compétition → Bassin**, puis Enregistrer.

### Tester sans matériel
```
python swim_relais.py --demo          # simule une course de 100 m, visible sur le site
python swim_relais.py --port COM5 --capture   # enregistre seulement (entraînement)
python swim_relais.py --replay journal-20261115-0900.jsonl   # rejoue un enregistrement
```
Chaque session écrit un **journal brut** (`journal-AAAAMMJJ-HHMM.jsonl`) : à garder et à m'envoyer en cas de souci.

## Bon à savoir
- Les noms des nageurs viennent du programme Live FFN du site (épreuve + série + couloir) :
  le numéro d'épreuve du Quantum doit correspondre au numéro d'épreuve FFN (à vérifier au premier essai).
- Les temps affichés sont **provisoires** ; les résultats officiels restent ceux du Live FFN.
- Si internet coupe, le relais renvoie automatiquement dès le retour de la connexion.


## Deux chronométrages en même temps (deux compétitions)

Chaque live a son propre direct bassin. Deux façons de faire tourner deux Quantum en même temps :

1. **Mot de passe organisateur (le plus simple)** : l'administrateur du site donne un mot de passe organisateur à chaque live (admin → en haut, « Accès organisateur »). Sur chaque PC de chrono, lance `enregistrer_mot_de_passe.bat` et tape le mot de passe organisateur de SON live : le relais envoie automatiquement au bon live, sans autre réglage.
2. **Clé du relais commune (RELAY_KEY)** : il faut alors préciser le live sur chaque PC, par exemple `python swim_relais.py --reseau tcp:127.0.0.1:26700 --evenement meeting-colmar` (l'identifiant est la fin de l'adresse du live, après /e/).

Sans l'un ni l'autre, le relais envoie au premier live réglé en mode « Bassin ».

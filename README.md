# Schwimme Direct

Live de la Fédération Alsacienne de Natation : plusieurs Live FFN fusionnés en un seul programme, avec horaires recalculés, séries, résultats, podiums et classement des Interclubs.

Auteurs : Flo et Mat.

- `public/index.html` : le site (page publique + admin)
- `src/ffn.js` : lecture des pages du Live FFN
- `src/worker.js` : serveur Cloudflare (API, stockage KV, récupération programmée)

Mise en ligne : Cloudflare Workers relié à ce dépôt GitHub. Chaque modification poussée sur `main` est publiée automatiquement.
Le mot de passe de l'admin est la variable secrète `ADMIN_PASSWORD` du Worker (Cloudflare → Workers → schwimme-direct → Settings → Variables and Secrets).

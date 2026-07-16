# Déploiement gratuit du portfolio + backend Lynda

Ce guide explique comment mettre en ligne **gratuitement** tout le projet :
le site (frontend statique) et l'assistante IA Lynda (backend Node.js).

---

## 1. Le site (frontend) — GitHub Pages (gratuit)

Le dépôt GitHub existe déjà : `maurelscientist/CV-de-Brou-ange-maurel`.

1. Allez dans **Settings** → **Pages** du dépôt.
2. *Source* : branche **main**, dossier **/root**.
3. Sauvegardez. Le site sera publié sur :
   `https://maurelscientist.github.io/CV-de-Brou-ange-maurel/`

> Astuce : pour un nom plus propre, vous pouvez renommer le dépôt en
> `maurel-brou.github.io` (GitHub Pages vous donnera alors une URL
> `https://maurelscientist.github.io/` sans le nom du dépôt).

**Alternatives gratuites** : Netlify, Vercel, Cloudflare Pages
(glisser-déposer le dossier, ou brancher le repo GitHub).

---

## 2. Le backend Lynda (Node.js) — Render (gratuit)

Le backend fait tourner l'IA (Groq / OpenRouter). Il doit être hébergé
pour que Lynda réponde en ligne.

### Option A — Render Blueprint (automatique)
1. Créez un compte sur https://render.com (gratuit).
2. **New** → **Blueprint** → connectez le dépôt GitHub.
3. Render lit le fichier `render.yaml` et crée le service `lynda-backend`.
4. Dans les **Environment Variables** du service, ajoutez :
   - `GROQ_KEY` = votre clé Groq (`gsk_...`)
   - `OPENROUTER_KEY` = votre clé OpenRouter (`sk-or-v1-...`)
   - (optionnel) `GROQ_KEY_2` = clé de secours
5. Une fois déployé, notez l'URL (ex. `https://lynda-backend.onrender.com`).

### Option B — Render manuel
1. **New** → **Web Service** → branche `main`.
2. *Root Directory* : `backend`
3. *Build Command* : `echo no build`
4. *Start Command* : `node server.js`
5. Plan : **Free**
6. Ajoutez les variables d'environnement ci-dessus.

> Note : le plan free de Render "dort" après 15 min d'inactivité. Le
> premier appel réveille le serveur (latence ~30 s). C'est normal.

**Alternatives gratuites** : Railway (500 h/mois), Koyeb, Fly.io.

---

## 3. Relier le frontend au backend

Dans `index.html`, juste avant les scripts Lynda, renseignez l'URL de
votre backend :

```html
<script>window.LYNDA_API_BASE = "https://lynda-backend.onrender.com";</script>
```

Si cette variable est vide ou absente, le code retombe sur
`http://127.0.0.1:5000` (utile en local). Le fichier `index.html`
contient déjà un placeholder `window.LYNDA_API_BASE = "";` — remplacez
la chaîne vide par l'URL de votre backend une fois celui-ci en ligne.

---

## 4. Sécurité des clés API

- Les clés **ne sont jamais** dans le code frontend (elles ont été retirées).
- Elles vivent dans `backend/.env` (ignoré par git) en local, et dans
  les **variables d'environnement** du service backend en production.
- Le fichier `backend/.env.example` documente les variables attendues.

---

## 5. Résumé des fichiers utiles

| Fichier | Rôle |
|---|---|
| `index.html` | Contient la balise `LYNDA_API_BASE` à configurer |
| `render.yaml` | Déploiement automatique du backend sur Render |
| `backend/package.json` | Déclare `node server.js` comme point d'entrée |
| `backend/server.js` | Backend (écoute sur `0.0.0.0` en prod) |
| `backend/.env.example` | Modèle de variables d'environnement |

---

## 6. Ordre recommandé

1. Déployer le backend sur Render (+ variables d'env) → récupérer l'URL.
2. Mettre à jour `LYNDA_API_BASE` dans `index.html` avec cette URL.
3. Activer GitHub Pages (ou Netlify/Vercel) pour le frontend.
4. Tester : ouvrez le site, demandez « mon CV » à Lynda, envoyez le
   formulaire de projet.

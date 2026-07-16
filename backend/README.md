# Backend Python — Lynda (Assistante IA de Maurel Brou)

Proxy sécurisé vers OpenRouter. La clé API reste **côté serveur**,
jamais exposée au navigateur.

## Mode IA pur (sans texte pré-écrit)

Lynda n'est **plus un bot à scripts**. Elle appelle directement l'API
OpenRouter et répond de façon **imprévisible** (`temperature: 1.0`).
Le moteur local a été supprimé : si l'API est indisponible, elle dit
honnêtement *"mon cerveau IA est momentanément indisponible"* — elle ne
simule jamais un bot.

## Limite actuelle : tier gratuit OpenRouter

Avec la clé fournie, **tous les modèles gratuits renvoient 429** (rate
limit) après 1-2 requêtes. C'est une restriction du compte, pas du code.

**Solutions pour une IA continue :**
- **Option A** : ajouter des crédits sur openrouter.ai (modifier
  `OPENROUTER_KEY` dans `server.py`).
- **Option B (recommandée)** : **Groq** — tier gratuit généreux
  (30 req/min, pas de rate limit agressif). Déjà intégré :
  1. Créez une clé gratuite sur https://console.groq.com
  2. Renseignez-la dans `server.py` (`GROQ_KEY = "gsk_..."`) ou via
     la variable d'environnement `GROQ_KEY`
  3. Relancez le serveur. Le frontend appelle automatiquement
     `/api/chat-groq` en priorité.
- **Option C** : Hugging Face Inference (token gratuit).

Le frontend essaie Groq en premier, puis OpenRouter en secours. Si les
deux échouent, Lynda dit honnêtement que son IA est indisponible
(elle ne simule jamais un bot).

## Recherche web (nouveau)

Lynda peut **chercher sur internet** pour les questions nécessitant
des infos externes ou récentes (actualité, tendances, prix, etc.).

- Endpoint : `POST /api/search` → `{ "q": "..." }` → `{ "results": [...] }`
- Moteur : DuckDuckGo via le package `ddgs` (gratuit, sans clé API)
- Le frontend détecte automatiquement les questions nécessitant une
  recherche (mots-clés : "recherche", "trouve", "actualité", "en 2026",
  "dernières", "comparatif", etc.) et :
  1. appelle `/api/search`
  2. passe les résultats à l'IA (Groq) qui les synthétise et cite ses sources
- Si la recherche échoue, Lynda répond avec ses connaissances générales.

Dépendance : `pip install ddgs` (ou `duckduckgo-search`).

## Démarrage

```bash
# 1. Installer les dépendances (une seule fois)
pip install flask flask-cors requests

# 2. Lancer le serveur
python backend/server.py
```

Le serveur écoute sur `http://127.0.0.1:5000`.

## Endpoints

| Méthode | URL | Description |
|---------|-----|-------------|
| GET | `/api/health` | Vérifie que le serveur est en ligne |
| POST | `/api/chat` | Reçoit `{ "messages": [...] }`, renvoie `{ "reply": "..." }` |

## Intégration frontend

Le fichier `assets/js/agent.js` appelle `http://127.0.0.1:5000/api/chat`.
Si le backend est indisponible (serveur éteint, rate limit OpenRouter…),
Lynda bascule automatiquement sur son **moteur génératif local** — le
service reste toujours disponible.

## Notes

- Modèle par défaut : `tencent/hy3:free` (gratuit, testé et validé).
- En cas de rate limit (429) du tier gratuit, le backend renvoie une
  erreur 502 et le frontend utilise le moteur local.
- Pour utiliser une clé différente, modifiez `OPENROUTER_KEY` dans
  `backend/server.py` ou utilisez la variable d'environnement
  `OPENROUTER_KEY`.

## Observabilité — Langfuse (traces LLM)

Le backend journalise chaque appel Groq dans `backend/llm-traces.log`
(via `traceLLM`). Pour visualiser ces traces dans VS Code avec
l'extension **Langfuse Traces** (`nicolasmota.langfuse-traces`) :

1. **Démarrer le mock Langfuse local** (sert l'API publique Langfuse
   en relisant `llm-traces.log`) :
   ```bash
   node backend/langfuse-mock.js
   # écoute sur http://127.0.0.1:3000
   ```
2. **Lancer le backend avec l'envoi activé** :
   ```bash
   $env:LANGFUSE_PUSH="1"; node backend/server.js
   ```
   (le backend pousse chaque trace au mock via `/api/public/ingestion`)
3. **Ouvrir l'extension** : View → Langfuse → la session `lynda-session`
   apparaît automatiquement. Cliquez dessus pour voir les spans
   (input système/utilisateur, output, modèle, durée).

> Note : le mock remplace une vraie instance Langfuse (Docker/cloud).
> Pour une instance réelle, pointez `langfuse.host` / `langfuse.publicKey`
> / `langfuse.secretKey` de l'extension vers votre instance et utilisez
> le SDK Langfuse officiel côté backend à la place du mock.

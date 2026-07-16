# Diagnostic IA — Lynda Portfolio (2026-07-15)

## Demande initiale
Utiliser OpenRouter comme clé principale (modèle gratuit `tencent/hy3:free`).

## Résultat des tests
| Fournisseur | État | Détail |
|-------------|------|--------|
| **Groq** (`llama-3.3-70b-versatile`) | ⚠️ Quota épuisé | Used 99153/100000 TPD. Réinitialisation ~8 min. Répond par moments (quota quasi épuisé). |
| **OpenRouter** (`tencent/hy3:free`) | ❌ Instable | Clé avec **0 crédit**. Modèles `:free` surchargés/dégradés. Échecs fréquents (5xx/timeout). |
| **OpenRouter** (modèles payants) | ❌ Bloqué | Clé sans crédit → impossible d'utiliser les modèles payants. |

## Tests de stabilité (10 appels `/api/chat`)
- OpenRouter prioritaire : 2 OK / 8 ERR (20%)
- Groq prioritaire + OpenRouter repli : 4 OK (2 Groq + 2 OpenRouter) / 6 ERR (40%)

## Conclusion
La demande (OpenRouter principal) **ne peut pas être satisfaite de façon fiable** car :
1. La clé OpenRouter fournie a **0 crédit** → seuls les modèles `:free` sont utilisables
2. Ces modèles `:free` sont **très instables** en ce moment (surcharge OpenRouter)
3. Groq est en **quota épuisé** → ne peut servir de repli fiable

## Solutions proposées
1. **Ajouter des crédits OpenRouter** (ex. $5) → débloque les modèles payants stables (Claude, GPT-4o-mini, Gemini)
2. **Attendre la réinitialisation Groq** (~8 min) → Groq redevient prioritaire stable
3. **Utiliser une autre clé Groq** (autre organisation) → double le quota
4. **Accepter l'instabilité** → config actuelle Groq prioritaire + OpenRouter repli (40% de réussite)

## Config actuelle (server.js)
- Groq en priorité (`llama-3.3-70b-versatile` → `llama-3.1-8b-instant`, 2 clés alternées)
- OpenRouter en repli (`tencent/hy3:free`, timeout 45s)
- Frontend : timeout augmenté à 100s (agent.js ligne 1569)

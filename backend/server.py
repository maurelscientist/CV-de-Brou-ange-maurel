"""
Backend Python pour Lynda — Assistante IA de Maurel Brou
========================================================
Proxy sécurisé vers Groq (la clé API reste côté serveur,
jamais exposée au navigateur).

Endpoints :
  POST /api/chat         { messages: [...] }                    -> { reply }
  POST /api/search       { q: "requête" }                       -> { results: [...] }
  POST /api/image        { prompt, width, height }               -> { image: dataURL }
  POST /api/vision       { image: base64, mimeType, name }      -> { description }
  POST /api/transcribe   FormData(file)                          -> { text }
  GET  /api/health                                                -> { status: "ok" }

Configuration (variables d'environnement) :
  GROQ_KEY         (obligatoire)   — clé API Groq, jamais de valeur par défaut
  ALLOWED_ORIGIN    (optionnel)     — origine autorisée en CORS (ex: https://maurelbrou.com)
  PORT              (optionnel)     — port d'écoute, 5000 par défaut

Lancement :
  export GROQ_KEY="ta_cle_groq"
  export ALLOWED_ORIGIN="https://ton-domaine.com"   # en prod
  python backend/server.py
  → écoute sur http://127.0.0.1:5000

Dépendances supplémentaires par rapport à la version précédente :
  pip install flask-limiter
"""
import os
import base64
import logging
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

try:
    from ddgs import DDGS
except ImportError:
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        DDGS = None

# ── Chargement des variables d'environnement (.env) ────────────
# La clé GROQ_KEY est stockée dans backend/.env (jamais dans le code
# source, jamais exposée au navigateur). Si python-dotenv est présent,
# on charge le fichier ; sinon on se contente des variables système.
try:
    from dotenv import load_dotenv
    # Charge backend/.env (ou .env à la racine) sans écraser l'existant.
    _here = os.path.dirname(os.path.abspath(__file__))
    for _cand in (os.path.join(_here, ".env"), os.path.join(_here, "..", ".env")):
        if os.path.exists(_cand):
            load_dotenv(_cand)
            break
except ImportError:
    pass  # python-dotenv optionnel : on utilise les variables système

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("lynda")

app = Flask(__name__)

# ── Sécurité de base ────────────────────────────────────────────
# 1) Taille de requête plafonnée globalement (protège /api/vision et
#    /api/chat contre des payloads énormes envoyés volontairement ou par
#    erreur : historique gigantesque, image trop lourde, etc.).
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 Mo

# 2) CORS restreint à l'origine du portfolio en production. En dev, on
#    autorise tout (pratique en local / file://), mais définis
#    ALLOWED_ORIGIN dès que le backend est exposé publiquement.
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
CORS(app, resources={r"/api/*": {"origins": ALLOWED_ORIGIN}})

# 3) Limite de débit par IP — évite qu'un visiteur (ou un bot) épuise ton
#    quota Groq en spammant l'endpoint, même sans connaître ta clé.
limiter = Limiter(get_remote_address, app=app, default_limits=["60 per hour"])

# ── Configuration ──────────────────────────────────────────────
# Aucune valeur par défaut : si GROQ_KEY n'est pas définie, le backend
# démarre quand même (pour /api/search, qui n'en a pas besoin) mais tous
# les endpoints IA renvoient explicitement une erreur 503 plutôt que de
# se rabattre sur une clé codée en dur.
GROQ_KEY = os.environ.get("GROQ_KEY", "")
if not GROQ_KEY:
    log.warning("GROQ_KEY n'est pas définie — /api/chat, /api/vision et /api/transcribe seront indisponibles.")

# Clé Gemini (Google AI Studio) — utilisée UNIQUEMENT pour la génération
# d'images (/api/image), qui renvoie des visuels plus nets et plus
# esthétiques que Pollinations. Si absente, on retombe sur Pollinations.
GEMINI_KEY = os.environ.get("GEMINI_KEY", "")
GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_IMAGE_MODEL + ":generateContent"

# Hugging Face (100% gratuit avec un token) — modèles FLUX.1 ou SDXL via
# l'API Inference. Utilisé en repli après Gemini, avant Pollinations.
HF_KEY = os.environ.get("HF_KEY", "")
HF_MODEL = os.environ.get("HF_MODEL", "black-forest-labs/FLUX.1-dev")
HF_URL = "https://api-inference.huggingface.co/models/" + HF_MODEL

# Replicate (crédits offerts à l'inscription, modèle FLUX.1 gratuit au
# début). Accessible depuis le réseau de l'utilisateur (contrairement à HF).
REPLICATE_KEY = os.environ.get("REPLICATE_KEY", "")
REPLICATE_MODEL = os.environ.get("REPLICATE_MODEL", "black-forest-labs/flux-schnell")
REPLICATE_URL = "https://api.replicate.com/v1/models/" + REPLICATE_MODEL.split("/")[0] + "/" + REPLICATE_MODEL.split("/")[1] + "/predictions"

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# Modèles à jour (juillet 2026). Groq déprécie régulièrement ses modèles :
# llama-3.3-70b-versatile, llama-3.1-8b-instant et les llama-3.2-*-vision
# sont en cours de retrait. Vérifie la liste actuelle avant de déployer :
# https://console.groq.com/docs/models — et le suivi des dépréciations :
# https://console.groq.com/docs/deprecations
GROQ_MODEL = "openai/gpt-oss-120b"
GROQ_MODEL_FALLBACK = "openai/gpt-oss-20b"
# Modèle multimodal (vision) — Groq fait tourner son offre vision très
# souvent ; celui-ci est en preview, donc pas garanti en production.
# Si /api/vision échoue systématiquement, vérifie la doc vision Groq et
# mets à jour cette constante.
VISION_MODEL = "qwen/qwen3.6-27b"

TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
TRANSCRIBE_MODEL = "whisper-large-v3-turbo"

IMAGE_URL = "https://image.pollinations.ai/prompt/{prompt}"
ALLOWED_IMAGE_MODELS = {"flux", "turbo", "dreamshaper"}

# Limites d'entrée simples, pour éviter les abus et les coûts inutiles.
MAX_MESSAGES = 40
MAX_MESSAGE_CHARS = 8000
MAX_PROMPT_CHARS = 800


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "groq_configured": bool(GROQ_KEY)})


def _clean_messages(raw_messages):
    """Valide et nettoie la liste de messages envoyée par le front.
    Ne fait JAMAIS confiance à un champ 'model' ou autre venant du
    client : seuls role/content sont conservés."""
    if not isinstance(raw_messages, list) or not raw_messages:
        return None
    if len(raw_messages) > MAX_MESSAGES:
        raw_messages = raw_messages[-MAX_MESSAGES:]
    clean = []
    for m in raw_messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")
        if role in ("user", "system", "assistant") and isinstance(content, str) and content.strip():
            clean.append({"role": role, "content": content[:MAX_MESSAGE_CHARS]})
    return clean or None


@app.route("/api/chat", methods=["POST"])
@limiter.limit("20 per minute")
def chat():
    """Fournisseur : Groq. Le modèle n'est JAMAIS choisi par le client,
    pour garder le contrôle des coûts et de la sécurité."""
    if not GROQ_KEY:
        return jsonify({"error": "GROQ_KEY non configurée côté serveur"}), 503

    data = request.get_json(force=True, silent=True) or {}
    messages = _clean_messages(data.get("messages"))
    if not messages:
        return jsonify({"error": "messages requis"}), 400

    last_err = None
    for model in (GROQ_MODEL, GROQ_MODEL_FALLBACK):
        try:
            resp = requests.post(
                GROQ_URL,
                headers={
                    "Authorization": f"Bearer {GROQ_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "temperature": 1.0,
                    "max_tokens": 2048,
                    "messages": messages,
                },
                timeout=40,
            )
            if not resp.ok:
                last_err = f"Groq {resp.status_code}: {resp.text[:500]}"
                log.warning("Groq error %s sur modele %s | body=%s", resp.status_code, model, resp.text[:500])
                continue
            reply = resp.json()["choices"][0]["message"]["content"].strip()
            if reply:
                return jsonify({"reply": reply, "model": model})
            last_err = "réponse vide"
        except Exception as e:
            last_err = str(e)
            log.exception("Exception Groq")
            continue
    return jsonify({"error": last_err or "LLM indisponible"}), 502


@app.route("/api/search", methods=["POST"])
@limiter.limit("30 per minute")
def web_search():
    """Recherche web gratuite (DuckDuckGo / ddgs)."""
    if DDGS is None:
        return jsonify({"error": "module de recherche non disponible"}), 503
    data = request.get_json(force=True, silent=True) or {}
    q = (data.get("q") or "").strip()[:300]
    if not q:
        return jsonify({"error": "q requis"}), 400
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(q, max_results=5))
        out = [
            {
                "title": r.get("title", ""),
                "href": r.get("href", ""),
                "body": r.get("body", ""),
            }
            for r in results
        ]
        return jsonify({"results": out})
    except Exception as e:
        log.exception("Exception recherche web")
        return jsonify({"error": str(e)}), 502


@app.route("/api/image-search", methods=["POST"])
@limiter.limit("20 per minute")
def image_search():
    """Recherche d'IMAGES RÉELLES (pas générées) via DuckDuckGo Images.
    Utilisé pour illustrer les entités (personnes, groupes, entreprises,
    monuments, pays, animaux, films, etc.)."""
    if DDGS is None:
        return jsonify({"error": "module de recherche non disponible"}), 503
    data = request.get_json(force=True, silent=True) or {}
    q = (data.get("q") or "").strip()[:300]
    if not q:
        return jsonify({"error": "q requis"}), 400
    try:
        with DDGS() as ddgs:
            results = list(ddgs.images(q, max_results=int(data.get("max", 3))))
        out = [
            {
                "title": r.get("title", ""),
                "url": r.get("image", ""),
                "source": r.get("source", ""),
                "thumbnail": r.get("thumbnail", ""),
            }
            for r in results
            if r.get("image")
        ]
        return jsonify({"results": out})
    except Exception as e:
        log.exception("Exception recherche image")
        return jsonify({"error": str(e)}), 502


@app.route("/api/image", methods=["POST"])
@limiter.limit("10 per minute")
def generate_image():
    """Génération d'image.

    Priorité : Gemini (Google AI Studio) si GEMINI_KEY est définie — rendu
    plus net et plus esthétique. Sinon, repli sur Pollinations.ai (gratuit,
    sans clé)."""
    data = request.get_json(force=True, silent=True) or {}
    prompt = (data.get("prompt") or "").strip()[:MAX_PROMPT_CHARS]
    if not prompt:
        return jsonify({"error": "prompt requis"}), 400
    width = max(256, min(int(data.get("width", 768)), 1024))
    height = max(256, min(int(data.get("height", 768)), 1024))

    # 1) Gemini (image nette et jolie)
    if GEMINI_KEY:
        try:
            import random
            # seed aléatoire pour éviter deux générations identiques
            seed = int(data.get("seed", random.randint(1, 2_147_483_647)))
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "responseModalities": ["IMAGE", "TEXT"],
                    "seed": seed,
                },
            }
            resp = requests.post(
                GEMINI_URL,
                params={"key": GEMINI_KEY},
                headers={"Content-Type": "application/json"},
                json=payload,
                timeout=90,
            )
            if resp.ok:
                j = resp.json()
                parts = (j.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
                for part in parts:
                    inline = part.get("inlineData")
                    if inline and inline.get("data"):
                        mime = inline.get("mimeType", "image/png")
                        b64 = inline["data"]
                        return jsonify({
                            "image": f"data:{mime};base64,{b64}",
                            "prompt": prompt,
                            "model": GEMINI_IMAGE_MODEL,
                        })
                log.warning("Gemini: aucune image dans la réponse -> fallback Pollinations")
            else:
                log.warning("Gemini image error %s -> fallback Pollinations | %s", resp.status_code, resp.text[:300])
        except Exception as e:
            log.exception("Exception Gemini image -> fallback Pollinations")

    # 2) Replicate (crédits offerts, FLUX.1) — accessible depuis le réseau
    if REPLICATE_KEY:
        try:
            import random, time
            seed = int(data.get("seed", random.randint(1, 2_147_483_647)))
            headers = {
                "Authorization": f"Token {REPLICATE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "wait",
            }
            payload = {
                "input": {
                    "prompt": prompt,
                    "seed": seed,
                    "num_outputs": 1,
                    "num_inference_steps": 4 if "schnell" in REPLICATE_MODEL else 28,
                    "width": width,
                    "height": height,
                    "output_format": "jpg",
                }
            }
            # "Prefer: wait" fait attendre la réponse directement (jusqu'à
            # 60s). On augmente le timeout côté client pour être large.
            resp = requests.post(REPLICATE_URL, headers=headers, json=payload, timeout=120)
            if resp.ok:
                j = resp.json()
                # Avec Prefer: wait, l'output est directement dans "output"
                out = j.get("output")
                if isinstance(out, list) and out:
                    out = out[0]
                if out and isinstance(out, str):
                    # Replicate renvoie une URL signée ; on la récupère
                    img_resp = requests.get(out, timeout=60)
                    if img_resp.ok:
                        mime = img_resp.headers.get("Content-Type", "image/jpeg")
                        b64 = base64.b64encode(img_resp.content).decode("utf-8")
                        return jsonify({
                            "image": f"data:{mime};base64,{b64}",
                            "prompt": prompt,
                            "model": "replicate/" + REPLICATE_MODEL,
                        })
                log.warning("Replicate: output vide -> fallback Pollinations | %s", str(j)[:200])
            else:
                log.warning("Replicate image error %s -> fallback Pollinations | %s", resp.status_code, resp.text[:200])
        except Exception as e:
            log.exception("Exception Replicate image -> fallback Pollinations")

    # 3) Repli Pollinations.ai (gratuit, sans clé)
    # Note : Hugging Face a été retiré de la chaîne car le domaine
    # api-inference.huggingface.co est bloqué par le réseau/FAI de
    # l'utilisateur (échec de résolution DNS). Le code reste disponible
    # plus bas (constants HF_*) si le réseau évolue.
    model = data.get("model", "flux")
    if model not in ALLOWED_IMAGE_MODELS:
        model = "flux"
    try:
        from urllib.parse import quote
        import random
        # seed aléatoire obligatoire : Pollinations met en cache les images
        # par URL. Sans seed variable, deux prompts identiques renvoient la
        # MÊME image en cache. Un seed aléatoire force une nouvelle génération.
        seed = int(data.get("seed", random.randint(1, 2_147_483_647)))
        p = quote(prompt, safe="")
        url = IMAGE_URL.format(prompt=p) + f"?width={width}&height={height}&model={model}&nologo=true&seed={seed}"
        resp = requests.get(url, timeout=90)
        if not resp.ok:
            return jsonify({"error": f"Image API {resp.status_code}"}), 502
        b64 = base64.b64encode(resp.content).decode("utf-8")
        mime = resp.headers.get("Content-Type", "image/jpeg")
        return jsonify({"image": f"data:{mime};base64,{b64}", "prompt": prompt, "model": model})
    except Exception as e:
        log.exception("Exception génération image")
        return jsonify({"error": str(e)}), 502


@app.route("/api/vision", methods=["POST"])
@limiter.limit("15 per minute")
def vision():
    """Analyse une image (base64) et renvoie une description. Le format
    de réponse ({"description": ...}) doit correspondre exactement à ce
    qu'attend le front (analyzeImage dans lynda.js)."""
    if not GROQ_KEY:
        return jsonify({"error": "GROQ_KEY non configurée côté serveur"}), 503

    data = request.get_json(force=True, silent=True) or {}
    image_b64 = (data.get("image") or "").strip()
    mime_type = (data.get("mimeType") or "image/png").strip()
    name = (data.get("name") or "image")[:120]
    if not image_b64:
        return jsonify({"error": "image (base64) requise"}), 400
    # ~10 Mo max décodés (cohérent avec MAX_CONTENT_LENGTH côté serveur
    # et MAX_FILE_SIZE côté front)
    if len(image_b64) > 14_000_000:
        return jsonify({"error": "image trop volumineuse"}), 413

    data_url = f"data:{mime_type};base64,{image_b64}"
    system = (
        "Tu es Lynda, l'assistante IA de Maurel Brou. "
        "L'utilisateur t'envoie une image. Réponds en français, de façon "
        "utile et structurée. Si l'image contient du texte, fais-en l'OCR. "
        "Si c'est un graphique, analyse-le. Signale les erreurs éventuelles "
        "et propose des améliorations concrètes."
    )
    user_prompt = (
        f"Voici l'image nommée « {name} ». Décris-la, détecte les erreurs "
        "éventuelles, propose des améliorations, et fais l'OCR du texte présent."
    )
    try:
        resp = requests.post(
            GROQ_URL,
            headers={
                "Authorization": f"Bearer {GROQ_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": VISION_MODEL,
                "temperature": 0.7,
                "max_tokens": 800,
                "messages": [
                    {"role": "system", "content": system},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_prompt},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    },
                ],
            },
            timeout=60,
        )
        if not resp.ok:
            log.warning("Vision error %s | %s", resp.status_code, resp.text[:300])
            return jsonify({"error": f"Groq {resp.status_code}: {resp.text[:300]}"}), 502
        reply = resp.json()["choices"][0]["message"]["content"].strip()
        if not reply:
            return jsonify({"error": "réponse vide"}), 502
        # Clé "description" — c'est celle que le front lit.
        return jsonify({"description": reply, "model": VISION_MODEL})
    except Exception as e:
        log.exception("Exception vision")
        return jsonify({"error": str(e)}), 502


@app.route("/api/transcribe", methods=["POST"])
@limiter.limit("15 per minute")
def transcribe():
    if not GROQ_KEY:
        return jsonify({"error": "GROQ_KEY non configurée côté serveur"}), 503
    if "file" not in request.files:
        return jsonify({"error": "fichier audio requis"}), 400
    f = request.files["file"]
    try:
        resp = requests.post(
            TRANSCRIBE_URL,
            headers={"Authorization": f"Bearer {GROQ_KEY}"},
            files={"file": (f.filename or "audio.webm", f.stream, f.mimetype or "audio/webm")},
            data={"model": TRANSCRIBE_MODEL, "language": "fr"},
            timeout=60,
        )
        if not resp.ok:
            return jsonify({"error": f"Groq {resp.status_code}: {resp.text[:300]}"}), 502
        return jsonify({"text": resp.json().get("text", "").strip()})
    except Exception as e:
        log.exception("Exception transcription")
        return jsonify({"error": str(e)}), 502


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    if not GROQ_KEY:
        print("⚠️  GROQ_KEY n'est pas définie. Définis-la avant de lancer en production :")
        print('    export GROQ_KEY="ta_cle_groq"')
    print(f"[Lynda backend] démarrage sur http://127.0.0.1:{port}")
    # Le serveur de développement Flask (app.run) ne doit pas servir de
    # backend en production. Pour un vrai déploiement, utilise gunicorn :
    #   gunicorn -w 2 -b 0.0.0.0:5000 server:app
    app.run(host="127.0.0.1", port=port, debug=False)
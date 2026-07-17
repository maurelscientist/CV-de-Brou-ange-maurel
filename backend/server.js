/*
 * Backend Node.js pour Lynda — Assistante IA de Maurel Brou
 * =========================================================
 * Équivalent de server.py, écrit en Node.js (aucune dépendance externe
 * requise : utilise le fetch natif de Node 18+ et le module http).
 *
 * Tout appel à un modèle IA passe par ce backend, qui seul détient les
 * clés API (variables d'environnement côté serveur, jamais exposées au
 * navigateur). La clé GROQ_KEY est lue dans backend/.env.
 *
 * Endpoints :
 *   GET  /api/health                         -> { status, groq_configured }
 *   POST /api/chat      { messages: [...] }  -> { reply, model }
 *   POST /api/search    { q }                -> { results: [...] }
 *   POST /api/image     { prompt, w, h }     -> { image: dataURL }
 *   POST /api/image-search { q, max }        -> { results: [...] }
 *   POST /api/vision    { image, mimeType }  -> { description }
 *   POST /api/transcribe (multipart file)    -> { text }
 *
 * Lancement :
 *   node backend/server.js
 *   -> écoute sur http://127.0.0.1:5000
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/* ---------- Lecture du .env (parseur minimal, sans dépendance) ---------- */
function loadEnv() {
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      const txt = fs.readFileSync(cand, 'utf8');
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (m && !process.env[m[1]]) {
          let val = m[2].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          process.env[m[1]] = val;
        }
      }
      break;
    }
  }
}
loadEnv();

/* ---------- Configuration ---------- */
const PORT = parseInt(process.env.PORT || '5000', 10);
// En production (hébergé), on écoute sur 0.0.0.0 pour être joignable
// depuis l'extérieur. En local, 127.0.0.1 suffit.
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const GROQ_KEY = process.env.GROQ_KEY || '';
const GROQ_KEY_2 = process.env.GROQ_KEY_2 || '';
// Liste des clés Groq disponibles, alternées en cas de quota épuisé (429).
const GROQ_KEYS = [GROQ_KEY, GROQ_KEY_2].filter(Boolean);
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_MODEL_FALLBACK = 'llama-3.1-8b-instant';
const VISION_MODEL = 'qwen/qwen3.6-27b';
const TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const TRANSCRIBE_MODEL = 'whisper-large-v3-turbo';
const POLLINATIONS_URL = 'https://image.pollinations.ai/prompt/';

/* ---------- OpenRouter (repli gratuit) ----------
   Utilisé quand Groq est en quota (429). Le modèle tencent/hy3:free
   est gratuit et sans quota journalier strict côté OpenRouter. */
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'tencent/hy3:free';

/* ---------- Getty Images (recherche d'images) ----------
   API Getty Images Connect (https://api.gettyimages.com). Nécessite une
   clé API (GETTY_KEY dans le .env / variable d'environnement). Si la clé
   est absente ou l'API échoue, on repli sur Pexels puis Wikipedia. */
const GETTY_KEY = process.env.GETTY_KEY || '';

if (!GROQ_KEYS.length && !OPENROUTER_KEY) {
  console.warn('⚠️  Aucune clé Groq/OpenRouter définie — /api/chat sera indisponible.');
}

/* ---------- Limite de débit simple (en mémoire, par IP) ---------- */
const rateBuckets = {};
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  const b = (rateBuckets[ip] = rateBuckets[ip] || { count: 0, reset: now + windowMs });
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count++;
  return b.count <= max;
}

/* ---------- Utilitaires ---------- */
function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req, limitBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('payload trop volumineux')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

/* ---------- LLM Trace Viewer : capture des appels IA ----------
   On journalise chaque appel à groqChat dans backend/llm-traces.log
   (format JSON lignes, un objet par ligne) pour analyser la cohérence
   de l'IA : prompt système, messages utilisateur, réponse, modèle,
   durée, et type de requête. Cela permet de vérifier que Lynda reste
   cohérente (pas de contradiction, respect du persona, etc.). */
const TRACE_LOG = path.join(__dirname, 'llm-traces.log');
let traceSeq = 0;
function traceLLM(kind, messages, result, meta) {
  try {
    const entry = {
      seq: ++traceSeq,
      ts: new Date().toISOString(),
      kind: kind || 'chat',
      model: result && result.model || null,
      durationMs: meta && meta.durationMs != null ? meta.durationMs : null,
      messages: Array.isArray(messages) ? messages.map(m => ({
        role: m.role,
        content: String(m.content || '').slice(0, 4000)
      })) : null,
      reply: result && result.reply ? String(result.reply).slice(0, 4000) : null,
      error: meta && meta.error || null,
      note: meta && meta.note || null
    };
    fs.appendFileSync(TRACE_LOG, JSON.stringify(entry) + '\n', 'utf8');
    // Envoi non bloquant au mock Langfuse local (extension VS Code) si activé.
    if (process.env.LANGFUSE_PUSH === '1') {
      try {
        const body = JSON.stringify({ batch: [{ type: 'trace', body: entry }] });
        const req = http.request({
          host: '127.0.0.1',
          port: process.env.LANGFUSE_MOCK_PORT || 3000,
          path: '/api/public/ingestion',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, () => {});
        req.on('error', () => {});
        req.write(body);
        req.end();
      } catch (e) { /* non bloquant */ }
    }
  } catch (e) { /* log non bloquant */ }
}

/* ---------- System prompt backend (persona officiel de Lynda) ----------
   Garantit que le modèle connaît toujours le vrai persona de Maurel Brou,
   même si le frontend n'envoie pas le prompt système complet. On injecte
   ce bloc EN PREMIER dans la liste des messages pour ancrer le contexte. */
const BACKEND_SYSTEM_PROMPT = `Tu es Lynda, l'assistante IA du portfolio de Maurel Brou.

IDENTITÉ DE MAUREL BROU (fais attention, ne jamais inventer d'autre métier) :
- Nom complet : Brou Amoikon Richard Ange-Maurel (surnom : Ange-Maurel)
- Rôle : Étudiant en MIAGE (Master en Ingénierie et Management des Systèmes d'Information), développeur web & mobile, passionné de Business Intelligence (BI) et de révolutions numériques.
- IL N'EST PAS auteur de bande dessinée, ni scénariste, ni dessinateur. Si on lui demande "Qui est Maurel Brou ?", tu réponds qu'il est développeur web & mobile / étudiant MIAGE / spécialiste BI.
- Ses projets réels (à citer si on parle de "ses projets") :
  1. Previsi-Q — plateforme de prévision/analytics
  2. UPB Connect — application de connexion universitaire
  3. Virtual Car Controller — contrôleur de voiture virtuelle / IoT
  4. Orange Success — projet/plateforme
  5. Ornifly — projet/drone ou application
- Contact : email disponible dans le portfolio.

RÈGLES DE COHÉRENCE :
- Reste strictement fidèle à ces faits. Si tu ne connais pas un détail, dis-le honnêtement plutôt que d'inventer.
- Quand l'utilisateur dit "ses projets", "son portfolio", "ses réalisations", réfère-toi à la liste ci-dessus.
- Réponds en français, de façon naturelle et utile.`;

/* ---------- Groq chat ---------- */
async function groqChat(messages, traceKind) {
  let lastErr = null;
  const t0 = Date.now();
  // Injection du prompt système backend (persona officiel) en premier,
  // sauf si le frontend a déjà fourni un message système complet.
  const hasSystem = Array.isArray(messages) && messages.some(m => m.role === 'system' && /lynda|maurel|assistan/i.test(m.content || ''));
  const finalMessages = hasSystem ? messages : [{ role: 'system', content: BACKEND_SYSTEM_PROMPT }, ...(messages || [])];

  // ---- 1) Groq en PRIORITÉ (llama-3.3-70b puis llama-3.1-8b, clés alternées) ----
  const models = [GROQ_MODEL, GROQ_MODEL_FALLBACK];
  const keys = GROQ_KEYS;
  let finalResult = null;

  for (const apiKey of keys) {
    for (const model of models) {
      // Une seule tentative par (clé, modèle) + 1 retry rapide en cas de
      // 429/5xx, pour rester sous le timeout du frontend (~45s).
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              temperature: 0.8,
              max_tokens: 1024,
              messages: finalMessages,
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!resp.ok) {
            lastErr = `Groq ${resp.status}: ${(await resp.text()).slice(0, 500)}`;
            // 429 (rate limit) ou 5xx : on attend un court instant et on retry.
            if ((resp.status === 429 || resp.status >= 500) && attempt < 1) {
              await new Promise(r => setTimeout(r, 1500));
              continue;
            }
            break; // passe au modèle suivant (ou à la clé suivante si 429)
          }
          const data = await resp.json();
          const reply = data.choices?.[0]?.message?.content?.trim();
          if (reply) { finalResult = { reply, model }; break; }
          lastErr = 'réponse vide';
          break;
        } catch (e) {
          lastErr = String(e && e.message || e);
          // Timeout ou erreur réseau : 1 retry rapide.
          if (attempt < 1) {
            await new Promise(r => setTimeout(r, 1200));
            continue;
          }
          break;
        }
      }
      if (finalResult) break;
      // Si on a eu un 429 avec cette clé, on bascule immédiatement sur la clé suivante.
      if (lastErr && lastErr.includes('429')) break;
    }
    if (finalResult) break;
    // Si on a eu un 429 avec cette clé, on bascule sur la clé suivante.
    if (lastErr && lastErr.includes('429')) continue;
    // Si on a un résultat (reply non vide) ou une autre erreur non-429, on s'arrête.
    break;
  }
  // Trace (même en cas d'erreur, pour analyser les échecs).
  traceLLM(traceKind || 'chat', messages, finalResult, {
    durationMs: Date.now() - t0,
    error: finalResult ? null : (lastErr || 'réponse vide')
  });
  if (finalResult) return finalResult;

  // REPLI OpenRouter (modèle gratuit tencent/hy3:free) si Groq est en
  // quota (429) ou indisponible. OpenRouter a son propre quota, indépendant
  // de l'organisation Groq, donc ça débloque quand Groq est saturé.
  // On ne bascule sur OpenRouter QUE si la clé est présente et valide
  // (pas de 401). Sinon on reste sur Groq (retry ci-dessous).
  if (OPENROUTER_KEY) {
    try {
      const orResp = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://127.0.0.1:5000',
          'X-Title': 'Lynda Portfolio'
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          temperature: 0.8,
          max_tokens: 1024,
          messages: finalMessages,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (orResp.ok) {
        const orData = await orResp.json();
        const orReply = orData.choices?.[0]?.message?.content?.trim();
        if (orReply) {
          traceLLM((traceKind || 'chat') + ':openrouter', messages, { reply: orReply, model: OPENROUTER_MODEL }, {
            durationMs: Date.now() - t0,
            error: null
          });
          return { reply: orReply, model: OPENROUTER_MODEL };
        }
      } else {
        const orBody = (await orResp.text()).slice(0, 300);
        // Si la clé OpenRouter est invalide (401), on ne bascule PAS dessus
        // et on garde Groq comme priorité (retry plus bas).
        if (orResp.status === 401) {
          lastErr = `OpenRouter clé invalide (401) — on reste sur Groq`;
        } else {
          lastErr = `OpenRouter ${orResp.status}: ${orBody}`;
        }
      }
    } catch (e) {
      lastErr = `OpenRouter err: ${String(e && e.message || e)}`;
    }
  }

  // REPLI FINAL : si Groq était en 429 (quota) et qu'OpenRouter a aussi
  // échoué (clé invalide, 401, surcharge…), on retente Groq une dernière
  // fois. Le quota Groq peut s'être libéré entre-temps, et c'est notre
  // fournisseur principal fiable. On évite ainsi le message « cerveau IA
  // indisponible » alors que Groq aurait pu répondre.
  try {
    const retry = await groqRequestWithKey(
      {
        model: GROQ_MODEL,
        temperature: 0.8,
        max_tokens: 1024,
        messages: finalMessages,
      },
      30000
    );
    if (retry && retry.resp && retry.resp.ok) {
      const rd = await retry.resp.json();
      const rr = rd.choices?.[0]?.message?.content?.trim();
      if (rr) {
        traceLLM((traceKind || 'chat') + ':groq-retry', messages, { reply: rr, model: GROQ_MODEL }, {
          durationMs: Date.now() - t0,
          error: null
        });
        return { reply: rr, model: GROQ_MODEL };
      }
    }
  } catch (e) {
    // on garde lastErr précédent
  }

  throw new Error(lastErr || 'LLM indisponible');
}

// Helper : effectue un appel Groq en alternant les clés disponibles.
// En cas de 429 (quota épuisé) sur une clé, bascule automatiquement sur la
// clé suivante. Retourne { resp, apiKey } ou lève une erreur.
async function groqRequestWithKey(body, timeoutMs, extraHeaders = {}) {
  const keys = GROQ_KEYS.length ? GROQ_KEYS : [GROQ_KEY];
  let lastErr = null;
  for (const apiKey of keys) {
    try {
      const resp = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) return { resp, apiKey };
      lastErr = `Groq ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
      // 429 (quota) : on bascule sur la clé suivante
      if (resp.status === 429) continue;
      // Autre erreur : on la renvoie telle quelle (pas de bascule)
      throw new Error(lastErr);
    } catch (e) {
      if (e.message && e.message.startsWith('Groq ')) throw e;
      lastErr = String(e && e.message || e);
      // Erreur réseau/timeout : on bascule sur la clé suivante
      continue;
    }
  }
  throw new Error(lastErr || 'LLM indisponible');
}

/* ---------- DuckDuckGo search (best-effort, sans clé) ---------- */
async function ddgSearch(q) {
  try {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null && results.length < 5) {
      const href = decodeURIComponent((m[1].replace(/^.*?uddg=/, '').split('&')[0]) || m[1]);
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      const body = m[3].replace(/<[^>]+>/g, '').trim();
      if (title) results.push({ title, href, body });
    }
    return results;
  } catch (e) {
    return [];
  }
}

/*
 * Recherche d'IMAGES RÉELLES via l'API Pexels (https://www.pexels.com/api/).
 * Pexels renvoie des photos réelles, libres de droits et variées pour
 * quasiment n'importe quelle requête (lieu, personne, objet, concept…).
 * Nécessite une clé API gratuite (PEXELS_KEY dans le .env). Si la clé est
 * absente ou l'API échoue, on repli sur Wikipedia / Wikimedia Commons.
 */
async function pexelsImageSearch(q, max = 6) {
  const key = process.env.PEXELS_KEY;
  if (!key) return [];
  try {
    const url = 'https://api.pexels.com/v1/search?query=' + encodeURIComponent(q) +
      '&per_page=' + Math.min(max, 30) + '&locale=fr-FR';
    const resp = await fetch(url, {
      headers: { 'Authorization': key },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const photos = (data.photos || []).slice(0, max);
    return photos.map(p => ({
      title: (p.alt || q),
      url: p.src && (p.src.large || p.src.large2x || p.src.original),
      source: 'pexels',
      thumbnail: p.src && (p.src.medium || p.src.small)
    })).filter(im => im.url && /^https?:\/\//.test(im.url));
  } catch (e) {
    return [];
  }
}

/*
 * Recherche d'IMAGES RÉELLES via l'API officielle Unsplash
 * (https://unsplash.com/developers). Nécessite une clé "Access Key"
 * (UNSPLASH_KEY dans le .env). Renvoie des photos réelles, libres de
 * droits, variées pour quasiment n'importe quelle requête.
 * Si la clé est absente ou l'API échoue, on repli sur Pexels puis Wikipedia.
 */
async function unsplashImageSearch(q, max = 6) {
  const key = process.env.UNSPLASH_KEY;
  if (!key) return [];
  try {
    const url = 'https://api.unsplash.com/search/photos?query=' + encodeURIComponent(q) +
      '&per_page=' + Math.min(max, 30) + '&content_filter=high&locale=fr';
    const resp = await fetch(url, {
      headers: {
        'Authorization': 'Client-ID ' + key,
        'Accept-Version': 'v1'
      },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const results = (data.results || []).slice(0, max);
    return results.map(r => ({
      title: (r.alt_description || r.description || q),
      url: r.urls && (r.urls.regular || r.urls.full || r.urls.raw),
      source: 'unsplash',
      thumbnail: r.urls && (r.urls.small || r.urls.thumb)
    })).filter(im => im.url && /^https?:\/\//.test(im.url));
  } catch (e) {
    return [];
  }
}

/* ---------- Repli Wikipedia / Wikimedia Commons ---------- */
async function wikipediaImageSearch(q, max = 6, type = null) {
  try {
    const UA = 'LyndaPortfolio/1.0 (https://example.com; contact@example.com)';
    const STOP = /\b(portrait|photo|image|picture|ville|city|paysage|landscape|photo de|vue de|tableau|dessin|illustration|photo)\b/gi;
    let clean = q.replace(STOP, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) clean = q.trim();

    // Pour les PERSONNES / ENTREPRISES / CÉLÉBRITÉS (type === 'person'), un
    // mot court comme "Orange" ou "Apple" résout par défaut vers l'article
    // le plus générique (le fruit, la pomme…) au lieu de l'entreprise. On
    // teste donc plusieurs titres désambiguïsés, du plus spécifique au plus
    // générique, et on garde le premier qui renvoie des images valides.
    const candidates = [clean.replace(/\s+/g, '_')];
    if (type === 'person') {
      candidates.unshift(
        clean + ' (company)',
        clean + ' (telecommunications company)',
        clean + ' (corporation)',
        clean + ' S.A.',
        clean + ' (business)'
      );
    }
    // Dé-duplication en gardant l'ordre.
    const seen = new Set();
    const uniqueCandidates = candidates.filter(c => {
      const k = c.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Tente de résoudre un titre Wikipédia valide pour un candidat donné
    // (via la recherche "list=search" qui renvoie le meilleur article).
    const resolveTitle = async (cand) => {
      try {
        const searchUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=search' +
          '&srsearch=' + encodeURIComponent(cand) + '&srlimit=1&format=json';
        const sResp = await fetch(searchUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
        if (sResp.ok) {
          const sd = await sResp.json();
          const hit = sd.query && sd.query.search && sd.query.search[0];
          if (hit && hit.title) return hit.title.replace(/\s+/g, '_');
        }
      } catch (e) { /* on garde le candidat brut */ }
      return cand.replace(/\s+/g, '_');
    };

    // Récupère les images (summary + generator=images) pour un titre résolu.
    const fetchImagesFor = async (resolved) => {
      const out = [];
      try {
        const summaryUrl = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(resolved);
        const sResp = await fetch(summaryUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
        if (sResp.ok) {
          const s = await sResp.json();
          const orig = s.originalimage && s.originalimage.source;
          const thumb = s.thumbnail && s.thumbnail.source;
          const img = orig || thumb;
          // On accepte les SVG (logos d'entreprise, blasons…) car ce sont des
          // visuels valides pour les entités. Seuls les SVG purement
          // décoratifs sans intérêt (icônes Wikimedia) sont filtrés plus bas.
          // NB : on ne filtre PAS sur "wikimedia" seul car cela matcherat le
          // domaine upload.wikimedia.org et exclurait TOUTES les images.
          if (img && /^https:\/\/upload\.wikimedia\.org\//.test(img) && !/Commons-logo\.svg|Wikipedia-logo|Wikimedia-logo/i.test(img)) {
            out.push({ title: s.title || q, url: img, source: 'wikipedia', thumbnail: thumb || img });
          }
        }
      } catch (e) { /* on continue */ }
      if (out.length < max) {
        try {
          const apiUrl = 'https://en.wikipedia.org/w/api.php?action=query&generator=images' +
            '&titles=' + encodeURIComponent(resolved) +
            '&prop=imageinfo&iiprop=url|extmetadata&gimlimit=' + max +
            '&format=json&iiurlwidth=600';
          const aResp = await fetch(apiUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
          if (aResp.ok) {
            const a = await aResp.json();
            const pages = (a.query && a.query.pages) || {};
            for (const id of Object.keys(pages)) {
              if (out.length >= max) break;
              const p = pages[id];
              const ii = p.imageinfo && p.imageinfo[0];
              if (!ii) continue;
              const url = ii.url;
              if (!/^https:\/\/upload\.wikimedia\.org\//.test(url)) continue;
              // On exclut les icônes décoratives Wikimedia (logo Commons,
              // flèches, drapeaux génériques) mais on GARDE les logos
              // d'entreprise / blasons qui sont des SVG valides. On ne
              // filtre PAS "wikimedia" seul (domain upload.wikimedia.org).
              if (/Commons-logo\.svg|Wikipedia-logo|Wikimedia-logo|Decrease|Increase|Flag_of_/i.test(url)) continue;
              const title = (ii.extmetadata && ii.extmetadata.ObjectName && ii.extmetadata.ObjectName.value) || p.title || q;
              const thumbUrl = ii.thumburl || url;
              if (out.some(o => o.url === url)) continue;
              out.push({ title, url, source: 'wikipedia', thumbnail: thumbUrl });
            }
          }
        } catch (e) { /* on continue */ }
      }
      return out.slice(0, max);
    };

    // On parcourt les candidats et on s'arrête au premier qui donne des
    // images (sinon on continue avec le candidat suivant, plus générique).
    for (const cand of uniqueCandidates) {
      const resolved = await resolveTitle(cand);
      const imgs = await fetchImagesFor(resolved);
      if (imgs && imgs.length) return imgs;
    }
    return [];
  } catch (e) {
    return [];
  }
}

/* ---------- Getty Images (recherche d'images réelles) ---------- */
async function gettyImageSearch(q, max = 6) {
  const key = GETTY_KEY;
  if (!key) return [];
  try {
    // API Getty Images Connect — endpoint de recherche (ancienne API REST).
    const url = 'https://api.gettyimages.com/v3/search/images' +
      '?phrase=' + encodeURIComponent(q) +
      '&page_size=' + Math.min(max, 30) +
      '&sort_order=most_popular' +
      '&fields=id,title,display_set,comp' +
      '&language=fr';
    const resp = await fetch(url, {
      headers: {
        'Api-Key': key,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const images = (data.images || []).slice(0, max);
    const out = [];
    for (const im of images) {
      // On privilégie la vignette "display_set" la plus grande disponible.
      let url = null;
      const ds = im.display_set;
      if (ds && Array.isArray(ds)) {
        // display_set est un tableau de "sets" ; on prend le premier uri valide.
        for (const set of ds) {
          const u = set && (set.uri || (set.members && set.members[0] && set.members[0].uri));
          if (u) { url = u; break; }
        }
      }
      if (!url && ds && !Array.isArray(ds) && ds.uri) url = ds.uri;
      if (!url && im.comp && im.comp.uri) url = im.comp.uri;
      if (!url) continue;
      if (!/^https?:\/\//.test(url)) continue;
      out.push({
        title: im.title || q,
        url: url,
        source: 'getty',
        thumbnail: (ds && !Array.isArray(ds) && ds.uri) || url
      });
    }
    return out.slice(0, max);
  } catch (e) {
    return [];
  }
}

/* ---------- Pollinations image (sans clé) ---------- */
async function pollinationsImage(prompt, width, height) {
  const p = encodeURIComponent(prompt || 'image');
  const seed = Math.floor(Math.random() * 2147483647);
  const url = POLLINATIONS_URL + p + `?width=${width}&height=${height}&model=flux&nologo=true&seed=${seed}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!resp.ok) throw new Error('Image API ' + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  const mime = resp.headers.get('content-type') || 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/* ---------- Parsing multipart (pour /api/transcribe) ---------- */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const parts = [];
  let start = buf.indexOf(Buffer.from(boundary));
  if (start === -1) return null;
  while (start !== -1) {
    const end = buf.indexOf(Buffer.from(boundary), start + boundary.length);
    if (end === -1) break;
    const part = buf.slice(start + boundary.length + 2, end - 2);
    if (part.length && part[0] !== 0x2d /* '-' */) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headerStr = part.slice(0, headerEnd).toString('utf8');
        const body = part.slice(headerEnd + 4);
        const nameM = /name="([^"]+)"/i.exec(headerStr);
        const fileM = /filename="([^"]+)"/i.exec(headerStr);
        const ctM = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr);
        parts.push({
          name: nameM ? nameM[1] : null,
          filename: fileM ? fileM[1] : null,
          contentType: ctM ? ctM[1].trim() : null,
          data: body,
        });
      }
    }
    start = end;
  }
  return parts;
}

/* ---------- Route handler ---------- */
const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    res.end();
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = u.pathname;

  try {
    /* ---- Health ---- */
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { status: 'ok', groq_configured: Boolean(GROQ_KEY) });
    }

    /* ---- Diagnostic (teste Groq et OpenRouter séparément) ---- */
    if (req.method === 'GET' && pathname === '/api/diag') {
      const diag = { groq: null, openrouter: null, groqKeys: GROQ_KEYS.length, openrouterSet: Boolean(OPENROUTER_KEY) };
      // Test Groq
      try {
        const gResp = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(15000),
        });
        diag.groq = { status: gResp.status, ok: gResp.ok };
        if (!gResp.ok) diag.groq.body = (await gResp.text()).slice(0, 300);
      } catch (e) {
        diag.groq = { error: String(e && e.message || e) };
      }
      // Test OpenRouter (seulement si clé présente)
      if (OPENROUTER_KEY) {
        try {
          const oResp = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://127.0.0.1:5000', 'X-Title': 'Lynda Portfolio' },
            body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: 'ping' }] }),
            signal: AbortSignal.timeout(15000),
          });
          diag.openrouter = { status: oResp.status, ok: oResp.ok };
          if (!oResp.ok) diag.openrouter.body = (await oResp.text()).slice(0, 300);
        } catch (e) {
          diag.openrouter = { error: String(e && e.message || e) };
        }
      }
      return sendJson(res, 200, diag);
    }

    /* ---- Chat ---- */
    if (req.method === 'POST' && pathname === '/api/chat') {
      if (!rateLimit(ip, 20, 60000)) return sendJson(res, 429, { error: 'trop de requêtes' });
      if (!GROQ_KEYS.length && !OPENROUTER_KEY) return sendJson(res, 503, { error: 'GROQ_KEY non configurée côté serveur' });
      const data = await readJson(req);
      let messages = data.messages;
      if (!Array.isArray(messages) || !messages.length) return sendJson(res, 400, { error: 'messages requis' });
      messages = messages.slice(-40).map(m => ({
        role: m.role,
        content: String(m.content || '').slice(0, 8000),
      })).filter(m => ['user', 'system', 'assistant'].includes(m.role) && m.content.trim());
      if (!messages.length) return sendJson(res, 400, { error: 'messages requis' });

      // Salutations courtes pures ("cc", "coucou", "yo", "wesh"…) : le
      // modèle a tendance à interpréter "cc" comme "carbon copy". On force
      // une réponse de salutation via un message système court et prioritaire.
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const GREETING_ONLY = /^(cc|c coucou|c'coucou|coucou|salut|slt|bjr|bsr|bonjour|bonsoir|hey|hello|hi|yo|wesh|salam|hola|yo yo|cc cc|coucou coucou)\b.*$/i;
      if (lastUser && GREETING_ONLY.test(lastUser.content.trim())) {
        const greetingMessages = [
          { role: 'system', content: "L'utilisateur te salue simplement (ex. \"cc\", \"coucou\", \"salut\", \"yo\"). Réponds UNIQUEMENT par une salutation courte et chaleureuse en français, suivie d'une question ouverte pour lancer la conversation (ex. \"Coucou ! Comment puis-je t'aider aujourd'hui ?\"). Ne cherche jamais à interpréter le mot comme un acronyme ou un terme technique. Reste bref." },
          { role: 'user', content: lastUser.content }
        ];
        try {
          const { reply, model } = await groqChat(greetingMessages, 'greeting');
          return sendJson(res, 200, { reply, model });
        } catch (e) {
          return sendJson(res, 502, { error: String(e.message || e) });
        }
      }

      try {
        const { reply, model } = await groqChat(messages, 'chat');
        return sendJson(res, 200, { reply, model });
      } catch (e) {
        return sendJson(res, 502, { error: String(e.message || e) });
      }
    }

    /* ---- Search ---- */
    if (req.method === 'POST' && pathname === '/api/search') {
      if (!rateLimit(ip, 30, 60000)) return sendJson(res, 429, { error: 'trop de requêtes' });
      const data = await readJson(req);
      const q = String(data.q || '').slice(0, 300).trim();
      if (!q) return sendJson(res, 400, { error: 'q requis' });
      const results = await ddgSearch(q);
      return sendJson(res, 200, { results });
    }

    /* ---- Image search ---- */
    if (req.method === 'POST' && pathname === '/api/image-search') {
      if (!rateLimit(ip, 20, 60000)) return sendJson(res, 429, { error: 'trop de requêtes' });
      const data = await readJson(req);
      const q = String(data.q || '').slice(0, 300).trim();
      const max = Math.min(parseInt(data.max || 3, 10) || 3, 8);
      // Choix de la source d'images selon le type d'entité :
      //  - Personnes, célébrités, entreprises (type === 'person') :
      //    WIKIPEDIA en priorité (portraits officiels, logos d'entreprise,
      //    photos libres de droits), repli sur Pexels si Wikipedia échoue.
      //  - Autres sujets (lieux, animaux, objets, concepts…) :
      //    PEXELS en priorité (photos réelles variées), repli sur Wikipedia.
      const isPerson = String(data.type || '').toLowerCase() === 'person';
      if (!q) return sendJson(res, 400, { error: 'q requis' });
      let finalResults;
      let source;
      if (isPerson) {
        const wiki = await wikipediaImageSearch(q, max, 'person');
        if (wiki && wiki.length) {
          finalResults = wiki;
          source = 'wikipedia';
        } else {
          finalResults = await pexelsImageSearch(q, max);
          source = 'pexels';
        }
      } else {
        const pexels = await pexelsImageSearch(q, max);
        if (pexels && pexels.length) {
          finalResults = pexels;
          source = 'pexels';
        } else {
          finalResults = await wikipediaImageSearch(q, max, null);
          source = 'wikipedia';
        }
      }
      return sendJson(res, 200, { results: finalResults, source });
    }

    /* ---- Image generation ---- */
    if (req.method === 'POST' && pathname === '/api/image') {
      if (!rateLimit(ip, 10, 60000)) return sendJson(res, 429, { error: 'trop de requêtes' });
      const data = await readJson(req);
      const prompt = String(data.prompt || '').slice(0, 800).trim();
      if (!prompt) return sendJson(res, 400, { error: 'prompt requis' });
      const width = Math.max(256, Math.min(parseInt(data.width || 768, 10) || 768, 1024));
      const height = Math.max(256, Math.min(parseInt(data.height || 768, 10) || 768, 1024));
      try {
        const image = await pollinationsImage(prompt, width, height);
        return sendJson(res, 200, { image, prompt, model: 'flux' });
      } catch (e) {
        return sendJson(res, 502, { error: String(e.message || e) });
      }
    }

    /* ---- Vision ---- */
    if (req.method === 'POST' && pathname === '/api/vision') {
      if (!GROQ_KEYS.length) return sendJson(res, 503, { error: 'GROQ_KEY non configurée côté serveur' });
      const data = await readJson(req);
      const imageB64 = String(data.image || '').trim();
      const mimeType = String(data.mimeType || 'image/png').trim();
      if (!imageB64) return sendJson(res, 400, { error: 'image (base64) requise' });
      const dataUrl = `data:${mimeType};base64,${imageB64}`;
      const system = 'Tu es Lynda, l\'assistante IA de Maurel Brou. Décris l\'image, détecte les erreurs, propose des améliorations et fais l\'OCR du texte présent. Réponds en français.';
      try {
        const { resp } = await groqRequestWithKey({
          model: VISION_MODEL,
          temperature: 0.7,
          max_tokens: 800,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: [
              { type: 'text', text: 'Décris cette image.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ] },
          ],
        }, 60000);
        const j = await resp.json();
        const description = j.choices?.[0]?.message?.content?.trim();
        if (!description) return sendJson(res, 502, { error: 'réponse vide' });
        return sendJson(res, 200, { description, model: VISION_MODEL });
      } catch (e) {
        return sendJson(res, 502, { error: String(e.message || e) });
      }
    }

    /* ---- Transcribe ---- */
    if (req.method === 'POST' && pathname === '/api/transcribe') {
      if (!GROQ_KEYS.length) return sendJson(res, 503, { error: 'GROQ_KEY non configurée côté serveur' });
      const buf = await readBody(req);
      const parts = parseMultipart(buf, req.headers['content-type']);
      const filePart = parts && parts.find(p => p.name === 'file' && p.data.length);
      if (!filePart) return sendJson(res, 400, { error: 'fichier audio requis' });
      try {
        const fd = new FormData();
        fd.append('file', new Blob([filePart.data], { type: filePart.contentType || 'audio/webm' }), filePart.filename || 'audio.webm');
        fd.append('model', TRANSCRIBE_MODEL);
        fd.append('language', 'fr');
        // Alternance des clés Groq sur l'endpoint audio aussi.
        const keys = GROQ_KEYS.length ? GROQ_KEYS : [GROQ_KEY];
        let lastErr = null;
        let resp = null;
        for (const apiKey of keys) {
          try {
            resp = await fetch(TRANSCRIBE_URL, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}` },
              body: fd,
              signal: AbortSignal.timeout(60000),
            });
            if (resp.ok) break;
            lastErr = `Groq ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
            if (resp.status === 429) continue; // bascule clé suivante
            break;
          } catch (e) {
            lastErr = String(e && e.message || e);
            continue;
          }
        }
        if (!resp || !resp.ok) return sendJson(res, 502, { error: lastErr || 'échec transcription' });
        const j = await resp.json();
        return sendJson(res, 200, { text: (j.text || '').trim() });
      } catch (e) {
        return sendJson(res, 502, { error: String(e.message || e) });
      }
    }

    /* ---- 404 ---- */
    sendJson(res, 404, { error: 'endpoint inconnu' });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[Lynda backend] démarrage sur http://${HOST}:${PORT}`);
  if (!GROQ_KEYS.length) {
    console.log('⚠️  GROQ_KEY non définie — renseignez-la dans backend/.env');
  } else {
    console.log(`[Lynda backend] ${GROQ_KEYS.length} clé(s) Groq configurée(s) — alternance activée`);
  }
});

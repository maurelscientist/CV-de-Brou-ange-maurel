/**
 * Mock Langfuse local pour le portfolio Lynda.
 *
 * Sert l'API publique Langfuse consommée par l'extension VS Code
 * "Langfuse Traces" (nicolasmota.langfuse-traces) en relisant le fichier
 * de traces déjà produit par backend/server.js (llm-traces.log).
 *
 * Endpoints exposés (compatibles extension) :
 *   GET /api/public/traces?sessionId=lynda-session
 *   GET /api/public/traces/:traceId
 *   GET /api/public/sessions?limit=&page=1
 *   POST /api/public/ingestion   (accepte les traces poussées par le backend)
 *
 * Aucune dépendance externe. Démarre sur le port 3000 par défaut.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.LANGFUSE_MOCK_PORT ? Number(process.env.LANGFUSE_MOCK_PORT) : 3000;
const TRACE_FILE = path.join(__dirname, 'llm-traces.log');
const SESSION_ID = 'lynda-session';

// Cache simple des traces poussées via ingestion (en plus du fichier).
let ingested = [];

function readFileTraces() {
  try {
    if (!fs.existsSync(TRACE_FILE)) return [];
    const raw = fs.readFileSync(TRACE_FILE, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function toLangfuseTrace(t, idx) {
  const safeTs = (t.ts || `idx-${idx}`).replace(/[:.]/g, '-');
  const id = `trace-${safeTs}-${t.seq != null ? t.seq : idx}`;
  const messages = Array.isArray(t.messages) ? t.messages : [];
  const userMsg = messages.find((m) => m.role === 'user');
  const sysMsg = messages.find((m) => m.role === 'system');
  const input = userMsg ? userMsg.content : (t.note || '');
  const output = t.reply || t.error || '';
  const observation = {
    id: `${id}-gen`,
    type: 'GENERATION',
    name: t.kind || 'chat',
    model: t.model || 'unknown',
    input: sysMsg ? { system: sysMsg.content, user: input } : input,
    output: output,
    metadata: {
      kind: t.kind,
      durationMs: t.durationMs,
      error: t.error || null,
      note: t.note || null,
    },
    modelParameters: { temperature: 0.8, max_tokens: 1024 },
    startTime: t.ts,
    endTime: t.ts,
    usage: t.usage || null,
  };
  return {
    id,
    name: `Lynda · ${t.kind || 'chat'}`,
    sessionId: SESSION_ID,
    userId: 'portfolio-visitor',
    input,
    output,
    metadata: { kind: t.kind, model: t.model, durationMs: t.durationMs },
    observations: [observation],
    timestamp: t.ts,
  };
}

function allTraces() {
  const fileTraces = readFileTraces().map(toLangfuseTrace);
  const ingestedTraces = ingested.map(toLangfuseTrace);
  // Dédoublonnage par id
  const map = new Map();
  for (const tr of [...fileTraces, ...ingestedTraces]) map.set(tr.id, tr);
  return Array.from(map.values()).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // Ingestion (backend -> mock)
  if (req.method === 'POST' && p === '/api/public/ingestion') {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const batch = Array.isArray(parsed) ? parsed : (parsed.batch || []);
        for (const item of batch) {
          if (item && item.body) ingested.push(item.body);
        }
        sendJson(res, 200, { status: 'ok', ingested: batch.length });
      } catch {
        sendJson(res, 400, { status: 'error', message: 'invalid json' });
      }
    });
    return;
  }

  // Liste des traces d'une session
  if (req.method === 'GET' && p === '/api/public/traces') {
    const sessionId = url.searchParams.get('sessionId');
    let traces = allTraces();
    if (sessionId) traces = traces.filter((t) => t.sessionId === sessionId);
    // L'extension ne lit que data[].id puis fetchFullTrace(id)
    sendJson(res, 200, { data: traces.map((t) => ({ id: t.id, name: t.name, sessionId: t.sessionId, timestamp: t.timestamp })), meta: { totalItems: traces.length } });
    return;
  }

  // Trace complète par id
  const m = p.match(/^\/api\/public\/traces\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const id = decodeURIComponent(m[1]);
    const trace = allTraces().find((t) => t.id === id);
    if (trace) sendJson(res, 200, trace);
    else sendJson(res, 404, { status: 'error', message: 'trace not found' });
    return;
  }

  // Sessions récentes
  if (req.method === 'GET' && p === '/api/public/sessions') {
    const limit = Number(url.searchParams.get('limit') || 10);
    sendJson(res, 200, {
      data: [{ id: SESSION_ID, name: 'Lynda Portfolio', userId: 'portfolio-visitor' }],
      meta: { totalItems: 1, limit, page: 1 },
    });
    return;
  }

  sendJson(res, 404, { status: 'error', message: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Langfuse mock] écoute sur http://127.0.0.1:${PORT} (lit ${TRACE_FILE})`);
});

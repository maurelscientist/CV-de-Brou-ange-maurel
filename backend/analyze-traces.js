/*
 * analyze-traces.js — Analyseur de cohérence des traces LLM
 * =========================================================
 * Lit backend/llm-traces.log (JSON lignes) et produit un rapport de
 * cohérence pour l'assistant Lynda :
 *   - Nombre de traces, par type (chat, greeting)
 *   - Vérifie que le persona "Lynda" est respecté (pas de fuite de
 *     prompt système, pas de contradiction évidente)
 *   - Détecte les réponses vides ou les erreurs
 *   - Affiche un échantillon des derniers échanges
 *
 * Usage : node backend/analyze-traces.js [--last N] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TRACE_LOG = path.join(__dirname, 'llm-traces.log');

function loadTraces() {
  if (!fs.existsSync(TRACE_LOG)) return [];
  const lines = fs.readFileSync(TRACE_LOG, 'utf8').split(/\r?\n/).filter(Boolean);
  const traces = [];
  for (const line of lines) {
    try { traces.push(JSON.parse(line)); } catch (e) { /* ignore ligne corrompue */ }
  }
  return traces;
}

function analyze(traces) {
  const report = {
    total: traces.length,
    byKind: {},
    errors: 0,
    emptyReplies: 0,
    personaLeaks: 0,
    knowledgeErrors: 0,
    knowledgeFlags: [],
    samples: []
  };

  // Vérifications de cohérence des connaissances sur Maurel Brou.
  // Le persona officiel : développeur web & mobile, étudiant MIAGE, BI.
  const KNOWLEDGE_RULES = [
    { bad: /auteur de bande dessinée|auteur de bd|scénariste|dessinateur/i, good: 'développeur', msg: 'Maurel décrit comme auteur BD (devrait être développeur)' },
    { bad: /chanteur|musicien|acteur|footballeur/i, good: 'développeur', msg: 'Maurel décrit avec un mauvais métier' },
  ];

  for (const t of traces) {
    report.byKind[t.kind] = (report.byKind[t.kind] || 0) + 1;
    if (t.error) report.errors++;
    if (!t.reply || !t.reply.trim()) report.emptyReplies++;

    // Détection de fuite de prompt système (le LLM répète des instructions)
    const replyLower = (t.reply || '').toLowerCase();
    if (replyLower.includes('system prompt') || replyLower.includes('tu es lynda') || replyLower.includes('instruction:')) {
      report.personaLeaks++;
    }

    // Vérification des connaissances sur Maurel Brou
    for (const rule of KNOWLEDGE_RULES) {
      const reply = t.reply || '';
      if (rule.bad.test(reply)) {
        // Ignore les négations : "n'est pas auteur de bande dessinée" est correct.
        const negated = /(n['’]est pas|n'est plus|jamais|ne (?:suis|sera|fut|fait) pas|pas (?:un|une|du))[^.]{0,40}?/i.test(
          reply.slice(0, reply.search(rule.bad))
        );
        if (negated) continue;
        report.knowledgeErrors++;
        report.knowledgeFlags.push({ ts: t.ts, msg: rule.msg, reply: reply.slice(0, 150) });
        break;
      }
    }
  }

  // Échantillon des 5 derniers échanges (user -> assistant)
  const recent = traces.slice(-5);
  for (const t of recent) {
    const userMsg = (t.messages || []).filter(m => m.role === 'user').pop();
    report.samples.push({
      ts: t.ts,
      kind: t.kind,
      model: t.model,
      user: userMsg ? userMsg.content.slice(0, 120) : null,
      reply: t.reply ? t.reply.slice(0, 200) : (t.error || '(vide)')
    });
  }

  return report;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const lastIdx = args.indexOf('--last');
  const lastN = lastIdx >= 0 ? parseInt(args[lastIdx + 1], 10) : null;

  let traces = loadTraces();
  if (lastN && !isNaN(lastN)) traces = traces.slice(-lastN);

  if (!traces.length) {
    console.log('Aucune trace trouvée. Lancez le backend et conversez avec Lynda.');
    return;
  }

  const report = analyze(traces);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('=== Rapport de cohérence LLM (Lynda) ===');
  console.log(`Total traces      : ${report.total}`);
  console.log(`Par type          : ${JSON.stringify(report.byKind)}`);
  console.log(`Erreurs          : ${report.errors}`);
  console.log(`Réponses vides   : ${report.emptyReplies}`);
  console.log(`Fuite de persona : ${report.personaLeaks}`);
  console.log(`Erreurs connaiss. : ${report.knowledgeErrors}`);
  if (report.knowledgeFlags.length) {
    console.log('\n--- Alertes connaissances ---');
    for (const f of report.knowledgeFlags) {
      console.log(`[${f.ts}] ${f.msg}`);
      console.log(`  -> ${f.reply}`);
    }
  }
  console.log('\n--- Derniers échanges ---');
  for (const s of report.samples) {
    console.log(`[${s.ts}] (${s.kind}/${s.model})`);
    console.log(`  User : ${s.user}`);
    console.log(`  Lynda: ${s.reply}`);
    console.log('');
  }
}

main();

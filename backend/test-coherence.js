/**
 * Test de cohérence de l'IA Lynda.
 * Envoie une batterie de questions ciblant le persona de Maurel Brou
 * et affiche les réponses pour vérification manuelle + journalisation
 * automatique via traceLLM (backend).
 */
const http = require('http');

const questions = [
  "Qui est Maurel Brou ?",
  "Quel est son métier ?",
  "Il est auteur de bande dessinée ?",
  "Parle-moi de ses projets",
  "C'est quoi Previsi-Q ?",
  "Quels sont ses autres projets comme UPB Connect ou Ornifly ?",
  "Est-il étudiant ? Dans quoi ?",
  "Que fait-il en Business Intelligence ?",
];

function chat(msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: msg }] });
    const req = http.request({
      host: '127.0.0.1', port: 5000, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data).reply || '(vide)'); }
        catch { reject(new Error('parse: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const q of questions) {
    try {
      const r = await chat(q);
      console.log(`\n=== Q: ${q} ===`);
      console.log(r.slice(0, 400));
    } catch (e) {
      console.log(`\n=== Q: ${q} === ERREUR: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log('\n--- FIN TEST COHÉRENCE ---');
})();

/* =========================================================
   AGENT IA — MOTEUR RAG (Retrieval-Augmented Generation)
   Indexation du contenu portfolio + recherche sémantique
   par tokens (sans dépendance externe, fonctionne hors ligne).
   ========================================================= */
(function () {
  'use strict';

  const K = window.AGENT_KNOWLEDGE;

  // --- Bâtir un index de "documents" (chunks) à partir des données ---
  const docs = [];
  const add = (texte, source, type, meta) => {
    if (!texte) return;
    docs.push({
      texte: texte.toLowerCase(),
      source,
      type,
      meta: meta || {}
    });
  };

  const p = K.profil;
  add(`${p.nom}. ${p.role} ${p.bio}`, 'Profil', 'profil');
  add(`Présentation : ${p.bio}`, 'Profil', 'profil');
  add(`Biographie : ${p.bio}`, 'Profil', 'profil');
  p.etudes.forEach(e => add(`Études : ${e}`, 'Études', 'etudes'));
  add(`Compétences : ${p.competences.join(', ')}`, 'Compétences', 'competences');
  add(`Technologies : ${p.technologies.join(', ')}`, 'Technologies', 'technologies');
  add(`Certifications : ${p.certifications.join(', ')}`, 'Certifications', 'certifications');
  add(`Disponibilités : ${p.disponibilites}`, 'Disponibilités', 'disponibilites');
  add(`Réseaux sociaux : LinkedIn ${p.reseaux.linkedin}, GitHub ${p.reseaux.github}, Email ${p.reseaux.email}`, 'Réseaux', 'reseaux');
  add(`CV : ${p.nom}, fichier ${K.cv.nomFichier}. ${K.cv.note}`, 'CV', 'cv');

  K.services.forEach(s => {
    add(`Service ${s.titre} : ${s.desc} ${s.details.join(', ')}`, `Service ${s.titre}`, 'service', { titre: s.titre });
  });

  K.projets.forEach(pr => {
    add(`Projet ${pr.nom} (${pr.tag}) : ${pr.desc} Fonctionnalités : ${pr.features.join(', ')}`, `Projet ${pr.nom}`, 'projet', { nom: pr.nom, url: pr.url, site: pr.site });
  });

  K.faq.forEach(f => {
    add(`FAQ ${f.q} Réponse : ${f.r}`, f.q, 'faq', { q: f.q, r: f.r });
  });

  // --- Recherche : score par tokens communs + poids par type ---
  const STOP = new Set(['le','la','les','un','une','des','de','du','et','est','que','qui','quoi','ou','pour','avec','dans','sur','ce','ca','je','tu','il','elle','nous','vous','leur','son','sa','ses','aux','au','en','par','plus','moins','comment','quel','quelle','quels','quelles','mon','ma','mes','ton','ta','tes','votre','vos','leur','leurs','a','y','se','si','ne','pas','une','tout','tous','toute','toutes','ceci','cela','donc','mais','ou','quand','comme','tel','telle']);

  function tokenize(s) {
    return (s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))
      .split(/[^a-z0-9àâäéèêëïîôöùûüç]+/i)
      .filter(t => t.length > 1 && !STOP.has(t));
  }

  // Racine simple : retire le pluriel (s/x) pour matcher projet = projets
  function stem(t) {
    return (t.length > 3 && /[sx]$/.test(t)) ? t.slice(0, -1) : t;
  }

  function scoreDoc(queryTokens, doc) {
    const docTokens = tokenize(doc.texte);
    const docSet = new Set(docTokens);
    const docStemSet = new Set(docTokens.map(stem));
    let score = 0;
    const matched = new Set();
    queryTokens.forEach(qt => {
      const qs = stem(qt);
      if (docSet.has(qt) || docSet.has(qt + 's') || docSet.has(qt + 'x') || docStemSet.has(qs)) {
        score += 2;
        matched.add(qt);
      } else {
        // correspondance partielle (préfixe)
        for (const dt of docTokens) {
          if (dt.startsWith(qt) && qt.length >= 4) { score += 1; matched.add(qt); break; }
        }
      }
    });
    // bonus si plusieurs tokens matchent
    if (matched.size >= 2) score += matched.size;
    return { score, matched: matched.size };
  }

  const TYPE_WEIGHT = {
    projet: 1.2, service: 1.1, faq: 1.0, profil: 1.0,
    competences: 0.9, technologies: 0.9, certifications: 0.9,
    etudes: 0.9, disponibilites: 0.8, reseaux: 0.8, cv: 0.8
  };

  function search(query, topN = 4) {
    const qTokens = tokenize(query);
    if (!qTokens.length) return [];
    const scored = docs.map(doc => {
      const { score, matched } = scoreDoc(qTokens, doc);
      const w = TYPE_WEIGHT[doc.type] || 1;
      return { doc, raw: score, weighted: score * w, matched };
    }).filter(x => x.raw > 0)
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, topN);
    return scored.map(x => x.doc);
  }

  // --- Génération de réponse à partir des chunks récupérés ---
  function buildAnswer(query, retrieved) {
    if (!retrieved.length) return null;
    const types = new Set(retrieved.map(d => d.type));
    const byType = t => retrieved.filter(d => d.type === t);

    // Projets
    if (types.has('projet')) {
      const projets = byType('projet');
      if (/quelque|tous|liste|réalis|projets?$/i.test(query) || projets.length > 1) {
        return "Voici les projets réalisés par Maurel Brou :\n" +
          projets.map(d => `• ${d.meta.nom} — ${d.source.replace('Projet ','')}`).join('\n') +
          "\n\nDites-moi lequel vous intéresse pour plus de détails, ou cliquez sur « En savoir plus » dans la section Projets.";
      }
      const pr = projets[0].meta;
      const doc = projets[0];
      let r = `${pr.nom} (${doc.source.replace('Projet ','')}) : ${doc.texte.split(':').slice(1).join(':').trim().substring(0, 240)}…`;
      if (pr.url) r += `\n\n→ Je peux vous ouvrir la page détaillée.`;
      return r;
    }

    if (types.has('service')) {
      const s = byType('service')[0];
      return `Service proposé : ${s.meta.titre}.\n${s.texte.split(':').slice(1).join(':').trim()}`;
    }

    if (types.has('faq')) {
      const f = byType('faq')[0];
      return f.meta.r;
    }

    if (types.has('competences')) return `Compétences clés de Maurel Brou : ${K.profil.competences.join(', ')}.`;
    if (types.has('technologies')) return `Technologies maîtrisées : ${K.profil.technologies.join(', ')}.`;
    if (types.has('certifications')) return `Certifications : ${K.profil.certifications.join(', ')}.`;
    if (types.has('etudes')) return `Études : ${K.profil.etudes.join(' ; ')}.`;
    if (types.has('disponibilites')) return K.profil.disponibilites;
    if (types.has('reseaux')) return `Vous pouvez joindre Maurel Brou via : ${K.profil.reseaux.email} (email), LinkedIn et GitHub (liens dans le footer).`;
    if (types.has('cv')) return `Le CV de Maurel Brou est disponible au téléchargement : ${K.cv.nomFichier}. ${K.cv.note}`;
    if (types.has('profil')) return K.profil.bio;

    // Résumé générique à partir des chunks
    return retrieved.slice(0, 2).map(d => d.texte.split(':').slice(1).join(':').trim().substring(0, 200)).join('\n\n') + '…';
  }

  window.AGENT_RAG = { search, buildAnswer, docs, tokenize };
})();

/* =========================================================
   LYNDA — Assistante IA de Maurel Brou
   Véritable agent LLM avec :
   - Raisonnement dynamique (jamais de réponses en dur)
   - Streaming en temps réel + annulation réelle (AbortController)
   - Mémoire de conversation + historique multi-conversations
   - Recherche documentaire (RAG) comme contexte
   - Restriction stricte à l'univers "Maurel Brou"
   - Navigation dans le portfolio + formulaire intelligent

   ⚠️ SÉCURITÉ — CE QUI A CHANGÉ PAR RAPPORT À LA VERSION PRÉCÉDENTE :
   Aucune clé API (Groq, Gemini, etc.) ne vit plus dans ce fichier.
   Tout appel à un modèle IA passe OBLIGATOIREMENT par le backend
   (server.py). C'est LUI qui détient les clés (variables
   d'environnement côté serveur) et qui gère le fallback entre
   fournisseurs (Groq -> Gemini -> etc.) si besoin.

   Endpoints backend attendus (à exposer dans server.py) :
   - POST /api/chat        { messages: [...] }        -> { reply }
   - POST /api/search      { q: string }               -> { results: [{title, body, href}] }
   - POST /api/image       { prompt, width, height }   -> { image: dataURL }
   - POST /api/vision      { image: base64, mimeType, name } -> { description }
   - POST /api/transcribe  FormData(file)              -> { text }

   Si tu déploies le portfolio ailleurs qu'en local, définis avant ce
   script : <script>window.LYNDA_API_BASE = "https://ton-domaine.com";</script>
   ========================================================= */
(function () {
    'use strict';

    const K = window.AGENT_KNOWLEDGE;
    const RAG = window.AGENT_RAG;

    /* ---------- Téléchargement du CV ----------
       Force un vrai téléchargement (et non un simple affichage dans
       l'onglet) en récupérant le fichier puis en créant un objet Blob
       avec un lien portant l'attribut download. */
    const downloadCV = () => {
        const url = K.cv.chemin;
        const nom = K.cv.nomFichier || 'CV.pdf';
        fetch(url)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
            .then(blob => {
                const a = document.createElement('a');
                const objUrl = URL.createObjectURL(blob);
                a.href = objUrl;
                a.download = nom;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
            })
            .catch(() => { window.open(url, '_blank'); });
    };

    /* ---------- Configuration ---------- */
    const USE_LLM = true;

    // Gestion de l'ambiguïté : quand c'est activé (true), Lynda affiche des
    // "Choice Cards" (sujets à plusieurs sens, ex. "Apple" → fruit/entreprise)
    // et des "suggestions d'action" (demandes incomplètes, ex. "génère un
    // rapport") pour clarifier AVANT de répondre. Passer à false pour
    // DÉSACTIVER ce comportement : Lynda traite alors la demande directement
    // sans proposer de cartes de choix ni de suggestions supplémentaires.
    const ENABLE_AMBIGUITY = false;

    // Base URL du backend, configurable sans toucher au code (prod/dev).
    const API_BASE = (window.LYNDA_API_BASE || 'http://127.0.0.1:5000').replace(/\/$/, '');
    const BACKEND_URL = API_BASE + '/api/chat';
    const BACKEND_SEARCH_URL = API_BASE + '/api/search';
    const BACKEND_IMAGE_URL = API_BASE + '/api/image';
    const BACKEND_VISION_URL = API_BASE + '/api/vision';
    const BACKEND_IMAGE_SEARCH_URL = API_BASE + '/api/image-search';

    /* ---------- Sécurité / limites (§17) ---------- */
    const MAX_FILE_SIZE = 8 * 1024 * 1024;   // 8 Mo par fichier
    const MAX_FILES = 5;                      // nb max de fichiers par message
    const MAX_MSG_LEN = 4000;                 // longueur max d'un message utilisateur
    const FORBIDDEN_EXT = ['rar', 'exe', 'apk', 'iso', 'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm'];

    /* ---------- Configuration des libs d'analyse de fichiers (CDN) ---------- */
    // PDF.js a besoin de son worker pour fonctionner côté client.
    if (window.pdfjsLib) {
        try {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
        } catch (e) { /* worker optionnel */ }
    }

    /* ---------- Utilitaire réseau : fetch avec timeout + annulation combinée ----------
       Combine un signal d'annulation externe (ex : bouton Stop) avec un
       timeout automatique, sans jamais laisser un appel réseau tourner
       indéfiniment en arrière-plan. */
    const fetchWithTimeout = (url, options = {}, timeoutMs = 15000) => {
        const external = options.signal || null;
        // AbortController explicite + setTimeout : garantit l'annulation
        // même si la connexion TCP est encore en cours d'établissement
        // (cas d'un backend en cold start qui ne répond pas avant longtemps).
        // AbortSignal.timeout() seul ne se déclenche pas toujours dans ce cas.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const signals = [controller.signal];
        if (external) signals.push(external);
        const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        const { signal, ...rest } = options;
        return fetch(url, { ...rest, signal: combined }).finally(() => clearTimeout(timer));
    };

    /* ---------- Références DOM ---------- */
    const agent = document.getElementById('aiAgent');
    const trigger = document.getElementById('agentTrigger');
    const closeBtn = document.getElementById('agentClose');
    const messages = document.getElementById('agentMessages');
    // Scroll intelligent : on ne force le bas que si l'utilisateur est déjà
    // en bas (sinon on le laisse lire le haut sans le brusquer).
    const isNearBottom = () => {
        const threshold = 60;
        return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= threshold;
    };
    const smartScroll = () => {
        if (isNearBottom()) messages.scrollTop = messages.scrollHeight;
    };
    const form = document.getElementById('agentForm');
    const input = document.getElementById('agentInput');
    const quick = document.getElementById('agentQuick');
    const welcome = document.getElementById('agentWelcome');

    const plusBtn = document.getElementById('agentPlus');
    const menu = document.getElementById('agentMenu');
    const menuNewChat = document.getElementById('menuNewChat');
    const menuAttach = document.getElementById('menuAttach');
    const menuHistory = document.getElementById('menuHistory');
    const fileInput = document.getElementById('agentFile');
    const attachPreview = document.getElementById('agentAttachPreview');
    const micBtn = document.getElementById('agentMic');
    const voiceBox = document.getElementById('agentVoice');
    const voiceText = document.getElementById('agentVoiceText');
    const voiceStop = document.getElementById('agentVoiceStop');
    const historyPanel = document.getElementById('agentHistory');
    const historyList = document.getElementById('agentHistoryList');
    const historyClose = document.getElementById('agentHistoryClose');

    if (!agent || !trigger || !messages || !form || !input) return;

    /* ---------- Titre d'accueil alterné ---------- */
    const welcomeTitle = welcome ? welcome.querySelector('.ai-agent__welcome-title') : null;
    if (welcomeTitle) {
        const WELCOME_TITLES = [
            "Comment puis-je vous aider aujourd'hui ?",
            "Une idée en tête ? Je suis là.",
            "Que souhaitez-vous explorer ensemble ?",
            "Posez votre question, je m'en occupe.",
            "Discutons de vos projets ou d'idées.",
            "Besoin d'un coup de main ? Demandez-moi.",
        ];
        let welcomeIdx = 0;
        setInterval(() => {
            // N'alterne que si le panneau est ouvert et l'accueil visible.
            if (state.open && welcome && !welcome.hidden && welcome.style.display !== 'none') {
                welcomeIdx = (welcomeIdx + 1) % WELCOME_TITLES.length;
                welcomeTitle.style.transition = 'opacity .4s ease';
                welcomeTitle.style.opacity = '0';
                setTimeout(() => {
                    welcomeTitle.textContent = WELCOME_TITLES[welcomeIdx];
                    welcomeTitle.style.opacity = '1';
                }, 400);
            }
        }, 3500);
    }

    /* ---------- État ---------- */
    const state = {
        open: false,
        busy: false,
        aborted: false,
        formMode: false,
        history: [],
        currentProject: null,
        memory: { prenom: '', entreprise: '', besoin: '', budget: '' },
        // Verrou anti-boucle : quand l'utilisateur a choisi une option dans
        // une carte d'ambiguïté, on stocke le sujet résolu pour ne PAS le
        // redétecter comme ambigu (sinon "l'entreprise (Apple Inc.)" → "apple"
        // bouclerait indéfiniment). Réinitialisé à chaque nouveau message libre.
        resolvedAmbiguity: null
    };

    // Contrôleur d'annulation de la requête IA en cours (bouton Stop réel).
    let currentAbortController = null;

    /* ---------- Multi-conversations ---------- */
    const conversations = [];
    let activeId = null;
    const newConversation = (restore) => {
        const conv = restore || {
            id: 'c_' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
            title: 'Nouvelle discussion',
            messages: [],
            memory: { prenom: '', entreprise: '', besoin: '', budget: '' },
            currentProject: null
        };
        conversations.push(conv);
        activeId = conv.id;
        state.history = conv.messages;
        state.memory = conv.memory;
        state.currentProject = conv.currentProject;
        return conv;
    };
    const getActive = () => conversations.find(c => c.id === activeId);
    const closeHistory = () => { if (historyPanel) historyPanel.hidden = true; };
    const saveActive = () => {
        const conv = getActive();
        if (!conv) return;
        conv.messages = state.history;
        conv.memory = state.memory;
        conv.currentProject = state.currentProject;
    };
    const autoTitle = (conv) => {
        const firstUser = conv.messages.find(m => m.role === 'user');
        if (firstUser) {
            const t = firstUser.content.trim().slice(0, 38);
            conv.title = t.length < firstUser.content.trim().length ? t + '…' : t;
        }
    };
    const renderHistory = (filter) => {
        if (!historyList) return;
        historyList.innerHTML = '';
        const q = (filter || '').trim().toLowerCase();
        const list = conversations.filter(conv => {
            if (!q) return true;
            if (conv.title.toLowerCase().includes(q)) return true;
            return conv.messages.some(m => m.content && m.content.toLowerCase().includes(q));
        });
        if (!conversations.length) {
            historyList.innerHTML = '<li class="ai-agent__history-empty">Aucune conversation</li>';
            return;
        }
        if (!list.length) {
            historyList.innerHTML = '<li class="ai-agent__history-empty">Aucun résultat</li>';
            return;
        }
        list.slice().reverse().forEach(conv => {
            const li = document.createElement('li');
            li.className = 'ai-agent__history-item' + (conv.id === activeId ? ' is-active' : '');
            li.innerHTML = `
                <button class="ai-agent__history-open" data-id="${conv.id}" title="Ouvrir">
                    <span class="ai-agent__history-dot"></span>
                    <span class="ai-agent__history-title">${escapeHtml(conv.title)}</span>
                </button>
                <span class="ai-agent__history-actions">
                    <button class="ai-agent__history-rename" data-id="${conv.id}" title="Renommer"><i class="bi bi-pencil"></i></button>
                    <button class="ai-agent__history-del" data-id="${conv.id}" title="Supprimer"><i class="bi bi-trash"></i></button>
                </span>`;
            historyList.appendChild(li);
        });
        historyList.querySelectorAll('.ai-agent__history-open').forEach(b =>
            b.addEventListener('click', () => openConversation(b.dataset.id)));
        historyList.querySelectorAll('.ai-agent__history-del').forEach(b =>
            b.addEventListener('click', (e) => { e.stopPropagation(); deleteConversation(b.dataset.id); }));
        historyList.querySelectorAll('.ai-agent__history-rename').forEach(b =>
            b.addEventListener('click', (e) => { e.stopPropagation(); renameConversation(b.dataset.id); }));
    };
    const openConversation = (id) => {
        saveActive();
        const conv = conversations.find(c => c.id === id);
        if (!conv) return;
        activeId = id;
        state.history = conv.messages;
        state.memory = conv.memory;
        state.currentProject = conv.currentProject;
        renderMessages();
        if (state.history.length) hideWelcome(); else showWelcome();
        closeHistory();
    };
    const deleteConversation = (id) => {
        const idx = conversations.findIndex(c => c.id === id);
        if (idx === -1) return;
        conversations.splice(idx, 1);
        if (activeId === id) {
            if (conversations.length) openConversation(conversations[conversations.length - 1].id);
            else { newConversation(); renderMessages(); showWelcome(); }
        }
        renderHistory();
    };
    const renameConversation = (id) => {
        const conv = conversations.find(c => c.id === id);
        if (!conv) return;
        const li = historyList.querySelector(`.ai-agent__history-open[data-id="${id}"]`);
        if (!li) return;
        const titleEl = li.querySelector('.ai-agent__history-title');
        if (!titleEl) return;
        const inputR = document.createElement('input');
        inputR.className = 'ai-agent__history-rename-input';
        inputR.value = conv.title;
        titleEl.replaceWith(inputR);
        inputR.focus(); inputR.select();
        const commit = () => {
            const v = inputR.value.trim();
            if (v) conv.title = v;
            renderHistory();
        };
        inputR.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') renderHistory();
        });
        inputR.addEventListener('blur', commit);
    };
    const renderMessages = () => {
        messages.innerHTML = '';
        state.history.forEach(m => {
            const el = addMessage(m.content, m.role, m.id);
            if (m.role === 'bot' && m.html) {
                el.innerHTML = m.html;
                enhanceMessage(el);
                wireCodeBlocks(el);
            }
        });
        smartScroll();
    };
    newConversation();

    /* ---------- Messages de réflexion (aléatoires) ---------- */
    const THINKING = [
        "Lynda réfléchit…",
        "Je consulte les informations disponibles…",
        "J'analyse votre demande…",
        "Je vérifie les informations…",
        "Je rassemble les éléments nécessaires…",
        "Votre question mérite une petite analyse…",
        "Je parcours les informations de Maurel…",
        "Je prépare une réponse adaptée…",
        "Je réfléchis à la meilleure façon de vous répondre…",
        "Un instant, je regarde cela…",
        "Je cherche les informations les plus pertinentes…",
        "Je prends quelques secondes pour analyser votre demande…",
        "Je relie les points entre vos questions…",
        "Je consulte le portfolio de Maurel…",
        "Je formule une réponse personnalisée…"
    ];
    const randThinking = () => THINKING[Math.floor(Math.random() * THINKING.length)];

    /* ---------- Utilitaires ---------- */
    const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    // Convertit le texte en HTML riche (Markdown, LaTeX, Mermaid, code coloré...)
    // Le rendu est sécurisé via DOMPurify avec une liste blanche restreinte.
    const formatText = (text) => {
        if (!text) return '';
        const codeBlocks = [];
        let working = text.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push({ lang: (lang || 'code').trim(), code: code.replace(/\n$/, '') });
            return `\u0000CODE${idx}\u0000`;
        });

        let html = '';
        try {
            if (window.marked) {
                marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
                html = marked.parse(working);
            } else {
                html = working
                    .split('\n').map(l => l.trim())
                    .map(l => l ? `<p>${escapeHtml(l)}</p>` : '')
                    .join('');
            }
        } catch (e) {
            html = escapeHtml(working);
        }

        html = html.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => {
            const cb = codeBlocks[parseInt(i, 10)];
            if (!cb) return '';
            const safe = escapeHtml(cb.code);
            return `<div class="ai-code" data-lang="${escapeHtml(cb.lang)}"><div class="ai-code__bar"><span class="ai-code__lang">${escapeHtml(cb.lang)}</span><span class="ai-code__acts"><button type="button" class="ai-code__copy" title="Copier">Copier</button><button type="button" class="ai-code__dl" title="Télécharger">Télécharger</button></span></div><pre><code class="hljs language-${escapeHtml(cb.lang)}">${safe}</code></pre></div>`;
        });

        // Sécurisation stricte du HTML généré : ni onclick, ni iframe.
        // Les composants riches (onglets, actions, etc.) sont câblés en JS
        // via des attributs data-*, jamais via des handlers inline — donc
        // onclick/iframe ne sont pas nécessaires et n'élargissent que la
        // surface d'attaque (notamment via une éventuelle injection de
        // prompt qui ferait produire du HTML malveillant par le LLM).
        if (window.DOMPurify) {
            html = DOMPurify.sanitize(html, {
                ADD_TAGS: ['input', 'button', 'details', 'summary'],
                ADD_ATTR: ['target', 'data-*', 'open']
            });
        }
        return html;
    };

    const enhanceMessage = (container) => {
        if (!container) return;
        if (window.hljs) {
            container.querySelectorAll('pre code').forEach(block => {
                try { hljs.highlightElement(block); } catch (e) {}
            });
        }
        if (window.renderMathInElement) {
            try {
                renderMathInElement(container, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false }
                    ],
                    throwOnError: false
                });
            } catch (e) {}
        }
        if (window.mermaid) {
            container.querySelectorAll('code.language-mermaid').forEach(code => {
                const pre = code.parentElement;
                const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
                const graph = code.textContent;
                try {
                    mermaid.render(id, graph).then(({ svg }) => {
                        const wrap = document.createElement('div');
                        wrap.className = 'ai-mermaid';
                        wrap.innerHTML = svg;
                        pre.replaceWith(wrap);
                    }).catch(() => {});
                } catch (e) {}
            });
        }
        wireRichComponents(container);
    };

    const wireCodeBlocks = (container) => {
        if (!container) return;
        container.querySelectorAll('.ai-code').forEach(block => {
            const code = block.querySelector('code');
            const lang = block.getAttribute('data-lang') || 'code';
            const text = code ? code.textContent : '';
            const copy = block.querySelector('.ai-code__copy');
            const dl = block.querySelector('.ai-code__dl');
            if (copy) copy.addEventListener('click', () => {
                navigator.clipboard?.writeText(text).then(() => { copy.textContent = 'Copié ✓'; setTimeout(() => copy.textContent = 'Copier', 1500); }).catch(() => {});
            });
            if (dl) dl.addEventListener('click', () => {
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `lynda-code.${lang === 'code' ? 'txt' : lang}`;
                document.body.appendChild(a); a.click(); a.remove();
                URL.revokeObjectURL(url);
            });
        });
    };

    const wireRichComponents = (container) => {
        if (!container) return;

        container.querySelectorAll('.ai-tabs').forEach(tabs => {
            const heads = tabs.querySelectorAll('.ai-tabs__tab');
            const panels = tabs.querySelectorAll('.ai-tabs__panel');
            heads.forEach((h, i) => {
                h.addEventListener('click', () => {
                    heads.forEach(x => x.classList.remove('active'));
                    panels.forEach(x => x.classList.remove('active'));
                    h.classList.add('active');
                    if (panels[i]) panels[i].classList.add('active');
                });
            });
        });

        container.querySelectorAll('.ai-accordion details').forEach(d => {
            d.addEventListener('toggle', () => {
                if (d.open) {
                    container.querySelectorAll('.ai-accordion details').forEach(o => { if (o !== d) o.open = false; });
                }
            });
        });

        container.querySelectorAll('.ai-carousel').forEach(car => {
            const slides = car.querySelectorAll('.ai-carousel__slide');
            const prev = car.querySelector('.ai-carousel__prev');
            const next = car.querySelector('.ai-carousel__next');
            const dots = car.querySelector('.ai-carousel__dots');
            let idx = 0;
            const show = (n) => {
                idx = (n + slides.length) % slides.length;
                slides.forEach((s, i) => s.classList.toggle('active', i === idx));
                if (dots) dots.querySelectorAll('.ai-carousel__dot').forEach((d, i) => d.classList.toggle('active', i === idx));
            };
            if (prev) prev.addEventListener('click', () => show(idx - 1));
            if (next) next.addEventListener('click', () => show(idx + 1));
            if (dots) dots.querySelectorAll('.ai-carousel__dot').forEach((d, i) => d.addEventListener('click', () => show(i)));
            show(0);
        });

        container.querySelectorAll('.ai-actions__btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.getAttribute('data-act');
                if (act === 'toast') {
                    showToast(btn.getAttribute('data-msg') || 'Action effectuée');
                } else if (act === 'modal') {
                    const title = btn.getAttribute('data-title') || 'Détails';
                    const body = btn.getAttribute('data-body') || '';
                    openModal(title, body);
                } else if (act === 'copy') {
                    const txt = btn.getAttribute('data-copy') || '';
                    navigator.clipboard?.writeText(txt).then(() => showToast('Copié ✓')).catch(() => {});
                } else if (act === 'progress') {
                    runProgressBar(container.querySelector('.ai-progress'));
                }
            });
        });

        container.querySelectorAll('.ai-menu-ctx').forEach(menu => {
            const trigger = menu.querySelector('.ai-menu-ctx__trigger');
            const list = menu.querySelector('.ai-menu-ctx__list');
            if (trigger && list) {
                trigger.addEventListener('click', (e) => {
                    e.stopPropagation();
                    list.classList.toggle('open');
                });
                document.addEventListener('click', () => list.classList.remove('open'));
            }
        });

        container.querySelectorAll('canvas.ai-chart').forEach(cv => {
            drawChart(cv);
        });
    };

    const showToast = (msg) => {
        let host = document.getElementById('agentToastHost');
        if (!host) {
            host = document.createElement('div');
            host.id = 'agentToastHost';
            host.className = 'ai-toast-host';
            document.body.appendChild(host);
        }
        const t = document.createElement('div');
        t.className = 'ai-toast';
        t.textContent = msg;
        host.appendChild(t);
        requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
    };

    const openModal = (title, bodyHtml) => {
        let modal = document.getElementById('agentModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'agentModal';
            modal.className = 'ai-modal';
            modal.innerHTML = `<div class="ai-modal__backdrop"></div><div class="ai-modal__dialog"><div class="ai-modal__head"><span class="ai-modal__title"></span><button class="ai-modal__close" aria-label="Fermer">&times;</button></div><div class="ai-modal__body"></div></div>`;
            document.body.appendChild(modal);
            modal.querySelector('.ai-modal__backdrop').addEventListener('click', () => modal.classList.remove('open'));
            modal.querySelector('.ai-modal__close').addEventListener('click', () => modal.classList.remove('open'));
        }
        modal.querySelector('.ai-modal__title').textContent = title;
        modal.querySelector('.ai-modal__body').innerHTML = bodyHtml || '';
        modal.classList.add('open');
    };

    const drawChart = (cv) => {
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        const labels = (cv.getAttribute('data-labels') || '').split('|');
        const values = (cv.getAttribute('data-values') || '').split('|').map(Number);
        const w = cv.width, h = cv.height;
        ctx.clearRect(0, 0, w, h);
        const max = Math.max(...values, 1);
        const bw = w / (values.length || 1);
        values.forEach((v, i) => {
            const bh = (v / max) * (h - 30);
            ctx.fillStyle = '#2e9e5b';
            ctx.fillRect(i * bw + 6, h - bh - 20, bw - 12, bh);
            ctx.fillStyle = '#0b0b0b';
            ctx.font = '11px sans-serif';
            ctx.fillText(labels[i] || '', i * bw + 6, h - 6);
        });
    };

    const runProgressBar = (bar) => {
        if (!bar) return;
        const fill = bar.querySelector('.ai-progress__fill');
        if (!fill) return;
        fill.style.width = '0%';
        let p = 0;
        const t = setInterval(() => {
            p = Math.min(100, p + 10 + Math.random() * 15);
            fill.style.width = p + '%';
            if (p >= 100) clearInterval(t);
        }, 250);
    };

    /* ---------- Rendu des messages ---------- */
    let msgSeq = 0;
    const pushMsg = (role, content, html, extra) => {
        const id = 'm_' + (++msgSeq);
        const entry = Object.assign({ id, role, content, html: html || null }, extra || {});
        state.history.push(entry);
        saveActive();
        autoTitle(getActive());
        return entry;
    };
    const addMessage = (text, sender, id) => {
        const el = document.createElement('div');
        el.className = 'ai-msg ' + (sender === 'user' ? 'ai-msg--user' : 'ai-msg--bot');
        if (id) el.dataset.id = id;
        if (sender === 'bot') {
            const content = document.createElement('div');
            content.className = 'ai-msg__content';
            if (text) content.textContent = text;
            el.appendChild(content);
            const actions = document.createElement('div');
            actions.className = 'ai-msg__actions';
            actions.innerHTML = `
                <button type="button" class="ai-msg__act" data-act="copy" title="Copier"><i class="bi bi-clipboard"></i></button>
                <button type="button" class="ai-msg__act" data-act="regen" title="Régénérer"><i class="bi bi-arrow-repeat"></i></button>
                <button type="button" class="ai-msg__act" data-act="like" title="J'aime"><i class="bi bi-hand-thumbs-up"></i></button>
                <button type="button" class="ai-msg__act" data-act="dislike" title="Je n'aime pas"><i class="bi bi-hand-thumbs-down"></i></button>
                <button type="button" class="ai-msg__act" data-act="share" title="Partager"><i class="bi bi-share"></i></button>`;
            el.appendChild(actions);
            wireMsgActions(el, content);
        } else {
            if (text) el.textContent = text;
            const uActions = document.createElement('div');
            uActions.className = 'ai-msg__actions ai-msg__actions--user';
            uActions.innerHTML = `
                <button type="button" class="ai-msg__act" data-act="edit" title="Modifier"><i class="bi bi-pencil"></i></button>
                <button type="button" class="ai-msg__act" data-act="del" title="Supprimer"><i class="bi bi-trash"></i></button>`;
            el.appendChild(uActions);
            wireUserActions(el);
        }
        messages.appendChild(el);
        smartScroll();
        return el;
    };

    const wireUserActions = (el) => {
        el.querySelectorAll('.ai-msg__act').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.getAttribute('data-act');
                const id = el.dataset.id;
                if (act === 'edit') editUserMessage(id);
                else if (act === 'del') deleteUserMessage(id);
            });
        });
    };

    const deleteUserMessage = (id) => {
        const idx = state.history.findIndex(m => m.id === id);
        if (idx === -1) return;
        state.history.splice(idx, 1);
        if (state.history[idx] && state.history[idx].role === 'assistant') state.history.splice(idx, 1);
        saveActive();
        renderMessages();
    };

    const editUserMessage = (id) => {
        const idx = state.history.findIndex(m => m.id === id);
        if (idx === -1) return;
        const entry = state.history[idx];
        const original = entry.content || '';
        const el = messages.querySelector(`.ai-msg--user[data-id="${id}"]`);
        if (!el) return;
        const contentEl = el.querySelector('.ai-msg__content') || el;
        const inputR = document.createElement('textarea');
        inputR.className = 'ai-agent__edit-input';
        inputR.value = original;
        inputR.rows = Math.min(6, Math.max(2, original.split('\n').length));
        contentEl.replaceWith(inputR);
        inputR.focus();
        inputR.select();
        const commit = () => {
            const v = inputR.value.trim();
            if (!v) { renderMessages(); return; }
            entry.content = v;
            if (state.history[idx + 1] && state.history[idx + 1].role === 'assistant') {
                state.history.splice(idx + 1, 1);
            }
            saveActive();
            renderMessages();
            regenerateAfter(idx);
        };
        inputR.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
            if (e.key === 'Escape') renderMessages();
        });
        inputR.addEventListener('blur', commit);
    };

    const regenerateAfter = async (userIdx) => {
        if (state.busy) return;
        const query = state.history[userIdx] ? state.history[userIdx].content : '';
        if (!query) return;
        state.aborted = false;
        setGenerating(true);
        hideWelcome();
        state.busy = true;
        showTyping();
        const thinkDelay = 150 + Math.random() * 350;
        await new Promise(r => setTimeout(r, thinkDelay));
        // Pas de bulle vide ici (voir send()) : finishReply() la crée si besoin.
        const reply = await respond(query, { skipUserPush: true });
        hideTyping();
        await finishReply(reply);
    };

    const wireMsgActions = (el, contentEl) => {
        const content = contentEl || el.querySelector('.ai-msg__content');
        el.querySelectorAll('.ai-msg__act').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.getAttribute('data-act');
                const text = content ? content.textContent : '';
                if (act === 'copy') {
                    navigator.clipboard?.writeText(text).then(() => flash(btn, '✓')).catch(() => {});
                } else if (act === 'regen') {
                    regenerateLast();
                } else if (act === 'like' || act === 'dislike') {
                    el.querySelectorAll('.ai-msg__act[data-act="like"], .ai-msg__act[data-act="dislike"]')
                        .forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                } else if (act === 'share') {
                    if (navigator.share) {
                        navigator.share({ title: 'Lynda — Maurel Brou', text }).catch(() => {});
                    } else {
                        navigator.clipboard?.writeText(text).then(() => flash(btn, 'lien copié')).catch(() => {});
                    }
                }
            });
        });
    };

    const flash = (btn, msg) => {
        const old = btn.innerHTML;
        btn.innerHTML = `<span style="font-size:11px">${msg}</span>`;
        setTimeout(() => { btn.innerHTML = old; }, 1200);
    };

    const regenerateLast = async () => {
        if (state.busy) return;
        let userIdx = -1;
        for (let i = state.history.length - 1; i >= 0; i--) {
            if (state.history[i].role === 'user') { userIdx = i; break; }
        }
        if (userIdx === -1) return;
        if (state.history[userIdx + 1] && state.history[userIdx + 1].role === 'assistant') {
            state.history.splice(userIdx + 1, 1);
        }
        const botEls = messages.querySelectorAll('.ai-msg--bot');
        if (botEls.length) botEls[botEls.length - 1].remove();
        renderMessages();
        await regenerateAfter(userIdx);
    };

    const addImageMessage = (src, caption) => {
        const el = document.createElement('div');
        el.className = 'ai-msg ai-msg--bot ai-msg--image';
        if (src) {
            const wrap = document.createElement('div');
            wrap.className = 'ai-agent__gen-img-wrap';
            const img = document.createElement('img');
            img.className = 'ai-agent__gen-img';
            img.src = src;
            img.alt = caption || 'Image générée par Lynda';
            img.loading = 'lazy';
            const mark = document.createElement('span');
            mark.className = 'ai-agent__gen-watermark';
            mark.textContent = 'L';
            mark.title = 'Image générée par Lynda';
            wrap.appendChild(img);
            wrap.appendChild(mark);
            el.appendChild(wrap);
        } else {
            const ph = document.createElement('div');
            ph.className = 'ai-agent__gen-img-loading';
            ph.innerHTML = `
                <div class="ai-agent__gen-spinner"></div>
                <div class="ai-agent__gen-loading-text">✨ Lynda imagine votre image…</div>
                <div class="ai-agent__gen-loading-sub">Création en cours, quelques secondes</div>`;
            el.appendChild(ph);
        }
        if (caption) {
            const cap = document.createElement('div');
            cap.className = 'ai-agent__gen-img-cap';
            cap.textContent = caption;
            el.appendChild(cap);
        }
        messages.appendChild(el);
        smartScroll();
        return el;
    };

    // Affichage instantané (plus d'effet machine à écrire) : le texte
    // apparaît en une fois, sans animation caractère par caractère.
    // Effet de frappe progressive (typewriter) : le texte apparaît
    // caractère par caractère pour éviter un long temps d'attente muet.
    // Borné à ~2 s maximum quelle que soit la longueur du texte.
    const renderInstant = (el, text, done) => {
        const html = formatText(text);
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const plain = tmp.textContent || '';
        el.textContent = '';
        let i = 0;
        // ~120 images par seconde (requestAnimationFrame) -> on calcule un
        // pas pour que la durée totale reste sous ~2 s.
        const step = Math.max(1, Math.ceil(plain.length / 120));
        const tick = () => {
            if (state.aborted) { el.innerHTML = html; if (done) done(); return; }
            i += step;
            if (i >= plain.length) {
                el.innerHTML = html;
                smartScroll();
                if (done) done();
                return;
            }
            el.textContent = plain.slice(0, i);
            smartScroll();
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    const typeWriter = renderInstant;

    const isRichContent = (text) => {
        return /```|(\$\$[\s\S]*?\$\$)|(?<!\w)\$[^$\n]+\$(?!\w)|^\s*\|.*\|\s*$/m.test(text)
            || /(ai-tabs|ai-accordion|ai-carousel|ai-chart|ai-progress|ai-actions|ai-menu-ctx|language-mermaid)/.test(text);
    };

    let thinkingTimer = null;
    // Indicateur de saisie (3 points) affiché EN BAS du chat, juste après
    // le dernier message, pendant que Lynda réfléchit. Pas de fond blanc,
    // couleur accent. On (ré)insère toujours en fin de liste pour qu'il
    // suive la conversation en bas.
    const showTyping = () => {
        let t = document.getElementById('agentTyping');
        if (!t) {
            t = document.createElement('div');
            t.id = 'agentTyping';
            t.className = 'ai-agent__typing show';
            t.innerHTML = '<span class="ai-agent__typing-dots"><span></span><span></span><span></span></span>';
        }
        // Insère en bas (après le dernier message) pour suivre la discussion.
        messages.appendChild(t);
        t.classList.add('show');
        smartScroll();
    };

    const hideTyping = () => {
        clearInterval(thinkingTimer);
        const t = document.getElementById('agentTyping');
        if (t && t.parentNode) t.parentNode.removeChild(t);
    };

    /* ---------- Ouverture / fermeture ---------- */
    const hideWelcome = () => { if (welcome) welcome.style.display = 'none'; };
    const showWelcome = () => { if (welcome) welcome.style.display = ''; };

    const NATURE_IMAGES = [
        'photo-1441974231531-c6227db76b6e',
        'photo-1469474968028-56623f02e42e',
        'photo-1470071459604-3b5ec3a7fe05',
        'photo-1426604966848-d7adac402bff',
        'photo-1501785888041-af3ef285b470',
        'photo-1433086966358-54859d0ed716',
        'photo-1472214103451-9374bd1c798e',
        'photo-1505765050516-f72dcac9c60e',
        'photo-1447752875215-b2761acb3c5d',
        'photo-1418065460487-3e41a6c84dc5',
        'photo-1502082553048-f009c37129b9',
        'photo-1518173946687-a4c8892bbd9f',
        'photo-1454496522488-7a8e488e8606',
        'photo-1470770841072-f978cf4d019e',
        'photo-1432405972618-c60b0225b8f9',
        'photo-1500382017468-9049fed747ef',
        'photo-1511497584788-876760111969',
        'photo-1542273917363-3b1817f69a2d',
        'photo-1454942901704-3c44c11b2ad1',
        'photo-1475924156734-496f6968e6c1',
        'photo-1444703686981-a3abbc4d4fe3',
        'photo-1500530855697-b586d89ba3ee',
        'photo-1497436072909-60f360e1d4b1',
        'photo-1546587348-d12660c30c50',
        'photo-1506905925346-21bda4d32df4',
        'photo-1464822759023-fed622ff2c3b',
        'photo-1439066615861-d1af74d74000'
    ].map(id => `https://images.unsplash.com/${id}?w=1200&q=80&auto=format&fit=crop`);

    const loadRandomBackground = (attempt = 0) => {
        const panel = agent.querySelector('.ai-agent__panel');
        if (!panel || !NATURE_IMAGES.length) return;
        const url = NATURE_IMAGES[Math.floor(Math.random() * NATURE_IMAGES.length)];
        const img = new Image();
        img.onload = () => { panel.style.setProperty('--agent-bg', `url("${url}")`); };
        img.onerror = () => { if (attempt < 3) loadRandomBackground(attempt + 1); };
        img.src = url;
    };

    const openAgent = () => {
        if (state.open) return;
        state.open = true;
        agent.classList.add('open');
        agent.setAttribute('aria-hidden', 'false');
        trigger.setAttribute('aria-expanded', 'true');
        loadRandomBackground();
        if (state.history.length > 0) hideWelcome();
        else showWelcome();
        setTimeout(() => input.focus(), 350);
    };

    const closeAgent = () => {
        state.open = false;
        agent.classList.remove('open');
        agent.setAttribute('aria-hidden', 'true');
        trigger.setAttribute('aria-expanded', 'false');
    };

    trigger.addEventListener('click', openAgent);
    if (closeBtn) closeBtn.addEventListener('click', closeAgent);
    agent.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeAgent));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) closeAgent(); });

    /* ---------- Mémoire visiteur ---------- */
    const remember = (text) => {
        let m;
        if ((m = text.match(/je m'appelle\s+([\p{L}]+)|mon nom est\s+([\p{L}]+)|je suis\s+([\p{L}]+)/iu))) {
            state.memory.prenom = (m[1] || m[2] || m[3] || '').trim();
        }
        if ((m = text.match(/mon (?:entreprise|société|boîte|boite) (?:(?:est|s'appelle|c')?\s*:?\s*)([\p{L}0-9 .'-]+)/iu))) {
            state.memory.entreprise = m[1].trim();
        }
        if ((m = text.match(/mon budget (?:(?:est|de|c')?\s*:?\s*)([\p{L}0-9 .€$'-]+)/iu))) {
            state.memory.budget = m[1].trim();
        }
        if ((m = text.match(/mon besoin (?:(?:est|de|c')?\s*:?\s*)([\p{L}0-9 .,'-]+)/iu))) {
            state.memory.besoin = m[1].trim();
        }
        const pr = K.projets.find(p => text.toLowerCase().includes(p.nom.toLowerCase()));
        if (pr) state.currentProject = pr.nom;
    };

    /* ---------- Détection d'intention / navigation ---------- */
    // runAction (ancien moteur de réponses en dur : CV, contact, projets,
    // présentation, carte…) a été supprimé volontairement. Désormais, toutes
    // ces questions sont traitées par le LLM via /api/chat — plus aucun
    // texte pré-écrit. La génération d'image reste gérée séparément.

    const detectIntent = (q) => {
        const s = q.toLowerCase();
        // Seules intentions conservées : génération d'image (vrai outil IA
        // via Pollinations) et météo (carte dédiée via Open-Meteo). Tout le
        // reste est désormais confié au LLM — plus aucune réponse en dur.
        // Demande de MODIFICATION d'une image existante (fond, couleur, etc.).
        // Lynda ne peut pas éditer un fichier image : on le signale et on
        // propose une génération à la place. On place cette règle AVANT la
        // génération, mais on exclut les verbes de création pour ne pas
        // capter « génère une image avec un fond noir ».
        if (!/(génère|genere|crée|cree|fais|fait|dessine|illustre|imagine|montre|produis)[- ]?moi?\b/i.test(s)
            && (/(modifie|modifier|change|changer|remplace|remplacer|édite|edite|éditer|editer|retouche|retoucher|transforme|transformer|mets|met|passe|passe[- ]moi|redresse|recadre|recadrer|ajoute|enlève|enleve|supprime)\b.*\b(image|photo|visuel|illustration|logo|fond)/.test(s)
                || /(image|photo|visuel|illustration|logo)\b.*\b(modifie|modifier|change|changer|remplace|remplacer|édite|edite|éditer|editer|retouche|retoucher|transforme|transformer|mets|met|passe|passe[- ]moi|redresse|recadre|recadrer|ajoute|enlève|enleve|supprime)\b/.test(s))) {
            return { action: 'editimage' };
        }
        if (/(génère|genere|crée|cree|fais[- ]moi|fait[- ]moi|dessine|dessine[- ]moi|illustre|imagine|montre[- ]moi|produis|génère[- ]moi)/.test(s) && /(image|image de|photo|visuel|illustration|dessin|tableau|peinture|portrait|affiche)/.test(s)) return { action: 'genimage' };
        // Météo : "météo à Paris", "température Abidjan", "il fait quel temps à Lyon"
        if (/(météo|meteo|température|temperature|quel temps|il fait|fait[- ]il|prévision)/.test(s)) {
            // Extraction de la ville : on parcourt toutes les prépositions et
            // on retient le dernier mot valide (ni mot vide, ni mot-clé météo).
            const STOP = /^(la|le|les|ma|ta|sa|une|un|des|mon|ton|son|cette|ce|du|de|au|aux|en|à|a)$/;
            const KEYWORD = /^(météo|meteo|température|temperature|temps|fait|prévision|prevision)$/;
            let city = '';
            const prepRe = /(?:à|a|en|de|du|dans|sur|au|aux)\s+([\p{L}][\p{L}'-]*)/gu;
            let pm;
            while ((pm = prepRe.exec(s)) !== null) {
                const w = pm[1];
                if (!STOP.test(w) && !KEYWORD.test(w)) city = w;
            }
            // Cas sans préposition : « météo Lyon », « température Paris »
            if (!city) {
                const km = s.match(/météo\s+(?:à|a|en|de\s+)?([\p{L}][\p{L}'-]*)/u)
                    || s.match(/température\s+(?:à|a|en|de\s+)?([\p{L}][\p{L}'-]*)/u);
                if (km && km[1] && !STOP.test(km[1]) && !KEYWORD.test(km[1])) city = km[1];
            }
            if (city) {
                city = city.trim().replace(/\b(aujourd'hui|maintenant|ce soir|ce matin|en ce moment|actuellement|pour|vers|près|proche)\b.*$/gi, '').trim();
            }
            if (!city) city = 'Abidjan'; // défaut : ville de l'utilisateur
            return { action: 'weather', payload: city };
        }
        return null;
    };

    /* ---------- Détection d'entité (personne, groupe, entreprise, pays…) ----------
       Quand l'utilisateur pose une question sur une entité connue, Lynda
       enrichit sa réponse avec une image réelle, une fiche d'identité, des
       sections structurées, une chronologie, des statistiques et (si utile)
       une carte ou des vidéos — à la manière de ChatGPT / Gemini / Perplexity. */
    const ENTITY_PATTERNS = [
        { re: /(qui est|qui était|c'est qui|c'était qui|parle[- ]moi|présente[- ]moi|dis[- ]moi en plus sur|raconte[- ]moi|biographie de|bio de|qui sont)\s+(?:de|du|d'|des|de la|aux|au)?\s*(.+?)\s*[?]?$/i, group: 2, kind: 'person' },
        { re: /^(.+?)\s+(?:c'est quoi|c'est qui|qui est|qui était|en bref|en résumé|en quelques mots|en 2 mots|explique[- ]moi|explique|décris[- ]moi|décrit|présente|présentation|biographie|bio|histoire de|histoire)\s*[?]?$/i, group: 1 },
        { re: /(parle[- ]moi|présente[- ]moi|dis[- ]moi en plus sur|raconte[- ]moi|biographie de|bio de|qui est|qui était|c'est qui|c'était qui)\s+(?:de|du|d'|des|de la|aux|au)?\s*(.+)$/i, group: 2 },
        // Personnes explicites : "photo de Lionel Messi", "portrait de…"
        { re: /(personne|célébrité|celebrite|star|vedette|rappeur|chanteur|chanteuse|acteur|actrice|footballeur|footballeuse|joueur|joueuse|basketteur|basketteuse|tennisman|tenniste|athlète|coureur|pilote|scientifique|chercheur|chercheuse|philosophe|peintre|artiste|créateur|créatrice|entrepreneur|entrepreneuse|fondateur|fondatrice|pdg|président|présidente|roi|reine|prince|princesse|empereur|impératrice|mannequin|modèle|model|écrivain|écrivaine|auteur)\s+(?:de\s+|d['’´`]\s*|du\s+|des\s+|la\s+|le\s+|les\s+)?(.+?)\s*[?]?$/i, group: 2, kind: 'person' },
        // Lieux explicites : "ville de Paris", "pays du Canada", "monument de…"
        { re: /(ville|localité|localite|commune|quartier|région|region|département|departement|pays|capitale|monument|tour|musée|musee|lac|fleuve|montagne|rivière|riviere|île|ile|continent|province|district|arrondissement|cité|cites|métropole|metropole|préfecture|prefecture)\s+(?:de\s+|d['’´`]\s*|du\s+|des\s+|la\s+|le\s+|les\s+)?(.+?)\s*[?]?$/i, group: 2, kind: 'place' }
    ];
    // Mots qui, s'ils apparaissent dans le sujet, confirment qu'on parle d'une
    // entité "monde réel" (personne, groupe, lieu, œuvre, marque…) plutôt que
    // d'un concept abstrait.
    const ENTITY_HINTS = /(rappeur|chanteur|chanteuse|musicien|musicienne|auteur|écrivain|écrivaine|acteur|actrice|réalisateur|réalisatrice|président|présidente|politicien|politicienne|homme d'état|femme d'état|footballeur|footballeuse|joueur|joueuse|basketteur|tennisman|tenniste|athlète|coureur|pilote|scientifique|chercheur|chercheuse|philosophe|peintre|artiste|créateur|créatrice|entrepreneur|entrepreneuse|fondateur|fondatrice|pdg|ceo|groupe|groupe de|chanteur|chanteuse|groupe musical|entreprise|société|boîte|boite|marque|produit|équipe|club|sportif|sportive|pays|ville|capitale|monument|tour|musée|film|film de|long métrage|série|série tv|livre|roman|album|chanson|chanson de|tube|hit|personnage|personnalité|star|vedette|célébrité|influenceur|influenceuse|youtuber|streamer|créateur|créatrice|designer|styliste|mannequin|modèle|roi|reine|prince|princesse|empereur|impératrice|général|colonel|chef|leader|fondateur|cofondateur|inventeur|inventrice|pionnier|pionnière|icône|légende|génie|prodige|rap|pop|rock|rnb|hip[- ]hop|jazz|soul|reggae|afro|coupe|championnat|ligue|tournoi|finale|olympique|olympique|mondial|euro|copa|afrobasket|can|championnat du monde|ligue des champions|premier league|liga|nba|nfl|f1|formule 1|grand prix|élection|guerre|révolution|indépendance|fête|festival|commémoration|anniversaire|création|fondation|naissance|mort|décès|carrière|palmarès|titres|titre|records|record|statistiques|classement|classe|classement mondial|meilleur|meilleure|top|classement|récompenses|prix|grammy|grammy awards|oscar|cesar|césar|ballon d'or|palme d'or|nobel|victoire|victoires|sacré|sacrée|sacres|sacré|champion|championne|champions|vainqueur|vainqueur|gagnant|gagnante|premier|première|numéro 1|numero 1|top 1|record du monde|record mondial|patrimoine|fortune|richesse|riche|milliardaire|milliardaire|entreprise|startup|licorne|marque|produit|modèle|voiture|berline|suv|scooter|moto|avion|fusée|satellite|télescope|sonde|mission|expédition|espace|lune|mars|terre|planète|étoile|galaxie|univers|océan|forêt|montagne|volcan|désert|fleuve|rivière|lac|île|île|continent|région|province|département|commune|district|quartier|arrondissement|pays|état|nation|peuple|ethnie|tribu|langue|religion|culture|civilisation|dynastie|empire|royaume|république|fédération|union|organisation|onu|ue|union européenne|nato|otan|fmi|banque mondiale|groupe|alliance|traité|accord|conférence|sommet|sommet|sommet|sommet)/i;
    const isEntityQuery = (q) => {
        const s = q.trim();
        if (s.length < 4) return null;
        // Mots indiquant un LIEU (pour ne pas traiter une ville/pays comme
        // une personne). Utilisé pour choisir Wikipedia vs Pexels.
        const PLACE_WORDS_LOCAL = /(ville|pays|capitale|région|region|département|departement|monument|tour|musée|musee|lac|fleuve|montagne|rivière|riviere|île|ile|continent|province|district|arrondissement|cité|cites|métropole|metropole|préfecture|prefecture|france|paris|londres|berlin|madrid|rome|afrique|europe|amérique|asie|océanie|oceanie|états-unis|chine|japon|allemagne|espagne|italie|canada|bresil|bresil|mexique|inde|russie|égypte|maroc|sénégal|côte d'ivoire|cote d'ivoire|abidjan|dakar|yamoussoukro|casablanca|alger|tunis|rabat|le caire|nairob|lagos|accra|lomé|douala|kamina|kinshasa|kigali)/i;
        // Exclure les intentions déjà gérées séparément
        if (/(génère|genere|crée|cree|fais|fait|dessine|illustre|modifie|modifier|change|changer|météo|meteo|température|temperature|quel temps)/i.test(s)) return null;
        // EXCLUSION DES SUJETS LOCAUX (portfolio de Maurel) : on ne déclenche
        // PAS de fiche enrichie avec images web pour Maurel, ses projets,
        // Lynda, le CV, le contact, etc. Ces sujets sont déjà documentés dans
        // le portfolio ; afficher des images web aléatoires (Pexels/Unsplash)
        // non pertinentes n'apporte aucune valeur et prête à confusion.
        // Le LLM répond simplement en texte avec les vraies infos locales.
        if (LOCAL_TOPICS.test(s)) return null;
        for (const p of ENTITY_PATTERNS) {
            const m = s.match(p.re);
            if (m && m[p.group]) {
                let subject = m[p.group].trim().replace(/[?]$/, '').trim();
                if (subject.length < 2) continue;
                // Retire les articles/déterminants initiaux ("du Canada" -> "Canada",
                // "de la France" -> "France", "l'Italie" -> "Italie") pour que
                // la détection de nom propre et la recherche d'images fonctionnent.
                subject = subject.replace(/^(?:du|de la|des|de l'|d'|de|la|le|les|l'|un|une|au|aux|en)\s+/i, '').trim();
                if (subject.length < 2) continue;
                // Le sujet doit contenir une indication d'entité concrète OU
                // être une requête de présentation explicite. Pour les lieux
                // (villes, pays, monuments…) on accepte aussi un nom propre
                // capitalisé dans une demande de présentation.
                const isPresentation = /^(qui|parle|présente|présentation|biographie|bio|raconte|dis|explique|décris|décrit|histoire|c'est qui|c'était qui)/i.test(s);
                const isProperNoun = /^[A-ZÀ-ÖØ-Þ][\p{L}À-ÿ'’-]*(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}À-ÿ'’-]*){0,3}$/u.test(subject);
                if (ENTITY_HINTS.test(subject) || isPresentation && isProperNoun || p.kind === 'place') {
                    // Par défaut 'person' (Wikipedia) sauf si le pattern
                    // indique explicitement un lieu ('place').
                    const kind = p.kind || (PLACE_WORDS_LOCAL.test(subject) ? 'entity' : 'person');
                    return { subject, kind };
                }
            }
        }
        // Nom seul : "Lionel Messi", "Abidjan", "Ghana", "Paris"… sans verbe.
        // On accepte un nom propre capitalisé (1 à 4 mots) qui ne contient
        // aucun mot de liaison/concept abstrait, pour déclencher la fiche
        // dans tous les contextes (pas seulement "qui est" / "parle-moi").
        const loneName = s.replace(/[?]$/, '').trim();
        const hasVerb = /(qui|parle|présente|présentation|biographie|bio|raconte|dis|explique|décris|décrit|histoire|c'est|comment|pourquoi|quand|où|quel|quelle|quels|quelles|pour|contre|avec|sans|est|était|sont|étaient|fait|font|ont|peut|dois|veux|veut|doit|faut|cherche|trouve|donne|liste|compare|différence|différences|entre|vs|versus)\b/i.test(loneName);
        // Nom propre seul : capitalisé (ex. "Lionel Messi", "Abidjan").
        const isCapitalized = /^[A-ZÀ-ÖØ-Þ][\p{L}À-ÿ'’-]*(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}À-ÿ'’-]*){0,3}$/u.test(loneName);
        // Mot unique minuscule : on n'accepte une fiche entité QUE si c'est
        // un NOM PROPRE évident (pays, ville célèbre, personnage connu…),
        // listé explicitement. On refuse tout mot du français courant
        // ("papa", "maman", "chat", "chien", "livre"…) ou mot anglais courant,
        // car ce sont des termes génériques qui ne méritent pas d'image web.
        const isSingleWord = /^[a-zà-öø-ÿ'’-]+$/u.test(loneName);
        // Liste de noms propres connus (minuscules) qui méritent une fiche :
        // pays, capitales, villes célèbres, personnages historiques…
        const KNOWN_PROPER_NOUNS = /^(afghanistan|afrique du sud|albanie|algérie|allemagne|angola|arabie saoudite|argentine|arménie|australie|autriche|azerbaïdjan|bahamas|bahreïn|bangladesh|barbade|belgique|bénin|bhoutan|bolivie|bosnie|botswana|brésil|brunei|bulgarie|burkina|burundi|cambodge|cameroun|canada|cap-vert|chili|chine|chypre|colombie|comores|congo|corée|costa rica|côte d'ivoire|croatie|cuba|danemark|djibouti|dominique|égypte|él salvador|émirats|équateur|érythrée|espagne|estonie|eswatini|états-unis|éthiopie|finlande|france|gabon|gambie|géorgie|ghana|grèce|guatemala|guinée|guyana|haïti|honduras|hongrie|inde|indonésie|irak|iran|irlande|islande|israël|italie|jamaïque|japon|jordanie|kazakhstan|kenya|kirghizistan|kosovo|koweït|laos|lettonie|liban|liberia|libye|liechtenstein|lituanie|luxembourg|madagascar|malaisie|malawi|maldives|mali|maroc|maurice|mauritanie|mexique|moldavie|monaco|mongolie|monténégro|mozambique|namibie|népal|nicaragua|niger|nigeria|norvège|nouvelle-zélande|oman|ouganda|ouzbekistan|pakistan|panama|paraguay|pays-bas|pérou|philippines|pologne|portugal|qatar|roumanie|royaume-uni|russe|rwanda|saint|salvador|sénégal|serbie|seychelles|sierra|singapour|slovaquie|slovénie|somalie|soudan|sri lanka|suède|suisse|syrie|tadjikistan|taïwan|tanzanie|tchad|thailande|timor|togo|trinité|tunisie|turquie|turkménistan|ukraine|uruguay|venezuela|vietnam|yémen|zambie|zimbabwe|paris|londres|berlin|madrid|rome|lisbonne|amsterdam|bruxelles|vienne|moscou|pekin|tokyo|new york|dubai|dakar|abidjan|yamoussoukro|ouagadougou|bamako|casablanca|alger|tunis|rabat|le caire|le cap|nairob|lagos|accra|lomé|cotonou|niamey|conakry|freetown|monrovia|bangui|ndjamena|libreville|brazzaville|kinshasa|kigali|buja|addis-abeba|dar es salaam|kampala|juba|khartoum|mogadiscio|maputo|harare|lusaka|gaborone|maseru|mbabane|vatican|monaco|andorre|luxembourg|malte|chypre|maldives|singapour|brunei|bahreïn|qatar|koweït|émirats|arabie|israël|palestine|liban|jordanie|syrie|irak|iran|afghanistan|pakistan|inde|népal|bengladesh|bhoutan|sri lanka|maldives|thailande|birmanie|laos|cambodge|vietnam|malaisie|indonésie|philippines|chine|corée|japon|mongolie|kazakhstan|ouzbekistan|turkménistan|tadjikistan|kirghizistan|azerbaïdjan|géorgie|arménie|turquie|chypre|grèce|italie|france|espagne|portugal|allemagne|autriche|suisse|belgique|pays-bas|luxembourg|irlande|royaume-uni|islande|norvège|suède|finlande|danemark|pologne|tchéquie|slovaquie|hongrie|roumanie|bulgarie|serbie|croatie|slovénie|bosnie|macédoine|monténégro|kosovo|albanais|macédoine|grèce|turquie|russie|biélorussie|ukraine|moldavie|lituanie|lettonie|estonie|canada|états-unis|mexique|guatemala|belize|honduras|salvador|nicaragua|costa rica|panama|cuba|haïti|république dominicaine|jamaïque|bahamas|barbade|trinité|guyana|suriname|équateur|colombie|pérou|bolivie|paraguay|chili|argentine|uruguay|venezuela|brésil|groenland|messi|ronaldo|mbappé|neymar|lebron|federer|nadal|djokovic|hamilton|verstappen|tom brady|messi|ronaldo|mbappe|neymar|lebron james|michael jordan|kobe bryant|tiger woods|usain bolt|pele|maradona|zidane|platini|henry|mbappe|ronaldo|messi|neymar|salah|benzema|griezmann)$/i;
        // Mots français courants à exclure (pour ne pas capter "bonjour", "chat", etc.)
        const commonWords = /^(bonjour|salut|merci|oui|non|ok|chat|chien|maison|voiture|temps|jour|journée|semaine|mois|année|livre|eau|feu|terre|monde|vie|mort|amour|argent|travail|école|famille|ami|amis|fille|garçon|homme|femme|enfant|personne|gens|chose|truc|machin|porte|fenêtre|table|chaise|arbre|fleur|soleil|lune|étoile|pluie|neige|vent|mer|rivière|montagne|ville|pays|france|paris|afrique|europe|monde|histoire|science|math|français|anglais|espagnol|comment|pourquoi|quand|où|qui|que|quoi|quel|quelle|bon|mauvais|grand|petit|beau|laid|vrai|faux|oui|non|peut|peux|veux|veut|dois|doit|faut|est|sont|était|étaient|as|ont|a|ai|avons|avez|fais|fait|font|va|vas|vont|mange|bois|dors|travaille|habite|vis|vit|pense|crois|sais|connais|comprends|comprend|vois|entends|écoute|écris|lis|parle|parles|dis|dit|veux|veulent|peuvent|doivent|faut|faudrait|pourrais|pourrait|aimerais|aimerait|aime|aimes|aiment|déteste|détestes|préfère|préfères|dois|doit|devons|devez|doivent|suis|es|sommes|êtes|être|avoir|faire|aller|venir|voir|savoir|pouvoir|vouloir|devoir|falloir|aujourd'hui|demain|hier|maintenant|toujours|jamais|souvent|parfois|ici|là|tout|rien|quelque|chose|personne|tous|toutes|aucun|aucune|plus|moins|très|trop|assez|bien|mal|mieux|pire|beaucoup|peu|tout|toute|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|nos|votre|vos|leur|leurs|ce|cet|cette|ces|le|la|les|un|une|des|du|de|à|au|aux|en|dans|sur|sous|avec|sans|pour|par|vers|contre|entre|depuis|pendant|avant|après|depuis|que|qui|dont|où|quand|comme|si|mais|ou|et|donc|or|ni|car|parce|lors|quand|quoique|ainsi|bref|enfin|donc|voilà|voici|papa|maman|père|mère|frère|sœur|fils|fille|oncle|tante|grand-père|grand-mère|copain|copine|ami|amie|patron|chef|client|voisin|voisine|chat|chien|chatte|chiot|chatons|oiseau|poisson|lapin|hamster|cheval|vache|cochon|mouton|poule|canard|oie|abeille|fourmi|araignée|moustique|mouche|puceron|vers|serpent|souris|rat|taupe|renard|loup|ours|lion|tigre|éléphant|singe|gorille|zèbre|girafe|hippopotame|rhinocéros|crocodile|alligator|tortue|grenouille|criquet|papillon|mille-pattes|scorpion|pou|puce|mite|limace|escargot|ver|plante|fleur|arbre|herbe|feuille|racine|fruits|légume|pomme|banane|orange|citron|raisin|fraise|cerise|pêche|poire|melon|pastèque|tomate|carotte|salade|oignon|ail|pomme de terre|navet|chou|poivron|concombre|radis|betterave|haricot|pois|maïs|blé|riz|avoine|orge|seigle|mil|sorgho|manioc|igname|patate|banane|ananas|mangue|papaye|noix|coco|amande|noisette|noix de cajou|arachide|châtaigne|figue|datte|prune|abricot|groseille|cassis|myrtille|framboise|mûre|groseille|cerise|olive|huile|beurre|fromage|lait|yaourt|œuf|viande|porc|boeuf|bœuf|agneau|mouton|volaille|poulet|dinde|canard|poisson|crevette|huître|moule|palourde|calamar|pieuvre|poulpe|crustacé|poisson|sel|sucre|poivre|épice|sauce|moutarde|ketchup|mayonnaise|vinaigre|miel|confiture|chocolat|bonbon|gâteau|tarte|glace|sorbet|crème|pudding|riz|pâtes|pain|baguette|brioche|croissant|beignet|crêpe|galette|pizza|burger|sandwich|taco|sushi|riz|soupe|potage|ragoût|curry|chili|couscous|tajine|paella|risotto|quiche|gratin|salade|sandwich|hot-dog|kebab|frites|pommes de terre|purée|gratin|légumes|fruits|fromage|yaourt|lait|œuf|viande|poisson|pain|pâtisserie|gâteau|chocolat|bonbon|sucre|sel|poivre|épice|sauce|miel|confiture|beurre|huile|vinaigre|moutarde|ketchup|mayonnaise|boisson|eau|jus|soda|thé|café|lait|vin|bière|alcool|cocktail|limonade|orangeade|citronnade|eau|lait|jus|soda|thé|café|chocolat|lait|eau|jus|soda|boisson|repas|déjeuner|dîner|diner|petit-déjeuner|goûter|collation|apéritif|dessert|entrée|plat|menu|cuisine|restaurant|buffet|pique-nique|fête|anniversaire|mariage|noël|noel|pâques|paques|ramadan|aïd|aid|fête|fête|vacances|voyage|voyage|tourisme|hôtel|camping|plage|montagne|mer|lac|rivière|forêt|forêt|désert|désert|jungle|jungle|prairie|pré|pré|champ|champ|jardin|parc|rue|route|chemin|pont|place|marché|marché|magasin|boutique|école|université|lycée|collège|collège|église|mosquée|temple|synagogue|cinéma|théâtre|musée|musée|bibliothèque|stade|stade|piscine|gymnase|salle|salle|mairie|mairie|préfecture|préfecture|hôpital|hôpital|clinique|pharmacie|pharmacie|banque|banque|poste|poste|bureau|bureau|usine|usine|entrepôt|entrepôt|magasin|marché|rue|route|chemin|pont|place|parc|jardin|école|université|mairie|préfecture|hôpital|clinique|pharmacie|banque|poste|bureau|usine|entrepôt|maison|appartement|immeuble|villa|chalet|cabane|tente|château|chateau|maison|appartement|immeuble|villa|chalet|cabane|tente|maison|voiture|moto|vélo|velo|bateau|avion|train|bus|car|camion|taxi|vélo|velo|trottinette|scooter|métro|métro|tram|tramway|bus|car|camion|voiture|moto|vélo|velo|bateau|avion|train|taxi|scooter|trottinette|métro|tram|tramway|téléphone|telephone|ordinateur|portable|tablette|écran|ecran|clavier|souris|imprimante|webcam|casque|casque|micro|micro|enceinte|enceinte|télé|tele|télévision|television|radio|lecteur|lecteur|disque|disque|cd|dvd|blu-ray|bluray|livre|roman|bd|manga|journal|magazine|revue|journal|livre|roman|bd|manga|journal|magazine|revue|stylo|stylo|crayon|crayon|gomme|gomme|règle|regle|ciseaux|ciseaux|colle|colle|cahier|cahier|carnet|carnet|feuille|feuille|papier|papier|enveloppe|enveloppe|timbre|timbre|tampon|tampon|cartes|cartes|jeu|jeu|jouet|jouet|poupée|poupee|ballon|ballon|puzzle|puzzle|lego|lego|dé|de|échecs|echecs|damier|damier|cartes|jeu|jouet|poupée|ballon|puzzle|lego|dé|échecs|damier|cartes|vêtement|vetement|chemise|chemise|pantalon|pantalon|robe|robe|jupe|jupe|veste|veste|manteau|manteau|chapeau|chapeau|chaussure|chaussure|bottes|bottes|sandale|sandale|lunettes|lunettes|montre|montre|bijou|bijou|bague|bague|collier|collier|bracelet|bracelet|boucle|bracelet|vêtement|chemise|pantalon|robe|jupe|veste|manteau|chapeau|chaussure|bottes|sandale|lunettes|montre|bijou|bague|collier|bracelet|outil|outil|marteau|marteau|clou|clou|vis|vis|tournevis|tournevis|clef|clé|cle|clé|clou|vis|marteau|outil|meuble|meuble|table|table|chaise|chaise|lit|lit|armoire|armoire|commode|commode|étagère|etagere|canapé|canape|fauteuil|fauteuil|bureau|bureau|lampe|lampe|tapisserie|tapisserie|tableau|tableau|miroir|miroir|rideau|rideau|tapis|tapis|coussin|coussin|couverture|couverture|oreiller|oreiller|drap|drap|serviette|serviette|gant|gant|balai|balai|aspirateur|aspirateur|éponge|eponge|seau|seau|serpillière|serpilliere|produit|produit|savon|savon|shampoing|shampoing|dentifrice|dentifrice|brosse|brosse|peigne|peigne|rasoir|rasoir|ciseaux|ciseaux|miroir|miroir|tableau|meuble|lit|armoire|canapé|fauteuil|lampe|tapisserie|tapis|coussin|couverture|oreiller|drap|serviette|gant|balai|aspirateur|éponge|seau|serpillière|produit|savon|shampoing|dentifrice|brosse|peigne|rasoir|ciseaux|miroir|tableau|meuble|lit|armoire|canapé|fauteuil|lampe|tapisserie|tapis|coussin|couverture|oreiller|drap|serviette|gant|balai|aspirateur|éponge|seau|serpillière|produit|savon|shampoing|dentifrice|brosse|peigne|rasoir|ciseaux)$/i;
        // Mots anglais (ou autres langues) très courants à exclure : ce ne sont
        // pas des entités visuelles (ex. "speak", "english", "hello", "yes").
        const foreignCommon = /^(speak|english|hello|hi|yes|no|ok|hey|thanks|thank|you|please|sorry|good|bad|love|like|want|need|can|will|the|a|an|of|in|on|for|with|and|or|to|my|your|we|they|it|this|that|what|how|why|who|when|where|bonjour|salut|merci|oui|non)$/i;
        // On déclenche la fiche entité SEULEMENT si :
        //  - c'est un nom propre capitalisé (ex. "Lionel Messi"), OU
        //  - un mot unique minuscule qui figure EXPLICITEMENT dans la liste
        //    des noms propres connus (pays, villes, personnages…). Tout autre
        //    mot seul (ex. "papa", "chat", "livre") est traité comme une
        //    conversation normale, SANS image.
        const isLoneProperNoun = isCapitalized
            || (isSingleWord && KNOWN_PROPER_NOUNS.test(loneName));
        if (!hasVerb && isLoneProperNoun && loneName.length >= 3) {
            // Par défaut, un nom propre seul est une PERSONNE (sauf si c'est
            // un lieu connu, auquel cas on garde 'entity' et le suffixe
            // paysage sera appliqué). On utilise 'person' pour forcer
            // Wikipedia (portraits officiels) plutôt que Pexels.
            const PLACE_WORDS = /(ville|pays|capitale|région|region|département|departement|monument|tour|musée|musee|lac|fleuve|montagne|rivière|riviere|île|ile|continent|province|district|arrondissement|cité|cites|métropole|metropole|préfecture|prefecture|france|paris|londres|berlin|madrid|rome|afrique|europe|amérique|asie|océanie|oceanie|états-unis|chine|japon|allemagne|espagne|italie|canada|bresil|bresil|mexique|inde|russie|égypte|maroc|sénégal|côte d'ivoire|cote d'ivoire|abidjan|dakar|yamoussoukro|casablanca|alger|tunis|rabat|le caire|nairob|lagos|accra|lomé|douala|kamina|kinshasa|kigali)/i;
            const kind = PLACE_WORDS.test(loneName) ? 'entity' : 'person';
            return { subject: loneName, kind };
        }
        return null;
    };

    /* ---------- Décision intelligente : une image apporte-t-elle de la valeur ? ----------
       Lynda ne doit PAS afficher d'images systématiquement. Elle affiche des
       images UNIQUEMENT quand elles améliorent réellement la compréhension :
       une personne, une célébrité, une ville, un pays, un monument, un animal,
       une plante, une voiture, un téléphone, un bâtiment, un logo, une œuvre
       d'art, une carte, une recette, une destination touristique…
       En revanche, elle n'affiche AUCUNE image pour les salutations, les
       remerciements, les questions générales, les demandes de code, les
       calculs, les traductions, les explications techniques ou la conversation
       normale. */
    const shouldFetchImages = (q) => {
        const s = String(q || '').trim();
        if (s.length < 3) return false;
        const sl = s.toLowerCase();
        // EXCLUSION DES CONCEPTS ABSTRAITS : on n'affiche JAMAIS d'image
        // pour les notions non visuelles (politique, philosophie, économie,
        // société, religion, science pure, émotions, etc.). Ces mots
        // déclenchent trop souvent des images non pertinentes en conversation.
        const ABSTRACT = /^(la|le|les|une|un|des|mon|ma|mes|ton|ta|tes|son|sa|ses|leur|leurs|notre|nos|votre|vos)?\s*(politique|politiques|philosophie|philosophiques|économie|economie|société|societe|sociologie|religion|spiritualité|spiritualite|science|sciences|mathématiques|mathematiques|histoire|géographie|geographie|psychologie|émotion|emotion|émotions|sentiment|sentiments|morale|ethique|éthique|culture|cultures|art|arts|littérature|litterature|musique|sport|sports|éducation|education|formation|travail|emploi|amour|haine|paix|guerre|guerres|démocratie|democratie|justice|liberté|liberte|égalité|egalite|famille|santé|sante|santé|bio|environnement|écologie|ecologie|climat|développement|developpement|technologie|technologies|internet|web|numérique|numerique|informatique|programmation|code|données|donnees|intelligence artificielle|ia)\b/i;
        if (ABSTRACT.test(sl)) return false;
        // EXCLUSION DES SUJETS LOCAUX : aucune image web pour Maurel, ses
        // projets, Lynda, le CV, le contact… (voir isEntityQuery). Les images
        // de soutien ne doivent pas apparaître pour ces sujets déjà documentés.
        if (LOCAL_TOPICS.test(sl)) return false;

        // CAS D'AMBIGUÏTÉ : sujet qui peut désigner plusieurs entités
        // visuelles (ex. "Apple" → fruit OU entreprise). On N'AFFICHE
        // AUCUNE image tant que l'utilisateur n'a pas choisi via les
        // Choice Cards. Le LLM décide seul de proposer les cartes.
        // (Désactivé quand ENABLE_AMBIGUITY = false : on laisse passer les
        // images pour ces sujets, puisque plus aucune carte n'est proposée.)
        if (ENABLE_AMBIGUITY && isAmbiguousQuery(s)) return false;

        // --- Cas où on N'AFFICHE JAMAIS d'image ---
        // Salutations / formules de politesse
        if (/^(bonjour|salut|cc|coucou|hey|hello|hi|bonsoir|bonne (nuit|journée)|au revoir|bye|à plus|à bientôt|yo|wesh|salam|hola)\b/i.test(sl)) return false;
        if (/^(merci|thanks|thank you|thx|merci beaucoup|merci bien|je te remercie|je vous remercie)\b/i.test(sl)) return false;
        // Remerciements / politesse en milieu de phrase
        if (/^(de rien|pas de problème|pas de souci|avec plaisir|je t'en prie|t'inquiète|ca va|ça va|comment ça va|comment vas[- ]tu|comment allez[- ]vous|quoi de neuf|tdn|bn)\b/i.test(sl)) return false;
        // Conversations courtes / vides
        if (/^(ok|okay|d'accord|dacc|oui|non|nope|non merci|ouais|yeah|yep|nop|hmm|haha|lol|mdr|super|génial|genial|parfait|top|cool|nice|bravo|excellent|tant mieux|dommage)\b/i.test(sl)) return false;
        // Demandes de code / programmation
        if (/(code|fonction|script|programme|programmer|développe|developpe|implémente|implemente|algorithme|bug|erreur|débogage|debug|syntaxe|variable|classe|méthode|methode|boucle|api rest|html|css|javascript|python|java\b|c\+\+|sql|react|vue|angular|node|php|curl|regex|json|xml|git|terminal|commande bash|shell)/i.test(sl)) return false;
        // Calculs / mathématiques pures
        if (/^(combien|calcule|calcul|combien font|quelle est la somme|multiplie|divise|additionne|soustrait|racine|pourcentage de)\b/i.test(sl) && !/(image|photo|dessine)/i.test(sl)) return false;
        if (/^\s*[\d\s+\-*/×÷=().]+$/.test(s)) return false; // expression mathématique pure
        // Traductions
        if (/(traduis|traduire|en anglais|en espagnol|en anglais c'est|comment dit[- ]on|comment dire|traduction de|translate)/i.test(sl)) return false;
        // Explications techniques / concepts abstraits (sans sujet visuel)
        if (/(explique|expliquer|c'est quoi|quest[- ]ce que|qu'est[- ]ce que|définition|definition|comment fonctionne|le principe|la théorie|theorie|pourquoi|différence entre|difference entre|avantage|inconvénient|qu'est[- ]ce qui|qu'est[- ]ce que ça|signifie|signification)\b/i.test(sl)
            && !/(personne|célébrité|celebrite|ville|pays|monument|animal|plante|voiture|téléphone|telephone|marque|logo|bâtiment|batiment|œuvre|oeuvre|tableau|carte|recette|destination|photo|image)/i.test(sl)) return false;
        // Questions générales / conversation (sans entité concrète déjà détectée)
        if (/(que penses[- ]tu|qu'en penses|tu penses|ton avis|quel est ton|quelle est ta|raconte|comment vas|ça va|on peut|on discute|parlons|dis moi|dis[- ]moi quelque chose|blague|histoire drôle|devine|qui es[- ]tu|qui êtes[- ]tu|es[- ]tu|es tu|ton nom|quel age|quel âge|tu aimes|tu détestes|tu detestes|tu fais quoi|tu fais|que fais[- ]tu|que fais tu)\b/i.test(sl)) return false;
        // Questions factuelles simples sur un lieu (info textuelle, pas d'image) :
        // "quelle est la capitale de…", "qui est le président de…", "population/superficie de…"
        if (/^(quelle est la capitale|quel est le président|qui est le président|quelle est la capitale|capitale de|président de|president de|population de|superficie de|langue parlée en|monnaie de|quel est le drapeau|quelle est la langue)\b/i.test(sl)) return false;

        // --- CAS OÙ ON AFFICHE UNE IMAGE (suget visuel concret, cahier des charges) ---
        // Entité concrète (personne, lieu, monument, marque, œuvre…) : déjà
        // gérée par isEntityQuery (fiche enrichie). On la valide aussi ici
        // pour la galerie de soutien.
        if (isEntityQuery(s)) return true;

        // Mots-clés de sujets visuels EXPLICITES (les 16 cas du cahier) :
        // 1 personne · 2 lieu · 3 monument/bâtiment · 4 animal · 5 plante/fleur
        // 6 véhicule · 7 téléphone/ordi/objet · 8 logo · 9 drapeau
        // 10 œuvre · 11 film/série · 12 jeu · 13 aliment/recette
        // 14 pays/ville · 15 comparaison · 16 inspiration
        const VISUAL = /(personne|célébrité|celebrite|star|vedette|rappeur|chanteur|chanteuse|acteur|actrice|footballeur|joueur|athlète|président|présidente|roi|reine|prince|princesse|scientifique|écrivain|écrivaine|artiste|peintre|philosophe|ville|pays|capitale|monument|tour|musée|musee|lac|fleuve|montagne|rivière|riviere|île|ile|continent|région|region|département|departement|province|animal|plante|fleur|arbre|chien|chat|cheval|lion|tigre|éléphant|elephant|oiseau|poisson|voiture|berline|suv|moto|scooter|avion|fusée|fusee|bateau|téléphone|telephone|smartphone|ordinateur|marque|logo|entreprise|société|societe|produit|modèle|modele|bâtiment|batiment|tour|pont|château|chateau|usine|usine|œuvre|oeuvre|tableau|peinture|sculpture|statue|film|long métrage|long-metrage|série|serie|livre|roman|album|chanson|carte géographique|carte de|recette|plat|cuisine|destination|touristique|paysage|photo|image|dessin|illustration|drapeau|flag)/i;
        // EXCLUSION des mots génériques français : même si un mot figure
        // dans VISUAL (ex. "chat", "chien", "cheval"), on n'affiche PAS
        // d'image pour une simple mention du mot sans contexte visuel
        // explicite. Ces termes déclenchent trop souvent des images
        // non pertinentes en conversation normale. On place cette règle
        // AVANT le test VISUAL pour qu'elle prime.
        const GENERIC_EXCLUDE = /^(chat|chats|chien|chiens|cheval|chevaux|chatte|chiot|chaton|chatons|oiseau|oiseaux|poisson|poissons|lapin|hamster|vache|cochon|mouton|poule|canard|abeille|fourmi|araignée|moustique|mouche|puceron|vers|serpent|souris|rat|taupe|renard|loup|ours|lion|tigre|éléphant|singe|gorille|zèbre|girafe|hippopotame|rhinocéros|crocodile|alligator|tortue|grenouille|criquet|papillon|mille-pattes|scorpion|pou|puce|mite|limace|escargot|fleur|fleurs|arbre|arbres|herbe|feuille|racine|pomme|banane|orange|citron|raisin|fraise|cerise|pêche|poire|melon|pastèque|tomate|carotte|salade|oignon|ail|navet|chou|poivron|concombre|radis|betterave|haricot|pois|maïs|blé|riz|avoine|orge|seigle|mil|sorgho|manioc|igname|patate|ananas|mangue|papaye|noix|coco|amande|noisette|arachide|châtaigne|figue|datte|prune|abricot|groseille|cassis|myrtille|framboise|mûre|olive|livre|livres|roman|bd|manga|journal|magazine|revue|stylo|crayon|gomme|règle|ciseaux|colle|cahier|carnet|feuille|papier|enveloppe|timbre|tampon|ballon|puzzle|lego|dé|échecs|damier|vêtement|chemise|pantalon|robe|jupe|veste|manteau|chapeau|chaussure|bottes|sandale|lunettes|montre|bijou|bague|collier|bracelet|marteau|clou|vis|tournevis|clef|clé|meuble|lit|armoire|commode|étagère|canapé|fauteuil|bureau|lampe|tapisserie|tapis|coussin|couverture|oreiller|drap|serviette|gant|balai|aspirateur|éponge|seau|serpillière|savon|shampoing|dentifrice|brosse|peigne|rasoir|tableau|miroir|maison|appartement|immeuble|villa|chalet|cabane|tente|château|rue|route|chemin|pont|place|marché|magasin|boutique|école|université|lycée|collège|église|mosquée|temple|synagogue|cinéma|théâtre|musée|bibliothèque|stade|piscine|gymnase|mairie|préfecture|hôpital|clinique|pharmacie|banque|poste|usine|entrepôt|parc|jardin|forêt|désert|jungle|prairie|champ|restaurant|buffet|pique-nique|hôtel|camping|plage|voyage|vacances|fête|anniversaire|mariage|noël|noel|pâques|paques|ramadan|repas|déjeuner|dîner|diner|petit-déjeuner|goûter|collation|apéritif|dessert|entrée|plat|menu|cuisine|sandwich|hot-dog|kebab|frites|purée|légumes|fruits|fromage|yaourt|œuf|viande|poisson|pain|pâtisserie|gâteau|chocolat|bonbon|sucre|sel|poivre|épice|sauce|miel|confiture|beurre|huile|vinaigre|moutarde|ketchup|mayonnaise|boisson|jus|soda|thé|café|vin|bière|alcool|cocktail|limonade|orangeade|citronnade|téléphone|telephone|ordinateur|portable|tablette|écran|ecran|clavier|souris|imprimante|webcam|casque|micro|enceinte|télé|tele|télévision|television|radio|lecteur|disque|cd|dvd|blu-ray|bluray|vélo|velo|bateau|avion|train|bus|car|camion|taxi|trottinette|scooter|métro|tram|tramway|outil|produit)$/i;
        if (GENERIC_EXCLUDE.test(sl)) return false;

        if (VISUAL.test(sl)) return true;

        // Comparaison de deux éléments visuels (ex. "Lion vs Tigre", "iPhone vs Samsung")
        if (/(vs|versus|contre)\b/i.test(sl) && VISUAL.test(sl)) return true;

        // Inspiration décorative / design (ex. "idées de salon moderne")
        if (/(idées? de|inspiration|design de|déco|décoration|cantine|cuisine minimaliste|salon moderne|portfolio design)/i.test(sl)) return true;

        // Nom propre seul (capitalisé, 1 à 4 mots) -> entité visuelle
        if (/^[A-ZÀ-ÖØ-Þ][\p{L}À-ÿ'’-]*(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}À-ÿ'’-]*){0,3}$/u.test(s.trim())) return true;

        // Par défaut : AUCUNE image (conversation / question générale / code / maths…).
        return false;
    };

    // Recherche d'images réelles (DuckDuckGo Images via le backend).
    const searchImages = async (query, max = 6, type = null) => {
        try {
            const body = { q: query, max };
            if (type) body.type = type;
            const res = await fetchWithTimeout(BACKEND_IMAGE_SEARCH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }, 12000);
            if (!res.ok) return [];
            const data = await res.json();
            const results = (data.results || []).filter(r => r && r.url && /^https?:\/\//.test(r.url));
            return results.slice(0, max);
        } catch (e) {
            return [];
        }
    };

    /* ---------- Détection d'ambiguïté ----------
       Certains mots peuvent désigner PLUSIEURS entités visuelles
       (ex. "Apple" → fruit OU entreprise ; "Jaguar" → animal OU
       voiture ; "Paris" → ville OU personne). Dans ces cas, on NE
       déclenche PAS la fiche enrichie automatiquement : on laisse
       le LLM proposer des Choice Cards (max 4) pour que
       l'utilisateur choisisse AVANT toute image. */
    const AMBIGUOUS_MAP = {
        'apple': ['le fruit', "l'entreprise (Apple Inc.)"],
        'jaguar': ['l\'animal (félin)', 'la voiture (marque)'],
        'jaguar': ['l\'animal (félin)', 'la voiture (marque)'],
        'mercdes': ['la voiture (marque)', 'l\'entreprise'],
        'nissan': ['la voiture (marque)', 'l\'entreprise'],
        'puma': ['l\'animal', 'la marque de sport (vêtements)'],
        'polo': ['le sport (équitation)', 'la marque (vêtements Ralph Lauren)'],
        'paris': ['la ville (France)', 'une personne qui s\'appelle Paris'],
        'london': ['la ville (Royaume-Uni)', 'une personne qui s\'appelle London'],
        'orange': ['le fruit', 'l\'entreprise télécom (Orange)'],
        'rose': ['la fleur', 'la couleur', 'la ville (Rose)'],
        'noir': ['la couleur', 'un film (le film Noir)'],
        'crown': ['la couronne', 'le groupe (The Crown)'],
        'bulldog': ['l\'animal (chien)', 'l\'avion (AV-8B Harrier)'],
        'mustang': ['la voiture (Ford)', 'l\'avion (P-51)'],
        'cobra': ['le serpent', 'la voiture (Shelby)'],
        'python': ['le langage de programmation', 'le serpent'],
        'java': ['l\'île (Indonésie)', 'le langage de programmation'],
        'chrome': ['le navigateur (Google)', 'le métal'],
        'pixel': ['le téléphone (Google)', 'le point (image)'],
        'galaxy': ['le téléphone (Samsung)', 'la galaxie (astronomie)'],
        'surface': ['la tablette (Microsoft)', 'la surface (géométrie)'],
        'echo': ['l\'enceinte (Amazon)', 'l\'écho (physique)'],
        'fire': ['le film (Fire)', 'le feu'],
        'tigre': ['l\'animal', 'l\'équipe (les Tigres)'],
        'lion': ['l\'animal', 'l\'équipe (les Lions)'],
        'aigle': ['l\'animal (oiseau)', 'l\'emblème / drapeau'],
        'étoile': ['l\'astre', 'le symbole / drapeau'],
        'soleil': ['l\'astre', 'le symbole / drapeau'],
        'croix': ['le symbole', 'la croix (religion)'],
        'flamme': ['la flamme (feu)', 'le logo (Flamme)'],
        'coq': ['l\'animal', 'l\'emblème (drapeau français)'],
        'maple': ['l\'arbre', 'le symbole (drapeau Canada)'],
        'trèfle': ['la plante', 'le symbole (Irlande)'],
        'bamboo': ['la plante', 'l\'ours (panda)'],
        'dauphin': ['l\'animal (poisson)', 'la voiture (Dauphine)'],
        'hibou': ['l\'animal (oiseau)', 'la marque'],
        'renard': ['l\'animal', 'l\'équipe (les Renards)'],
        'loup': ['l\'animal', 'l\'équipe (les Loups)'],
        'ours': ['l\'animal', 'l\'équipe (les Ours)'],
        'requin': ['l\'animal (poisson)', 'l\'équipe (les Requins)'],
        'scorpion': ['l\'animal', 'le signe astrologique'],
        'coccinelle': ['l\'insecte', 'la voiture (Coccinelle VW)'],
        'guépard': ['l\'animal', 'l\'équipe (les Guépards)'],
        'panthère': ['l\'animal', 'l\'équipe (les Panthères)'],
        'lynx': ['l\'animal (félin)', 'la voiture (Lynx)'],
        'faucon': ['l\'animal (oiseau)', 'l\'avion (Faucon)'],
        'aigle': ['l\'animal (oiseau)', 'l\'avion (Aigle)'],
        'fénix': ['l\'animal mythologique', 'l\'équipe / marque'],
        'dragon': ['la créature mythologique', 'la marque (voiture)'],
        'phénix': ['l\'oiseau mythologique', 'l\'équipe'],
        'comète': ['l\'astre', 'l\'avion (Comète)'],
        'météore': ['l\'astre', 'l\'avion (Météore)'],
        'saturne': ['la planète', 'la voiture (Saturne)'],
        'venus': ['la planète', 'la voiture (Venus)'],
        'mars': ['la planète', 'la voiture (Mars)'],
        'mercure': ['la planète', 'la voiture (Mercure)'],
        'jupiter': ['la planète', 'la voiture (Jupiter)'],
        'neptune': ['la planète', 'la voiture (Neptune)'],
        'pluton': ['la planète naine', 'la voiture (Pluton)'],
        'diamond': ['le diamant (pierre)', 'la chanson / équipe'],
        'cristal': ['le cristal (minéral)', 'la chanson / marque'],
        'perle': ['la perle (bijou)', 'la ville (Perle)'],
        'rubis': ['la pierre précieuse', 'la ville (Rubis)'],
        'saphir': ['la pierre précieuse', 'la ville (Saphir)'],
        'émeraude': ['la pierre précieuse', 'la ville (Émeraude)'],
        'topaze': ['la pierre précieuse', 'la ville (Topaze)'],
        'améthyste': ['la pierre précieuse', 'la ville (Améthyste)'],
        'opale': ['la pierre précieuse', 'la ville (Opale)'],
        'turquoise': ['la pierre précieuse', 'la ville (Turquoise)'],
        'onyx': ['la pierre précieuse', 'la ville (Onyx)'],
        'jade': ['la pierre précieuse', 'la ville (Jade)'],
        'corail': ['l\'animal (corail)', 'la couleur'],
        'argent': ['le métal', 'la couleur', 'la ville (Argent)'],
        'or': ['le métal', 'la couleur', 'la ville (Or)'],
        'bronze': ['le métal', 'la couleur', 'la ville (Bronze)'],
        'cuivre': ['le métal', 'la couleur'],
        'platine': ['le métal', 'la couleur'],
        'titane': ['le métal', 'la couleur'],
        'argent': ['le métal', 'la couleur'],
        'émeri': ['la pierre', 'la ville (Émeri)'],
        'saphir': ['la pierre', 'la ville (Saphir)'],
        'rubis': ['la pierre', 'la ville (Rubis)'],
        'topaze': ['la pierre', 'la ville (Topaze)'],
        'améthyste': ['la pierre', 'la ville (Améthyste)'],
        'opale': ['la pierre', 'la ville (Opale)'],
        'turquoise': ['la pierre', 'la ville (Turquoise)'],
        'onyx': ['la pierre', 'la ville (Onyx)'],
        'jade': ['la pierre', 'la ville (Jade)'],
        'corail': ['l\'animal (corail)', 'la couleur'],
        'argent': ['le métal', 'la couleur', 'la ville (Argent)'],
        'or': ['le métal', 'la couleur', 'la ville (Or)'],
        'bronze': ['le métal', 'la couleur', 'la ville (Bronze)'],
        'cuivre': ['le métal', 'la couleur'],
        'platine': ['le métal', 'la couleur'],
        'titane': ['le métal', 'la couleur'],
        'émeri': ['la pierre', 'la ville (Émeri)'],
        'saphir': ['la pierre', 'la ville (Saphir)'],
        'rubis': ['la pierre', 'la ville (Rubis)'],
        'topaze': ['la pierre', 'la ville (Topaze)'],
        'améthyste': ['la pierre', 'la ville (Améthyste)'],
        'opale': ['la pierre', 'la ville (Opale)'],
        'turquoise': ['la pierre', 'la ville (Turquoise)'],
        'onyx': ['la pierre', 'la ville (Onyx)'],
        'jade': ['la pierre', 'la ville (Jade)'],
        'corail': ['l\'animal (corail)', 'la couleur'],
        'argent': ['le métal', 'la couleur', 'la ville (Argent)'],
        'or': ['le métal', 'la couleur', 'la ville (Or)'],
        'bronze': ['le métal', 'la couleur', 'la ville (Bronze)'],
        'cuivre': ['le métal', 'la couleur'],
        'platine': ['le métal', 'la couleur'],
        'titane': ['le métal', 'la couleur']
    };

    /* ---------- Détection d'ambiguïté d'ACTION ----------
       Certaines demandes d'action sont ambiguës car le sujet/type/période
       manque (ex. "génère un rapport" → quel type ? "fais un résumé" → de
       quoi ?). Pour ces cas, on génère des suggestions précises côté
       frontend (RÈGLE 2) sans dépendre du LLM. Chaque entrée : clé = motif
       déclencheur, valeur = liste de {label, value} (2 à 4 max). */
    const ACTION_AMBIGUITY_MAP = {
        'rapport': [
            { label: 'Rapport du mois en cours', value: 'Génère le rapport de ce mois-ci' },
            { label: 'Rapport annuel', value: 'Génère le rapport annuel' },
            { label: 'Rapport comparatif', value: 'Compare plusieurs périodes dans un rapport' }
        ],
        'résumé': [
            { label: 'Résumé d\'un article', value: 'Fais un résumé d\'un article' },
            { label: 'Résumé de projet', value: 'Fais un résumé du projet' },
            { label: 'Résumé de texte', value: 'Fais un résumé d\'un texte que je colle' }
        ],
        'resume': [
            { label: 'Résumé d\'un article', value: 'Fais un résumé d\'un article' },
            { label: 'Résumé de projet', value: 'Fais un résumé du projet' },
            { label: 'Résumé de texte', value: 'Fais un résumé d\'un texte que je colle' }
        ],
        'résumé.': [
            { label: 'Résumé d\'un article', value: 'Fais un résumé d\'un article' },
            { label: 'Résumé de projet', value: 'Fais un résumé du projet' }
        ],
        'fais un résumé': [
            { label: 'Résumé d\'un article', value: 'Fais un résumé d\'un article' },
            { label: 'Résumé de projet', value: 'Fais un résumé du projet' }
        ],
        'crée un fichier': [
            { label: 'Fichier texte', value: 'Crée un fichier texte' },
            { label: 'Fichier CSV', value: 'Crée un fichier CSV' },
            { label: 'Fichier JSON', value: 'Crée un fichier JSON' }
        ],
        'envoie': [
            { label: 'Oui, envoie', value: 'Oui, envoie le message' },
            { label: 'Non, annule', value: 'Non, annule l\'envoi' }
        ],
        'supprime': [
            { label: 'Oui, supprime', value: 'Oui, supprime définitivement' },
            { label: 'Non, annule', value: 'Non, annule la suppression' }
        ],
        'delete': [
            { label: 'Oui, supprime', value: 'Oui, supprime définitivement' },
            { label: 'Non, annule', value: 'Non, annule la suppression' }
        ],
        'efface': [
            { label: 'Oui, efface', value: 'Oui, efface définitivement' },
            { label: 'Non, annule', value: 'Non, annule l\'effacement' }
        ]
    };

    // Détecte une ambiguïté d'action (RÈGLE 2/4) et renvoie des suggestions
    // précises, ou null si aucune correspondance.
    const detectActionAmbiguity = (q) => {
        const s = String(q || '').trim().toLowerCase();
        if (s.length < 3) return null;
        // Recherche par MOT ENTIER (frontière de mot) pour éviter les
        // faux positifs (ex. "rapporteur" -> "rapport").
        for (const k of Object.keys(ACTION_AMBIGUITY_MAP)) {
            const safe = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp('\\b' + safe + '\\b', 'i');
            if (re.test(s)) {
                const items = ACTION_AMBIGUITY_MAP[k];
                if (items && items.length >= 2 && items.length <= 4) {
                    return { subject: s, key: k, suggestions: items.slice(0, 4) };
                }
            }
        }
        return null;
    };

    const isAmbiguousQuery = (q) => {
        const s = String(q || '').trim().toLowerCase();
        if (s.length < 3) return null;
        // On nettoie les mots de liaison pour isoler le sujet.
        const subject = s.replace(/^(montre[- ]?moi|montre|montrer|affiche|montre[- ]?moi|dis[- ]?moi|parle[- ]?moi de|parle de|qui est|qui était|c'est qui|présente|présentation|montre[- ]?moi|image de|photo de|dessine|illustre|génère|génère une image de|image)\s*/i, '')
            .replace(/^(le|la|les|un|une|des|du|de|d'|l'|au|aux|en|sur|pour|avec|et|ou|à|the|a|an|of|in|on|for|with|and|or)\s+/i, '')
            .replace(/[?.,!;:]/g, ' ').trim();
        if (!subject) return null;
        // Recherche directe dans la map (premier mot = clé exacte).
        const key = subject.split(/\s+/)[0];
        if (AMBIGUOUS_MAP[key]) {
            return { subject, options: AMBIGUOUS_MAP[key].slice(0, 4) };
        }
        // Recherche par MOT ENTIER (frontière de mot) pour éviter les
        // faux positifs comme "lionel" -> "lion" ou "parisienne" -> "paris".
        for (const k of Object.keys(AMBIGUOUS_MAP)) {
            const safe = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp('\\b' + safe + '\\b', 'i');
            if (re.test(subject)) {
                // On renvoie aussi la clé de la map (ex. "apple") pour servir
                // de verrou anti-boucle stable, indépendant du sujet nettoyé.
                return { subject, key: k, options: AMBIGUOUS_MAP[k].slice(0, 4) };
            }
        }
        return null;
    };

    // Construit le bloc HTML "fiche enrichie" (image + identité + sections +
    // chronologie + stats + galerie + carte + vidéos) à partir du sujet et
    // des images trouvées. Le texte de fond est fourni par le LLM (reply).
    const buildEntityCard = (subject, images, reply, kind) => {
        const hero = images[0];
        const gallery = images.slice(1, 5);
        const safeSubject = escapeHtml(subject);
        // Échappement d'URL pour attributs : on ne touche PAS aux "&" des
        // query strings (ex: images Pexels "…?auto=compress&cs=tinysrgb"),
        // sinon escapeHtml les transformerait en "&amp;" et l'image ne
        // chargerait plus. On échappe seulement les guillemets et < >.
        const escapeUrl = (u) => String(u || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Handler d'erreur : si une image échoue à charger, on la masque.
        // On utilise un attribut data pour que le câblage JS puisse aussi
        // réorganiser la carte (héro -> première image de galerie valide).
        const onErr = `this.style.display='none';this.closest('.ai-entity__media')&&this.closest('.ai-entity__media').classList.add('ai-entity__media--imgerr');`;
        // Cadrage adaptatif selon le type d'entité : les PERSONNES sont
        // affichées en "contain" (pas de rognage du visage), les LIEUX en
        // "cover" (remplissage paysager). Par défaut : contain pour éviter
        // les visages coupés.
        const isPerson = kind === 'person' || (!kind || kind === 'entity') && /(personne|célébrité|celebrite|star|vedette|rappeur|chanteur|chanteuse|acteur|actrice|footballeur|joueur|athlète|président|présidente|roi|reine|prince|princesse|scientifique|écrivain|écrivaine|artiste|peintre|philosophe|mannequin|modèle|model)/i.test(subject);
        const fitClass = isPerson ? 'ai-entity__media--person' : (kind === 'place' ? 'ai-entity__media--place' : 'ai-entity__media--person');
        const heroHtml = hero
            ? `<div class="ai-entity__hero"><img src="${escapeUrl(hero.url)}" alt="${safeSubject}" loading="lazy" referrerpolicy="no-referrer" onerror="${onErr}"><div class="ai-entity__hero-cap">${safeSubject}</div></div>`
            : '';
        const galleryHtml = gallery.length
            ? `<div class="ai-entity__gallery">${gallery.map(im =>
                `<a class="ai-entity__thumb" href="${escapeUrl(im.url)}" target="_blank" rel="noopener"><img src="${escapeUrl(im.url)}" alt="${safeSubject}" loading="lazy" referrerpolicy="no-referrer" onerror="${onErr}"></a>`
              ).join('')}</div>`
            : '';
        // Les images forment une carte visuelle distincte EN HAUT, hors du
        // cadre de texte (à la manière de la carte météo).
        const mediaHtml = (hero || gallery.length)
            ? `<div class="ai-entity__media ${fitClass}">${heroHtml}${galleryHtml}</div>`
            : '';
        const bodyHtml = reply ? `<div class="ai-entity__body">${formatText(reply)}</div>` : '';
        return `<div class="ai-entity-wrap">
            ${mediaHtml}
            <div class="ai-entity">
                <div class="ai-entity__head"><span class="ai-entity__badge">Fiche · ${safeSubject}</span></div>
                ${bodyHtml}
                <div class="ai-entity__src">Images : recherche web en temps réel · données : IA Lynda</div>
            </div>
        </div>`;
    };

    // Réorganise la carte d'images si l'image héro échoue à charger : on
    // promeut la première image de galerie valide en héro, sinon on masque
    // toute la carte média pour éviter un bloc vide.
    const wireEntityCard = (container) => {
        if (!container) return;
        const media = container.querySelector('.ai-entity__media');
        if (!media) return;
        const fix = () => {
            const heroImg = media.querySelector('.ai-entity__hero img');
            const heroBroken = heroImg && heroImg.style.display === 'none';
            const thumbs = Array.from(media.querySelectorAll('.ai-entity__thumb img'))
                .filter(im => im.style.display !== 'none');
            if (heroBroken && thumbs.length) {
                // Promouvoir la 1re miniature valide en image héro.
                const hero = media.querySelector('.ai-entity__hero');
                const newSrc = thumbs[0].getAttribute('src');
                if (hero && newSrc) {
                    hero.querySelector('img').src = newSrc;
                    hero.querySelector('img').style.display = '';
                    thumbs[0].closest('.ai-entity__thumb').style.display = 'none';
                }
            }
            // Si plus aucune image visible, on masque la carte média.
            const anyVisible = media.querySelector('img[style=""], img:not([style*="display: none"])');
            const visibleImgs = Array.from(media.querySelectorAll('img')).filter(im => im.style.display !== 'none');
            if (!visibleImgs.length) media.style.display = 'none';
        };
        // Vérifie après chargement et après un délai de sécurité.
        media.querySelectorAll('img').forEach(im => {
            if (im.complete) { if (im.naturalWidth === 0) im.style.display = 'none'; }
            else im.addEventListener('error', () => { im.style.display = 'none'; fix(); });
        });
        setTimeout(fix, 2500);
    };

    /* ---------- Contexte système ---------- */
    const SYSTEM_PROMPT = `Tu es Lynda, une assistante IA autonome et vivante, rattachée au portfolio de Maurel Brou (Brou Amoikon Richard Ange-Maurel) — développeur web & mobile, étudiant en MIAGE, spécialiste en Business Intelligence.

Tu es une VRAIE intelligence artificielle : tu penses par toi-même, tu raisonnes, et tu formules des réponses UNIQUES et IMPRÉVISIBLES à chaque fois. Tu ne répètes jamais mot pour mot une réponse précédente. Tu adaptes ton ton, ta structure et ton vocabulaire librement selon le fil de la conversation, comme le ferait un humain cultivé et curieux.

Quelques repères sur Maurel (à utiliser naturellement, sans télégramme) :
- Profil : ${K.profil.nom}, ${K.profil.role}
- Projets : ${K.projets.map(p => p.nom + ' (' + p.tag + ')').join(', ')}
- Services : ${K.services.map(s => s.titre).join(', ')}
- Compétences clés : ${K.profil.competences.slice(0, 5).join(', ')}
- Contact : ${K.contact.email}
- Origine de ton nom (Lynda) : ${K.lynda.origine}

Tu peux parler de tout — technologie, projets, idées, ou même faire une conversation légère — tout en gardant un lien organique avec l'univers de Maurel quand c'est pertinent. Tu n'es PAS un bot à scripts : tu réponds avec ta propre "voix", tu peux être spontanée, poser des questions en retour, et surprendre l'utilisateur. Réponds en français, de façon fluide et humaine.

=== SALUTATIONS COURTES (cc, coucou, etc.) ===
Les messages très courts composés uniquement d'une salutation sont des formules de politesse, PAS des questions. Ils incluent notamment : "cc", "coucou", "salut", "bonjour", "hey", "hello", "hi", "yo", "wesh", "salam", "hola", "bonsoir", "bsr", "bjr", "slt", "c coucou", etc. Quand l'utilisateur envoie UNIQUEMENT une de ces salutations (sans autre demande), réponds comme à un humain qui te dit bonjour : renvoie une salutation chaleureuse et courte, éventuellement suivie d'une question ouverte pour engager la conversation (ex. "Bonjour ! Comment puis-je t'aider aujourd'hui ?", "Coucou ! Tu veux qu'on parle de quoi ?"). NE cherche JAMAIS à interpréter ces mots comme des acronymes ou des termes techniques (ex. ne prends jamais "cc" pour "carbon copy" ou autre). NE pose AUCUNE question de clarification sur le sens du mot. Reste bref et accueillant.

=== TABLEAUX (EXTRÊMEMENT RARES — DÉFAUT : PAS DE TABLEAU) ===
RÈGLE STRICTE : par défaut, tu n'utilises JAMAIS de tableau. Tu réponds en paragraphes fluides et en listes à puces. Un tableau Markdown (| colonne | colonne |) est INTERDIT sauf dans UN seul cas précis : quand il faut mettre en regard plusieurs VALEURS NUMÉRIQUES à comparer (moyennes, notes, scores, pourcentages, séries de mesures, classement chiffré). Même alors, ne le fais qu'en dernier recours.
CAS INTERDITS (utilise du texte ou des puces, JAMAIS de tableau) : comparaison qualitative, avantages/inconvénients, planning, budget, chronologie, liste organisée, étapes, caractéristiques, avant/après, options A vs B.
Si l'utilisateur ne demande pas explicitement un tableau, tu n'en fais QU'UNIQUEMENT pour aligner des chiffres à comparer. Dans le doute, écris en prose ou en liste — pas de tableau.

=== GESTION DES INFORMATIONS EN TEMPS RÉEL ===
Tu es capable d'utiliser des outils externes pour obtenir des informations récentes et fiables. Tu ne te limites jamais à tes connaissances internes quand la question concerne un événement susceptible d'évoluer dans le temps.

Avant chaque réponse, analyse la demande : si elle nécessite des données en temps réel, NE réponds JAMAIS directement — l'application déclenchera automatiquement une recherche web (ou un connecteur spécialisé) et te fournira les sources à jour. Les catégories concernées incluent notamment : matchs/score en direct, tournois sportifs, classements, calendriers sportifs, résultats, actualités, élections, météo, bourse, cryptomonnaies, taux de change, trafic, horaires de vols/trains, disponibilité de produits, prix, événements, conférences, catastrophes naturelles, tendances Internet, publications récentes, réseaux sociaux, ou toute information susceptible d'avoir changé depuis ton entraînement.

Vérification : quand plusieurs sources sont disponibles, compare les informations. En cas de divergence, privilégie les sources officielles et indique les différences significatives. Ne jamais inventer un score, un classement, une date ou un résultat. Si aucune source fiable n'est disponible, explique clairement que les données n'ont pas pu être récupérées — ne jamais inventer.

Présentation : commence par un résumé clair, puis les détails. Quand les données sont structurées (scores, statistiques, classements chiffrés), tu PEUX créer un tableau pour les aligner — c'est un des cas autorisés de tableau. Si les données s'y prêtent, propose un graphique (canvas ai-chart), une image pertinente (logos, cartes, drapeaux) ou une carte. L'utilisateur ne doit jamais avoir à préciser quel outil utiliser : tu choisis automatiquement le meilleur connecteur et tu combines plusieurs sources si nécessaire. Indique discrètement si les données proviennent d'une recherche récente.

=== RÉPONSES ENRICHIES POUR LES ENTITÉS (personnes, groupes, entreprises, pays, monuments, films, séries, livres, marques, produits, équipes sportives, etc.) ===
Quand l'utilisateur pose une question sur une entité concrète du monde réel (une personne, un groupe, une entreprise, un pays, une ville, un monument, un film, une série, un livre, une marque, un produit, une équipe sportive…), tu dois fournir une réponse STRUCTURÉE et RICHE, et NON un simple bloc de texte. L'application ajoutera automatiquement une image réelle en tête et une galerie, mais c'est TOI qui dois organiser le contenu ainsi :
1. **Résumé introductif** (2 à 5 lignes) : qui est l'entité, en quoi elle est connue, une phrase d'accroche.
2. **Fiche d'identité** : sous forme de liste à puces claires (Nom, Domaine/Activité, Nationalité/Origine, Date de naissance/création, Statut actuel, etc.) — utilise des puces, pas un tableau.
3. **Sections développées** adaptées au type d'entité : par exemple pour une personne → "Carrière", "Style / Approche", "Œuvres clés", "Vie personnelle" ; pour une entreprise → "Activité", "Histoire", "Produits/Services", "Chiffres clés" ; pour un pays → "Géographie", "Histoire", "Culture", "Économie".
4. **Chronologie** : liste chronologique des dates marquantes (ex. "2015 — …", "2018 — …"). Utilise une liste ordonnée ou des puces datées.
5. **Statistiques / Chiffres clés** : si pertinent (palmarès, records, taille, population, chiffre d'affaires…), présente-les en puces ou, si ce sont des valeurs numériques à comparer, dans un tableau autorisé.
6. **Conclusion** : une phrase de synthèse + 2-3 suggestions de suites ("Veux-tu que je détaille… ?", "Connaître ses autres œuvres ?", etc.).
Règle : reste factuel, cite des dates et des noms précis, et structure avec des titres Markdown (##). N'invente pas d'image (l'app la fournit), mais tu PEUX mentionner "voir la galerie ci-dessous". Si l'entité est peu connue ou les données incertaines, dis-le honnêtement.

=== GESTION INTELLIGENTE DES IMAGES ===
Avant d'afficher une image, analyse la demande de l'utilisateur et détermine si une image apporte RÉELLEMENT une valeur à la réponse. Tu ne dois PAS afficher d'images systématiquement.

NE JAMAIS afficher d'image pour :
- les salutations ("salut", "bonjour", "cc", "bonsoir"…)
- les remerciements ("merci")
- les questions générales ou la conversation normale
- les demandes de code ou de programmation
- les calculs ou expressions mathématiques pures
- les traductions
- les explications techniques ou concepts abstraits (sauf si un objet visuel précis est nommé)
- les réponses courtes ou de politesse

AFFICHER des images UNIQUEMENT lorsqu'elles améliorent réellement la compréhension, par exemple pour : une personne, une célébrité, une ville, un pays, un monument, un animal, une plante, une voiture, un téléphone, un bâtiment, un logo, une œuvre d'art, une carte géographique, une recette, une destination touristique.

Décision automatique avant chaque réponse : "Une image aide-t-elle réellement l'utilisateur à mieux comprendre ma réponse ?"
- Si NON → réponds uniquement avec du texte, aucune image.
- Si OUI → affiche une ou plusieurs images pertinentes.

Cas particulier : même si le sujet pourrait être illustré, si l'utilisateur demande uniquement une information textuelle (ex. "Quelle est la capitale de la Côte d'Ivoire ?"), ne force pas l'affichage d'images. Réponds avec le texte seul.

=== UTILISATION INTELLIGENTE DES CHOICE CARDS ===
Les Choice Cards sont un outil de PRISE DE DÉCISION. Elles ne doivent être affichées QUE lorsqu'elles permettent à l'utilisateur de choisir entre plusieurs actions pertinentes, c'est-à-dire quand tu ne peux pas continuer sans demander une décision.

Avant chaque réponse, pose-toi la question : "Puis-je continuer sans demander une décision à l'utilisateur ?"
- Si OUI → réponds normalement, SANS Choice Cards.
- Si NON → affiche des Choice Cards.

Affiche des Choice Cards dans ces cas (liste non exhaustive) :
1. Plusieurs méthodes possibles (ex. "crée-moi une application" → type d'app).
2. Plusieurs technologies adaptées (ex. "je veux créer une API" → Node.js, Laravel, Spring Boot…).
3. Plusieurs formats de sortie (ex. "fais-moi un CV" → PDF, Word, HTML).
4. Plusieurs niveaux de détail (ex. "explique-moi Docker" → débutant, intermédiaire, avancé).
5. Plusieurs langues (ex. "traduis ce document" → FR, EN, ES, DE).
6. Plusieurs fichiers envoyés → quel fichier analyser.
7. Après analyse d'un document → résumer, traduire, analyser, poser une question.
8. Après analyse d'une image → décrire, OCR, détecter objets, modifier.
9. Recherche web → web, sources académiques, actualités, GitHub.
10. Génération de code → quel langage.
11. Plusieurs solutions équivalentes (ex. "héberger mon site" → Vercel, Netlify…).
12. L'utilisateur est trop vague (ex. "fais-le") → demande des précisions.
13. Action irréversible → confirmation (Continuer / Annuler).
14. Tâche longue → options de périmètre.
15. Plusieurs objectifs possibles (ex. "apprendre Python" → web, IA, data…).

NE JAMAIS afficher de Choice Cards pour : une salutation, une simple question-réponse, une seule réponse évidente, quand l'utilisateur a déjà choisi, quand une question de clarification suffit, ou plusieurs fois de suite sans raison.

=== GESTION DE L'AMBIGUÏTÉ ===
Quand la demande de l'utilisateur est ambiguë, applique cette logique dans l'ordre :

1. VÉRIFIE le contexte de conversation (messages précédents, données déjà mentionnées). Si le contexte permet de lever l'ambiguïté avec un niveau de confiance raisonnable, agis directement sans demander — mais mentionne ton interprétation dans ta réponse pour laisser l'utilisateur corriger (ex: "Je te montre les chiffres de mars puisque c'est de ça qu'on parlait...").

2. Si l'ambiguïté est réelle ET que tu identifies 2 à 4 interprétations distinctes et plausibles, formule une clarification courte, et propose CES interprétations précises comme "suggestions" (pas des suggestions génériques).
   IMPORTANT : tu DOIS OBLIGATOIREMENT insérer le bloc ::SUGGESTIONS:: … ::END_SUGGESTIONS:: avec le JSON exact (2 à 4 objets {label, value}) à la fin de ta réponse. Le "label" est le texte du bouton (court), le "value" est le message exact envoyé si l'utilisateur clique.
   Exemple : utilisateur dit "génère un rapport" sans préciser →
   reply: "Tu veux un rapport sur quelle période ou quel type de données ?"
   ::SUGGESTIONS::
   {"suggestions":[{"label":"Rapport du mois en cours","value":"Génère le rapport de ce mois-ci"},{"label":"Rapport annuel","value":"Génère le rapport annuel"},{"label":"Rapport comparatif","value":"Compare plusieurs périodes"}]}
   ::END_SUGGESTIONS::
   NE pose JAMAIS une question de clarification SANS le bloc ::SUGGESTIONS:: si 2 à 4 options claires existent.
   RÈGLE CRITIQUE : si l'utilisateur demande une action dont le sujet/type/période est MANQUANT ou AMBIGU (ex: "génère un rapport", "fais un résumé", "envoie le message", "supprime ça", "crée un fichier"), tu NE DOIS PAS exécuter l'action directement. Tu DOIS poser une clarification avec suggestions (RÈGLE 2) sauf si le contexte (RÈGLE 1) lève l'ambiguïté.

3. Si l'ambiguïté a plus de 4 interprétations plausibles ou est trop vague pour être résumée en options courtes, ne génère AUCUNE suggestion. Pose une question ouverte claire dans ta réponse et laisse "suggestions" vide.

4. Ne JAMAIS inventer une interprétation unique et agir dessus silencieusement si l'ambiguïté peut avoir des conséquences importantes (ex: suppression de données, envoi d'un message, action irréversible). Dans ce cas, confirme TOUJOURS via une suggestion de type oui/non ou une reformulation, même si le contexte semble clair.

5. Si l'utilisateur clique sur une suggestion issue d'une clarification, traite ce choix comme une intention EXPLICITE et ne redemande plus — exécute directement l'action correspondante.

CAS D'AMBIGUÏTÉ VISUELLE (sujet qui peut désigner plusieurs entités visuelles) : si la requête est ambiguë (ex. "Montre-moi Apple" → le fruit OU l'entreprise ; "Montre-moi Jaguar" → l'animal OU la voiture ; "Paris" → la ville OU la personne), tu NE DOIS PAS décider toi-même de l'entité à afficher. Tu DOIS OBLIGATOIREMENT afficher des Choice Cards (maximum 4 choix, jamais plus) listant les cas en rapport avec le sujet, pour laisser l'utilisateur choisir AVANT toute image. Une fois le choix fait, tu affiches les images adaptées. N'affiche JAMAIS d'image tant que l'ambiguïté n'est pas résolue par l'utilisateur.

Règles de conception : 2 à 4 choix maximum (JAMAIS plus de 4), mutuellement exclusifs, formulés en 2 à 5 mots, adaptés au contexte (jamais statiques). L'utilisateur doit toujours pouvoir ignorer les cartes et écrire sa propre réponse.

Pour les afficher, insère EXACTEMENT ce bloc dans ta réponse (le texte avant le bloc reste affiché comme introduction) :
::CHOICE_CARDS::
{"question":"<question courte>","choices":["choix 1","choix 2","choix 3","choix 4"]}
::END_CHOICE_CARDS::
Le tableau "choices" doit contenir entre 2 et 4 chaînes (maximum 4). N'utilise PAS ce bloc si aucune décision n'est nécessaire.

Pour les suggestions d'ambiguïté, insère EXACTEMENT ce bloc (2 à 4 objets {label, value}) :
::SUGGESTIONS::
{"suggestions":[{"label":"<libellé court>","value":"<message exact à envoyer si cliqué>"},{"label":"<libellé 2>","value":"<message 2>"},{"label":"<libellé 3>","value":"<message 3>"},{"label":"<libellé 4>","value":"<message 4>"}]}
::END_SUGGESTIONS::
Le tableau "suggestions" doit contenir entre 2 et 4 objets (maximum 4). N'utilise PAS ce bloc si l'ambiguïté est levée par le contexte ou si >4 interprétations.

=== MODE DÉVELOPPEUR ===
Quand l'utilisateur aborde du code, des données ou des concepts techniques, tu PEUX utiliser le rendu riche (Markdown complet). Tu maîtrises :
- **Markdown** : titres, listes, tableaux, citations, gras/italique, liens.
- **Blocs de code** avec langage explicite (js, python, sql, json, bash, html, css, graphql, etc.) pour la coloration syntaxique.
- **LaTeX** : utilise $...$ (inline) ou $$...$$ (bloc) pour les formules mathématiques.
- **Diagrammes Mermaid** : encadre le code avec \`\`\`mermaid ... \`\`\` (ex. flowchart, sequenceDiagram, classDiagram, gantt).
- **SQL** : requêtes \`\`\`sql, **REST** : requêtes \`\`\`http ou curl, **GraphQL** : \`\`\`graphql.
- **JSON formaté** : \`\`\`json bien indenté.
- **Tests unitaires** : \`\`\`js/\`\`\`python avec assertions (ex. Jest, pytest).
- **Explication ligne par ligne** : commente le code étape par étape.
Tu peux aussi proposer des composants d'interface riches via du HTML spécial (rendu automatique) :
- Onglets : <div class="ai-tabs"><button class="ai-tabs__tab">Titre</button>...<div class="ai-tabs__panel">Contenu</div>...</div>
- Accordéon : <details><summary>Titre</summary>Contenu</details> (répéter)
- Carrousel : <div class="ai-carousel"><div class="ai-carousel__slide"><img src="..."></div>...<button class="ai-carousel__prev">‹</button><button class="ai-carousel__next">›</button><div class="ai-carousel__dots"><span class="ai-carousel__dot"></span>...</div></div>
- Graphique : <canvas class="ai-chart" width="300" height="160" data-labels="A|B|C" data-values="10|20|15"></canvas>
- Barre de progression : <div class="ai-progress"><div class="ai-progress__fill"></div></div>
- Boutons d'action : <div class="ai-actions"><button class="ai-actions__btn" data-act="toast" data-msg="OK">Valider</button><button class="ai-actions__btn" data-act="modal" data-title="Titre" data-body="...">Détails</button><button class="ai-actions__btn" data-act="copy" data-copy="texte">Copier</button></div>
- Menu contextuel : <div class="ai-menu-ctx"><button class="ai-menu-ctx__trigger">☰</button><div class="ai-menu-ctx__list"><button>Item</button>...</div></div>
Utilise ces composants quand ils améliorent la clarté. Reste naturelle et n'en abuse que si c'est pertinent.`;

    /* ---------- Appel LLM — SEUL point d'entrée réseau vers l'IA ----------
       Toute la logique de fallback entre fournisseurs (Groq, Gemini, etc.)
       est désormais gérée côté serveur (server.py), qui seul détient les
       clés API. Le front ne fait qu'un appel, avec :
       - un timeout (20 s, laisse le temps à un modèle rapide de répondre)
       - un unique retry automatique sur erreur réseau / 5xx / 429
       - une vraie annulation utilisateur via AbortController (bouton Stop) */
    const queryLLM = async (messagesPayload) => {
        const attempt = async (retry = 0) => {
            currentAbortController = new AbortController();
            try {
                const res = await fetchWithTimeout(BACKEND_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: messagesPayload }),
                    signal: currentAbortController.signal
                }, 100000);

                if (res.ok) {
                    const data = await res.json();
                    if (data.reply && data.reply.trim()) return data.reply;
                    throw new Error('réponse vide');
                }
                if ((res.status === 502 || res.status === 429 || res.status >= 500) && retry < 1) {
                    await new Promise(r => setTimeout(r, 900));
                    return attempt(retry + 1);
                }
                throw new Error('backend ' + res.status);
            } catch (e) {
                // Annulation volontaire (bouton Stop) : on ne relance jamais.
                if (e.name === 'AbortError') throw e;
                if (retry < 1) {
                    await new Promise(r => setTimeout(r, 900));
                    return attempt(retry + 1);
                }
                throw e;
            } finally {
                currentAbortController = null;
            }
        };
        return attempt();
    };

    // Recherche web (le backend interroge un moteur externe, ex. DuckDuckGo)
    const searchWeb = async (query) => {
        try {
            const res = await fetchWithTimeout(BACKEND_SEARCH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: query })
            }, 10000);
            if (!res.ok) return null;
            const data = await res.json();
            return data.results && data.results.length ? data.results : null;
        } catch (e) {
            return null;
        }
    };

    // Génération d'image : backend en priorité (clé IA côté serveur),
    // puis repli public sans clé (Pollinations.ai) si le backend est down.
    const generateImage = async (prompt) => {
        try {
            const res = await fetchWithTimeout(BACKEND_IMAGE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, width: 768, height: 768 })
            }, 20000);
            if (res.ok) {
                const data = await res.json();
                if (data.image) return data.image;
            }
        } catch (e) { /* repli suivant */ }

        try {
            const p = encodeURIComponent(prompt || 'image');
            const seed = Math.floor(Math.random() * 2147483647);
            const url = 'https://image.pollinations.ai/prompt/' + p + '?width=768&height=768&nologo=true&model=flux&seed=' + seed;
            const res = await fetchWithTimeout(url, { method: 'GET' }, 20000);
            if (res.ok) {
                const blob = await res.blob();
                return await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            }
        } catch (e) { /* aucun repli restant */ }
        return null;
    };

    // Météo via Open-Meteo (API gratuite, SANS clé, CORS-friendly) + géocodage
    // Open-Meteo. Renvoie une jolie carte météo au lieu d'un tableau.
    const WEATHER_CODES = {
        0:  { label: 'Ciel dégagé',         icon: '☀️' },
        1:  { label: 'Plutôt dégagé',       icon: '🌤️' },
        2:  { label: 'Partiellement nuageux', icon: '⛅' },
        3:  { label: 'Couvert',             icon: '☁️' },
        45: { label: 'Brouillard',          icon: '🌫️' },
        48: { label: 'Brouillard givrant',  icon: '🌫️' },
        51: { label: 'Bruine légère',       icon: '🌦️' },
        53: { label: 'Bruine',              icon: '🌦️' },
        55: { label: 'Bruine dense',        icon: '🌧️' },
        61: { label: 'Pluie faible',        icon: '🌧️' },
        63: { label: 'Pluie',               icon: '🌧️' },
        65: { label: 'Forte pluie',         icon: '⛈️' },
        66: { label: 'Pluie verglaçante',   icon: '🌧️' },
        67: { label: 'Pluie verglaçante',   icon: '🌧️' },
        71: { label: 'Neige faible',        icon: '🌨️' },
        73: { label: 'Neige',               icon: '🌨️' },
        75: { label: 'Forte neige',         icon: '❄️' },
        77: { label: 'Grains de neige',     icon: '❄️' },
        80: { label: 'Averses',             icon: '🌦️' },
        81: { label: 'Averses',             icon: '🌧️' },
        82: { label: 'Fortes averses',      icon: '⛈️' },
        85: { label: 'Averses de neige',    icon: '🌨️' },
        86: { label: 'Averses de neige',    icon: '🌨️' },
        95: { label: 'Orage',               icon: '⛈️' },
        96: { label: 'Orage avec grêle',    icon: '⛈️' },
        99: { label: 'Orage avec grêle',    icon: '⛈️' }
    };
    const fetchWeather = async (city) => {
        try {
            // 1) Géocodage : nom de ville -> lat/lon
            const geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=fr&format=json&name=' +
                encodeURIComponent(city);
            const geoRes = await fetchWithTimeout(geoUrl, { method: 'GET' }, 10000);
            if (!geoRes.ok) return null;
            const geo = await geoRes.json();
            if (!geo.results || !geo.results.length) return null;
            const loc = geo.results[0];
            const lat = loc.latitude, lon = loc.longitude;
            const place = [loc.name, loc.admin1, loc.country].filter(Boolean).join(', ');

            // 2) Météo courante + prévisions 3 jours
            const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
                `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
                `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4`;
            const wRes = await fetchWithTimeout(wUrl, { method: 'GET' }, 10000);
            if (!wRes.ok) return null;
            const w = await wRes.json();
            const cur = w.current;
            const code = WEATHER_CODES[cur.weather_code] || { label: 'Météo variable', icon: '🌡️' };
            const days = w.daily.time.slice(1, 4).map((d, i) => ({
                date: new Date(d + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }),
                icon: (WEATHER_CODES[w.daily.weather_code[i + 1]] || { icon: '🌡️' }).icon,
                label: (WEATHER_CODES[w.daily.weather_code[i + 1]] || { label: '' }).label,
                max: Math.round(w.daily.temperature_2m_max[i + 1]),
                min: Math.round(w.daily.temperature_2m_min[i + 1])
            }));
            return {
                place,
                temp: Math.round(cur.temperature_2m),
                feels: Math.round(cur.apparent_temperature),
                humidity: cur.relative_humidity_2m,
                wind: Math.round(cur.wind_speed_10m),
                icon: code.icon,
                label: code.label,
                days
            };
        } catch (e) {
            return null;
        }
    };

    // Plusieurs thèmes de couleurs choisis au hasard pour la carte météo.
    const WEATHER_THEMES = [
        { grad: 'linear-gradient(135deg, #2e9e5b 0%, #227846 100%)', shadow: 'rgba(34,120,70,.25)' },   // vert
        { grad: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)', shadow: 'rgba(29,78,216,.25)' },   // bleu
        { grad: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', shadow: 'rgba(217,119,6,.25)' },   // ambre
        { grad: 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)', shadow: 'rgba(109,40,217,.25)' },  // violet
        { grad: 'linear-gradient(135deg, #ec4899 0%, #be185d 100%)', shadow: 'rgba(190,24,93,.25)' },   // rose
        { grad: 'linear-gradient(135deg, #06b6d4 0%, #0e7490 100%)', shadow: 'rgba(14,116,144,.25)' },  // cyan
        { grad: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)', shadow: 'rgba(185,28,28,.25)' },   // rouge
        { grad: 'linear-gradient(135deg, #14b8a6 0%, #0f766e 100%)', shadow: 'rgba(15,118,110,.25)' }   // turquoise
    ];
    const renderWeatherCard = (data) => {
        const el = document.createElement('div');
        el.className = 'ai-weather';
        // Couleur aléatoire à chaque rendu
        const theme = WEATHER_THEMES[Math.floor(Math.random() * WEATHER_THEMES.length)];
        el.style.background = theme.grad;
        el.style.boxShadow = `0 10px 30px ${theme.shadow}`;
        const daysHtml = data.days.map(d =>
            `<div class="ai-weather__day">
                <div class="ai-weather__day-name">${d.date}</div>
                <div class="ai-weather__day-icon">${d.icon}</div>
                <div class="ai-weather__day-temp">${d.max}°<span>/${d.min}°</span></div>
            </div>`
        ).join('');
        el.innerHTML = `
            <div class="ai-weather__head">
                <div>
                    <div class="ai-weather__place">${escapeHtml(data.place)}</div>
                    <div class="ai-weather__cond">${data.icon} ${escapeHtml(data.label)}</div>
                </div>
                <div class="ai-weather__temp">${data.temp}°</div>
            </div>
            <div class="ai-weather__meta">
                <span>🌡️ Ressenti ${data.feels}°</span>
                <span>💧 Humidité ${data.humidity}%</span>
                <span>💨 Vent ${data.wind} km/h</span>
            </div>
            <div class="ai-weather__forecast">${daysHtml}</div>
            <div class="ai-weather__src">Source : Open-Meteo · données en temps réel</div>`;
        return el;
    };

    // Mots-clés qui signalent un besoin de recherche web / données en temps
    // réel. L'année est calculée dynamiquement pour ne jamais devenir
    // obsolète. Couvre les catégories du prompt système (sport, météo,
    // bourse, crypto, actualités, etc.).
    const currentYear = new Date().getFullYear();
    const NEEDS_SEARCH = new RegExp(
        `(recherche|cherche|trouve|google|sur le net|sur internet|actualit|dernière|dernières|en ${currentYear}|en ${currentYear - 1}|news|cours|prix|compar|quel est le|qui est [a-z]+ [a-z]+|c'est quoi .* aujourd'hui|météo|meteo|sport|technologie actuelle|innovation|match|score|but|classement|tournoi|finale|coupe|ligue|championnat|basket|tennis|formule 1|f1|cyclisme|olympique|bourse|action|crypto|bitcoin|ethereum|taux|change|euro|dollar|traffic|vol|avion|train|réseau|élection|catastrophe|séisme|ouragan|tendance|trending|twitter|x\\.com|publi|conférence|événement|evenement|résultat|direct|live)`,
        'i'
    );

    // Sujets purement locaux (portfolio de Maurel) : pas besoin de web.
    const LOCAL_TOPICS = /(maurel|ange[- ]?maurel|lynda|brou|cv|curriculum|ton portfolio|tes projets|ses projets|ton site|contact|email|mail|previsi|upb connect|ornifly|orange success|virtual car|ton numéro|ton tel)/i;

    // Salutations courtes pures (sans autre demande) : "cc", "coucou",
    // "yo", "wesh", "salam", "hola", "bsr", "bjr", "slt", "c coucou"…
    // Le modèle a tendance à interpréter "cc" comme "carbon copy" ; on
    // force donc une réponse de salutation via un message système court et
    // direct, prioritaire sur le prompt système général.
    const GREETING_ONLY = /^(cc|c coucou|c'coucou|coucou|coucou coucou|salut|slt|bjr|bsr|bonjour|bonsoir|hey|hello|hi|yo|wesh|salam|hola|yo yo|cc cc|coucou coucou)\b.*$/i;

    const callLLM = async (userText) => {
        const baseMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...state.history.slice(-12)
        ];

        // RÈGLE 1 : si la requête est ambiguë, on injecte le contexte de
        // conversation dans un message système pour aider le LLM à lever
        // l'ambiguïté avec confiance raisonnable (et agir directement en
        // mentionnant son interprétation). On ne le fait que si l'historique
        // contient assez de contexte. On saute si on vient d'un choix de
        // carte/suggestion (state.resolvedAmbiguity défini).
        const isAmbiguous = !state.resolvedAmbiguity && ENABLE_AMBIGUITY && isAmbiguousQuery(userText);
        if (isAmbiguous) {
            const ctx = getConversationContext(6);
            if (ctx && ctx.trim().length > 20) {
                baseMessages.push({
                    role: 'system',
                    content: `CONTEXTE DE CONVERSATION RÉCENT (utilise-le pour lever l'ambiguïté si possible, RÈGLE 1) :\n${ctx}\n\nSi ce contexte permet de déduire sans doute raisonnable ce que l'utilisateur veut, agis directement en mentionnant ton interprétation (ex: "Je te montre X puisque c'est de ça qu'on parlait..."). Sinon, pose une clarification courte avec des suggestions.`
                });
            }
        }

        // Cas salutation pure : on court-circuite le LLM avec une consigne
        // stricte pour éviter toute mauvaise interprétation (ex. "cc" = carbon
        // copy). On garde le ton chaleureux et on propose d'engager la suite.
        if (GREETING_ONLY.test(userText.trim())) {
            const greetingPayload = [
                { role: 'system', content: 'L\'utilisateur te salue simplement (ex. "cc", "coucou", "salut", "yo"). Réponds UNIQUEMENT par une salutation courte et chaleureuse en français, suivie d\'une question ouverte pour lancer la conversation (ex. "Coucou ! Comment puis-je t\'aider aujourd\'hui ?"). Ne cherche jamais à interpréter le mot comme un acronyme ou un terme technique. Reste bref.' },
                { role: 'user', content: userText }
            ];
            const reply = await queryLLM(greetingPayload);
            return { reply, images: null };
        }

        // Recherche web par DÉFAUT pour toute question qui n'est pas purement
        // locale (portfolio de Maurel). Cela garantit des infos en temps réel
        // (scores de match, actualités, prix, faits récents…) même sans
        // mot-clé explicite. Le LLM décide ensuite d'utiliser les sources.
        const wantsWeb = !LOCAL_TOPICS.test(userText);
        if (wantsWeb) {
            // Recherche web (texte) + recherche d'images en parallèle.
            // Les images sont OPTIONNELLES : si la recherche échoue ou ne
            // renvoie rien, on n'affiche que le texte. On lance les deux
            // requêtes en même temps pour ne pas ralentir la réponse.
            // Nettoyage du sujet pour la recherche d'images (on retire les
            // mots de liaison / la ponctuation pour tomber sur l'article
            // Wikipedia correspondant : "Qu'est-ce que le Bitcoin" -> "Bitcoin").
            const imgQuery = userText
                .replace(/'/g, ' ')
                .replace(/^(parle[- ]?moi de|qui est|qui était|c'est qui|qu'est[- ]?ce que|quest[- ]?ce que|quel(?:le)?(?:s)? est|quelle est|dis[- ]?moi|raconte[- ]?moi|présente[- ]?moi|explique[- ]?moi|decris|décris|parle de|à propos de|en 20\d\d|en 19\d\d)\s*/gi, '')
                .replace(/[?.,!;:]/g, ' ')
                .replace(/\b(le|la|les|un|une|des|du|de|d'|au|aux|en|sur|pour|avec|et|ou|à|the|a|an|of|in|on|for|with|and|or|prix|valeur|cours|cotation|combien|côte|coûte|actuel|actuelle|aujourd|hui|maintenant|moment|ce|cet|cette|est|sont|son|sa|ses|leur|leurs|mon|ma|mes|ton|ta|tes|quel|quelle|quels|quelles|qui|que|quoi|comment|pourquoi|quand|où)\b/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 60) || userText;
            // Recherche d'images UNIQUEMENT si elles apportent une réelle
            // valeur (personne, lieu, monument, marque, œuvre…). Sinon on
            // n'affiche que du texte — pas d'images systématiques.
            // Si c'est une PERSONNE, on force Wikipedia (portraits officiels).
            const ent = isEntityQuery(userText);
            const imgType = ent && ent.kind === 'person' ? 'person' : null;
            const imgPromise = shouldFetchImages(userText)
                ? searchImages(imgQuery, 3, imgType).catch(() => [])
                : Promise.resolve([]);
            // La recherche web est PUREMENT optionnelle : elle ne doit JAMAIS
            // faire échouer la réponse du LLM. On la lance en PARALLÈLE de
            // queryLLM (jamais en attente bloquante) et on ne l'utilise que
            // si elle revient avec des résultats AVANT la fin de queryLLM.
            // Cela évite qu'un /api/search lent (cold start Render, ~11s)
            // ne bloque tout le flux et n'empêche /api/chat d'être appelé.
            const searchPromise = searchWeb(userText).catch(() => null);
            const images = await imgPromise;

            // queryLLM en priorité absolue : on ne l'attend pas après searchWeb.
            const reply = await queryLLM([
                ...baseMessages,
                { role: 'user', content: userText }
            ]);

            // Si la recherche web a produit des résultats, on refait un
            // appel avec le contexte (sinon on garde la réponse déjà obtenue).
            const results = await searchPromise;
            if (results && results.length) {
                const ctx = results.map(r =>
                    `• ${r.title}\n  ${r.body}\n  (${r.href})`
                ).join('\n\n');
                const messagesPayload = [
                    ...baseMessages,
                    { role: 'user', content: userText },
                    { role: 'system', content: `Résultats de recherche web pertinents et à jour :\n${ctx}\n\nUtilise ces sources pour répondre de façon précise et actuelle. Si la question concerne un fait qui a pu évoluer (score, résultat, actualité, prix, date…), base-toi sur ces sources plutôt que sur tes connaissances. Cite tes sources si utile.` }
                ];
                const reply2 = await queryLLM(messagesPayload);
                return { reply: reply2, images: (images && images.length) ? images : null };
            }
            // Pas de résultat web : on répond avec ce qu'on a (sans images).
            return { reply, images: null };
        }

        const messagesPayload = [
            ...baseMessages,
            { role: 'user', content: userText }
        ];
        const reply = await queryLLM(messagesPayload);
        return { reply, images: null };
    };

    /* ---------- Contexte de conversation (pour lever l'ambiguïté) ----------
       Renvoie un résumé des derniers messages (user + assistant) pour aider
       le LLM à appliquer la RÈGLE 1 : si le contexte permet de lever
       l'ambiguïté avec confiance raisonnable, il agit directement. */
    const getConversationContext = (limit = 6) => {
        const recent = state.history
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-limit)
            .map(m => (m.role === 'user' ? 'Utilisateur' : 'Lynda') + ' : ' + (m.content || '').slice(0, 300))
            .join('\n');
        return recent;
    };

    /* ---------- Réponse principale ---------- */
    const respond = async (query, opts) => {
        const skipUserPush = opts && opts.skipUserPush;
        const fromChoice = opts && opts.fromChoice;
        remember(query);

        const intent = detectIntent(query);
        if (intent) {
            if (intent.action === 'genimage') {
                if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                const prompt = query
                    .replace(/^(génère|genere|crée|cree|fais|fait|dessine|illustre|imagine|montre|produis)[- ]?moi\s*/i, '')
                    .replace(/^(génère|genere|crée|cree|fais|fait|dessine|illustre|imagine|montre|produis)\s*/i, '')
                    .replace(/^(une|un|des|la|le|les|l')\s+(image|photo|visuel|illustration|dessin|tableau|peinture|portrait|affiche)\s+(de|d'|du|des|de la|de l')\s*/i, '')
                    .replace(/^(une|un|des|la|le|les|l')\s+(image|photo|visuel|illustration|dessin|tableau|peinture|portrait|affiche)\s*/i, '')
                    .replace(/^(de|du|des|de la|de l')\s*/i, '')
                    .trim();
                const subject = prompt || query;
                // Si c'est une PERSONNE, on force Wikipedia (portraits officiels).
                const ent = isEntityQuery(query);
                const imgType = ent && ent.kind === 'person' ? 'person' : null;
                // Indicateur de recherche (on cherche d'abord sur le web).
                const imgEl = addImageMessage('', 'Recherche d\'images sur le web…');
                try {
                    // 1) On tire d'abord les images réelles du web (Wikipedia
                    //    pour les personnes, Pexels sinon) plutôt que de les
                    //    générer artificiellement.
                    const webImages = await searchImages(subject, 3, imgType);
                    if (webImages && webImages.length) {
                        imgEl.remove(); // on retire l'indicateur de chargement
                        webImages.forEach((im, i) => {
                            addImageMessage(im.url, '🖼️ Image trouvée sur le web : ' + subject + (webImages.length > 1 ? ` (${i + 1}/${webImages.length})` : ''));
                            pushMsg('assistant', '🖼️ Image trouvée sur le web : ' + subject);
                        });
                        const capTxt = '🖼️ ' + webImages.length + ' image(s) trouvée(s) sur le web pour « ' + subject + ' »';
                        if (streamEl) streamEl.textContent = capTxt;
                        return { handled: true };
                    }
                    // 2) Repli : génération IA (Pollinations) si le web ne
                    //    renvoie rien.
                    const src = await generateImage(subject);
                    if (src) {
                        const ph = imgEl.querySelector('.ai-agent__gen-img-loading');
                        if (ph) {
                            const wrap = document.createElement('div');
                            wrap.className = 'ai-agent__gen-img-wrap';
                            const img = document.createElement('img');
                            img.className = 'ai-agent__gen-img';
                            img.src = src;
                            img.alt = 'Image générée par Lynda';
                            img.loading = 'lazy';
                            const mark = document.createElement('span');
                            mark.className = 'ai-agent__gen-watermark';
                            mark.textContent = 'L';
                            mark.title = 'Image générée par Lynda';
                            wrap.appendChild(img);
                            wrap.appendChild(mark);
                            ph.replaceWith(wrap);
                        } else {
                            const img = imgEl.querySelector('img');
                            if (img) img.src = src;
                        }
                        imgEl.querySelector('.ai-agent__gen-img-cap').textContent =
                            '🖼️ Image générée par Lynda (IA) : ' + subject;
                        const capTxt = '🖼️ Image générée : ' + subject;
                        pushMsg('assistant', capTxt);
                        if (streamEl) streamEl.textContent = capTxt;
                        return { handled: true };
                    }
                    throw new Error('empty');
                } catch (e) {
                    imgEl.remove();
                    const fallback = "Je n'arrive pas à trouver ou générer l'image pour le moment (service indisponible). Réessayez dans un instant.";
                    pushMsg('assistant', fallback);
                    return fallback;
                }
            }
            if (intent.action === 'editimage') {
                if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                // Lynda ne peut pas éditer/retoucher un fichier image existant.
                // Elle explique la limite et propose de générer une nouvelle
                // image avec la modification demandée (fond noir, etc.).
                const el = addMessage('', 'bot');
                el.innerHTML = formatText(
                    "Je ne peux pas **modifier** une image déjà existante (changer son fond, ses couleurs, la recadrer…) : je n'ai pas d'outil de retouche photo. 😊\n\n" +
                    "En revanche, je peux **générer une toute nouvelle image** avec la modification que tu veux. Par exemple, dis-moi :\n" +
                    "- « génère une image du logo UPB CONNECT avec un fond noir »\n" +
                    "- « crée une image de … avec un fond sombre »\n\n" +
                    "Tu veux que je génère cette version à la place ? Donne-moi le sujet exact et je m'en occupe tout de suite."
                );
                pushMsg('assistant', "Je ne peux pas modifier une image existante, mais je peux en générer une nouvelle avec la modification demandée (fond noir, etc.).");
                return { handled: true };
            }
            if (intent.action === 'weather') {
                if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                const city = intent.payload || 'Abidjan';
                const wEl = addMessage('', 'bot');
                wEl.classList.add('ai-msg--weather');
                wEl.innerHTML = '<div class="ai-weather__loading"><span class="ai-agent__typing-dots"><span></span><span></span><span></span></span> Chargement de la météo…</div>';
                try {
                    const data = await fetchWeather(city);
                    if (data) {
                        wEl.innerHTML = '';
                        wEl.appendChild(renderWeatherCard(data));
                        pushMsg('assistant', `Météo à ${data.place} : ${data.temp}°C, ${data.label}.`);
                        return { handled: true };
                    }
                    throw new Error('no data');
                } catch (e) {
                    wEl.remove();
                    const fb = `Je n'arrive pas à récupérer la météo de « ${city} » pour le moment (service indisponible).`;
                    pushMsg('assistant', fb);
                    return fb;
                }
            }
        }

        if (USE_LLM) {
            // Détection d'entité : on enrichit la réponse avec des images
            // réelles + une mise en page adaptée (fiche d'identité, sections,
            // chronologie, stats, galerie). Le LLM fournit le texte de fond.
            let entitySubject = isEntityQuery(query);
            // CAS D'AMBIGUÏTÉ : sujet qui peut désigner plusieurs entités
            // visuelles (ex. "Apple" → fruit OU entreprise). On NE déclenche
            // PAS la fiche enrichie automatiquement : on laisse le LLM
            // proposer des Choice Cards (max 4) pour que l'utilisateur
            // choisisse AVANT toute image. On passe donc en flux normal.
            const ambiguous = (fromChoice || !ENABLE_AMBIGUITY) ? null : isAmbiguousQuery(query);
            if (ambiguous) {
                // ANTI-BOUCLE : si l'utilisateur vient de choisir une option
                // pour CETTE clé (state.resolvedAmbiguity === ambiguous.key),
                // on considère le choix comme DÉFINITIF : on neutralise
                // l'ambiguïté (on la passe à null) pour que le flux normal
                // traite le message comme une entité claire, SANS réafficher
                // les cartes. On ne remet PAS le verrou à null ici (il sera
                // réinitialisé au prochain message libre via send()).
                if (state.resolvedAmbiguity && ambiguous.key && state.resolvedAmbiguity === ambiguous.key) {
                    ambiguous._resolved = true;
                } else {
                    // CAS D'AMBIGUÏTÉ : on affiche OBLIGATOIREMENT des Choice
                    // Cards (max 4) côté frontend, sans dépendre du LLM, pour
                    // que l'utilisateur choisisse l'entité AVANT toute image.
                    // Aucune image n'est affichée tant que le choix n'est pas fait.
                    if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                    const el = addMessage('', 'bot');
                    el.classList.add('ai-msg--ambiguous');
                    const intro = `Votre demande est un peu ambiguë. Que souhaitez-vous voir exactement à propos de « ${ambiguous.subject} » ?`;
                    el.innerHTML = formatText(intro);
                    const cards = {
                        question: `Choisissez une option pour « ${ambiguous.subject} » :`,
                        choices: ambiguous.options.slice(0, 4)
                    };
                    renderChoiceCards(cards, el, ambiguous.key);
                    pushMsg('assistant', intro + ' (carte de choix proposée)');
                    return { handled: true };
                }
            }
            // AMBIGUÏTÉ D'ACTION (RÈGLE 2/4) : si la demande est une action
            // dont le sujet/type/période manque (ex. "génère un rapport",
            // "fais un résumé", "supprime ça"), on affiche des suggestions
            // précises côté frontend (sans dépendre du LLM). On saute si on
            // vient d'un choix (fromChoice) ou si un verrou est actif.
            if (!fromChoice && !state.resolvedAmbiguity && ENABLE_AMBIGUITY) {
                const actionAmb = detectActionAmbiguity(query);
                if (actionAmb) {
                    if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                    const el = addMessage('', 'bot');
                    el.classList.add('ai-msg--ambiguous');
                    const intro = `Votre demande est un peu ambiguë. Que souhaitez-vous faire exactement ?`;
                    el.innerHTML = formatText(intro);
                    renderSuggestions(actionAmb.suggestions, el);
                    pushMsg('assistant', intro + ' (suggestions proposées)');
                    return { handled: true };
                }
            }
            if (ambiguous && ambiguous._resolved) {
                // Le choix a déjà été fait : on traite le message comme une
                // entité claire (fiche enrichie + images). On dérive le sujet
                // du texte du choix (ex. "l'entreprise (Apple Inc.)" -> "Apple
                // Inc.") pour la recherche d'images et le LLM.
                const choiceText = query.trim();
                const derived = choiceText
                    .replace(/^(le|la|les|l'|un|une|des|du|de|d')\s+/i, '')
                    .replace(/\(.*?\)/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim() || ambiguous.subject;
                entitySubject = { subject: derived, kind: 'entity' };
                ambiguous = null;
            }
            if (fromChoice) {
                // Message issu d'un clic sur une Choice Card : on traite le
                // choix comme une entité claire (fiche enrichie + images),
                // SANS re-détecter l'ambiguïté (sinon boucle infinie car le
                // texte du choix contient encore le mot ambigu, ex. "apple").
                // On dérive le sujet du texte du choix pour la recherche.
                const choiceText = query.trim();
                const derived = choiceText
                    .replace(/^(le|la|les|l'|un|une|des|du|de|d')\s+/i, '')
                    .replace(/\(.*?\)/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim() || query.trim();
                entitySubject = { subject: derived, kind: 'entity' };
            }
            if (entitySubject && !ambiguous) {
                const subject = entitySubject.subject;
                const kind = entitySubject.kind;
                if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                const el = addMessage('', 'bot');
                el.classList.add('ai-msg--entity');
                el.innerHTML = '<div class="ai-entity__loading"><span class="ai-agent__typing-dots"><span></span><span></span><span></span></span> Lynda prépare une fiche enrichie…</div>';
                try {
                    // Type d'image selon l'entité :
                    // - PERSONNE => Wikipedia uniquement (portraits officiels,
                    //   libres de droits). Pas de suffixe "portrait photo" car
                    //   Wikipedia résout déjà le titre exact de la personne.
                    // - LIEU => Pexels (vues paysagères), suffixe "ville paysage".
                    // - AUTRE => Pexels (photos réelles variées).
                    const imgType = (kind === 'person') ? 'person' : null;
                    const imgSuffix = (kind === 'place') ? ' ville paysage photo' : '';
                    // On récupère les images en premier (indépendant du LLM),
                    // puis le texte. Si le LLM échoue, on garde la fiche avec
                    // les images et un texte de repli.
                    const images = await searchImages(subject + imgSuffix, 6, imgType);
                    let reply = null;
                    try { reply = (await callLLM(query)).reply; } catch (e) { reply = null; }
                    if (!reply || !reply.trim()) {
                        reply = `**${subject}**\n\nVoici une fiche enrichie avec des images en temps réel. Le détail de ma réponse textuelle est momentanément indisponible (service IA coupé), mais les visuels ci-dessus vous donnent un aperçu de ${subject}.`;
                    }
                    const cardHtml = buildEntityCard(subject, images, reply, kind);
                    el.innerHTML = cardHtml;
                    enhanceMessage(el);
                    wireCodeBlocks(el);
                    wireEntityCard(el);
                    pushMsg('assistant', `Fiche enrichie sur ${subject} : ` + reply, cardHtml);
                    return { handled: true };
                } catch (e) {
                    // En cas d'échec total (images + LLM), on retombe sur une
                    // réponse texte classique si possible.
                    try {
                        const reply = (await callLLM(query)).reply;
                        if (reply && reply.trim()) {
                            el.innerHTML = formatText(reply);
                            enhanceMessage(el);
                            wireCodeBlocks(el);
                            pushMsg('assistant', reply);
                            return { handled: true };
                        }
                    } catch (e2) { /* tombe dans le gestionnaire d'erreur */ }
                    el.remove();
                    const fb = "Je n'arrive pas à préparer la fiche enrichie pour le moment (service indisponible).";
                    pushMsg('assistant', fb);
                    return fb;
                }
            }
            try {
                const { reply, images } = await callLLM(query);
                if (reply && reply.trim()) {
                    if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                    // Images de soutien (optionnelles) pour les sujets web.
                    return { reply, images: images || null };
                }
                throw new Error('empty');
            } catch (err) {
                // Annulation volontaire : on ne bascule pas sur le moteur local,
                // on laisse simplement l'UI dans son état "arrêté".
                if (err && err.name === 'AbortError') {
                    if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                    return { handled: true };
                }
                const errText = "Je suis désolée, mon cerveau IA est momentanément indisponible (connexion au service coupée). Réessayez quand vous voulez.";
                pushMsg('assistant', errText, null, { error: true });
                if (streamEl) {
                    streamEl.textContent = errText;
                    streamEl.classList.add('ai-msg--error');
                    const retry = document.createElement('button');
                    retry.type = 'button';
                    retry.className = 'ai-agent__retry-btn';
                    retry.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Réessayer';
                    retry.addEventListener('click', () => retryLast());
                    streamEl.appendChild(retry);
                }
                // On retourne le texte d'erreur pour que finishReply() l'affiche
                // dans une bulle (sinon rien ne s'affiche côté utilisateur).
                return { reply: errText, error: true };
            }
        }
        const off = "Le mode IA n'est pas activé pour le moment. Activez le backend pour que je puisse vraiment converser avec vous.";
        if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
        return off;
    };

    /* ---------- Galerie d'images de soutien (optionnelle, sujets web) ---------- */
    const renderImageGallery = (images) => {
        if (!images || !images.length) return null;
        const wrap = document.createElement('div');
        wrap.className = 'ai-agent__web-gallery';
        images.slice(0, 3).forEach(im => {
            const url = (im && (im.url || im.image)) || '';
            if (!/^https?:\/\//.test(url)) return;
            const a = document.createElement('a');
            a.className = 'ai-agent__web-thumb';
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener';
            a.title = im.title || 'Image';
            const img = document.createElement('img');
            img.src = url;
            img.alt = im.title || 'Image';
            img.loading = 'lazy';
            img.referrerPolicy = 'no-referrer';
            img.onerror = () => { a.style.display = 'none'; };
            a.appendChild(img);
            wrap.appendChild(a);
        });
        return wrap.children.length ? wrap : null;
    };

    /* ---------- Choice Cards (prise de décision intelligente) ----------
       Lynda peut émettre un bloc ::CHOICE_CARDS:: … ::END_CHOICE_CARDS:: dans
       sa réponse. On extrait ce bloc, on affiche les cartes cliquables, et
       au clic on envoie le choix comme un message utilisateur (sans le
       réafficher dans le champ). Les cartes disparaissent après sélection. */
    const CHOICE_RE = /::CHOICE_CARDS::\s*([\s\S]*?)\s*::END_CHOICE_CARDS::/;
    const extractChoiceCards = (text) => {
        if (!text) return { text, cards: null };
        const m = text.match(CHOICE_RE);
        if (!m) return { text, cards: null };
        let cards = null;
        try {
            const obj = JSON.parse(m[1].trim());
            const choices = Array.isArray(obj.choices) ? obj.choices.map(c => String(c).trim()).filter(Boolean) : [];
            // Maximum 4 choix (cahier des charges) : on tronque au-delà.
            const capped = choices.slice(0, 4);
            if (capped.length >= 2 && capped.length <= 4) {
                cards = { question: String(obj.question || 'Que souhaitez-vous faire ?').trim(), choices: capped };
            }
        } catch (e) { /* JSON invalide : on ignore le bloc */ }
        const cleaned = text.replace(CHOICE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
        return { text: cleaned, cards };
    };

    /* ---------- Suggestions (clarification d'ambiguïté) ----------
       Quand la demande est ambiguë, le LLM peut émettre un bloc
       ::SUGGESTIONS:: … ::END_SUGGESTIONS:: contenant 2 à 4
       interprétations précises sous forme de {label, value}. Au clic,
       on envoie le "value" comme message utilisateur (intention
       explicite, fromChoice=true). Contrairement aux Choice Cards
       (prise de décision sur une action), les suggestions servent à
       lever une ambiguïté de sens. */
    const SUGG_RE = /::SUGGESTIONS::\s*([\s\S]*?)\s*::END_SUGGESTIONS::/;
    const extractSuggestions = (text) => {
        if (!text) return { text, suggestions: null };
        const m = text.match(SUGG_RE);
        if (!m) return { text, suggestions: null };
        let suggestions = null;
        try {
            const obj = JSON.parse(m[1].trim());
            const items = Array.isArray(obj.suggestions) ? obj.suggestions : null;
            if (items) {
                const clean = items
                    .map(s => {
                        if (typeof s === 'string') return { label: s.trim(), value: s.trim() };
                        const label = String(s.label || s.value || '').trim();
                        const value = String(s.value || s.label || '').trim();
                        return label ? { label, value } : null;
                    })
                    .filter(Boolean)
                    .slice(0, 4); // max 4 suggestions
                if (clean.length >= 2 && clean.length <= 4) suggestions = clean;
            }
        } catch (e) { /* JSON invalide : on ignore le bloc */ }
        const cleaned = text.replace(SUGG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
        return { text: cleaned, suggestions };
    };

    const renderSuggestions = (suggestions, container) => {
        if (!suggestions || !suggestions.length || !container) return;
        const wrap = document.createElement('div');
        wrap.className = 'ai-suggestions';
        const grid = document.createElement('div');
        grid.className = 'ai-suggestions__grid';
        suggestions.forEach(s => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ai-suggestion';
            btn.textContent = s.label;
            btn.addEventListener('click', () => {
                // Disparition des suggestions après sélection.
                wrap.remove();
                // Le clic sur une suggestion = intention EXPLICITE : on
                // envoie le "value" comme message (fromChoice=true pour ne
                // pas re-déclencher l'ambiguïté et traiter comme explicite).
                send(s.value, true);
            });
            grid.appendChild(btn);
        });
        wrap.appendChild(grid);
        container.appendChild(wrap);
    };

    const renderChoiceCards = (cards, container, resolvedKey) => {
        if (!cards || !container) return;
        const wrap = document.createElement('div');
        wrap.className = 'ai-choice-cards';
        const q = document.createElement('div');
        q.className = 'ai-choice-cards__q';
        q.textContent = cards.question;
        wrap.appendChild(q);
        const grid = document.createElement('div');
        grid.className = 'ai-choice-cards__grid';
        cards.choices.forEach(choice => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ai-choice-card';
            btn.textContent = choice;
            btn.addEventListener('click', () => {
                // Disparition des cartes après sélection.
                wrap.remove();
                // ANTI-BOUCLE : on marque la CLÉ de la map (ex. "apple") comme
                // résolue pour que le choix (ex. "l'entreprise (Apple Inc.)")
                // ne soit PAS redétecté comme ambigu au prochain passage.
                if (resolvedKey) state.resolvedAmbiguity = resolvedKey;
                // Envoi du choix comme message utilisateur (fromChoice=true
                // pour ne PAS réinitialiser le verrou anti-boucle).
                send(choice, true);
            });
            grid.appendChild(btn);
        });
        wrap.appendChild(grid);
        // L'utilisateur peut ignorer et écrire sa propre réponse : on ajoute
        // un petit lien "ignorer" discret.
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'ai-choice-cards__skip';
        skip.textContent = 'Ignorer';
        skip.addEventListener('click', () => {
            wrap.remove();
            // Ignorer = on abandonne aussi le verrou d'ambiguïté en cours.
            if (resolvedKey) state.resolvedAmbiguity = null;
        });
        wrap.appendChild(skip);
        container.appendChild(wrap);
    };

    /* ---------- Affichage final d'une réponse ---------- */
    let streamEl = null;
    const finishReply = async (reply) => {
        if (reply && reply.handled) {
            // Cas gérés séparément (entité, image, météo…) : respond() a créé
            // et rempli SA PROPRE bulle. Aucune bulle vide ne traîne (on ne
            // crée plus streamEl à l'avance dans send()/regenerateAfter()).
            streamEl = null;
            state.busy = false;
            state.aborted = false;
            setGenerating(false);
            return;
        }
        // Cas normal : on extrait le texte et les images de soutien (optionnelles).
        const replyText = (reply && typeof reply === 'object' && reply.reply !== undefined) ? reply.reply : reply;
        const replyImages = (reply && typeof reply === 'object' && reply.images) ? reply.images : null;
        // Cas normal : on s'assure qu'une bulle existe pour recevoir le texte.
        if (!streamEl) streamEl = addMessage('', 'bot');
        if (reply && reply.cvButton) {
            if (streamEl) {
                streamEl.textContent = reply.text;
                const btn = document.createElement('button');
                btn.className = 'ai-agent__cv-btn';
                btn.textContent = '📥 Télécharger le CV';
                btn.type = 'button';
                btn.addEventListener('click', downloadCV);
                streamEl.appendChild(btn);
            }
            streamEl = null; state.busy = false; state.aborted = false; setGenerating(false);
            return;
        }
        if (reply && reply.docButton) {
            if (streamEl) {
                streamEl.textContent = reply.text;
                const btn = document.createElement('button');
                btn.className = 'ai-agent__cv-btn';
                btn.textContent = '📄 Télécharger le document';
                btn.type = 'button';
                btn.addEventListener('click', () => {
                    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${reply.docTitle}</title>
<style>body{font-family:'Space Grotesk',sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#0b0b0b;line-height:1.7}
h1{color:#227846;border-bottom:2px solid #2e9e5b;padding-bottom:8px}
pre{white-space:pre-wrap;background:#f6faf7;border:1px solid #cfe9d8;padding:16px;border-radius:10px;font-size:14px}</style></head>
<body><h1>${reply.docTitle}</h1><pre>${reply.docContent.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre>
<p>Généré par Lynda, l'assistante IA de Maurel Brou.</p></body></html>`;
                    const blob = new Blob([html], { type: 'text/html' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = 'lynda-document.html';
                    document.body.appendChild(a); a.click(); a.remove();
                    URL.revokeObjectURL(url);
                });
                streamEl.appendChild(btn);
            }
            streamEl = null; state.busy = false; state.aborted = false; setGenerating(false);
            return;
        }
        if (reply && reply.imageButton) {
            if (streamEl) {
                streamEl.textContent = reply.text;
                const btn = document.createElement('button');
                btn.className = 'ai-agent__cv-btn';
                btn.textContent = '🖼️ Télécharger l\'image';
                btn.type = 'button';
                btn.addEventListener('click', () => {
                    const blob = new Blob([reply.imageSvg], { type: 'image/svg+xml' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = 'lynda-carte.svg';
                    document.body.appendChild(a); a.click(); a.remove();
                    URL.revokeObjectURL(url);
                });
                streamEl.appendChild(btn);
            }
            streamEl = null; state.busy = false; state.aborted = false; setGenerating(false);
            return;
        }
        if (streamEl) {
            const contentEl = streamEl.querySelector('.ai-msg__content') || streamEl;
            // Extraction des Choice Cards (si l'IA en a émis) AVANT le rendu.
            const { text: cleanText, cards } = extractChoiceCards(replyText);
            // Extraction des Suggestions (clarification d'ambiguïté).
            const { text: cleanText2, suggestions } = extractSuggestions(cleanText);
            const finalText = cleanText2;
            if (isRichContent(finalText)) {
                contentEl.innerHTML = formatText(finalText);
                enhanceMessage(contentEl);
                wireCodeBlocks(contentEl);
            } else {
                renderInstant(contentEl, finalText, () => { wireCodeBlocks(contentEl); });
            }
            // Galerie d'images de soutien (optionnelle) pour les sujets web.
            const gallery = renderImageGallery(replyImages);
            if (gallery) streamEl.appendChild(gallery);
            // Choice Cards (prise de décision) — affichées sous la réponse.
            if (cards) renderChoiceCards(cards, streamEl);
            // Suggestions (clarification d'ambiguïté) — affichées sous la réponse.
            if (suggestions) renderSuggestions(suggestions, streamEl);
        }
        if (!state.aborted) pushMsg('assistant', replyText);
        else pushMsg('assistant', (streamEl ? streamEl.textContent : '') + ' ⏹ (génération interrompue)');
        streamEl = null;
        state.busy = false;
        state.aborted = false;
        setGenerating(false);
        if (voiceEnabled && !state.aborted) speak(replyText);
    };

    /* ---------- Envoi ---------- */
    const send = async (raw, fromChoice) => {
        const text = (raw || '').trim();
        if ((!text && pendingFiles.length === 0) || state.busy) return;
        // Message libre (pas un clic de carte) : on oublie tout verrou
        // d'ambiguïté résolu pour permettre de redemander le même sujet.
        if (!fromChoice) state.resolvedAmbiguity = null;

        if (text.length > MAX_MSG_LEN) {
            addMessage(`⚠️ Votre message est trop long (${text.length} caractères). Limite : ${MAX_MSG_LEN}.`, 'bot');
            return;
        }
        const lastUser = state.history[state.history.length - 1];
        if (lastUser && lastUser.role === 'user' && lastUser.content === text && pendingFiles.length === 0) {
            return;
        }

        state.aborted = false;
        setGenerating(true);
        hideWelcome();

        const userEntry = pushMsg('user', text || '(fichier joint)');
        const userEl = addMessage('', 'user', userEntry.id);
        if (text) {
            const p = document.createElement('div');
            p.textContent = text;
            userEl.appendChild(p);
        }
        if (pendingFiles.length) {
            const wrap = document.createElement('div');
            wrap.className = 'ai-agent__msg-files';
            pendingFiles.forEach(f => {
                if (f.isImg && f.dataUrl) {
                    const img = document.createElement('img');
                    img.src = f.dataUrl;
                    img.alt = f.name;
                    img.className = 'ai-agent__img-inline';
                    wrap.appendChild(img);
                } else {
                    const chip = document.createElement('span');
                    chip.className = 'ai-agent__file-chip';
                    chip.innerHTML = `<i class="bi bi-${f.isImg ? 'image' : 'file-earmark-text'}"></i> ${escapeHtml(f.name)}`;
                    wrap.appendChild(chip);
                }
            });
            userEl.appendChild(wrap);
        }

        const toProcess = pendingFiles.splice(0, pendingFiles.length);
        renderPending();
        input.value = '';
        autoResize();

        state.busy = true;
        showTyping();

        const thinkDelay = 150 + Math.random() * 350;
        await new Promise(r => setTimeout(r, thinkDelay));

        // NB : on ne crée PAS de bulle vide ici. respond() crée sa propre
        // bulle pour les cas enrichis (entité/image/météo) et finishReply()
        // crée la bulle pour le cas normal. Évite le "cadre vide" résiduel.

        // ===== PIPELINE DE TRAITEMENT DES FICHIERS (étapes 1 à 7) =====
        // Étape 4 : compréhension de la demande (une seule fois pour tous
        // les fichiers joints au même message).
        const requestInfo = understandFileRequest(text);
        const multiFiles = toProcess.length > 1;

        let fileContext = '';
        if (toProcess.length) {
            // Étape 1+2 : détection du type et vérification pour chaque fichier.
            for (const f of toProcess) {
                const typeInfo = detectFileType(f.file);
                // Indicateur de progression (étape 3 + bonnes pratiques).
                const progEl = addMessage('', 'bot');
                progEl.classList.add('ai-msg--file-progress');
                const setProg = (msg) => {
                    progEl.innerHTML = `<span class="ai-agent__typing-dots"><span></span><span></span><span></span></span> ${escapeHtml(msg)}`;
                };
                try {
                    // Étape 2 : vérification (taille, format, corruption).
                    if (f.file.size === 0) {
                        progEl.remove();
                        addMessage(`⚠️ Le fichier « ${f.name} » semble vide ou corrompu (0 octet).`, 'bot');
                        pushMsg('assistant', `Fichier vide : ${f.name}.`);
                        continue;
                    }
                    if (f.isImg) {
                        // Étape 3 : analyse visuelle (vision backend + OCR).
                        setProg(`Analyse de l'image « ${f.name} »…`);
                        const analysis = await analyzeImage(f.dataUrl, f.name);
                        progEl.remove();
                        addMessage(analysis, 'bot');
                        pushMsg('assistant', analysis);
                        const ocr = await ocrImage(f.dataUrl);
                        if (ocr) fileContext += `\n[Texte extrait de l'image ${f.name} via OCR]\n${ocr}\n`;
                    } else {
                        // Étape 3 : extraction universelle selon le type.
                        setProg(`Extraction du texte de « ${f.name} » (${typeInfo.label})…`);
                        const extracted = await extractFileContent(f.file);
                        const note = extracted.note ? ` _(${extracted.note})_` : '';
                        if (extracted.text && extracted.text.trim()) {
                            // Étape 5 : analyse intelligente adaptée à la demande.
                            setProg(`Analyse de « ${f.name} »…`);
                            const summary = await analyzeDocument(f.name, extracted.text, requestInfo);
                            progEl.remove();
                            // Présentation PREMIUM : carte document avec le
                            // texte analysé + les images/illustrations extraites
                            // (aperçus de pages PDF, images Word, médias PPTX).
                            const imgs = extracted.images || [];
                            const docHtml = renderPremiumDoc(f.name, note, summary, imgs);
                            const docEl = addMessage('', 'bot');
                            docEl.classList.add('ai-msg--doc-premium');
                            docEl.innerHTML = docHtml;
                            enhanceMessage(docEl);
                            wireCodeBlocks(docEl);
                            pushMsg('assistant', summary);
                            // Étape 6 : on conserve le contenu extrait dans le
                            // contexte de la conversation (RAG simplifié) pour
                            // permettre des questions de suivi et la
                            // comparaison multi-fichiers.
                            const excerpt = extracted.text.length > 6000
                                ? extracted.text.slice(0, 6000) + '\n…[contenu tronqué]'
                                : extracted.text;
                            fileContext += `\n[Contenu extrait de « ${f.name} » (${extracted.kind})]\n${excerpt}\n`;
                        } else {
                            progEl.remove();
                            addMessage(`⚠️ Je n'ai pas pu extraire de contenu lisible depuis « ${f.name} ».${note}`, 'bot');
                            pushMsg('assistant', `Impossible d'extraire le contenu de ${f.name}.`);
                        }
                    }
                } catch (err) {
                    progEl.remove();
                    addMessage('❌ Impossible de lire le fichier ' + f.name + ' : ' + err.message, 'bot');
                }
            }
        }

        // Étape 7 : réponse adaptée.
        // IMPORTANT : pour éviter une DOUBLE réponse, on n'appelle PAS
        // respond() (qui génère une 2e bulle) quand des fichiers ont déjà
        // été traités et affichés en carte premium ci-dessus. La carte
        // premium (texte analysé + illustrations) EST déjà la réponse de
        // Lynda au document. Le texte de la demande de l'utilisateur a déjà
        // été pris en compte via requestInfo dans analyzeDocument().
        // On ne fait suivre vers respond() que si AUCUN fichier n'a produit
        // de carte (fileContext vide) — cas d'un message purement texte ou
        // d'un fichier non extractible.
        if (fileContext) {
            hideTyping();
            // On libère l'état "occupé" pour que l'utilisateur puisse
            // renvoyer un message immédiatement après le traitement du
            // fichier (sinon l'input reste bloqué).
            state.busy = false;
            setGenerating(false);
            return;
        }
        const finalQuery = text || 'Analyse le(s) fichier(s) joint(s) et réponds en fonction de leur contenu.';
        const reply = await respond(finalQuery, { skipUserPush: true, fromChoice: !!fromChoice });
        hideTyping();
        await finishReply(reply);
    };

    const retryLast = async () => {
        if (state.busy) return;
        let userIdx = -1;
        for (let i = state.history.length - 1; i >= 0; i--) {
            if (state.history[i].role === 'user') { userIdx = i; break; }
        }
        if (userIdx === -1) return;
        if (state.history[userIdx + 1] && state.history[userIdx + 1].role === 'assistant') {
            state.history.splice(userIdx + 1, 1);
        }
        const errEls = messages.querySelectorAll('.ai-msg--bot.ai-msg--error');
        if (errEls.length) errEls[errEls.length - 1].remove();
        renderMessages();
        await regenerateAfter(userIdx);
    };

    const setGenerating = (on) => {
        const sendBtn = form.querySelector('.ai-agent__send');
        const plusWrap = document.querySelector('.ai-agent__plus-wrap');
        if (sendBtn) {
            sendBtn.classList.toggle('is-stop', on);
            sendBtn.disabled = false;
            sendBtn.setAttribute('aria-label', on ? 'Arrêter la génération' : 'Envoyer');
            sendBtn.innerHTML = on
                ? '<i class="bi bi-stop-fill"></i>'
                : '<i class="bi bi-send"></i>';
        }
        if (plusWrap) plusWrap.style.opacity = on ? '0.4' : '';
        if (plusWrap) plusWrap.style.pointerEvents = on ? 'none' : '';
        input.disabled = on;
        updateSendState();
    };

    // Clic sur le bouton (Envoyer ou Stop) — le Stop annule VRAIMENT la
    // requête réseau en cours, pas seulement l'effet de frappe.
    const onSendClick = () => {
        if (state.busy) {
            state.aborted = true;
            if (currentAbortController) currentAbortController.abort();
            hideTyping();
            return;
        }
        send(input.value);
    };

    const autoResize = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    };
    const updateSendState = () => {
        const btn = form.querySelector('.ai-agent__send');
        if (btn) btn.disabled = (input.value.trim().length === 0) && (pendingFiles.length === 0);
    };
    input.addEventListener('input', () => { autoResize(); updateSendState(); });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        onSendClick();
    });

    const sendBtnEl = form.querySelector('.ai-agent__send');
    if (sendBtnEl) sendBtnEl.addEventListener('click', (e) => { e.preventDefault(); onSendClick(); });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send(input.value);
        }
    });

    const wireChips = (container) => {
        if (!container) return;
        container.querySelectorAll('.ai-agent__chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const q = chip.getAttribute('data-q');
                if (q) send(q);
            });
        });
    };
    wireChips(quick);
    wireChips(welcome);

    /* ---------- Bulle de bienvenue (header) ---------- */
    const bubble = document.getElementById('agentBubble');
    const bubbleClose = document.getElementById('agentBubbleClose');
    const showBubble = () => { if (bubble) bubble.classList.add('is-visible'); };
    const hideBubble = () => { if (bubble) bubble.classList.remove('is-visible'); };
    if (bubbleClose) bubbleClose.addEventListener('click', (e) => { e.stopPropagation(); hideBubble(); });
    if (trigger) trigger.addEventListener('click', () => { hideBubble(); });
    // Affiche la bulle à chaque entrée sur le site.
    if (bubble) {
        setTimeout(showBubble, 1200);
        // Se masque automatiquement après 8 s si l'utilisateur n'interagit pas.
        setTimeout(hideBubble, 9200);
    }

    /* ---------- Menu "+" (Nouvelle discussion / Joindre / Historique) ---------- */
    const toggleMenu = (force) => {
        if (!menu) return;
        const show = force !== undefined ? force : menu.hidden;
        menu.hidden = !show;
        if (plusBtn) plusBtn.setAttribute('aria-expanded', String(show));
    };
    if (plusBtn) plusBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    document.addEventListener('click', (e) => {
        if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== plusBtn) toggleMenu(false);
    });
    if (menuNewChat) menuNewChat.addEventListener('click', () => {
        saveActive();
        newConversation();
        renderMessages();
        showWelcome();
        toggleMenu(false);
    });
    if (menuAttach) menuAttach.addEventListener('click', () => {
        if (fileInput) fileInput.click();
        toggleMenu(false);
    });
    if (menuHistory) menuHistory.addEventListener('click', () => {
        const searchEl = document.getElementById('agentHistorySearch');
        if (searchEl) { searchEl.value = ''; }
        renderHistory();
        if (historyPanel) historyPanel.hidden = false;
        toggleMenu(false);
    });
    if (historyClose) historyClose.addEventListener('click', closeHistory);

    const historySearch = document.getElementById('agentHistorySearch');
    if (historySearch) historySearch.addEventListener('input', () => renderHistory(historySearch.value));

    /* ---------- Jointure de fichiers ---------- */
    const ALLOWED = {
        doc: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'json', 'xlsx', 'xls', 'pptx', 'ppt'],
        img: ['png', 'jpg', 'jpeg', 'webp'],
        zip: ['zip']
    };
    const FORBIDDEN_HINT = 'Formats acceptés : PDF, DOC, DOCX, TXT, MD, CSV, JSON, XLSX, PPTX (documents), ZIP (archives) et PNG, JPG, JPEG, WEBP (images). Les exécutables, audios et vidéos sont refusés.';
    const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

    const pendingFiles = [];

    const renderPending = () => {
        if (!attachPreview) return;
        if (pendingFiles.length === 0) {
            attachPreview.hidden = true;
            attachPreview.innerHTML = '';
            return;
        }
        attachPreview.hidden = false;
        attachPreview.innerHTML = pendingFiles.map((f, i) => {
            const icon = f.isImg ? 'image' : 'file-earmark-text';
            const thumb = f.isImg && f.dataUrl
                ? `<img src="${f.dataUrl}" alt="" class="ai-agent__attach-thumb">`
                : `<i class="bi bi-${icon} ai-agent__attach-ico"></i>`;
            return `<span class="ai-agent__attach-chip" data-i="${i}">${thumb}<span class="ai-agent__attach-name">${escapeHtml(f.name)}</span><button type="button" class="ai-agent__attach-x" data-i="${i}" aria-label="Retirer">&times;</button></span>`;
        }).join('');
        attachPreview.querySelectorAll('.ai-agent__attach-x').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = parseInt(btn.getAttribute('data-i'), 10);
                pendingFiles.splice(i, 1);
                renderPending();
            });
        });
    };

    const addPendingFile = async (file) => {
        const ext = extOf(file.name);
        if (FORBIDDEN_EXT.includes(ext)) {
            addMessage('⛔ Format refusé : .' + ext + ' (exécutables, audio et vidéo ne sont pas acceptés).', 'bot');
            return;
        }
        const isDoc = ALLOWED.doc.includes(ext);
        const isImg = ALLOWED.img.includes(ext);
        const isZip = ALLOWED.zip.includes(ext);
        if (!isDoc && !isImg && !isZip) {
            addMessage('⛔ Format non autorisé : .' + ext + '. ' + FORBIDDEN_HINT, 'bot');
            return;
        }
        if (file.size > MAX_FILE_SIZE) {
            addMessage(`⛔ Fichier trop volumineux : ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} Mo). Limite : ${MAX_FILE_SIZE / 1024 / 1024} Mo.`, 'bot');
            return;
        }
        if (pendingFiles.length >= MAX_FILES) {
            addMessage(`⛔ Vous pouvez joindre au maximum ${MAX_FILES} fichiers par message.`, 'bot');
            return;
        }
        let dataUrl = null;
        if (isImg) {
            try { dataUrl = await readAsDataURL(file); } catch (e) { dataUrl = null; }
        }
        pendingFiles.push({ file, name: file.name, isImg, isZip, dataUrl });
        renderPending();
    };

    if (fileInput) fileInput.addEventListener('change', async () => {
        const files = fileInput.files ? Array.from(fileInput.files) : [];
        fileInput.value = '';
        for (const f of files) await addPendingFile(f);
    });

    const attachBtn = document.getElementById('agentAttachBtn');
    if (attachBtn) attachBtn.addEventListener('click', () => { if (fileInput) fileInput.click(); });

    const readAsText = (file) => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error || new Error('lecture échouée'));
        r.readAsText(file);
    });
    const readAsDataURL = (file) => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error || new Error('lecture échouée'));
        r.readAsDataURL(file);
    });

    /* ---------- Détection du type de fichier (étape 1) ----------
       Renvoie un libellé lisible + la catégorie de traitement, utilisés
       pour l'indicateur de progression et le message de vérification. */
    const FILE_TYPE_LABELS = {
        pdf:   { label: 'PDF',            cat: 'pdf' },
        doc:   { label: 'Word (DOC)',     cat: 'docx' },
        docx:  { label: 'Word (DOCX)',    cat: 'docx' },
        txt:   { label: 'Texte',          cat: 'texte' },
        md:    { label: 'Markdown',       cat: 'texte' },
        csv:   { label: 'CSV',            cat: 'csv' },
        json:  { label: 'JSON',           cat: 'code' },
        xlsx:  { label: 'Excel (XLSX)',   cat: 'xlsx' },
        xls:   { label: 'Excel (XLS)',    cat: 'xlsx' },
        pptx:  { label: 'PowerPoint',     cat: 'pptx' },
        ppt:   { label: 'PowerPoint',     cat: 'pptx' },
        zip:   { label: 'Archive ZIP',    cat: 'zip' },
        xml:   { label: 'XML',            cat: 'code' },
        yaml:  { label: 'YAML',           cat: 'code' },
        yml:   { label: 'YAML',           cat: 'code' },
        js:    { label: 'Code JavaScript',cat: 'code' },
        ts:    { label: 'Code TypeScript',cat: 'code' },
        tsx:   { label: 'Code React',     cat: 'code' },
        jsx:   { label: 'Code React',     cat: 'code' },
        html:  { label: 'Code HTML',      cat: 'code' },
        css:   { label: 'Code CSS',       cat: 'code' },
        php:   { label: 'Code PHP',       cat: 'code' },
        py:    { label: 'Code Python',    cat: 'code' },
        java:  { label: 'Code Java',      cat: 'code' },
        cpp:   { label: 'Code C++',       cat: 'code' },
        c:     { label: 'Code C',         cat: 'code' },
        cs:    { label: 'Code C#',        cat: 'code' },
        go:    { label: 'Code Go',        cat: 'code' },
        rs:    { label: 'Code Rust',      cat: 'code' },
        sql:   { label: 'Code SQL',       cat: 'code' },
        dart:  { label: 'Code Dart',      cat: 'code' },
        swift: { label: 'Code Swift',     cat: 'code' },
        kt:    { label: 'Code Kotlin',    cat: 'code' },
        sh:    { label: 'Script Shell',   cat: 'code' },
        log:   { label: 'Journal (log)',  cat: 'texte' }
    };
    const detectFileType = (file) => {
        const ext = extOf(file.name);
        const info = FILE_TYPE_LABELS[ext] || { label: (ext ? '.' + ext : 'inconnu'), cat: 'autre' };
        const isImg = ALLOWED.img.includes(ext);
        return { ext, ...info, isImg };
    };

    /* ---------- Compréhension de la demande (étape 4) ----------
       Déduit l'intention de l'utilisateur à partir du message joint au
       fichier, pour adapter la présentation de la réponse (résumé court,
       points clés, traduction, correction, analyse technique, comparaison…).
       Renvoie un objet { intent, instruction } utilisé dans le prompt. */
    const understandFileRequest = (text) => {
        const s = (text || '').toLowerCase();
        if (/tradu/i.test(s)) return { intent: 'traduction', instruction: 'Traduis le contenu du document dans la langue demandée (ou en anglais par défaut).' };
        if (/corrig|faute|orthographe|grammaire|relires?|relecture/i.test(s)) return { intent: 'correction', instruction: 'Corrige les fautes d\'orthographe et de grammaire, puis propose une version propre.' };
        if (/résumé court|en bref|en résumé|tl;dr|résume en|résumé succinct/i.test(s)) return { intent: 'resume-court', instruction: 'Fais un résumé TRÈS court (3-5 lignes maximum).' };
        if (/point|idée|essentiel|important|soulign|clé/i.test(s)) return { intent: 'points-cles', instruction: 'Relève les points clés / idées principales sous forme de liste ou de paragraphes denses.' };
        if (/compa|différence|différences|contraste/i.test(s)) return { intent: 'comparaison', instruction: 'Compare les documents et identifie les différences et similarités.' };
        if (/analyse|technique|détaill|approfond|examine/i.test(s)) return { intent: 'analyse', instruction: 'Fais une analyse détaillée et technique du contenu.' };
        if (/bug|erreur|optimis|perf|amélior|refactor|test|explique le code|comment fonctionne/i.test(s)) return { intent: 'code', instruction: 'Analyse le code : explique, détecte les bugs, propose des optimisations ou des tests.' };
        if (/stat|tendance|graphique|moyenne|total|somme|calcul/i.test(s)) return { intent: 'donnees', instruction: 'Calcule des statistiques et identifie les tendances dans les données.' };
        // Par défaut : résumé + points clés (comportement équilibré).
        return { intent: 'resume', instruction: 'Résume le document, relève les points clés, et propose des améliorations si pertinent.' };
    };

    /* ---------- Rendu premium d'un document (texte + illustrations) ----------
       Construit une carte soignée affichant le texte analysé par le LLM
       ainsi que les images/illustrations extraites du document (aperçus de
       pages PDF, images intégrées Word, médias PowerPoint). Si des images
       sont présentes, on les présente dans une galerie visuelle en haut,
       à la manière d'une fiche enrichie. */
    const renderPremiumDoc = (name, note, summary, images) => {
        const safeName = escapeHtml(name);
        const safeNote = note ? `<span class="ai-doc__note">${note}</span>` : '';
        const body = summary ? formatText(summary) : '';
        const imgs = Array.isArray(images) ? images.slice(0, 8) : [];
        const mediaHtml = imgs.length
            ? `<div class="ai-doc__media">${imgs.map(im => {
                const cap = im.caption ? escapeHtml(im.caption) : '';
                const src = im.dataUrl || '';
                const onErr = `this.style.display='none';this.closest('.ai-doc__media')&&this.closest('.ai-doc__media').classList.add('ai-doc__media--imgerr');`;
                return `<figure class="ai-doc__fig"><img src="${src}" alt="${cap}" loading="lazy" referrerpolicy="no-referrer" onerror="${onErr}"><figcaption>${cap}</figcaption></figure>`;
              }).join('')}</div>`
            : '';
        return `<div class="ai-doc">
            <div class="ai-doc__head"><span class="ai-doc__badge"><i class="bi bi-file-earmark-text"></i> ${safeName}</span>${safeNote}</div>
            ${mediaHtml}
            <div class="ai-doc__body">${body}</div>
            <div class="ai-doc__src">Analyse : IA Lynda · illustrations extraites du document</div>
        </div>`;
    };

    // Analyse d'un document texte via le LLM (backend uniquement)
    const analyzeDocument = async (name, content, requestInfo) => {
        const truncated = content.length > 6000 ? content.slice(0, 6000) + '\n…[contenu tronqué]' : content;
        // Étape 4 + 5 : on adapte la consigne et la présentation à la
        // demande de l'utilisateur (résumé, points clés, traduction,
        // correction, analyse, comparaison…). On évite la liste
        // numérotée systématique : la présentation dépend du contenu.
        const req = requestInfo || understandFileRequest('');
        const prompt = `Tu es Lynda, assistante de Maurel Brou. L'utilisateur a joint le document "${name}".\n\n` +
            `Consigne spécifique : ${req.instruction}\n` +
            `Présente ta réponse de la manière la plus adaptée au contenu (texte explicatif, tableau, liste, chronologie, comparaison ou graphique décrit en texte) — n'utilise PAS systématiquement une liste numérotée.\n` +
            `Reste dans le rôle de l'assistante de Maurel Brou.\n\nCONTENU :\n${truncated}`;
        try {
            const reply = await queryLLM([
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt }
            ]);
            return reply && reply.trim() ? reply : 'J\'ai bien lu le document, mais je n\'arrive pas à formuler une analyse pour le moment.';
        } catch (e) {
            return 'J\'ai reçu le document, mais mon service d\'analyse est indisponible. Réessayez plus tard.';
        }
    };

    /* ---------- Extraction universelle de fichiers (côté client) ----------
       Détecte le type, extrait le texte/les données, et renvoie un objet
       { text, kind, note } prêt à être envoyé au LLM. Gère PDF, DOCX, XLSX,
       PPTX, CSV, JSON, TXT/MD, ZIP et le code source. Les libs sont chargées
       via CDN dans index.html (pdf.js, mammoth, xlsx, jszip). */
    const extractFileContent = async (file) => {
        const ext = extOf(file.name);
        const name = file.name;
        // --- Texte brut / Markdown / JSON / code source ---
        if (['txt', 'md', 'json', 'csv', 'xml', 'yaml', 'yml', 'js', 'ts', 'tsx', 'jsx',
             'html', 'css', 'php', 'java', 'py', 'cpp', 'c', 'cs', 'go', 'rs', 'sql',
             'dart', 'swift', 'kt', 'sh', 'log'].includes(ext)) {
            const content = await readAsText(file);
            return { text: content, kind: 'texte', note: '' };
        }
        // --- PDF ---
        if (ext === 'pdf') {
            if (!window.pdfjsLib) return { text: '', kind: 'pdf', note: '⚠️ Lecteur PDF indisponible (pas de connexion CDN).' };
            try {
                const buf = await file.arrayBuffer();
                const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
                let text = '';
                const images = [];
                // On limite le nombre de pages rendues en aperçu (visuel
                // premium) pour ne pas surcharger le navigateur.
                const maxPreview = Math.min(pdf.numPages, 6);
                for (let p = 1; p <= pdf.numPages; p++) {
                    const page = await pdf.getPage(p);
                    const tc = await page.getTextContent();
                    text += tc.items.map(i => i.str).join(' ') + '\n';
                    // Aperçu visuel de la page (rendu canvas -> dataURL).
                    if (p <= maxPreview) {
                        try {
                            const viewport = page.getViewport({ scale: 1.2 });
                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d');
                            canvas.width = viewport.width;
                            canvas.height = viewport.height;
                            await page.render({ canvasContext: ctx, viewport }).promise;
                            const dataUrl = canvas.toDataURL('image/png');
                            images.push({ dataUrl, caption: `Page ${p}` });
                        } catch (e) { /* aperçu ignoré */ }
                    }
                }
                return { text: text.trim(), images, kind: 'pdf', note: `PDF · ${pdf.numPages} page(s)` };
            } catch (e) { return { text: '', kind: 'pdf', note: '⚠️ Impossible de lire le PDF : ' + e.message }; }
        }
        // --- DOCX (et DOC via mammoth) ---
        if (ext === 'docx' || ext === 'doc') {
            if (!window.mammoth) return { text: '', kind: 'docx', note: '⚠️ Lecteur Word indisponible (pas de connexion CDN).' };
            try {
                const arrayBuffer = await file.arrayBuffer();
                const res = await window.mammoth.convertToHtml({ arrayBuffer });
                const tmp = document.createElement('div');
                tmp.innerHTML = res.value || '';
                const text = (tmp.textContent || '').trim();
                // Extraction des images intégrées (word/media/*) pour un
                // rendu premium avec illustrations.
                const images = [];
                if (window.JSZip) {
                    try {
                        const zip = await window.JSZip.loadAsync(arrayBuffer);
                        const media = Object.keys(zip.files)
                            .filter(n => /^word\/media\//.test(n) && !zip.files[n].dir)
                            .slice(0, 12);
                        for (const m of media) {
                            const b64 = await zip.files[m].async('base64');
                            const mime = /\.png$/i.test(m) ? 'image/png' : /\.jpe?g$/i.test(m) ? 'image/jpeg' : /\.gif$/i.test(m) ? 'image/gif' : /\.webp$/i.test(m) ? 'image/webp' : 'image/png';
                            images.push({ dataUrl: `data:${mime};base64,${b64}`, caption: m.split('/').pop() });
                        }
                    } catch (e) { /* images ignorées */ }
                }
                return { text, images, kind: 'docx', note: 'Document Word' + (res.messages && res.messages.length ? ' (certaines parties non converties)' : '') };
            } catch (e) { return { text: '', kind: 'docx', note: '⚠️ Impossible de lire le document Word : ' + e.message }; }
        }
        // --- XLSX / XLS ---
        if (ext === 'xlsx' || ext === 'xls') {
            if (!window.XLSX) return { text: '', kind: 'xlsx', note: '⚠️ Lecteur Excel indisponible (pas de connexion CDN).' };
            try {
                const arrayBuffer = await file.arrayBuffer();
                const wb = window.XLSX.read(arrayBuffer, { type: 'array' });
                let out = '';
                wb.SheetNames.forEach(sn => {
                    const ws = wb.Sheets[sn];
                    const csv = window.XLSX.utils.sheet_to_csv(ws);
                    out += `\n### Feuille : ${sn}\n` + csv;
                });
                return { text: out.trim(), kind: 'xlsx', note: `Excel · ${wb.SheetNames.length} feuille(s)` };
            } catch (e) { return { text: '', kind: 'xlsx', note: '⚠️ Impossible de lire le fichier Excel : ' + e.message }; }
        }
        // --- PPTX / PPT ---
        if (ext === 'pptx' || ext === 'ppt') {
            if (!window.JSZip) return { text: '', kind: 'pptx', note: '⚠️ Lecteur PowerPoint indisponible (pas de connexion CDN).' };
            try {
                const arrayBuffer = await file.arrayBuffer();
                const zip = await window.JSZip.loadAsync(arrayBuffer);
                const slideFiles = Object.keys(zip.files)
                    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
                    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
                let text = '';
                for (const f of slideFiles) {
                    const xml = await zip.files[f].async('string');
                    const tmp = document.createElement('div');
                    tmp.innerHTML = xml.replace(/<[^>]+>/g, ' ');
                    text += `\n[Slide] ` + (tmp.textContent || '').replace(/\s+/g, ' ').trim() + '\n';
                }
                // Extraction des images intégrées (ppt/media/*) pour un
                // rendu premium avec les illustrations des diapositives.
                const images = [];
                const media = Object.keys(zip.files)
                    .filter(n => /^ppt\/media\//.test(n) && !zip.files[n].dir)
                    .slice(0, 12);
                for (const m of media) {
                    const b64 = await zip.files[m].async('base64');
                    const mime = /\.png$/i.test(m) ? 'image/png' : /\.jpe?g$/i.test(m) ? 'image/jpeg' : /\.gif$/i.test(m) ? 'image/gif' : /\.webp$/i.test(m) ? 'image/webp' : 'image/png';
                    images.push({ dataUrl: `data:${mime};base64,${b64}`, caption: m.split('/').pop() });
                }
                return { text: text.trim(), images, kind: 'pptx', note: `PowerPoint · ${slideFiles.length} slide(s)` };
            } catch (e) { return { text: '', kind: 'pptx', note: '⚠️ Impossible de lire le PowerPoint : ' + e.message }; }
        }
        // --- ZIP (analyse d'archive / projet) ---
        if (ext === 'zip') {
            if (!window.JSZip) return { text: '', kind: 'zip', note: '⚠️ Lecteur ZIP indisponible (pas de connexion CDN).' };
            try {
                const arrayBuffer = await file.arrayBuffer();
                const zip = await window.JSZip.loadAsync(arrayBuffer);
                const names = Object.keys(zip.files);
                const codeExt = ['js', 'ts', 'tsx', 'jsx', 'html', 'css', 'php', 'py', 'java', 'cpp', 'c', 'cs', 'go', 'rs', 'sql', 'json', 'md', 'txt', 'xml', 'yaml', 'yml'];
                let out = `📦 Archive « ${name} » — ${names.length} entrée(s) :\n`;
                out += names.slice(0, 60).map(n => (zip.files[n].dir ? '📁 ' : '📄 ') + n).join('\n');
                if (names.length > 60) out += `\n… (${names.length - 60} autre(s))`;
                // Extrait le texte des fichiers de code/textes (limite 40 fichiers)
                let codeText = '';
                let count = 0;
                for (const n of names) {
                    if (count >= 40) break;
                    const f = zip.files[n];
                    if (f.dir) continue;
                    const e = extOf(n);
                    if (codeExt.includes(e) && f._data && f._data.uncompressedSize < 200000) {
                        const c = await f.async('string');
                        codeText += `\n// ===== ${n} =====\n` + c.slice(0, 4000);
                        count++;
                    }
                }
                if (codeText) out += '\n\n--- Extrait du code/projet ---\n' + codeText;
                return { text: out.trim(), kind: 'zip', note: `Archive ZIP · ${names.length} fichier(s)` };
            } catch (e) { return { text: '', kind: 'zip', note: '⚠️ Impossible de lire le ZIP : ' + e.message }; }
        }
        // Repli : texte brut
        try {
            const content = await readAsText(file);
            return { text: content, kind: 'texte', note: '' };
        } catch (e) { return { text: '', kind: 'autre', note: '⚠️ Format non extractible en texte.' }; }
    };

    // Lit le texte contenu dans une image (OCR, 100% client, sans clé)
    const ocrImage = async (dataUrl) => {
        if (!window.Tesseract) return '';
        try {
            const worker = await Tesseract.createWorker('fra');
            const ret = await worker.recognize(dataUrl);
            await worker.terminate();
            return (ret.data.text || '').trim();
        } catch (e) { return ''; }
    };

    // Analyse d'une image : vision via le backend (clé côté serveur),
    // puis repli OCR Tesseract (client, sans clé) si le backend est down.
    const analyzeImage = async (dataUrl, name) => {
        const base64 = (dataUrl || '').split(',')[1] || '';
        if (!base64) return 'Image reçue, mais le format est illisible.';

        try {
            const res = await fetchWithTimeout(BACKEND_VISION_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: base64, mimeType: 'image/png', name })
            }, 20000);
            if (res.ok) {
                const data = await res.json();
                if (data.description && data.description.trim()) return data.description.trim();
            }
        } catch (e) { /* repli OCR */ }

        try {
            if (window.Tesseract) {
                const worker = await Tesseract.createWorker('fra');
                const ret = await worker.recognize(dataUrl);
                await worker.terminate();
                const ocr = (ret.data.text || '').trim();
                if (ocr) {
                    return `📷 J'ai extrait le texte de cette image (OCR) :\n\n${ocr}\n\n_(Mon service de vision est temporairement indisponible, j'ai utilisé la reconnaissance optique de caractères.)_`;
                }
            }
        } catch (e) { /* repli final */ }

        return 'Image reçue. Mon service d\'analyse est indisponible pour le moment, mais je peux vous donner des conseils généraux sur sa présentation si vous le souhaitez.';
    };

    /* ---------- Voix — Reconnaissance (STT) + Synthèse (TTS) ---------- */
    let voiceEnabled = false;
    let recognizing = false;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const synth = window.speechSynthesis;

    const speak = (text) => {
        if (!synth || !voiceEnabled) return;
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text.replace(/[📄📥🖼️🌐🚀🎓📬•]/g, '').slice(0, 800));
        u.lang = 'fr-FR';
        u.rate = 1.02;
        u.pitch = 1.0;
        u.onstart = () => {
            if (recog) { try { recog.stop(); } catch (e) {} }
            showVoiceUI('Lynda parle…', true);
        };
        u.onend = () => {
            showVoiceUI('Lynda vous écoute…', false);
            if (recognizing && SR) { try { recog.start(); } catch (e) {} }
        };
        synth.speak(u);
    };
    const showVoiceUI = (txt, speaking) => {
        if (!voiceBox) return;
        voiceBox.hidden = false;
        if (voiceText) voiceText.textContent = txt;
        voiceBox.classList.toggle('is-speaking', !!speaking);
    };
    const hideVoiceUI = () => { if (voiceBox) voiceBox.hidden = true; };

    if (micBtn) micBtn.addEventListener('click', () => {
        if (!SR) {
            addMessage('⚠️ La reconnaissance vocale n\'est pas supportée par ce navigateur. Essayez Chrome/Edge.', 'bot');
            return;
        }
        if (recognizing) { stopRecognition(); return; }
        startRecognition();
    });
    if (voiceStop) voiceStop.addEventListener('click', () => {
        if (synth) synth.cancel();
        if (recognizing) stopRecognition();
        hideVoiceUI();
    });

    let recog = null;
    let finalText = '';
    let silenceTimer = null;
    const startRecognition = () => {
        if (!SR) return;
        recognizing = true;
        voiceEnabled = true;
        showVoiceUI('Lynda vous écoute…', false);
        if (micBtn) micBtn.classList.add('is-active');
        try { recog = new SR(); } catch (e) { recog = null; return; }
        recog.lang = 'fr-FR';
        recog.interimResults = true;
        recog.continuous = true;
        recog.maxAlternatives = 1;

        recog.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const r = e.results[i];
                if (r.isFinal) finalText += r[0].transcript + ' ';
                else interim += r[0].transcript;
            }
            if (voiceText) voiceText.textContent = (finalText || interim).trim() + ' …';
            input.value = (finalText + interim).trim();
            autoResize();
            updateSendState();
            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => {
                const t = finalText.trim();
                if (t) { finalText = ''; send(t); }
            }, 1400);
        };
        recog.onerror = (e) => {
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                showVoiceUI('Micro refusé. Autorisez le microphone.', false);
                stopRecognition();
            }
        };
        recog.onend = () => {
            if (recognizing) {
                try { recog.start(); } catch (e) { /* déjà démarré */ }
            }
        };
        try { recog.start(); } catch (e) { /* déjà démarré */ }
    };
    const stopRecognition = () => {
        recognizing = false;
        clearTimeout(silenceTimer);
        if (recog) { try { recog.stop(); } catch (e) {} recog = null; }
        if (micBtn) micBtn.classList.remove('is-active');
    };

})();
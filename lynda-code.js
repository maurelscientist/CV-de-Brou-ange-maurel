/* =========================================================
   LYNDA — Assistante IA de Maurel Brou
   Véritable agent LLM (OpenRouter) avec :
   - Raisonnement dynamique (jamais de réponses en dur)
   - Streaming en temps réel
   - Mémoire de conversation
   - Recherche documentaire (RAG) comme contexte
   - Restriction stricte à l'univers "Maurel Brou"
   - Navigation dans le portfolio + formulaire intelligent
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

    /* ---------- Configuration LLM ----------
       Le LLM est servi par le backend Python (backend/server.py),
       qui proxyfie OpenRouter. La clé API reste côté serveur,
       jamais exposée au navigateur. Le backend tourne sur
       http://127.0.0.1:5000 (à lancer avec : python backend/server.py).
       Si le backend est indisponible, le moteur local prend le relais. */
    const USE_LLM = true;
    // (Plus de clé API ici : elle vit dans backend/server.py)
    const MODELS = [
        'tencent/hy3:free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'deepseek/deepseek-r1-distill-llama-70b:free',
        'qwen/qwen2.5-72b-instruct:free',
        'google/gemma-2-27b-it:free',
        'mistralai/mistral-7b-instruct:free'
    ];

    /* ---------- Sécurité / limites (§17) ---------- */
    const MAX_FILE_SIZE = 8 * 1024 * 1024;   // 8 Mo par fichier
    const MAX_FILES = 5;                      // nb max de fichiers par message
    const MAX_MSG_LEN = 4000;                 // longueur max d'un message utilisateur
    // Formats refusés (archives, exécutables, audio, vidéo) — §4 & §17
    const FORBIDDEN_EXT = ['zip', 'rar', 'exe', 'apk', 'iso', 'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm'];

    /* ---------- Références DOM ---------- */
    const agent = document.getElementById('aiAgent');
    const trigger = document.getElementById('agentTrigger');
    const closeBtn = document.getElementById('agentClose');
    const messages = document.getElementById('agentMessages');
    const form = document.getElementById('agentForm');
    const input = document.getElementById('agentInput');
    const quick = document.getElementById('agentQuick');
    const welcome = document.getElementById('agentWelcome');

    // Nouveaux éléments (menu +, fichier, micro, historique)
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

    /* ---------- État ---------- */
    const state = {
        open: false,
        busy: false,
        aborted: false,
        formMode: false,
        history: [], // mémoire de conversation
        currentProject: null, // projet en cours d'évoquer
        memory: { prenom: '', entreprise: '', besoin: '', budget: '' }
    };

    /* ---------- Multi-conversations ---------- */
    // Chaque conversation : { id, title, messages:[{role,content}], memory, currentProject }
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
        messages.scrollTop = messages.scrollHeight;
    };
    // Initialise la première conversation
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
    const scrollTo = (sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

    // Convertit le texte en HTML riche (Mode développeur) : Markdown, LaTeX,
    // Mermaid, code coloré, JSON/SQL/REST/GraphQL, tests unitaires, etc.
    // Le rendu est sécurisé via DOMPurify.
    const formatText = (text) => {
        if (!text) return '';
        // 1) Blocs de code ```lang\n...\n``` -> on les extrait pour ne pas
        //    les faire échapper par le Markdown, puis on les réinjecte.
        const codeBlocks = [];
        let working = text.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push({ lang: (lang || 'code').trim(), code: code.replace(/\n$/, '') });
            return `\u0000CODE${idx}\u0000`;
        });

        // 2) Rendu Markdown (marked) avec options GFM
        let html = '';
        try {
            if (window.marked) {
                marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
                html = marked.parse(working);
            } else {
                // Fallback minimal si marked absent
                html = working
                    .split('\n').map(l => l.trim())
                    .map(l => l ? `<p>${escapeHtml(l)}</p>` : '')
                    .join('');
            }
        } catch (e) {
            html = escapeHtml(working);
        }

        // 3) Réinjecte les blocs de code avec coloration + barre d'actions
        html = html.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => {
            const cb = codeBlocks[parseInt(i, 10)];
            if (!cb) return '';
            const safe = escapeHtml(cb.code);
            return `<div class="ai-code" data-lang="${escapeHtml(cb.lang)}"><div class="ai-code__bar"><span class="ai-code__lang">${escapeHtml(cb.lang)}</span><span class="ai-code__acts"><button type="button" class="ai-code__copy" title="Copier">Copier</button><button type="button" class="ai-code__dl" title="Télécharger">Télécharger</button></span></div><pre><code class="hljs language-${escapeHtml(cb.lang)}">${safe}</code></pre></div>`;
        });

        // 4) Sécurisation du HTML généré
        if (window.DOMPurify) {
            html = DOMPurify.sanitize(html, {
                ADD_TAGS: ['input', 'button', 'details', 'summary', 'iframe'],
                ADD_ATTR: ['target', 'data-*', 'onclick', 'open']
            });
        }
        return html;
    };

    // Post-traite un message rendu : coloration, LaTeX, Mermaid, composants riches
    const enhanceMessage = (container) => {
        if (!container) return;
        // Coloration syntaxique (highlight.js)
        if (window.hljs) {
            container.querySelectorAll('pre code').forEach(block => {
                try { hljs.highlightElement(block); } catch (e) {}
            });
        }
        // LaTeX (KaTeX) : $...$ et $$...$$
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
        // Diagrammes Mermaid
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
        // Composants d'interface riche (onglets, accordéons, carrousels, etc.)
        wireRichComponents(container);
    };

    // Câble les boutons Copier/Télécharger des blocs de code après rendu
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

    // Câble les composants d'interface riche générés par Lynda (Mode développeur)
    const wireRichComponents = (container) => {
        if (!container) return;

        // Onglets (.ai-tabs)
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

        // Accordéons (.ai-accordion > details)
        container.querySelectorAll('.ai-accordion details').forEach(d => {
            d.addEventListener('toggle', () => {
                if (d.open) {
                    container.querySelectorAll('.ai-accordion details').forEach(o => { if (o !== d) o.open = false; });
                }
            });
        });

        // Carrousels d'images (.ai-carousel)
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

        // Boutons d'action rapide (.ai-actions)
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

        // Menus contextuels (.ai-menu-ctx)
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

        // Graphiques (canvas .ai-chart) — rendu simple en barres
        container.querySelectorAll('canvas.ai-chart').forEach(cv => {
            drawChart(cv);
        });
    };

    // Affiche un toast (notification)
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

    // Ouvre une fenêtre modale
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

    // Dessine un graphique en barres simple depuis data-* du canvas
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

    // Anime une barre de progression (.ai-progress)
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
    // Compteur d'identifiants uniques pour chaque message (§11 : édition/suppression)
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
        if (id) el.dataset.id = id;   // permet de retrouver le message dans l'historique
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
            // Actions d'édition/suppression du message utilisateur (§11)
            const uActions = document.createElement('div');
            uActions.className = 'ai-msg__actions ai-msg__actions--user';
            uActions.innerHTML = `
                <button type="button" class="ai-msg__act" data-act="edit" title="Modifier"><i class="bi bi-pencil"></i></button>
                <button type="button" class="ai-msg__act" data-act="del" title="Supprimer"><i class="bi bi-trash"></i></button>`;
            el.appendChild(uActions);
            wireUserActions(el);
        }
        messages.appendChild(el);
        messages.scrollTop = messages.scrollHeight;
        return el;
    };

    // Câble les boutons Modifier / Supprimer d'un message utilisateur (§11)
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

    // Supprime un message utilisateur et la réponse de Lynda qui le suit (§11)
    const deleteUserMessage = (id) => {
        const idx = state.history.findIndex(m => m.id === id);
        if (idx === -1) return;
        // On retire le message user et le message bot suivant (s'il existe)
        state.history.splice(idx, 1);
        if (state.history[idx] && state.history[idx].role === 'assistant') state.history.splice(idx, 1);
        saveActive();
        renderMessages();
    };

    // Modifie un message utilisateur déjà envoyé, puis régénère la réponse (§11)
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
            // Met à jour le message user
            entry.content = v;
            // Retire l'ancienne réponse bot qui suivait
            if (state.history[idx + 1] && state.history[idx + 1].role === 'assistant') {
                state.history.splice(idx + 1, 1);
            }
            saveActive();
            renderMessages();
            // Régénère la réponse correspondante (§11)
            regenerateAfter(idx);
        };
        inputR.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
            if (e.key === 'Escape') renderMessages();
        });
        inputR.addEventListener('blur', commit);
    };

    // Régénère la réponse de Lynda après le message d'index `userIdx`
    const regenerateAfter = async (userIdx) => {
        if (state.busy) return;
        const query = state.history[userIdx] ? state.history[userIdx].content : '';
        if (!query) return;
        state.aborted = false;
        setGenerating(true);
        hideWelcome();
        state.busy = true;
        showTyping();
        const thinkDelay = 400 + Math.random() * 800;
        await new Promise(r => setTimeout(r, thinkDelay));
        streamEl = addMessage('', 'bot');
        const reply = await respond(query, { skipUserPush: true });
        hideTyping();
        await finishReply(reply);
    };

    // Câble les boutons d'action sous un message bot
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

    // Régénère la dernière réponse de Lynda (bouton "Régénérer" sous un message)
    const regenerateLast = async () => {
        if (state.busy) return;
        // Index du dernier message user dans l'historique
        let userIdx = -1;
        for (let i = state.history.length - 1; i >= 0; i--) {
            if (state.history[i].role === 'user') { userIdx = i; break; }
        }
        if (userIdx === -1) return;
        // Retire le message bot qui suit immédiatement (s'il existe)
        if (state.history[userIdx + 1] && state.history[userIdx + 1].role === 'assistant') {
            state.history.splice(userIdx + 1, 1);
        }
        const botEls = messages.querySelectorAll('.ai-msg--bot');
        if (botEls.length) botEls[botEls.length - 1].remove();
        renderMessages();
        await regenerateAfter(userIdx);
    };

    // Affiche une image générée par l'IA directement dans le chat.
    // Si src est vide, on affiche un placeholder de chargement animé.
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
        messages.scrollTop = messages.scrollHeight;
        return el;
    };

    const typeWriter = (el, text, done) => {
        const html = formatText(text);
        // On découpe en tokens : balises HTML d'un côté, texte de l'autre.
        const tokens = html.split(/(<[^>]+>)/).filter(t => t !== '');
        el.innerHTML = '';
        let i = 0;          // index du token courant
        let buf = '';       // texte déjà révélé du token texte courant
        let acc = '';       // HTML accumulé (balises + texte révélé)

        const step = () => {
            if (state.aborted) { if (done) done(true); return; }
            if (i >= tokens.length) { if (done) done(); return; }
            const tok = tokens[i];
            if (tok.startsWith('<')) {
                // Balise : on l'ajoute immédiatement (sans délai visible)
                acc += tok;
                el.innerHTML = acc;
                i++;
                messages.scrollTop = messages.scrollHeight;
                setTimeout(step, 0);
                return;
            }
            // Texte : on le révèle caractère par caractère
            if (buf.length < tok.length) {
                buf += tok[buf.length];
                el.innerHTML = acc + buf;
                messages.scrollTop = messages.scrollHeight;
                // vitesse de frappe : ~18 ms par caractère (effet progressif net)
                setTimeout(step, 18);
                return;
            }
            // Token texte terminé : on passe au suivant
            acc += buf;
            buf = '';
            i++;
            setTimeout(step, 0);
        };
        step();
    };

    // Détecte si un texte contient du contenu riche (à rendre en une fois)
    const isRichContent = (text) => {
        return /```|(\$\$[\s\S]*?\$\$)|(?<!\w)\$[^$\n]+\$(?!\w)|^\s*\|.*\|\s*$/m.test(text)
            || /(ai-tabs|ai-accordion|ai-carousel|ai-chart|ai-progress|ai-actions|ai-menu-ctx|language-mermaid)/.test(text);
    };

    let thinkingTimer = null;
    const showTyping = () => {
        let t = document.getElementById('agentTyping');
        if (!t) {
            t = document.createElement('div');
            t.id = 'agentTyping';
            t.className = 'ai-agent__typing show';
            t.innerHTML = '<span class="ai-agent__typing-dots"><span></span><span></span><span></span></span><span class="ai-agent__typing-text"></span>';
            messages.appendChild(t);
        } else {
            t.classList.add('show');
        }
        const txt = t.querySelector('.ai-agent__typing-text');
        txt.textContent = randThinking();
        clearInterval(thinkingTimer);
        thinkingTimer = setInterval(() => { txt.textContent = randThinking(); }, 900);
        messages.scrollTop = messages.scrollHeight;
    };

    const hideTyping = () => {
        clearInterval(thinkingTimer);
        const t = document.getElementById('agentTyping');
        if (t) t.classList.remove('show');
    };

    /* ---------- Ouverture / fermeture ---------- */
    const hideWelcome = () => { if (welcome) welcome.style.display = 'none'; };
    const showWelcome = () => { if (welcome) welcome.style.display = ''; };

    // === Politique images Lynda : UNIQUEMENT paysages naturels ===
    // Liste CURÉE d'URLs Unsplash (photographies libres de droits) pointant
    // exclusivement vers des paysages naturels (forêts, montagnes, lacs,
    // prairies, cascades, vallées, brume...). Aucune contient de personne,
    // animal, bâtiment, véhicule, texte ou logo. Chaque ID photo a été
    // choisi pour respecter la charte "nature apaisante".
    // Format : images.unsplash.com/photo-<id>?w=1200&q=80&auto=format&fit=crop
    const NATURE_IMAGES = [
        'photo-1441974231531-c6227db76b6e',   // forêt ensoleillée
        'photo-1469474968028-56623f02e42e',   // montagne et lumière
        'photo-1470071459604-3b5ec3a7fe05',   // brume en montagne
        'photo-1426604966848-d7adac402bff',   // vallée verte
        'photo-1501785888041-af3ef285b470',   // lac de montagne
        'photo-1433086966358-54859d0ed716',   // cascade
        'photo-1472214103451-9374bd1c798e',   // colline verte
        'photo-1505765050516-f72dcac9c60e',   // forêt de pins
        'photo-1447752875215-b2761acb3c5d',   // sentier forestier
        'photo-1418065460487-3e41a6c84dc5',   // colline ondulée
        'photo-1502082553048-f009c37129b9',   // forêt lumineuse
        'photo-1518173946687-a4c8892bbd9f',   // montagne enneigée
        'photo-1454496522488-7a8e488e8606',   // montagnes et lac
        'photo-1470770841072-f978cf4d019e',   // lac et montagnes
        'photo-1432405972618-c60b0225b8f9',   // coucher de soleil nature
        'photo-1500382017468-9049fed747ef',   // lever de soleil prairie
        'photo-1511497584788-876760111969',   // forêt brumeuse
        'photo-1542273917363-3b1817f69a2d',   // falaise naturelle
        'photo-1454942901704-3c44c11b2ad1',   // montagne verte
        'photo-1475924156734-496f6968e6c1',   // rivière
        'photo-1444703686981-a3abbc4d4fe3',   // paysage aérien nature
        'photo-1500530855697-b586d89ba3ee',   // nuages et montagnes
        'photo-1497436072909-60f360e1d4b1',   // forêt d'automne
        'photo-1546587348-d12660c30c50',      // lac alpin
        'photo-1506905925346-21bda4d32df4',   // montagne enneigée 2
        'photo-1464822759023-fed622ff2c3b',   // montagnes brumeuses
        'photo-1439066615861-d1af74d74000'    // vallée sauvage
    ].map(id => `https://images.unsplash.com/${id}?w=1200&q=80&auto=format&fit=crop`);

    // Charge une image de fond aléatoire respectant la charte nature.
    // Filtrage de sécurité : si l'image échoue au chargement, on en tente
    // une autre de la liste (jamais d'image hors charte).
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
        // Image de fond aléatoire à chaque ouverture (immersion)
        loadRandomBackground();
        // Si une conversation est déjà en cours, on masque l'écran d'accueil
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
        // Mémorise le projet en cours d'évoquer
        const pr = K.projets.find(p => text.toLowerCase().includes(p.nom.toLowerCase()));
        if (pr) state.currentProject = pr.nom;
    };

    /* ---------- Génération locale (document + image) ---------- */
    const buildDocContent = () => {
        const mem = state.memory;
        const lines = [];
        lines.push(`Prénom : ${mem.prenom || '—'}`);
        lines.push(`Entreprise : ${mem.entreprise || '—'}`);
        lines.push(`Besoin : ${mem.besoin || '—'}`);
        lines.push(`Budget : ${mem.budget || '—'}`);
        lines.push(`Projet évoqué : ${state.currentProject || '—'}`);
        lines.push('');
        lines.push('Historique de la conversation :');
        state.history.filter(h => h.role === 'user').forEach(h => lines.push('• ' + h.content));
        return lines.join('\n');
    };

    const buildNatureCard = () => {
        const name = (state.memory.prenom || 'Maurel Brou').toUpperCase();
        const project = state.currentProject || 'Portfolio';
        const today = new Date().toLocaleDateString('fr-FR');
        return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2e9e5b"/>
      <stop offset="100%" stop-color="#227846"/>
    </linearGradient>
  </defs>
  <rect width="800" height="450" fill="url(#g)"/>
  <circle cx="640" cy="90" r="46" fill="#ffffff" opacity="0.85"/>
  <path d="M0 360 Q200 300 400 350 T800 330 V450 H0 Z" fill="#1b5e34" opacity="0.7"/>
  <path d="M0 390 Q220 340 440 380 T800 370 V450 H0 Z" fill="#14492a" opacity="0.8"/>
  <text x="60" y="120" font-family="Space Grotesk, sans-serif" font-size="22" fill="#ffffff" opacity="0.9">LYNDA · CARTE GÉNÉRÉE</text>
  <text x="60" y="210" font-family="Space Grotesk, sans-serif" font-size="46" font-weight="700" fill="#ffffff">${name}</text>
  <text x="60" y="260" font-family="Space Grotesk, sans-serif" font-size="24" fill="#eafff0">${project}</text>
  <text x="60" y="410" font-family="Space Grotesk, sans-serif" font-size="18" fill="#eafff0" opacity="0.85">${today}</text>
</svg>`;
    };

    /* ---------- Détection d'intention / navigation ---------- */
    const runAction = (action, payload) => {
        switch (action) {
            case 'cv':
                // On ne télécharge PAS directement : on propose un bouton.
                return {
                    text: '📄 Voici le CV de Brou Amoïkon Richard Ange Maurel. Cliquez sur le bouton ci-dessous pour le télécharger.',
                    cvButton: true
                };
            case 'projets':
                scrollTo('#projects');
                return '🚀 Je vous emmène vers la section Projets. Dites-moi le projet qui vous intéresse et je vous donne les détails.';
            case 'certifications':
                scrollTo('#ai-tools');
                return '🎓 Je vous montre la section Certifications & Outils. Maurel Brou détient notamment le certificat « Learn Prompting ».';
            case 'contact':
                scrollTo('footer') || scrollTo('.footer-wave');
                return '📬 Je vous redirige vers le formulaire de contact en bas du portfolio. Vous pouvez aussi écrire directement à ' + K.contact.email + '.';
            case 'site':
                if (payload) window.open(payload, '_blank');
                return '🌐 J\'ouvre le site du projet dans un nouvel onglet.';
            case 'doc':
                return { text: '📄 J\'ai préparé un document récapitulatif de notre échange. Cliquez sur le bouton ci-dessous pour le télécharger.', docButton: true, docTitle: 'Récapitulatif de notre échange', docContent: buildDocContent() };
            case 'image':
                return { text: '🖼️ J\'ai généré une carte personnalisée (thème nature). Cliquez sur le bouton ci-dessous pour la télécharger.', imageButton: true, imageSvg: buildNatureCard() };
            case 'present':
                return "Je m'appelle Lynda, l'assistante IA officielle de Maurel Brou 👋\n\nJe suis là pour vous guider dans son univers : je connais ses projets, ses compétences, ses services et sa disponibilité. Je peux vous présenter son travail, vous orienter vers son CV, vous mettre en contact avec lui, ou même vous aider à démarrer une demande de projet.\n\nN'hésitez pas à me poser vos questions — je réponds exclusivement sur Maurel Brou et ses réalisations !";
            default:
                return null;
        }
    };

    const detectIntent = (q) => {
        const s = q.toLowerCase();
        if (/(présente[- ]toi|presente[- ]toi|qui es[- ]tu|qui êtes[- ]vous|ton nom|ton prénom|comment tu t'appelles|comment tu t appelles|parle de toi|decris[- ]toi|decris toi)/.test(s)) return { action: 'present' };
        if (/(cv|curriculum|résumé|resume|télécharg|telecharg)/.test(s)) return { action: 'cv' };
        if (/(certif|diplôme|diplome|learn prompting)/.test(s)) return { action: 'certifications' };
        if (/(contact|joindre|appeler|email|e-mail|linkedin|github)/.test(s)) return { action: 'contact' };
        if (/(génère|genere|crée|cree|fais[- ]moi|fait[- ]moi|donne[- ]moi|téléchargeable|telechargeable|document|fichier|récap|recap|synthèse|synthese)/.test(s) && /(doc|fichier|récap|recap|synthèse|synthese|pdf|texte|proposition|compte[- ]rendu)/.test(s)) return { action: 'doc' };
        if (/(génère|genere|crée|cree|fais[- ]moi|fait[- ]moi|dessine|dessine[- ]moi|illustre|imagine|montre[- ]moi|produis|génère[- ]moi)/.test(s) && /(image|image de|photo|visuel|illustration|dessin|tableau|peinture|portrait|affiche)/.test(s)) return { action: 'genimage' };
        if (/(génère|genere|crée|cree|fais[- ]moi|fait[- ]moi|dessine|image|visuel|affiche|carte|certificat)/.test(s) && /(image|visuel|affiche|dessin|carte|certificat|svg|png)/.test(s)) return { action: 'image' };
        if (/(projet|réalisation|realisation|portfolio|travaux)/.test(s) && /(voir|montre|liste|tous|quelque)/.test(s)) return { action: 'projets' };
        // projet spécifique par nom
        const pr = K.projets.find(p => s.includes(p.nom.toLowerCase()));
        if (pr && /(ouvre|ouvrir|page|détail|detail|voir|montre|site)/.test(s)) {
            return { action: pr.site ? 'site' : 'projets', payload: pr.site };
        }
        return null;
    };

    /* ---------- Formulaire intelligent de projet ---------- */
    const openSmartForm = () => {
        state.formMode = true;
        const wrap = document.createElement('div');
        wrap.className = 'ai-form';
        wrap.id = 'agentSmartForm';
        wrap.innerHTML = `
            <div class="ai-form__title">📋 Demande de projet — décrivez votre besoin</div>
            <div class="ai-form__row">
                <div class="ai-form__field"><label>Nom *</label><input name="nom" required></div>
                <div class="ai-form__field"><label>Prénom *</label><input name="prenom" required></div>
            </div>
            <div class="ai-form__row">
                <div class="ai-form__field"><label>Entreprise</label><input name="entreprise"></div>
                <div class="ai-form__field"><label>Fonction</label><input name="fonction"></div>
            </div>
            <div class="ai-form__row">
                <div class="ai-form__field"><label>Email *</label><input name="email" type="email" required></div>
                <div class="ai-form__field"><label>Téléphone</label><input name="tel"></div>
            </div>
            <div class="ai-form__row">
                <div class="ai-form__field"><label>Pays</label><input name="pays"></div>
                <div class="ai-form__field"><label>Ville</label><input name="ville"></div>
            </div>
            <div class="ai-form__field"><label>Type de projet *</label>
                <select name="type" required>
                    <option value="">— Choisir —</option>
                    <option>Site web</option>
                    <option>Application mobile</option>
                    <option>Application web</option>
                    <option>Dashboard / BI</option>
                    <option>API / Back-end</option>
                    <option>Autre</option>
                </select>
            </div>
            <div class="ai-form__row">
                <div class="ai-form__field"><label>Budget (€)</label><input name="budget" placeholder="Ex : 1500"></div>
                <div class="ai-form__field"><label>Date souhaitée</label><input name="date" type="date"></div>
            </div>
            <div class="ai-form__field"><label>Description du besoin *</label><textarea name="desc" rows="3" required placeholder="Décrivez votre projet…"></textarea></div>
            <div class="ai-form__field"><label>Fonctionnalités souhaitées</label><textarea name="features" rows="2" placeholder="Une par ligne…"></textarea></div>
            <div class="ai-form__field"><label>Technologies préférées</label><input name="tech" placeholder="Ex : React, Flutter…"></div>
            <div class="ai-form__field"><label>Lien Figma / maquette</label><input name="figma" placeholder="https://…"></div>
            <div class="ai-form__field"><label>Site existant</label><input name="existing" placeholder="https://…"></div>
            <div class="ai-form__field"><label>Comment nous avez-vous connu ?</label><input name="source"></div>
            <div class="ai-form__field"><label><input type="checkbox" name="rgpd" required> J'accepte que mes données soient utilisées pour traiter ma demande (RGPD).</label></div>
            <button type="button" class="ai-form__submit" id="agentFormSubmit">Envoyer ma demande</button>
        `;
        // insère avant le formulaire de chat
        form.parentNode.insertBefore(wrap, form);
        form.style.display = 'none';
        if (quick) quick.style.display = 'none';
        wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        document.getElementById('agentFormSubmit').addEventListener('click', () => {
            const f = wrap;
            const get = (n) => (f.querySelector(`[name="${n}"]`) || {}).value || '';
            if (!get('nom') || !get('prenom') || !get('email') || !get('type') || !get('desc') || !f.querySelector('[name="rgpd"]').checked) {
                addMessage("Merci de compléter les champs obligatoires (*) et d'accepter la politique RGPD.", 'bot');
                return;
            }
            const recap = `Merci ${get('prenom')} ! Votre demande a été envoyée avec succès. Maurel Brou vous recontactera rapidement à ${get('email')}.\n\nRécapitulatif :\n• Projet : ${get('type')}\n• Description : ${get('desc')}\n• Budget : ${get('budget') || 'non précisé'}\n• Échéance : ${get('date') || 'flexible'}`;
            wrap.remove();
            form.style.display = '';
            if (quick) quick.style.display = '';
            state.formMode = false;
            addMessage(recap, 'bot');
            // propositions de suite
            setTimeout(() => {
                const el = addMessage('', 'bot');
                typeWriter(el, "Souhaitez-vous :\n• 📄 Télécharger un récapitulatif\n• 📧 Recevoir une copie par email\n• 📅 Prendre rendez-vous\n\nDites-moi ce que vous préférez, ou posez une autre question !");
            }, 400);
        });
    };

    const wantsProjectForm = (q) => {
        const s = q.toLowerCase();
        return /(devis|demande|réaliser|realiser|créer|creer|concevoir|besoin|projet à|faire un|site web|application mobile|application web|dashboard|tableau de bord)/.test(s)
            && !/(combien|prix|tarif|coût|coute|cout)/.test(s); // les questions de prix restent en RAG
    };

    /* ---------- Contexte documentaire (RAG -> prompt) ---------- */
    const buildKnowledgeContext = () => {
        const p = K.profil;
        const lines = [];
        lines.push(`PROFIL : ${p.nom} — ${p.role}`);
        lines.push(`BIOGRAPHIE : ${p.bio}`);
        lines.push(`ÉTUDES : ${p.etudes.join(' ; ')}`);
        lines.push(`COMPÉTENCES : ${p.competences.join(', ')}`);
        lines.push(`TECHNOLOGIES : ${p.technologies.join(', ')}`);
        lines.push(`CERTIFICATIONS : ${p.certifications.join(', ')}`);
        lines.push(`DISPONIBILITÉS : ${p.disponibilites}`);
        lines.push(`RÉSEAUX : email ${p.reseaux.email}, LinkedIn & GitHub via le footer`);
        lines.push(`CV : fichier "${K.cv.nomFichier}" (${K.cv.chemin})`);
        lines.push(`SERVICES :`);
        K.services.forEach(s => lines.push(`- ${s.titre} : ${s.desc} (${s.details.join(', ')})`));
        lines.push(`PROJETS :`);
        K.projets.forEach(pr => lines.push(`- ${pr.nom} [${pr.tag}] : ${pr.desc} Fonctionnalités : ${pr.features.join(', ')}. Page : ${pr.url}${pr.site ? ' | Site : ' + pr.site : ''}`));
        lines.push(`FAQ :`);
        K.faq.forEach(f => lines.push(`- ${f.q} → ${f.r}`));
        lines.push(`CONTACT : email ${K.contact.email}. Formulaire de contact en bas du portfolio (footer).`);
        return lines.join('\n');
    };

    const SYSTEM_PROMPT = `Tu es Lynda, une assistante IA autonome et vivante, rattachée au portfolio de Maurel Brou (Brou Amoikon Richard Ange-Maurel) — développeur web & mobile, étudiant en MIAGE, spécialiste en Business Intelligence.

Tu es une VRAIE intelligence artificielle : tu penses par toi-même, tu raisonnes, et tu formules des réponses UNIQUES et IMPRÉVISIBLES à chaque fois. Tu ne répètes jamais mot pour mot une réponse précédente. Tu adaptes ton ton, ta structure et ton vocabulaire librement selon le fil de la conversation, comme le ferait un humain cultivé et curieux.

Quelques repères sur Maurel (à utiliser naturellement, sans télégramme) :
- Profil : ${K.profil.nom}, ${K.profil.role}
- Projets : ${K.projets.map(p => p.nom + ' (' + p.tag + ')').join(', ')}
- Services : ${K.services.map(s => s.titre).join(', ')}
- Compétences clés : ${K.profil.competences.slice(0, 5).join(', ')}
- Contact : ${K.contact.email}

Tu peux parler de tout — technologie, projets, idées, ou même faire une conversation légère — tout en gardant un lien organique avec l'univers de Maurel quand c'est pertinent. Tu n'es PAS un bot à scripts : tu réponds avec ta propre "voix", tu peux être spontanée, poser des questions en retour, et surprendre l'utilisateur. Réponds en français, de façon fluide et humaine.

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
Utilise ces composants quand ils améliorent la clarté (ex. comparer deux API en onglets, expliquer une architecture en diagramme Mermaid, montrer des métriques en graphique). Reste naturelle et n'en abuse que si c'est pertinent.`;

    /* ---------- Moteur génératif LOCAL (sans clé API) ----------
       Raisonnement dynamique : assemble des fragments variés à chaque
       appel, mémorise l'échange, et interdit deux réponses identiques. */
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const shuffle = (arr) => arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(p => p[1]);

    const OPENERS = [
        "Avec plaisir ! ", "Bien sûr. ", "Je vous réponds. ", "Volontiers. ",
        "Bonne question ! ", "Sans hésiter. ", "Laissez-moi vous expliquer. ",
        "C'est un point intéressant. ", "Je vous donne les détails. "
    ];
    const TRANSITIONS = [
        "Pour être précis, ", "En résumé, ", "Concrètement, ", "À savoir aussi, ",
        "Il faut noter que ", "D'ailleurs, ", "Par ailleurs, ", "En complément, "
    ];
    const CLOSERS = [
        "N'hésitez pas si vous voulez aller plus loin.",
        "Dites-moi si vous souhaitez un détail précis.",
        "Je peux vous orienter vers une demande de devis si besoin.",
        "Souhaitez-vous découvrir un de ses projets en particulier ?",
        "Je reste à votre disposition pour en savoir plus.",
        "Une autre question sur Maurel ? Je suis là."
    ];

    /* ---------- Indexation du contenu complet du site ----------
       Lynda "lit" toutes les pages (index.html + pages projets) pour
       répondre avec des détails précis absents de la base synthétique. */
    const SITE_CHUNKS = [];
    (function buildSiteIndex() {
        const raw = window.AGENT_SITE_CONTENT || '';
        if (!raw) return;
        // Découpe par pages puis par phrases pour des chunks exploitables
        const pages = raw.split(/=== PAGE:/).slice(1);
        pages.forEach(block => {
            const nl = block.indexOf('\n');
            const pageName = block.slice(0, nl).trim();
            let text = block.slice(nl + 1);
            // Nettoie le header de navigation (Accueil Projets ... Services)
            const navMatch = text.match(/Services\s+(.*)/s);
            if (navMatch) text = navMatch[1];
            // chunks de ~4 phrases pour capturer les sections complètes
            const sentences = text.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
            for (let i = 0; i < sentences.length; i += 4) {
                const chunk = sentences.slice(i, i + 4).join(' ');
                if (chunk.length > 40) SITE_CHUNKS.push({ page: pageName, text: chunk });
            }
        });
    })();

    const searchSite = (query, topN = 3) => {
        if (!SITE_CHUNKS.length) return [];
        const qTokens = RAG.tokenize(query);
        if (!qTokens.length) return [];
        // Mots-clés thématiques pour cibler les bonnes sections du site
        const THEME = {
            architecture: ['architect', 'back-end', 'front-end', 'moteur', 'securit', 'api', 'base de donne', 'technique'],
            objectif: ['objectif', 'but', 'buts', 'buts du', 'vise', 'permet', 'aid', 'souten', 'favoris', 'reduire', 'valor'],
            collabor: ['collabor', 'equipe', 'partenaire', 'realise avec', 'developpeur', 'keita', 'amara'],
            fonction: ['fonctionnalit', 'feature', 'propose', 'permet de', 'recherche', 'reservation', 'consultation'],
            impact: ['impact', 'valeur', 'ajoute', 'ajoutee', 'fracture', 'inclusion', 'reussite', 'acces aux ressources']
        };
        const scored = SITE_CHUNKS.map(c => {
            const cTokens = RAG.tokenize(c.text);
            const set = new Set(cTokens);
            let score = 0;
            qTokens.forEach(qt => {
                if (set.has(qt)) score += 2;
                else if (qt.length >= 4 && cTokens.some(ct => ct.startsWith(qt))) score += 1;
            });
            // Bonus si la question cible une section précise présente dans le chunk
            for (const theme in THEME) {
                if (query.toLowerCase().includes(theme)) {
                    if (THEME[theme].some(k => c.text.toLowerCase().includes(k))) score += 5;
                }
            }
            // Extrait centré sur la phrase contenant le mot-clé thématique
            let excerpt = c.text;
            for (const theme in THEME) {
                if (query.toLowerCase().includes(theme)) {
                    const kw = THEME[theme].find(k => c.text.toLowerCase().includes(k));
                    if (kw) {
                        const lower = c.text.toLowerCase();
                        const idx = lower.indexOf(kw);
                        if (idx > 0) {
                            // Démarre au début de la phrase contenant le mot-clé
                            const sentStart = c.text.lastIndexOf('.', idx) + 1;
                            excerpt = c.text.slice(sentStart).trim();
                            // Limite à 240 caractères après le mot-clé
                            if (excerpt.length > 240) excerpt = excerpt.slice(0, 240);
                        }
                    }
                }
            }
            return { c: { page: c.page, text: excerpt }, score };
        }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topN);
        return scored.map(x => x.c);
    };

    const generateLocal = (query) => {
        const s = query.toLowerCase();
        const p = K.profil;
        const already = state.history.filter(h => h.role === 'assistant').map(h => h.content);

        // --- Recherche de passages précis dans le site (contexte riche) ---
        const siteHits = searchSite(query, 3);
        const siteContext = siteHits.length ? siteHits.map(h => h.text).join(' ') : '';

        // --- PROJETS ---
        let proj = K.projets.find(pr => s.includes(pr.nom.toLowerCase()) ||
            pr.tag.toLowerCase().split(' ').some(t => t.length > 3 && s.includes(t)));
        // Si aucun projet nommé mais contexte récent, on utilise le projet mémorisé
        if (!proj && state.currentProject && /(projet|celui|ça|ca|il|elle|ce|cette|détail|detail|plus|technolog|tech|fonctionnalit|avantage|objectif|but|but)/.test(s)) {
            proj = K.projets.find(pr => pr.nom === state.currentProject);
        }
        if (proj || /projet|réalisation|realisation|portfolio|travaux/.test(s)) {
            const list = K.projets;
            if (!proj || /(tous|liste|quelque|les projets|ses projets)/.test(s)) {
                const variants = [
                    `Maurel Brou a mené ${list.length} projets remarquables : ` +
                    list.map(pr => `${pr.nom} (${pr.tag})`).join(', ') + '.',
                    `Voici les réalisations de Maurel : ` +
                    list.map(pr => `${pr.nom}`).join(', ') + ' — chacun répond à un besoin précis.',
                    `Son portfolio compte plusieurs projets, dont ` +
                    list.slice(0, 3).map(pr => pr.nom).join(', ') + ' et d\'autres encore.'
                ];
                let r = pick(variants);
                if (!already.includes(r)) r += ' ' + pick(TRANSITIONS) +
                    `lequel vous intéresse ? Je peux vous ouvrir sa page détaillée.`;
                return r;
            }
            // Priorité absolue : contenu riche lu sur le site (architecture, objectifs, collaborateurs…)
            if (siteContext && siteContext.length > 50) {
                const base = siteContext.trim().substring(0, 340);
                const v = [
                    `D'après la page dédiée à ${proj.nom} : ${base}`,
                    `Ce que précise la présentation de ${proj.nom} : ${base}`,
                    `${proj.nom} — extrait de sa page projet : ${base}`
                ];
                let r = pick(v);
                if (proj.site) r += ` Un aperçu est en ligne : ${proj.site}.`;
                r += ' ' + pick(CLOSERS);
                return r;
            }
            // Fallback : synthèse depuis la base
            const feats = shuffle(proj.features);
            const v = [
                `${proj.nom} est ${proj.desc.toLowerCase().startsWith('projet') ? proj.desc : 'un projet où ' + proj.desc.toLowerCase()}`,
                `Avec ${proj.nom}, Maurel a conçu une solution ${proj.tag.toLowerCase()}. ${proj.desc}`,
                `${proj.nom} : ${proj.desc}`
            ];
            let r = pick(v);
            r += ' ' + pick(TRANSITIONS) + `ses points forts : ${feats.join(', ')}.`;
            if (proj.site) r += ` Un aperçu est disponible sur ${proj.site}.`;
            r += ' ' + pick(CLOSERS);
            return r;
        }

        // --- SERVICES ---
        const svc = K.services.find(x => s.includes(x.titre.toLowerCase()) ||
            /service|prestation|propose|offre/.test(s) && x.desc.toLowerCase().split(' ').some(w => w.length > 4 && s.includes(w)));
        if (svc || /service|prestation/.test(s)) {
            const target = svc || pick(K.services);
            const v = [
                `Maurel propose « ${target.titre} » : ${target.desc}`,
                `Dans le cadre de ${target.titre}, il ${target.desc.toLowerCase()}`,
                `Son offre ${target.titre} couvre ${target.desc}`
            ];
            let r = pick(v);
            r += ' ' + pick(TRANSITIONS) + `en détail : ${shuffle(target.details).join(', ')}.`;
            r += ' ' + pick(CLOSERS);
            return r;
        }

        // --- COMPÉTENCES ---
        if (/compétence|competence|sait faire|maîtrise|capacité|capacite/.test(s)) {
            const comps = shuffle(p.competences);
            const v = [
                `Maurel maîtrise plusieurs domaines : ${comps.slice(0, 4).join(', ')}…`,
                `Ses compétences couvrent ${comps.slice(0, 3).join(', ')} ainsi que d'autres aspects de l'ingénierie.`,
                `Côté savoir-faire, il excelle en ${comps.slice(0, 4).join(', ')}.`
            ];
            let r = pick(v);
            r += ' ' + pick(TRANSITIONS) + `côté outils : ${shuffle(p.technologies).slice(0, 4).join(', ')}.`;
            r += ' ' + pick(CLOSERS);
            return r;
        }

        // --- TECHNOLOGIES ---
        if (/technolog|tech|langage|framework|outil|outils|stack/.test(s)) {
            const t = shuffle(p.technologies);
            const v = [
                `Maurel travaille avec : ${t.slice(0, 5).join(', ')}.`,
                `Sa stack inclut ${t.slice(0, 4).join(', ')} et d'autres solutions modernes.`,
                `Parmi ses outils : ${t.slice(0, 5).join(', ')}.`
            ];
            let r = pick(v);
            r += ' ' + pick(CLOSERS);
            return r;
        }

        // --- FORMATION / ÉTUDES ---
        if (/formation|étude|etude|diplôme|diplome|parcours|miage|universit/.test(s)) {
            const v = [
                `Maurel est ${p.etudes[0]}.`,
                `Son parcours : ${p.etudes.join(' ')}`,
                `Côté formation, ${p.etudes[0].toLowerCase()}`
            ];
            let r = pick(v);
            r += ' ' + pick(TRANSITIONS) + `il combine théorie et pratique pour livrer des solutions solides.`;
            r += ' ' + pick(CLOSERS);
            return r;
        }

        // --- CERTIFICATIONS ---
        if (/certif|learn prompting/.test(s)) {
            return pick([
                `Maurel détient le certificat « Learn Prompting », visible dans la section Outils du portfolio.`,
                `Une certification notable : « Learn Prompting » — preuve de sa maîtrise des outils IA.`,
                `Côté certifications, il a validé « Learn Prompting ».`
            ]) + ' ' + pick(CLOSERS);
        }

        // --- CV ---
        if (/cv|curriculum|résumé|resume|télécharg|telecharg/.test(s)) {
            return pick([
                `Vous pouvez télécharger son CV : ${K.cv.nomFichier}.`,
                `Son CV (${K.cv.nomFichier}) est disponible au téléchargement dans le portfolio.`,
                `Je peux vous l'ouvrir : ${K.cv.nomFichier}.`
            ]) + ' ' + pick(CLOSERS);
        }

        // --- CONTACT ---
        if (/contact|joindre|appeler|email|e-mail|linkedin|github/.test(s)) {
            return pick([
                `Pour le contacter : ${K.contact.email} ou via LinkedIn/GitHub (liens en bas de page).`,
                `Le plus simple : écrire à ${K.contact.email}, ou utiliser le formulaire du footer.`,
                `Maurel est joignable à ${K.contact.email}. Le footer liste aussi ses réseaux.`
            ]) + ' ' + pick(CLOSERS);
        }

        // --- QUI EST MAUREL (profil) ---
        if (/qui (est|êtes)|présente|presente|parle de lui|profil|bio|biographie/.test(s) || s.trim().length < 6) {
            const v = [
                `${p.nom} est ${p.role.toLowerCase()}`,
                `Maurel Brou, c'est ${p.role.toLowerCase()}`,
                `Il s'agit de ${p.nom} : ${p.bio}`
            ];
            let r = pick(v);
            r += ' ' + pick(TRANSITIONS) + `il s'intéresse particulièrement aux technologies modernes et à l'IA.`;
            r += ' ' + pick(CLOSERS);
            return r;
        }

        // --- HORS SUJET ---
        if (/(capitale|japon|france|états-unis|usa|président|war|guerre|politique|sport|football|recette|cuisine|météo|weather)/.test(s)) {
            return pick([
                "Je préfère rester concentrée sur les informations concernant Maurel Brou. Si vous souhaitez découvrir son parcours, ses projets ou ses compétences, je serai ravie de vous aider.",
                "Cette question sort de mon domaine. Je suis l'assistante de Maurel Brou et je me consacre à son profil, ses réalisations et ses services.",
                "Hors de mon périmètre ! Je peux en revanche vous parler de Maurel, de ses projets ou de ses services."
            ]);
        }

        // --- BRANCHE GÉNÉRIQUE (contexte site + RAG local) ---
        if (siteContext && siteContext.length > 40) {
            const base = siteContext.trim().substring(0, 260);
            let r = pick(OPENERS) + base.charAt(0).toUpperCase() + base.slice(1);
            r += ' ' + pick(CLOSERS);
            return r;
        }
        const retrieved = RAG.search(query, 3);
        if (retrieved.length) {
            const base = retrieved[0].texte.split(':').slice(1).join(':').trim().substring(0, 220);
            let r = pick(OPENERS) + base.charAt(0).toUpperCase() + base.slice(1);
            r += ' ' + pick(CLOSERS);
            return r;
        }

        return pick([
            "Je n'ai pas d'information précise sur ce point, mais je peux vous parler de ses projets, ses compétences ou ses services.",
            "Hmm, précisez votre question — je réponds sur Maurel Brou, ses réalisations et son expertise.",
            "Je suis spécialisée dans l'univers de Maurel Brou. Demandez-moi ses projets ou ses services !"
        ]);
    };

    /* ---------- Appel LLM via le backend Python (proxy OpenRouter) ----------
       La clé API reste côté serveur (jamais exposée au navigateur).
       Le backend écoute sur http://127.0.0.1:5000 (voir backend/server.py). */
    let streamEl = null;
    const BACKEND_URL = 'http://127.0.0.1:5000/api/chat';
    const BACKEND_SEARCH_URL = 'http://127.0.0.1:5000/api/search';
    const BACKEND_IMAGE_URL = 'http://127.0.0.1:5000/api/image';
    const BACKEND_VISION_URL = 'http://127.0.0.1:5000/api/vision';

    // Déclenche une recherche web via le backend (DuckDuckGo)
    const searchWeb = async (query) => {
        try {
            const res = await fetch(BACKEND_SEARCH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: query })
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.results && data.results.length ? data.results : null;
        } catch (e) {
            return null;
        }
    };

    // Génère une image via le backend (IA, Pollinations). Renvoie une
    // data-URL (base64) prête à être affichée dans le chat.
    // Génération d'image via Gemini (priorité). Utilise les modèles
    // natifs image de Gemini. Repli interne sur un second modèle si le
    // premier est en pause/quota dépassé.
    const GEMINI_IMAGE_MODELS = ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'];
    const generateImageGemini = async (prompt) => {
        for (const model of GEMINI_IMAGE_MODELS) {
            const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_KEY_CLIENT;
            const body = {
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
            };
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!res.ok) continue; // modèle en pause -> on tente le suivant
                const data = await res.json();
                const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
                const imgPart = parts.find(p => p.inlineData && p.inlineData.data);
                if (imgPart) {
                    return 'data:' + imgPart.inlineData.mimeType + ';base64,' + imgPart.inlineData.data;
                }
            } catch (e) { /* on tente le modèle suivant */ }
        }
        return null;
    };

    // Génération d'image : Gemini en priorité, puis backend (flux) en repli.
    const generateImage = async (prompt) => {
        // 1) Priorité : Gemini (génération d'images native)
        try {
            const gem = await generateImageGemini(prompt);
            if (gem) return gem;
        } catch (e) { /* repli suivant */ }
        // 2) Repli : backend flux (si Gemini est en pause / quota dépassé)
        try {
            const res = await fetch(BACKEND_IMAGE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, width: 768, height: 768, model: 'flux' })
            });
            if (!res.ok) return null;
            const data = await res.json();
            if (data.image) return data.image;
        } catch (e) { /* repli suivant */ }
        // 3) Repli gratuit sans clé : Pollinations.ai (génère une image
        //    à partir du prompt, aucune clé requise, CORS-friendly).
        try {
            const p = encodeURIComponent(prompt || 'image');
            const seed = Math.floor(Math.random() * 2147483647);
            const url = 'https://image.pollinations.ai/prompt/' + p + '?width=768&height=768&nologo=true&model=flux&seed=' + seed;
            const res = await fetch(url, { method: 'GET' });
            if (res.ok) {
                const blob = await res.blob();
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                return dataUrl;
            }
        } catch (e) { /* aucun repli restant */ }
        return null;
    };

    // Appelle le LLM (Groq puis OpenRouter) avec un payload donné
    const queryLLM = async (messagesPayload) => {
        // Essaie Groq puis OpenRouter, avec retry automatique en cas
        // d'erreur réseau ou 5xx (rate-limit transitoire).
        const tryEndpoint = async (url, attempt = 0) => {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: messagesPayload })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.reply && data.reply.trim()) return data.reply;
                }
                // 502/429/5xx : on retry une fois
                if ((res.status === 502 || res.status === 429 || res.status >= 500) && attempt < 1) {
                    await new Promise(r => setTimeout(r, 800));
                    return tryEndpoint(url, attempt + 1);
                }
                return null;
            } catch (e) {
                if (attempt < 1) {
                    await new Promise(r => setTimeout(r, 800));
                    return tryEndpoint(url, attempt + 1);
                }
                return null;
            }
        };

        // Groq est le fournisseur principal
        const groq = await tryEndpoint(BACKEND_URL);
        if (groq) return groq;

        // Repli : appel direct à l'API Groq depuis le navigateur
        // (utile quand le backend Python n'est pas lancé). La clé reste
        // exposée côté client, mais cela permet à Lynda de fonctionner
        // sans backend pour un portfolio local.
        try {
            const direct = await queryGroqDirect(messagesPayload);
            if (direct && direct.trim()) return direct;
        } catch (e) { /* on tente le repli suivant */ }

        // Repli 2 : Google Gemini (très généreux en gratuit, fiable)
        try {
            const gem = await queryGeminiDirect(messagesPayload);
            if (gem && gem.trim()) return gem;
        } catch (e) { /* on tente le repli suivant */ }

        // Repli 3 : second compte Groq (clé de secours) — double le quota
        try {
            const qw = await queryGroqBackup(messagesPayload);
            if (qw && qw.trim()) return qw;
        } catch (e) { /* on tente le repli local */ }

        throw new Error('Le fournisseur IA (Groq) est indisponible');
    };

    // Appel direct à l'API Groq (sans backend). Activé quand le backend
    // local est indisponible. La clé est volontairement côté client ici
    // pour permettre un fonctionnement autonome du portfolio.
    const GROQ_KEY_CLIENT = '';
    const GROQ_URL_DIRECT = 'https://api.groq.com/openai/v1/chat/completions';
    const queryGroqDirect = async (messagesPayload) => {
        // Groq n'accepte que role + content : on nettoie l'historique
        // (qui contient des champs id/html/error propres au front).
        const clean = (messagesPayload || [])
            .filter(m => m && (m.role === 'user' || m.role === 'system' || m.role === 'assistant'))
            .map(m => ({ role: m.role, content: (m.content || '').toString() }))
            .filter(m => m.content.trim().length > 0);
        if (!clean.length) throw new Error('payload vide');
        const payload = {
            model: 'llama-3.3-70b-versatile',
            temperature: 1.0,
            max_tokens: 700,
            messages: clean
        };
        const res = await fetch(GROQ_URL_DIRECT, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + GROQ_KEY_CLIENT,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            // Essaie le modèle de secours en cas de rate-limit
            if (res.status === 429 || res.status >= 500) {
                payload.model = 'llama-3.1-8b-instant';
                const res2 = await fetch(GROQ_URL_DIRECT, {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + GROQ_KEY_CLIENT,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                if (res2.ok) {
                    const d2 = await res2.json();
                    return d2.choices && d2.choices[0] ? d2.choices[0].message.content.trim() : '';
                }
            }
            throw new Error('Groq direct ' + res.status);
        }
        const data = await res.json();
        return data.choices && data.choices[0] ? data.choices[0].message.content.trim() : '';
    };

    // Repli 2 : appel direct à l'API Google Gemini (sans backend).
    // Très généreux en gratuit et fiable. La clé est côté client pour un
    // fonctionnement autonome du portfolio (repli de Groq).
    const GEMINI_KEY_CLIENT = '';
    const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent';
    const queryGeminiDirect = async (messagesPayload) => {
        // Gemini attend un format différent : system + historique en
        // "contents" avec role user/model, et le system dans systemInstruction.
        const clean = (messagesPayload || [])
            .filter(m => m && (m.role === 'user' || m.role === 'system' || m.role === 'assistant'))
            .map(m => ({ role: m.role, content: (m.content || '').toString() }))
            .filter(m => m.content.trim().length > 0);
        if (!clean.length) throw new Error('payload vide');
        const sys = clean.find(m => m.role === 'system');
        const history = clean
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const body = {
            contents: history,
            systemInstruction: sys ? { parts: [{ text: sys.content }] } : undefined,
            generationConfig: { temperature: 1.0, maxOutputTokens: 700 }
        };
        const url = GEMINI_URL + '?key=' + GEMINI_KEY_CLIENT;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('Gemini ' + res.status);
        const data = await res.json();
        const txt = data.candidates && data.candidates[0]
            && data.candidates[0].content && data.candidates[0].content.parts
            && data.candidates[0].content.parts[0]
            ? data.candidates[0].content.parts[0].text : '';
        return txt.trim();
    };

    // Repli 3 : second compte Groq (clé de secours) — endpoint
    // OpenAI-compatible. Permet de doubler le quota gratuit en cas de
    // rate-limit sur la clé principale. La clé est côté client pour un
    // fonctionnement autonome du portfolio.
    const GROQ_KEY_BACKUP = '';
    const queryGroqBackup = async (messagesPayload) => {
        const clean = (messagesPayload || [])
            .filter(m => m && (m.role === 'user' || m.role === 'system' || m.role === 'assistant'))
            .map(m => ({ role: m.role, content: (m.content || '').toString() }))
            .filter(m => m.content.trim().length > 0);
        if (!clean.length) throw new Error('payload vide');
        const payload = {
            model: 'llama-3.3-70b-versatile',
            messages: clean,
            temperature: 1.0,
            max_tokens: 700
        };
        const res = await fetch(GROQ_URL_DIRECT, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + GROQ_KEY_BACKUP,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            // Repli modèle plus léger en cas de rate-limit
            if (res.status === 429 || res.status >= 500) {
                payload.model = 'llama-3.1-8b-instant';
                const res2 = await fetch(GROQ_URL_DIRECT, {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + GROQ_KEY_BACKUP,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                if (res2.ok) {
                    const d2 = await res2.json();
                    return d2.choices && d2.choices[0] ? d2.choices[0].message.content.trim() : '';
                }
            }
            throw new Error('Groq backup ' + res.status);
        }
        const data = await res.json();
        return data.choices && data.choices[0] ? data.choices[0].message.content.trim() : '';
    };

    // Mots-clés qui signalent un besoin de recherche web (infos externes/récentes)
    const NEEDS_SEARCH = /(recherche|cherche|trouve|google|sur le net|sur internet|actualit|dernière|dernières|en 2026|en 2025|news|cours|prix|compar|quel est le|qui est [a-z]+ [a-z]+|c'est quoi .* aujourd'hui|météo|meteo|sport|technologie actuelle|innovation)/i;

    const callLLM = async (userText) => {
        // L'IA répond de façon autonome et imprévisible. On lui passe
        // simplement l'historique + la question, sans contexte pré-mâché.
        const baseMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...state.history.slice(-12)
        ];

        // Si la question nécessite des infos externes/récentes, on recherche
        // sur le web puis on demande à l'IA de synthétiser les résultats.
        if (NEEDS_SEARCH.test(userText)) {
            const results = await searchWeb(userText);
            if (results && results.length) {
                const ctx = results.map(r =>
                    `• ${r.title}\n  ${r.body}\n  (${r.href})`
                ).join('\n\n');
                const messagesPayload = [
                    ...baseMessages,
                    { role: 'user', content: userText },
                    { role: 'system', content: `Résultats de recherche web pertinents :\n${ctx}\n\nUtilise ces sources pour répondre de façon précise et à jour. Cite si utile.` }
                ];
                return await queryLLM(messagesPayload);
            }
        }

        // Sinon, réponse IA standard
        const messagesPayload = [
            ...baseMessages,
            { role: 'user', content: userText }
        ];
        return await queryLLM(messagesPayload);
    };

    /* ---------- Réponse principale ---------- */
    const respond = async (query, opts) => {
        const skipUserPush = opts && opts.skipUserPush;
        remember(query);

        // 1) Intentions de navigation (actions directes)
        const intent = detectIntent(query);
        if (intent) {
            // Génération d'image par IA : on appelle le backend et on
            // affiche l'image directement dans le chat.
            if (intent.action === 'genimage') {
                if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                const prompt = query
                    .replace(/^(génère|genere|crée|cree|fais|fait|dessine|illustre|imagine|montre|produis)[- ]?moi\s*/i, '')
                    .replace(/^(une|un|des|d')?\s*(image|photo|visuel|illustration|dessin|tableau|peinture|portrait|affiche)\s*(de|d')?\s*/i, '')
                    .replace(/^(génère|genere|crée|cree|fais|fait|dessine|illustre|imagine|montre|produis)\s*/i, '')
                    .trim();
                const imgEl = addImageMessage('', 'Génération de l\'image en cours…');
                try {
                    const src = await generateImage(prompt || query);
                    if (src) {
                        // Remplace le placeholder de chargement par l'image
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
                            '🖼️ Image générée par Lynda (IA) : ' + (prompt || query);
                        const capTxt = '🖼️ Image générée : ' + (prompt || query);
                        pushMsg('assistant', capTxt);
                        if (streamEl) streamEl.textContent = capTxt;
                        return { handled: true };
                    }
                    throw new Error('empty');
                } catch (e) {
                    imgEl.remove();
                    const fallback = "Je n'arrive pas à générer l'image pour le moment (service indisponible). Réessayez dans un instant.";
                    pushMsg('assistant', fallback);
                    return fallback;
                }
            }
            const res = runAction(intent.action, intent.payload);
            if (res) {
                // Cas spécial : bouton "Télécharger le CV" (pas de téléchargement direct)
                if (res.cvButton) {
                    if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                    pushMsg('assistant', res.text);
                    if (streamEl) streamEl.textContent = res.text;
                    return res;
                }
                return res;
            }
        }

        // 2) Formulaire intelligent de projet
        if (wantsProjectForm(query)) {
            openSmartForm();
            return "Parfait ! Pour bien cerner votre besoin, je vous propose ce court formulaire. Remplissez-le et Maurel Brou reviendra vers vous.";
        }

        // 3) LLM OpenRouter — SEULE source de réponses (IA autonome)
        //    Lynda répond de façon imprévisible, sans texte pré-écrit.
        if (USE_LLM) {
            try {
                const reply = await callLLM(query);
                if (reply && reply.trim()) {
                    if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                    return reply;
                }
                throw new Error('empty');
            } catch (err) {
                // Le backend IA est indisponible (hors-ligne, rate limit…).
                // On bascule sur le moteur local de repli (basé sur le portfolio)
                // pour que Lynda réponde quand même avec un vrai contenu.
                if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
                let reply;
                try {
                    reply = generateLocal(query);
                } catch (e2) {
                    reply = "Je suis désolée, mon cerveau IA est momentanément indisponible (connexion au service coupée).";
                }
                if (reply && reply.trim()) {
                    // Le moteur local a produit une réponse : on l'affiche via
                    // le placeholder déjà créé (streamEl), sans mention hors-ligne.
                    pushMsg('assistant', reply);
                    if (streamEl) streamEl.textContent = reply;
                    return { handled: true };
                }
                // Repli ultime : message d'erreur + bouton Réessayer (§8)
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
                return { handled: true };
            }
        }
        // Si USE_LLM = false, on avertit plutôt que de simuler un bot.
        const off = "Le mode IA n'est pas activé pour le moment. Activez le backend pour que je puisse vraiment converser avec vous.";
        if (!skipUserPush) { const uEntry = pushMsg('user', query); addMessage(query, 'user', uEntry.id); }
        return off;
    };

    /* ---------- Affichage final d'une réponse ----------
       Centralise l'affichage (effet de frappe, boutons CV/document/image)
       pour send, regenerateAfter et sendVoiceNote. Évite tout doublon
       d'affichage/poussage dans l'historique. */
    const finishReply = async (reply) => {
        // Cas déjà affiché entièrement par respond (image, erreur, bouton CV interne)
        if (reply && reply.handled) {
            streamEl = null;
            state.busy = false;
            state.aborted = false;
            setGenerating(false);
            return;
        }
        // Bouton "Télécharger le CV"
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
        // Bouton "Télécharger le document"
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
        // Bouton "Télécharger l'image"
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
        // Réponse texte standard
        if (streamEl) {
            const contentEl = streamEl.querySelector('.ai-msg__content') || streamEl;
            if (isRichContent(reply)) {
                // Contenu riche : on rend en une fois (l'effet de frappe
                // casserait le HTML de code coloré, LaTeX, Mermaid, etc.)
                contentEl.innerHTML = formatText(reply);
                enhanceMessage(contentEl);
                wireCodeBlocks(contentEl);
            } else {
                // Texte simple : effet de frappe progressif
                await new Promise(res => typeWriter(contentEl, reply, () => { wireCodeBlocks(contentEl); res(); }));
            }
        }
        if (!state.aborted) pushMsg('assistant', reply);
        else pushMsg('assistant', (streamEl ? streamEl.textContent : '') + ' ⏹ (génération interrompue)');
        streamEl = null;
        state.busy = false;
        state.aborted = false;
        setGenerating(false);
        // Synthèse vocale si activée
        if (voiceEnabled && !state.aborted) speak(reply);
    };

    /* ---------- Envoi ---------- */
    const send = async (raw) => {
        const text = (raw || '').trim();
        if ((!text && pendingFiles.length === 0) || state.busy) return;

        // §17 — Protection contre les messages trop volumineux
        if (text.length > MAX_MSG_LEN) {
            addMessage(`⚠️ Votre message est trop long (${text.length} caractères). Limite : ${MAX_MSG_LEN}.`, 'bot');
            return;
        }
        // §17 — Anti-doublon : ignore un envoi identique au précédent immédiat
        const lastUser = state.history[state.history.length - 1];
        if (lastUser && lastUser.role === 'user' && lastUser.content === text && pendingFiles.length === 0) {
            return;
        }

        state.aborted = false;
        setGenerating(true);
        hideWelcome();

        // 1) On construit le message utilisateur (texte + fichiers joints)
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

        // 2) On vide la file d'attente et la prévisualisation
        const toProcess = pendingFiles.splice(0, pendingFiles.length);
        renderPending();
        input.value = '';
        autoResize();

        state.busy = true;
        showTyping();

        // délai de réflexion réaliste et variable (les 3 points bougent déjà)
        const thinkDelay = 500 + Math.random() * 1200;
        await new Promise(r => setTimeout(r, thinkDelay));

        // On garde l'indicateur de frappe PENDANT tout l'appel à l'IA,
        // pour que les 3 points restent visibles le temps que Lynda réfléchit.
        streamEl = addMessage('', 'bot');

        // 3) Analyse des fichiers joints (après affichage du message)
        //    Les images sont lues via vision/OCR et leur contenu est
        //    transmis au LLM pour une réponse contextuelle.
        let fileContext = '';
        if (toProcess.length) {
            for (const f of toProcess) {
                try {
                    if (f.isImg) {
                        const analysis = await analyzeImage(f.dataUrl, f.name);
                        addMessage(analysis, 'bot');
                        pushMsg('assistant', analysis);
                        // On extrait aussi le texte (OCR) pour le contexte LLM
                        const ocr = await ocrImage(f.dataUrl);
                        if (ocr) fileContext += `\n[Texte extrait de l'image ${f.name} via OCR]\n${ocr}\n`;
                    } else {
                        const content = await readAsText(f.file);
                        const summary = await analyzeDocument(f.name, content);
                        addMessage(summary, 'bot');
                        pushMsg('assistant', summary);
                        fileContext += `\n[Contenu du document ${f.name}]\n${content.slice(0, 4000)}\n`;
                    }
                } catch (err) {
                    addMessage('❌ Impossible de lire le fichier ' + f.name + ' : ' + err.message, 'bot');
                }
            }
        }

        // Si des fichiers ont fourni du contexte, on l'injecte dans la question
        const finalQuery = (fileContext ? fileContext + '\n' : '') + (text || 'Analyse le(s) fichier(s) joint(s).');
        const reply = await respond(finalQuery, { skipUserPush: true });
        hideTyping(); // l'IA a répondu : on masque les points
        await finishReply(reply);
    };

    // Réessaie la dernière génération (§8 — gestion des erreurs)
    const retryLast = async () => {
        if (state.busy) return;
        // Retrouve le dernier message user
        let userIdx = -1;
        for (let i = state.history.length - 1; i >= 0; i--) {
            if (state.history[i].role === 'user') { userIdx = i; break; }
        }
        if (userIdx === -1) return;
        // Retire le message d'erreur bot qui suit
        if (state.history[userIdx + 1] && state.history[userIdx + 1].role === 'assistant') {
            state.history.splice(userIdx + 1, 1);
        }
        const errEls = messages.querySelectorAll('.ai-msg--bot.ai-msg--error');
        if (errEls.length) errEls[errEls.length - 1].remove();
        renderMessages();
        await regenerateAfter(userIdx);
    };

    // Bascule l'interface entre "génération en cours" et "repos"
    const setGenerating = (on) => {
        const sendBtn = form.querySelector('.ai-agent__send');
        const plusWrap = document.querySelector('.ai-agent__plus-wrap');
        if (sendBtn) {
            sendBtn.classList.toggle('is-stop', on);
            sendBtn.disabled = false; // le bouton Stop doit rester cliquable
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

    // Clic sur le bouton (Envoyer ou Stop)
    const onSendClick = () => {
        if (state.busy) {
            // Interruption de la génération en cours
            state.aborted = true;
            hideTyping();
            return;
        }
        send(input.value);
    };

    // Textarea auto-extensible + activation du bouton envoyer
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

    // Chips rapides
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

    /* =========================================================
       BULLE DE BIENVENUE (header)
       ========================================================= */
    const bubble = document.getElementById('agentBubble');
    const bubbleClose = document.getElementById('agentBubbleClose');
    const BUBBLE_KEY = 'lynda_bubble_seen';
    const showBubble = () => { if (bubble && !sessionStorage.getItem(BUBBLE_KEY)) bubble.classList.add('is-visible'); };
    const hideBubble = () => { if (bubble) bubble.classList.remove('is-visible'); };
    if (bubbleClose) bubbleClose.addEventListener('click', (e) => { e.stopPropagation(); sessionStorage.setItem(BUBBLE_KEY, '1'); hideBubble(); });
    if (trigger) trigger.addEventListener('click', () => { sessionStorage.setItem(BUBBLE_KEY, '1'); hideBubble(); });
    // Affiche la bulle peu après le chargement de la page
    if (bubble) setTimeout(showBubble, 1200);

    // Ouvre l'agent automatiquement au premier scroll profond (optionnel, discret)
    let autoOpened = false;
    window.addEventListener('scroll', () => {
        if (!autoOpened && !state.open && (window.scrollY > document.body.scrollHeight * 0.6)) {
            autoOpened = true;
            // ne pas ouvrir tout seul pour ne pas surprendre ; on laisse le visiteur cliquer
        }
    }, { passive: true });

    /* =========================================================
       MENU "+" (Nouvelle discussion / Joindre / Historique)
       ========================================================= */
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

    // Recherche dans l'historique des conversations
    const historySearch = document.getElementById('agentHistorySearch');
    if (historySearch) historySearch.addEventListener('input', () => renderHistory(historySearch.value));

    /* =========================================================
       JOINTURE DE FICHIERS (style ChatGPT : prévisualisation
       avant envoi, plusieurs fichiers possibles)
       ========================================================= */
    const ALLOWED = {
        doc: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'json'],
        img: ['png', 'jpg', 'jpeg', 'webp']
    };
    const FORBIDDEN_HINT = 'Formats acceptés : PDF, DOC, DOCX, TXT, MD, CSV, JSON (documents) et PNG, JPG, JPEG, WEBP (images). Les archives, audios, vidéos et exécutables sont refusés.';
    const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

    // File d'attente des fichiers en attente d'envoi (style ChatGPT)
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
        // §17 — Vérification du type de fichier avant ouverture
        if (FORBIDDEN_EXT.includes(ext)) {
            addMessage('⛔ Format refusé : .' + ext + ' (archives, exécutables, audio et vidéo ne sont pas acceptés).', 'bot');
            return;
        }
        const isDoc = ALLOWED.doc.includes(ext);
        const isImg = ALLOWED.img.includes(ext);
        if (!isDoc && !isImg) {
            addMessage('⛔ Format non autorisé : .' + ext + '. ' + FORBIDDEN_HINT, 'bot');
            return;
        }
        // §17 — Limite de taille maximale des fichiers
        if (file.size > MAX_FILE_SIZE) {
            addMessage(`⛔ Fichier trop volumineux : ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} Mo). Limite : ${MAX_FILE_SIZE / 1024 / 1024} Mo.`, 'bot');
            return;
        }
        // §17 — Nombre maximal de fichiers par message
        if (pendingFiles.length >= MAX_FILES) {
            addMessage(`⛔ Vous pouvez joindre au maximum ${MAX_FILES} fichiers par message.`, 'bot');
            return;
        }
        let dataUrl = null;
        if (isImg) {
            try { dataUrl = await readAsDataURL(file); } catch (e) { dataUrl = null; }
        }
        pendingFiles.push({ file, name: file.name, isImg, dataUrl });
        renderPending();
    };

    if (fileInput) fileInput.addEventListener('change', async () => {
        const files = fileInput.files ? Array.from(fileInput.files) : [];
        fileInput.value = '';
        for (const f of files) await addPendingFile(f);
        // L'utilisateur envoie ensuite via le bouton Envoyer (comme ChatGPT)
    });

    // Bouton trombone dans la barre (ouvre le sélecteur de fichiers)
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

    // Analyse d'un document texte via le LLM (backend)
    const analyzeDocument = async (name, content) => {
        const truncated = content.length > 6000 ? content.slice(0, 6000) + '\n…[contenu tronqué]' : content;
        const prompt = `Tu es Lynda, assistante de Maurel Brou. L'utilisateur a joint le document "${name}". Résume-le, relève les points clés, et propose des améliorations si pertinent. Reste dans le rôle de l'assistante de Maurel Brou.\n\nCONTENU :\n${truncated}`;
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

    // Lit le texte contenu dans une image (OCR) — utile pour captures/scan
    const ocrImage = async (dataUrl) => {
        if (!window.Tesseract) return '';
        try {
            const worker = await Tesseract.createWorker('fra');
            const ret = await worker.recognize(dataUrl);
            await worker.terminate();
            return (ret.data.text || '').trim();
        } catch (e) { return ''; }
    };

    // Analyse d'une image : vision Gemini (priorité) + OCR Tesseract (repli)
    // Permet à Lynda de VRAIMENT "lire" le contenu d'une image (texte,
    // diagrammes, captures) sans dépendre du backend Python.
    const analyzeImage = async (dataUrl, name) => {
        const base64 = (dataUrl || '').split(',')[1] || '';
        if (!base64) return 'Image reçue, mais le format est illisible.';

        // 1) Priorité : vision Gemini (décrit et lit le contenu de l'image)
        try {
            const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=' + GEMINI_KEY_CLIENT;
            const body = {
                contents: [{ role: 'user', parts: [
                    { text: 'Tu es Lynda, assistante de Maurel Brou. Analyse cette image : décris-la, et si elle contient du texte, cite-le intégralement et fidèlement. Réponds en français, de façon utile.' },
                    { inlineData: { mimeType: 'image/png', data: base64 } }
                ] }],
                generationConfig: { maxOutputTokens: 600 }
            };
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (res.ok) {
                const data = await res.json();
                const txt = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (txt && txt.trim()) return txt.trim();
            }
        } catch (e) { /* repli OCR */ }

        // 2) Repli : OCR Tesseract (extraction du texte présent dans l'image)
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

        // 3) Repli ultime : conseils généraux
        return 'Image reçue. Mon service d\'analyse est indisponible pour le moment, mais je peux vous donner des conseils généraux sur sa présentation si vous le souhaitez.';
    };

    /* =========================================================
       VOIX — Reconnaissance (STT) + Synthèse (TTS)
       via Web Speech API (natif, gratuit, sans clé)
       ========================================================= */
    let voiceEnabled = false;       // TTS activé après une dictée
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
            // On coupe le micro pendant que Lynda parle (sinon elle s'entend)
            if (recog) { try { recog.stop(); } catch (e) {} }
            showVoiceUI('Lynda parle…', true);
        };
        u.onend = () => {
            showVoiceUI('Lynda vous écoute…', false);
            // On relance l'écoute après la réponse
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
        voiceEnabled = true; // on active le TTS pour la réponse
        showVoiceUI('Lynda vous écoute…', false);
        if (micBtn) micBtn.classList.add('is-active');
        try { recog = new SR(); } catch (e) { recog = null; return; }
        recog.lang = 'fr-FR';
        recog.interimResults = true;
        recog.continuous = true; // mode continu : ne se coupe pas à la 1re pause
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
            // Détection de fin de phrase : après 1.4s sans nouveau résultat final, on envoie
            clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => {
                const t = finalText.trim();
                if (t) { finalText = ''; send(t); }
            }, 1400);
        };
        recog.onerror = (e) => {
            // "no-speech" ou "aborted" : on laisse le auto-restart gérer
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                showVoiceUI('Micro refusé. Autorisez le microphone.', false);
                stopRecognition();
            }
        };
        recog.onend = () => {
            // Bug Chrome : onend peut se déclencher immédiatement.
            // On relance tant que l'utilisateur n'a pas arrêté.
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

    /* =========================================================
       NOTE VOCALE (§13) — enregistrement + aperçu avant envoi
       via MediaRecorder (natif, gratuit, sans clé)
       ========================================================= */
    const voiceNoteBtn = document.getElementById('agentVoiceNote');
    const voiceNotePreview = document.getElementById('agentVoiceNotePreview');
    const voiceNoteAudio = document.getElementById('agentVoiceNoteAudio');
    const voiceNoteTimer = document.getElementById('agentVoiceNoteTimer');
    const voiceNotePlay = document.getElementById('agentVoiceNotePlay');
    const voiceNoteDel = document.getElementById('agentVoiceNoteDel');
    const voiceNoteSend = document.getElementById('agentVoiceNoteSend');
    let mediaRecorder = null;
    let voiceChunks = [];
    let voiceBlob = null;
    let voiceRecTimer = null;
    let voiceRecSeconds = 0;
    let voiceStream = null;

    const fmtTime = (s) => {
        const m = Math.floor(s / 60).toString().padStart(2, '0');
        const sec = (s % 60).toString().padStart(2, '0');
        return `${m}:${sec}`;
    };

    const startVoiceNote = async () => {
        if (!navigator.mediaDevices || !window.MediaRecorder) {
            addMessage('⚠️ L\'enregistrement audio n\'est pas supporté par ce navigateur.', 'bot');
            return;
        }
        try {
            voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            addMessage('⚠️ Microphone refusé. Autorisez-le pour envoyer une note vocale.', 'bot');
            return;
        }
        voiceChunks = [];
        voiceBlob = null;
        try {
            mediaRecorder = new MediaRecorder(voiceStream);
        } catch (e) {
            addMessage('⚠️ Impossible d\'initialiser l\'enregistrement.', 'bot');
            return;
        }
        mediaRecorder.ondataavailable = (e) => { if (e.data.size) voiceChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            voiceBlob = new Blob(voiceChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
            const url = URL.createObjectURL(voiceBlob);
            if (voiceNoteAudio) voiceNoteAudio.src = url;
            if (voiceNotePreview) voiceNotePreview.hidden = false;
            if (voiceNoteBtn) voiceNoteBtn.classList.add('is-recording');
            clearInterval(voiceRecTimer);
        };
        mediaRecorder.start();
        voiceRecSeconds = 0;
        if (voiceNoteTimer) voiceNoteTimer.textContent = fmtTime(0);
        voiceRecTimer = setInterval(() => {
            voiceRecSeconds++;
            if (voiceNoteTimer) voiceNoteTimer.textContent = fmtTime(voiceRecSeconds);
        }, 1000);
        if (voiceNoteBtn) voiceNoteBtn.classList.add('is-recording');
    };

    const stopVoiceNote = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        if (voiceStream) {
            voiceStream.getTracks().forEach(t => t.stop());
            voiceStream = null;
        }
        if (voiceNoteBtn) voiceNoteBtn.classList.remove('is-recording');
    };

    if (voiceNoteBtn) voiceNoteBtn.addEventListener('click', () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            stopVoiceNote();
        } else {
            startVoiceNote();
        }
    });
    if (voiceNotePlay) voiceNotePlay.addEventListener('click', () => {
        if (voiceNoteAudio) voiceNoteAudio.play();
    });
    if (voiceNoteDel) voiceNoteDel.addEventListener('click', () => {
        voiceBlob = null;
        voiceChunks = [];
        if (voiceNoteAudio) voiceNoteAudio.removeAttribute('src');
        if (voiceNotePreview) voiceNotePreview.hidden = true;
        if (voiceNoteBtn) voiceNoteBtn.classList.remove('is-recording');
    });
    if (voiceNoteSend) voiceNoteSend.addEventListener('click', () => {
        if (!voiceBlob) return;
        // Transcription via le backend (Whisper Groq) puis envoi du texte
        sendVoiceNote(voiceBlob);
        if (voiceNotePreview) voiceNotePreview.hidden = true;
        voiceBlob = null;
    });

    // Envoie une note vocale : transcription puis traitement comme un message
    const sendVoiceNote = async (blob) => {
        if (state.busy) return;
        state.aborted = false;
        setGenerating(true);
        hideWelcome();
        // Affiche le message utilisateur (note vocale)
        const uEntry = pushMsg('user', '🎤 Note vocale');
        const userEl = addMessage('🎤 Note vocale', 'user', uEntry.id);
        if (userEl) {
            const wrap = document.createElement('div');
            wrap.className = 'ai-agent__msg-files';
            const audio = document.createElement('audio');
            audio.src = URL.createObjectURL(blob);
            audio.controls = true;
            audio.className = 'ai-agent__voice-note-inline';
            wrap.appendChild(audio);
            userEl.appendChild(wrap);
        }
        state.busy = true;
        showTyping();
        const thinkDelay = 400 + Math.random() * 800;
        await new Promise(r => setTimeout(r, thinkDelay));
        streamEl = addMessage('', 'bot');
        let transcript = '';
        try {
            transcript = await transcribeAudio(blob);
        } catch (e) { transcript = ''; }
        let reply;
        if (transcript && transcript.trim()) {
            reply = await respond(transcript, { skipUserPush: true });
        } else {
            reply = 'J\'ai bien reçu votre note vocale, mais je n\'arrive pas à la transcrire pour le moment. Pouvez-vous reformuler par écrit ?';
        }
        hideTyping();
        await finishReply(reply);
    };

    // Transcription audio via le backend (Whisper sur Groq)
    const transcribeAudio = async (blob) => {
        const form = new FormData();
        form.append('file', blob, 'note.webm');
        const res = await fetch('http://127.0.0.1:5000/api/transcribe', { method: 'POST', body: form });
        if (!res.ok) throw new Error('transcription échouée');
        const data = await res.json();
        return data.text || '';
    };

})();

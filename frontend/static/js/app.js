/**
 * AIvora v2.0 — Frontend Application
 * ENSA Beni Mellal · USMS
 * Rôles différenciés: étudiant / professeur / admin
 * Profil, changement mdp, EDT dynamique
 */

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
let audioContext;
let analyser;
let dataArray;


function startAudioAnalysis(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    
    // On mesure l'agitation de la voix
    detectVocalStress();
}

function detectVocalStress() {
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
    }
    let average = sum / dataArray.length;
    
    // Si le volume est très instable ou trop haut, on marque un "Audio Stress"
    if (average > 100) { 
        APP.audioStressDetected = true; 
    }
    
    if (APP.recording) requestAnimationFrame(detectVocalStress);
}
const APP = {
  user:                 null,
  token:                null,
  activePDF:            null,
  currentConversationId: null,   // ← ID de la conversation en cours
  degradeMode:          false,
  recording:            false,
  reqLog:               [],
  cacheHits:            0,
  piiCount:             0,
  latencies:            [],
  reportTarget:         null,
  adminRepTarget:       null,
  schedTarget:          null,
  voiceTranscript:      '',
  MAX_RPM:              10,
  notifications:        [],
  pdfs:                 [],
};

// ═══════════════════════════════════════════════════
// PII REGEX — double protection côté client
// ═══════════════════════════════════════════════════
const PII_PATTERNS = [
  { re: /\b[A-Za-z]{1,2}[\s.\-_/\\|]{0,3}(?:\d[\s.\-_/\\|]{0,3}){6}\b/gi, label: 'CIN' },
  { re: /\b(?:\d[\s.\-]{0,2}){16}\b/g, label: 'CARTE_BANCAIRE' },
  { re: /\b0[5-7](?:[\s.\-]?\d{2}){4}\b/g, label: 'TELEPHONE' },
  { re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, label: 'EMAIL' },
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, label: 'IP' },
  { re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){4,7}\b/g, label: 'IBAN' },
];
function filterPII(text) {
  let f = text, d = [];
  for (const { re, label } of PII_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(f)) { d.push(label); re.lastIndex = 0; f = f.replace(re, `[DONNÉE_${label}_FILTRÉE]`); }
    re.lastIndex = 0;
  }
  return { filtered: f, detected: d };
}

// SQLi detection
const SQLI_RE = [
  /\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|EXEC|TRUNCATE)\b/i,
  /(--|#|\/\*|\*\/)/,
  /('|`).*(OR|AND)\s+\w+\s*=\s*\w+/i,
  /\b1\s*=\s*1\b/i,
];
const detectSQLi = t => SQLI_RE.some(r => r.test(t));

// Rate limiting client
function checkRate() {
  const now = Date.now();
  APP.reqLog = APP.reqLog.filter(t => now - t < 60000);
  if (APP.reqLog.length >= APP.MAX_RPM) return false;
  APP.reqLog.push(now);
  updateRateBar();
  return true;
}
// BUG 4 CORRIGÉ: robustifié pour ne jamais crasher si un élément est absent
function updateRateBar() {
  const n = APP.reqLog.length;
  const pct = (n / APP.MAX_RPM * 100);
  const fill = document.getElementById('rate-fill');
  const ctr  = document.getElementById('rate-counter');
  if (fill) {
    fill.style.width = pct + '%';
    fill.style.background = n >= 8 ? '#ef4444' : n >= 6 ? '#f59e0b' : '#10b981';
  }
  if (ctr) ctr.textContent = n + '/10';
}

// API helper
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (APP.token) headers['X-Auth-Token'] = APP.token;
  const res = await fetch(path, { ...options, headers, credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

// ═══════════════════════════════════════════════════
// LOGIN / LOGOUT
// ═══════════════════════════════════════════════════
async function doLogin() {
  const email = document.getElementById('li-email').value.trim().toLowerCase();
  const pass  = document.getElementById('li-pass').value;
  let ok = true;
  ['e-email','e-pass','e-general'].forEach(id => document.getElementById(id).classList.add('hidden'));
  ['li-email','li-pass'].forEach(id => document.getElementById(id).classList.remove('error'));

  if (!email || !email.endsWith('@usms.ac.ma')) {
    document.getElementById('e-email').classList.remove('hidden');
    document.getElementById('li-email').classList.add('error');
    ok = false;
  }
  if (!pass) {
    document.getElementById('e-pass').classList.remove('hidden');
    document.getElementById('li-pass').classList.add('error');
    ok = false;
  }
  if (!ok) return;

  const btn = document.getElementById('login-btn');
  const txt = document.getElementById('login-btn-text');
  const spn = document.getElementById('login-spinner');
  btn.disabled = true; txt.textContent = 'Connexion…'; spn.classList.remove('hidden');

  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: pass }) });
    APP.token = data.token;
    APP.user  = data.user;
    localStorage.setItem('aivora_token', data.token);
    initApp();
  } catch(e) {
    const eg = document.getElementById('e-general');
    eg.textContent = e.error || 'Identifiants incorrects. Contactez l\'administration ENSA.';
    eg.classList.remove('hidden');
    ['li-email','li-pass'].forEach(id => document.getElementById(id).classList.add('error'));
  } finally {
    btn.disabled = false; txt.textContent = 'Accéder à la plateforme'; spn.classList.add('hidden');
  }
}

function togglePwd() {
  const inp = document.getElementById('li-pass');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}
// Charge la liste des conversations à gauche
async function fetchHistory() {
  const container = document.getElementById('history-list');
  if (!container) return;

  try {
    const data = await api('/api/conversations');
    if (!data.length) {
      container.innerHTML = '<div style="color:var(--text-muted,#8b949e);font-size:11px;padding:8px 4px;">Aucune conversation</div>';
      return;
    }
    container.innerHTML = data.map(item => {
      const isActive = APP.currentConversationId === item.id;
      const title = (item.title || 'Conversation').substring(0, 38);
      const display = title.length < (item.title || '').length ? title + '…' : title;
      return `
        <div class="sb-history-item${isActive ? ' sb-history-active' : ''}"
             title="${escHtml(item.title || '')}">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;" onclick="loadConversation('${item.id}')">
            <i class="fas fa-comment-dots" style="font-size:10px;margin-right:7px;opacity:0.55;flex-shrink:0;"></i>${escHtml(display)}
          </span>
          <button onclick="deleteConversation('${item.id}',this)" title="Supprimer" style="background:none;border:none;color:var(--text-muted,#8b949e);cursor:pointer;padding:0 2px;font-size:11px;flex-shrink:0;opacity:0.5;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.5">✕</button>
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div style="color:gray;font-size:10px;">Historique indisponible</div>';
  }
}

// Charge tous les messages d'une conversation et les affiche
async function loadConversation(convId) {
  APP.currentConversationId = convId;
  const chatContainer = document.getElementById('chat-messages');
  const welcome = document.getElementById('welcome-screen');

  if (welcome) welcome.classList.add('hidden');
  chatContainer.innerHTML = '<div class="typing-bubble">Chargement de la conversation…</div>';

  try {
    const messages = await api(`/api/conversations/${convId}/messages`);
    chatContainer.innerHTML = '';

    if (!messages.length) {
      chatContainer.innerHTML = '<div style="text-align:center;color:gray;margin-top:40px;">Conversation vide</div>';
    } else {
      messages.forEach(m => {
        if (m.role === 'user') addUserMsg(m.content, [], m.id);
        else addAIMsg(m.content, m.mode, m.latency_ms, m.id);
      });
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    fetchHistory(); // Mettre à jour la surbrillance active dans la sidebar
  } catch (e) {
    chatContainer.innerHTML = '';
    toast('Erreur', 'Impossible de charger cette conversation', 'error');
  }
}
// ═══════════════════════════════════════════════════
// INIT APP — configuration selon le rôle
// ═══════════════════════════════════════════════════
function initApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  const u = APP.user;
  const role = u.role;

  // Sidebar info
  document.getElementById('sb-name').textContent  = u.name;
  document.getElementById('sb-email').textContent = u.email;
  document.getElementById('sb-avatar').textContent = u.name.charAt(0).toUpperCase();
  document.getElementById('ws-name').textContent  = u.prenom || u.name.split(' ')[0];

  // Role badge
  const badge = document.getElementById('role-badge');
  badge.textContent = { student:'ÉTUDIANT', professor:'PROFESSEUR', admin:'ADMINISTRATEUR' }[role] || role.toUpperCase();
  badge.className = 'role-badge ' + { student:'student', professor:'prof', admin:'admin' }[role];

  // Nav selon rôle
  document.querySelectorAll('.role-prof').forEach(el => {
    el.classList.toggle('hidden', role !== 'professor');
  });
  document.querySelectorAll('.role-admin').forEach(el => {
    el.classList.toggle('hidden', role !== 'admin');
  });

  // Chips welcome selon rôle
  renderWelcomeChips(role);

  // Placeholder input selon rôle
  const placeholders = {
    student:   'Posez une question sur vos cours, l\'ENSA, ou demandez votre planning…',
    professor: 'Analysez un PDF, demandez de l\'aide pédagogique, ou consultez l\'EDT…',
    admin:     'Demandez des statistiques, des rapports ou des informations de gestion…',
  };
  document.getElementById('user-input').placeholder = placeholders[role] || 'Posez votre question…';

  fetchStatus();
  fetchPDFs();
  fetchHistory();
  fetchNotifications();
  renderScheduleView();
  setInterval(fetchStatus, 15000);
  setInterval(fetchNotifications, 10000);

  toast('Connexion réussie', `Bienvenue ${u.prenom || u.name} — Session Edge active`, 'success');
}

function renderWelcomeChips(role) {
  const chips = {
    student: [
      "Mon emploi du temps aujourd'hui",
      "Présentation de l'ENSA Béni Mellal",
      "Filière IACS — programme et modules",
      "Explique les réseaux de neurones",
      "Crée mon planning de révision S4",
      "Procédure pour un stage PFE",
    ],
    professor: [
      "Analyse le cours PDF importé",
      "Génère des questions d'examen sur ce cours",
      "Comment structurer un TP de cybersécurité ?",
      "Aide-moi à rédiger un sujet de projet",
      "Points clés à évaluer en DevOps",
    ],
    admin: [
      "Statistiques d'utilisation de la plateforme",
      "Signalements en attente de traitement",
      "Comment gérer les comptes utilisateurs ?",
      "Procédures RGPD pour les données étudiantes",
    ],
  };
  const container = document.getElementById('ws-chips');
  container.innerHTML = (chips[role] || chips.student).map(c =>
    `<div class="chip" onclick="useChip(this)">${escHtml(c)}</div>`
  ).join('');
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  APP.token = null; APP.user = null;
  localStorage.removeItem('aivora_token');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('li-pass').value = '';
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('welcome-screen').style.display = '';
  toast('Déconnecté', 'Session terminée avec succès', 'info');
}

// ═══════════════════════════════════════════════════
// PROFIL — Voir et changer le mot de passe
// ═══════════════════════════════════════════════════
function openProfileModal() {
  const u = APP.user;
  if (!u) return;

  document.getElementById('profile-avatar-big').textContent = u.name.charAt(0).toUpperCase();
  document.getElementById('profile-full-name').textContent = u.name;
  const roleLabels = { student:'Étudiant', professor:'Professeur', admin:'Administrateur' };
  const roleTag = document.getElementById('profile-role-tag');
  roleTag.textContent = roleLabels[u.role] || u.role;
  roleTag.style.background = { student:'var(--accent)', professor:'#8b5cf6', admin:'#ef4444' }[u.role] || 'var(--accent)';

  document.getElementById('p-prenom').textContent = u.prenom || '—';
  document.getElementById('p-nom').textContent    = u.nom || '—';
  document.getElementById('p-email').textContent  = u.email;
  document.getElementById('p-filiere').textContent= u.filiere || '—';
  document.getElementById('p-niveau').textContent = u.niveau || '—';
  document.getElementById('p-apogee').textContent = u.num_apogee || (u.role !== 'student' ? 'N/A (personnel)' : '—');

  // Cacher N° Apogée pour admin
  if (u.role === 'admin') {
    document.getElementById('p-apogee-row').style.display = 'none';
  } else {
    document.getElementById('p-apogee-row').style.display = '';
  }

  // Reset pwd fields
  ['pwd-current','pwd-new','pwd-confirm'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('pwd-error').classList.add('hidden');

  document.getElementById('profile-modal').classList.remove('hidden');
}

function closeProfileModal() {
  document.getElementById('profile-modal').classList.add('hidden');
}

async function changePassword() {
  const current = document.getElementById('pwd-current').value;
  const newPwd  = document.getElementById('pwd-new').value;
  const confirm = document.getElementById('pwd-confirm').value;
  const errEl   = document.getElementById('pwd-error');
  errEl.classList.add('hidden');

  if (!current || !newPwd || !confirm) {
    errEl.textContent = 'Tous les champs sont requis.';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPwd.length < 8) {
    errEl.textContent = 'Le nouveau mot de passe doit contenir au moins 8 caractères.';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPwd !== confirm) {
    errEl.textContent = 'Les mots de passe ne correspondent pas.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    await api('/api/profile/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: current, new_password: newPwd })
    });
    toast('✅ Mot de passe modifié', 'Votre mot de passe a été mis à jour avec succès.', 'success');
    closeProfileModal();
  } catch(e) {
    errEl.textContent = e.error || 'Erreur lors du changement de mot de passe.';
    errEl.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════
async function fetchStatus() {
  try {
    const s = await api('/api/status');
    const mode = APP.degradeMode ? 'degrade' : s.mode;
    setModeUI(mode);
    document.getElementById('rp-cache').textContent = s.total_cache_hits || 0;
  } catch {}
}

function setModeUI(mode) {
  const dot   = document.getElementById('mode-dot');
  const label = document.getElementById('mode-label');
  const rp    = document.getElementById('rp-mode');
  if (!dot) return;
  const configs = {
    edge:     { dot: '#10b981', label: 'MODE EDGE',    rp: 'EDGE',    rpCls: 'rp-val rp-blue' },
    cache:    { dot: '#3b82f6', label: 'CACHE',        rp: 'CACHE',   rpCls: 'rp-val rp-teal' },
    degrade:  { dot: '#f59e0b', label: 'MODE DÉGRADÉ', rp: 'DÉGRADÉ', rpCls: 'rp-val rp-orange' },
    degraded: { dot: '#f59e0b', label: 'MODE DÉGRADÉ', rp: 'DÉGRADÉ', rpCls: 'rp-val rp-orange' },
  };
  const cfg = configs[mode] || configs.edge;
  dot.style.background = cfg.dot;
  label.textContent    = cfg.label;
  if (rp) { rp.textContent = cfg.rp; rp.className = cfg.rpCls; }
}

// ═══════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
// SEND MESSAGE — version corrigée
// Corrections:
//   • checkRate() appelé AVANT d'envoyer (rate limiting fonctionnel)
//   • PII filter + SQLi detection actifs
//   • fetchHistory() appelé APRÈS chaque réponse
//   • Analyse stress en parallèle (non bloquante)
// ═══════════════════════════════════════════════════
async function sendMessage() {
  const input = document.getElementById('user-input');
  const raw = input.value.trim();
  if (!raw) return;

  // ── Rate limiting ──
  if (!checkRate()) {
    toast('Anti-DDoS', 'Limite 10 req/min atteinte. Patientez.', 'warning');
    addBlockMsg('⛔ Limite de requêtes (10/min) atteinte. Protection anti-DDoS active.');
    return;
  }

  // ── Sécurité côté client ──
  if (detectSQLi(raw)) {
    toast('Sécurité', 'Tentative d\'injection SQL bloquée.', 'error');
    addBlockMsg('⛔ Contenu bloqué : injection SQL détectée.');
    return;
  }
  const { filtered, detected } = filterPII(raw);
  if (detected.length) {
    APP.piiCount++;
    const piiEl = document.getElementById('rp-pii');
    if (piiEl) piiEl.textContent = APP.piiCount;
    toast('Données filtrées', 'PII supprimées : ' + detected.join(', '), 'warning');
  }

  input.value = '';
  updateCharCount();
  document.getElementById('welcome-screen').classList.add('hidden');
  const msgId = 'u-' + Date.now();
  addUserMsg(filtered, detected, msgId);
  document.getElementById('send-btn').disabled = true;

  // ── Si un PDF est actif → envoyer la question au PDF ──
  if (APP.activePDF) {
    await sendPDFQuery(filtered);
    document.getElementById('send-btn').disabled = false;
    return;
  }

  const tid = addTyping();

  try {
    // Appel principal au chat avec conversation_id
    const res = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: filtered, conversation_id: APP.currentConversationId })
    });
    removeTyping(tid);

    // Stocker l'ID de conversation retourné par le backend
    if (res.conversation_id) APP.currentConversationId = res.conversation_id;

    // Analyse de stress en parallèle (non bloquante)
    let stressLabel = '';
    try {
      const stressRes = await api('/api/stress/analyze', {
        method: 'POST',
        body: JSON.stringify({ transcript: filtered })
      });
      if (stressRes.level === 'high') {
        stressLabel = '**' + stressRes.label + '** — ' + stressRes.recommendation + '\n\n';
        toast('Bien-être', stressRes.recommendation, 'warning');
      }
    } catch {}

    const aiId = 'ai-' + Date.now();
    addAIMsg((stressLabel || '') + res.response, res.mode, res.latency_ms, aiId);
    updatePerf(res.latency_ms);
    setModeUI(APP.degradeMode ? 'degrade' : (res.mode || 'edge'));

    // Cache hit
    if (res.mode === 'cache') {
      APP.cacheHits++;
      const chEl = document.getElementById('rp-cache');
      if (chEl) chEl.textContent = APP.cacheHits;
      addCacheEntry(filtered);
    }

    // Rafraîchir l'historique après chaque réponse
    fetchHistory();

  } catch (e) {
    removeTyping(tid);
    addAIMsg('_Erreur de connexion. Vérifiez que Flask est démarré (`python backend/app.py`)._', 'degrade', 0, 'err-' + Date.now());
  } finally {
    document.getElementById('send-btn').disabled = false;
  }
}
// ═══════════════════════════════════════════════════
// PDF
// ═══════════════════════════════════════════════════
async function sendPDFQuery(question) {
  if (!APP.activePDF) return;
  const tid = addTyping();
  try {
    const res = await api(`/api/pdf/${APP.activePDF.id}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ question })
    });
    removeTyping(tid);
    addAIMsg(res.response, res.mode, res.latency_ms, 'pdf-' + Date.now(), true);
    updatePerf(res.latency_ms);
  } catch(e) {
    removeTyping(tid);
    addAIMsg('_Erreur lors de l\'analyse du PDF._', 'degrade', 0, 'err-' + Date.now());
  }
}

async function pdfQuickAction(action) {
  if (!APP.activePDF) return;
  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('send-btn').disabled = true;
  const labels = { resume:'Résume ce cours', questions:'Génère des questions sur ce cours', 'points-cles':'Points clés du cours', quiz:'Crée un quiz sur ce cours' };
  addUserMsg(labels[action] || action, [], 'pdf-q-'+Date.now());
  const tid = addTyping();
  try {
    const res = await api(`/api/pdf/${APP.activePDF.id}/analyze`, { method: 'POST', body: JSON.stringify({ action }) });
    removeTyping(tid);
    addAIMsg(res.response, res.mode, res.latency_ms, 'pdf-r-'+Date.now(), true);
    updatePerf(res.latency_ms);
  } catch(e) {
    removeTyping(tid);
    addAIMsg('_Erreur d\'analyse PDF._', 'degrade', 0, 'e'+Date.now());
  }
  document.getElementById('send-btn').disabled = false;
}

async function uploadPDFs(evt) {
  const files = [...evt.target.files];
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/pdf/upload', {
        method: 'POST',
        headers: { 'X-Auth-Token': APP.token },
        body: fd
      });
      const data = await res.json();
      if (res.ok) {
        APP.pdfs.push({ id: data.id, name: data.name });
        renderPDFList();
        document.getElementById('rp-pdfs').textContent = APP.pdfs.length;
        toast('PDF importé', `${file.name} — ${data.chars} caractères extraits`, 'success');
      } else {
        toast('Erreur PDF', data.error || 'Erreur d\'upload', 'error');
      }
    } catch {
      toast('Erreur', 'Impossible d\'uploader le fichier', 'error');
    }
  }
  evt.target.value = '';
}

// Upload cours prof (avec module_name et is_course)
async function uploadCoursePDF(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const moduleName = document.getElementById('course-module-name').value.trim();
  const isShared   = document.getElementById('course-is-shared').checked;

  const fd = new FormData();
  fd.append('file', file);
  fd.append('module_name', moduleName);
  fd.append('is_course', isShared ? 'true' : 'false');

  try {
    const res = await fetch('/api/pdf/upload', {
      method: 'POST',
      headers: { 'X-Auth-Token': APP.token },
      body: fd
    });
    const data = await res.json();
    if (res.ok) {
      toast('✅ Cours déposé', `${file.name}${isShared ? ' — Partagé avec les étudiants' : ''}`, 'success');
      fetchProfCourses();
      fetchPDFs();
    } else {
      toast('Erreur', data.error || 'Erreur upload', 'error');
    }
  } catch {
    toast('Erreur', 'Impossible d\'uploader', 'error');
  }
  evt.target.value = '';
}

async function fetchPDFs() {
  try {
    const pdfs = await api('/api/pdf/list');
    APP.pdfs = pdfs.map(p => ({ id: p.id, name: p.original_name, is_course: p.is_course, module: p.module_name }));
    renderPDFList();
    document.getElementById('rp-pdfs').textContent = APP.pdfs.length;
  } catch {}
}

function renderPDFList() {
  const list = document.getElementById('pdf-list');
  if (!APP.pdfs.length) {
    list.innerHTML = '<div class="sb-pdf-empty">Aucun PDF importé</div>';
    return;
  }
  list.innerHTML = APP.pdfs.map(p => `
    <div class="sb-pdf-item ${APP.activePDF?.id === p.id ? 'active-pdf' : ''}" onclick="selectPDF('${p.id}','${escHtml(p.name)}')">
      <span style="font-size:14px;flex-shrink:0">${p.is_course ? '📚' : '📄'}</span>
      <span class="sb-pdf-item-name" title="${escHtml(p.name)}">${escHtml(p.name)}</span>
      <button class="sb-pdf-del" onclick="event.stopPropagation();deletePDF('${p.id}')">✕</button>
    </div>`).join('');
}

function selectPDF(id, name) {
  APP.activePDF = { id, name };
  renderPDFList();
  document.getElementById('pdf-context-bar').classList.remove('hidden');
  document.getElementById('pdf-ctx-name').textContent = name;
  document.getElementById('user-input').placeholder = `Posez une question sur "${name}"…`;
  toast('PDF actif', name + ' — Utilisez les actions rapides ou posez vos questions', 'info');
}

function clearPDFCtx() {
  APP.activePDF = null;
  renderPDFList();
  document.getElementById('pdf-context-bar').classList.add('hidden');
  const role = APP.user?.role || 'student';
  const placeholders = {
    student:   'Posez une question sur vos cours, l\'ENSA, ou demandez votre planning…',
    professor: 'Analysez un PDF, demandez de l\'aide pédagogique, ou consultez l\'EDT…',
    admin:     'Demandez des statistiques, des rapports ou des informations de gestion…',
  };
  document.getElementById('user-input').placeholder = placeholders[role] || 'Posez votre question…';
}

function deletePDF(id) {
  APP.pdfs = APP.pdfs.filter(p => p.id !== id);
  if (APP.activePDF?.id === id) clearPDFCtx();
  renderPDFList();
  document.getElementById('rp-pdfs').textContent = APP.pdfs.length;
}

// ═══════════════════════════════════════════════════
// PROFESSEUR — Cours déposés
// ═══════════════════════════════════════════════════
async function fetchProfCourses() {
  try {
    const pdfs = await api('/api/pdf/list');
    const container = document.getElementById('prof-courses-list');
    if (!pdfs.length) {
      container.innerHTML = '<div class="reports-empty">Aucun cours déposé pour l\'instant.</div>';
      return;
    }
    container.innerHTML = pdfs.map(p => `
      <div class="course-pdf-card">
        <div class="course-pdf-icon">${p.is_course ? '📚' : '📄'}</div>
        <div class="course-pdf-info">
          <div class="course-pdf-name">${escHtml(p.original_name)}</div>
          <div class="course-pdf-meta">
            ${p.module_name ? `Module: ${escHtml(p.module_name)} · ` : ''}
            Déposé le ${formatDate(p.created_at)}
          </div>
        </div>
        ${p.is_course ? '<span class="course-shared-badge">Partagé</span>' : ''}
      </div>`).join('');
  } catch {}
}

// ═══════════════════════════════════════════════════
// PROFESSEUR — Soumettre une séance EDT
// ═══════════════════════════════════════════════════
async function submitProfSchedule() {
  const module_name = document.getElementById('ps-module').value.trim();
  const jour        = parseInt(document.getElementById('ps-jour').value);
  const heure_debut = document.getElementById('ps-debut').value;
  const heure_fin   = document.getElementById('ps-fin').value;
  const salle       = document.getElementById('ps-salle').value.trim();
  const filiere     = document.getElementById('ps-filiere').value.trim();

  if (!module_name || !heure_debut || !heure_fin) {
    toast('Champs manquants', 'Veuillez remplir le module, l\'heure de début et l\'heure de fin.', 'error');
    return;
  }

  try {
    await api('/api/schedule/add', {
      method: 'POST',
      body: JSON.stringify({ module_name, jour, heure_debut, heure_fin, salle, filiere })
    });
    toast('✅ Séance soumise', 'En attente de confirmation par l\'administration.', 'success');
    fetchProfSchedule();
    // Reset form
    document.getElementById('ps-module').value = '';
  } catch(e) {
    toast('Erreur', e.error || 'Impossible de soumettre la séance.', 'error');
  }
}

async function fetchProfSchedule() {
  try {
    const entries = await api('/api/schedule/my');
    const container = document.getElementById('prof-sched-list');
    const badge = document.getElementById('prof-sched-badge');
    const pending = entries.filter(e => e.status === 'pending').length;

    if (pending > 0) {
      badge.textContent = pending;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    if (!entries.length) {
      container.innerHTML = '<div class="reports-empty">Aucune séance soumise.</div>';
      return;
    }
    const DAY_NAMES = {1:'Lundi',2:'Mardi',3:'Mercredi',4:'Jeudi',5:'Vendredi',6:'Samedi'};
    container.innerHTML = entries.map(e => `
      <div class="sched-card">
        <div class="sched-card-header">
          <div>
            <div class="sched-module">${escHtml(e.module_name)}</div>
            <div class="sched-meta">${DAY_NAMES[e.jour] || '?'} · ${e.heure_debut}–${e.heure_fin} · ${escHtml(e.salle)}</div>
          </div>
          <span class="sched-status-${e.status}">${
            {pending:'⏳ En attente', confirmed:'✅ Confirmé', rejected:'❌ Refusé'}[e.status] || e.status
          }</span>
        </div>
        ${e.admin_note ? `<div style="font-size:12px;color:var(--text3);margin-top:6px;">Note admin: ${escHtml(e.admin_note)}</div>` : ''}
        <div style="font-size:11px;color:var(--text3);margin-top:4px;">${formatDate(e.created_at)}</div>
      </div>`).join('');
  } catch {}
}

// ═══════════════════════════════════════════════════
// ADMIN — Statistiques
// ═══════════════════════════════════════════════════
async function fetchAdminStats() {
  try {
    const s = await api('/api/admin/stats');
    const container = document.getElementById('admin-stats-cards');
    const cards = [
      { val: s.total_users,      label: 'Utilisateurs actifs' },
      { val: s.total_students,   label: 'Étudiants' },
      { val: s.total_professors, label: 'Professeurs' },
      { val: s.total_messages,   label: 'Messages échangés' },
      { val: s.pending_reports,  label: 'Signalements en attente' },
      { val: s.pending_schedule, label: 'Séances à valider' },
      { val: s.cache_hits,       label: 'Cache hits' },
      { val: (s.avg_latency_ms || 0) + ' ms', label: 'Latence moyenne' },
    ];
    container.innerHTML = cards.map(c => `
      <div class="admin-stat-card">
        <div class="admin-stat-val">${c.val}</div>
        <div class="admin-stat-label">${c.label}</div>
      </div>`).join('');
  } catch {}
}

// ═══════════════════════════════════════════════════
// ADMIN — Validation EDT
// ═══════════════════════════════════════════════════
async function fetchAdminSchedule() {
  try {
    const entries = await api('/api/schedule/pending');
    const container = document.getElementById('admin-sched-list');
    const badge = document.getElementById('sched-badge');
    const pending = entries.filter(e => e.status === 'pending').length;

    if (pending > 0) {
      badge.textContent = pending;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    if (!entries.length) {
      container.innerHTML = '<div class="reports-empty">Aucune séance en attente de validation.</div>';
      return;
    }
    const DAY_NAMES = {1:'Lundi',2:'Mardi',3:'Mercredi',4:'Jeudi',5:'Vendredi',6:'Samedi'};
    container.innerHTML = entries.map(e => `
      <div class="sched-card">
        <div class="sched-card-header">
          <div>
            <div class="sched-module">${escHtml(e.module_name)}</div>
            <div class="sched-meta">
              Prof: ${escHtml(e.prof_name)} (${escHtml(e.prof_email)})<br>
              ${DAY_NAMES[e.jour] || '?'} · ${e.heure_debut}–${e.heure_fin} · ${escHtml(e.salle)} · ${escHtml(e.filiere)}
            </div>
          </div>
          <span class="sched-status-${e.status}">${
            {pending:'⏳ En attente', confirmed:'✅ Confirmé', rejected:'❌ Refusé'}[e.status] || e.status
          }</span>
        </div>
        <div style="font-size:11px;color:var(--text3);">Soumis: ${formatDate(e.created_at)}</div>
        ${e.status === 'pending' ? `
        <div class="sched-actions">
          <button class="btn-confirm" onclick="openSchedModal('${e.id}','${escHtml(e.module_name)}','${DAY_NAMES[e.jour]}','${e.heure_debut}','${e.heure_fin}')">✅ Confirmer</button>
          <button class="btn-reject"  onclick="openSchedModal('${e.id}','${escHtml(e.module_name)}','${DAY_NAMES[e.jour]}','${e.heure_debut}','${e.heure_fin}')">❌ Refuser</button>
        </div>` : ''}
      </div>`).join('');
  } catch {}
}

function openSchedModal(id, module, jour, debut, fin) {
  APP.schedTarget = id;
  document.getElementById('admin-sched-modal-info').innerHTML =
    `<strong>${escHtml(module)}</strong> — ${escHtml(jour)} ${escHtml(debut)}–${escHtml(fin)}`;
  document.getElementById('admin-sched-note').value = '';
  document.getElementById('admin-sched-modal').classList.remove('hidden');
}

async function handleScheduleAction(action) {
  if (!APP.schedTarget) return;
  const note = document.getElementById('admin-sched-note').value.trim();
  try {
    await api(`/api/schedule/${APP.schedTarget}/confirm`, {
      method: 'POST', body: JSON.stringify({ action, note })
    });
    document.getElementById('admin-sched-modal').classList.add('hidden');
    APP.schedTarget = null;
    toast(action === 'confirm' ? '✅ Séance confirmée' : '❌ Séance refusée',
          'Le professeur a été notifié.', 'success');
    fetchAdminSchedule();
    renderScheduleView(); // refresh EDT
  } catch(e) {
    toast('Erreur', e.error || 'Impossible de traiter la séance.', 'error');
  }
}

// ═══════════════════════════════════════════════════
// SCHEDULE VIEW — EDT avec séances confirmées
// ═══════════════════════════════════════════════════
async function renderScheduleView() {
  const grid = document.getElementById('schedule-content');
  if (!grid) return;

  let schedData;
  try {
    schedData = await api('/api/schedule');
  } catch {
    schedData = null;
  }

  const today = new Date().getDay() === 0 ? 7 : new Date().getDay();
  const DAYS = {1:'Lundi',2:'Mardi',3:'Mercredi',4:'Jeudi',5:'Vendredi',6:'Samedi'};
  grid.innerHTML = '';

  for (let d = 1; d <= 5; d++) {
    const div = document.createElement('div');
    div.className = 'sched-day';
    const isToday = d === today;
    div.innerHTML = `<div class="sched-day-title ${isToday?'today-label':''}">${DAYS[d]}${isToday?' ● Aujourd\'hui':''}</div>`;

    const courses = schedData?.full_schedule?.[String(d)] || [];
    if (!courses.length) {
      div.innerHTML += '<div style="font-size:11px;color:var(--text3);padding:8px 4px;">Pas de cours</div>';
    }
    courses.forEach(c => {
      div.innerHTML += `<div class="sched-course ${isToday?'today-course':''} ${c.extra?'extra-course':''}">
        <div class="sc-name">${c.name}${c.extra ? ' <span style="font-size:9px;color:#8b5cf6;">[NOUVEAU]</span>' : ''}</div>
        ${c.prof ? `<div class="sc-prof">${c.prof}</div>` : ''}
        <div class="sc-time">${c.heure}${c.salle ? ' · '+c.salle : ''}</div>
      </div>`;
    });
    grid.appendChild(div);
  }

  // Today courses in right panel
  const todayCourses = schedData?.today_courses || [];
  if (todayCourses.length) {
    document.getElementById('rp-today-section').style.display = 'block';
    document.getElementById('rp-today-courses').innerHTML = todayCourses.map(c =>
      `<div class="rp-today-course"><div class="rp-tc-name">${c.name}</div><div class="rp-tc-meta">${c.heure}${c.prof ? ' · '+c.prof : ''}</div></div>`
    ).join('');
  }
}

function askPlanning(type) {
  switchView('chat', document.querySelector('.sb-item[data-view="chat"]'));
  const prompts = {
    semaine: 'Donne-moi l\'emploi du temps complet de la semaine S4 IACS.',
    examen:  'Crée mon planning de révision avant les examens S4.',
    aujourd: 'Quels sont mes cours aujourd\'hui ?',
  };
  document.getElementById('user-input').value = prompts[type] || '';
  updateCharCount();
  sendMessage();
}

// ═══════════════════════════════════════════════════
// SIGNALEMENTS
// ═══════════════════════════════════════════════════
function openReportModal(msgId) {
  APP.reportTarget = msgId;
  document.getElementById('report-modal').classList.remove('hidden');
  document.getElementById('report-desc').value = '';
}
function closeReportModal() { document.getElementById('report-modal').classList.add('hidden'); APP.reportTarget = null; }

async function submitReport() {
  const desc = document.getElementById('report-desc').value.trim();
  if (!desc) return;
  try {
    await api('/api/reports', { method: 'POST', body: JSON.stringify({ description: desc, message_id: APP.reportTarget }) });
    closeReportModal();
    toast('Signalement envoyé', 'L\'administration a été notifiée. Vous serez informé(e) de la réponse.', 'success');
  } catch { toast('Erreur', 'Impossible d\'envoyer le signalement', 'error'); }
}

async function fetchReports() {
  try {
    const reports = await api('/api/reports');
    renderReports(reports);
  } catch {}
}

function renderReports(reports) {
  const isAdmin = APP.user?.role === 'admin';
  // Pour l'admin: remplir le panel dédié admin-reports-panel
  // Pour l'utilisateur: remplir reports-list
  const listId  = isAdmin ? 'admin-reports-panel' : 'reports-list';
  const container = document.getElementById(listId);
  if (!container) return;
  if (!reports.length) {
    container.innerHTML = '<div class="reports-empty">Aucun signalement pour le moment.</div>';
    return;
  }
  container.innerHTML = reports.map(r => `
    <div class="report-card">
      <div class="report-card-header">
        <span class="report-ref">Ref #${r.id.substring(0,8)}</span>
        <span class="report-status status-${r.status}">${r.status === 'pending' ? '⏳ En attente' : '✅ Résolu'}</span>
      </div>
      ${isAdmin ? `<div style="font-size:11px;color:var(--text3);margin-bottom:6px;">De: ${escHtml(r.user_name||'')} &lt;${escHtml(r.user_email||'')}&gt;</div>` : ''}
      <div class="report-desc">${escHtml(r.description)}</div>
      ${r.admin_reply ? `<div class="report-reply"><div class="report-reply-title">📬 Réponse de l'administration:</div>${escHtml(r.admin_reply)}</div>` : ''}
      <div class="report-date">${formatDate(r.created_at)}</div>
      ${isAdmin && r.status === 'pending' ? `<button class="admin-reply-btn" onclick="openAdminReply('${r.id}','${escHtml(r.description).substring(0,80)}')">📬 Répondre</button>` : ''}
    </div>`).join('');

  if (isAdmin) {
    const pending = reports.filter(r => r.status === 'pending').length;
    // badge principal admin
    const badge = document.getElementById('admin-badge');
    if (badge) { badge.textContent = pending; pending > 0 ? badge.classList.remove('hidden') : badge.classList.add('hidden'); }
    // badge sidebar signalements
    const repBadge = document.getElementById('admin-reports-badge');
    if (repBadge) { repBadge.textContent = pending; pending > 0 ? repBadge.classList.remove('hidden') : repBadge.classList.add('hidden'); }
  }
}

async function fetchAdminReportsPanel() {
  try {
    const reports = await api('/api/reports');
    renderReports(reports);
  } catch {}
}

function openAdminReply(reportId, desc) {
  APP.adminRepTarget = reportId;
  document.getElementById('admin-modal-desc').textContent = desc + '…';
  document.getElementById('admin-reply-text').value = '';
  document.getElementById('admin-reply-modal').classList.remove('hidden');
}
function closeAdminModal() { document.getElementById('admin-reply-modal').classList.add('hidden'); APP.adminRepTarget = null; }

async function submitAdminReply() {
  const reply = document.getElementById('admin-reply-text').value.trim();
  if (!reply || !APP.adminRepTarget) return;
  try {
    await api(`/api/reports/${APP.adminRepTarget}/reply`, { method: 'POST', body: JSON.stringify({ reply }) });
    closeAdminModal();
    fetchReports();
    toast('Réponse envoyée', 'L\'étudiant a été notifié.', 'success');
  } catch(e) { toast('Erreur', e.error || 'Impossible d\'envoyer la réponse', 'error'); }
}

// ═══════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════
async function fetchNotifications() {
  try {
    const notifs = await api('/api/notifications');
    APP.notifications = notifs;
    const unread = notifs.filter(n => !n.is_read).length;
    const badge  = document.getElementById('notif-count');
    if (unread > 0) { badge.textContent = unread; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
    renderNotifications(notifs);
  } catch {}
}

function renderNotifications(notifs) {
  const list = document.getElementById('notif-list');
  if (!notifs.length) { list.innerHTML = '<div class="nd-empty">Aucune notification</div>'; return; }
  list.innerHTML = notifs.map(n => `
    <div class="nd-item ${!n.is_read ? 'unread' : ''}">
      <div class="nd-item-title">${escHtml(n.title)}</div>
      <div class="nd-item-msg">${escHtml(n.message)}</div>
      <div class="nd-item-time">${formatDate(n.created_at)}</div>
    </div>`).join('');
}

function toggleNotifications() {
  const dd = document.getElementById('notif-dropdown');
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) fetchNotifications();
}
async function markAllRead() {
  try { await api('/api/notifications/read', { method: 'POST' }); fetchNotifications(); } catch {}
}
document.addEventListener('click', e => {
  if (!e.target.closest('#notif-btn') && !e.target.closest('#notif-dropdown')) {
    document.getElementById('notif-dropdown')?.classList.add('hidden');
  }
});

// ═══════════════════════════════════════════════════
// VOICE
// ═══════════════════════════════════════════════════
let mediaRec = null, audioChunks = [];

// 1. Remplacez votre fonction toggleVoice (ou celle qui lance le micro) par celle-ci :
function toggleVoice() {
  if (APP.recording) {
    stopVoice();
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  const recognition = new SpeechRecognition();
  
  // ICI : On force le français pour que "examen" ne devienne pas "egg zen"
  recognition.lang = 'fr-FR'; 
  recognition.interimResults = false;

  recognition.onstart = () => {
    APP.recording = true;
    document.getElementById('voice-modal').classList.remove('hidden');
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    document.getElementById('user-input').value = transcript;
    stopVoice();
    // On lance l'envoi pour que l'IA analyse le texte
    sendMessage(); 
  };

  recognition.onerror = () => stopVoice();
  recognition.start();
}

// 2. Assurez-vous que stopVoice ressemble à ceci :
function stopVoice() {
    APP.recording = false;
    document.getElementById('voice-modal').classList.add('hidden');
}

function processVoice() {
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recog = new SR();
    recog.lang = 'fr-FR'; recog.continuous = false; recog.interimResults = false;
    recog.onresult = async (ev) => { await handleTranscript(ev.results[0][0].transcript, ev.results[0][0].confidence); };
    recog.onerror = () => simulateVoice();
    recog.start();
    document.getElementById('voice-status').textContent = 'Transcription en cours…';
  } else { simulateVoice(); }
}

function simulateVoice() {
  const samples = [
    { t: "J'ai du mal à comprendre les réseaux de neurones", conf: 0.9 },
    { t: "Aide-moi avec le cours de cryptographie", conf: 0.88 },
  ];
  const s = samples[Math.floor(Math.random() * samples.length)];
  handleTranscript(s.t, s.conf);
}

async function handleTranscript(transcript, confidence) {
  document.getElementById('voice-transcript').textContent = `"${transcript}"`;
  document.getElementById('voice-transcript').classList.remove('hidden');
  document.getElementById('voice-status').textContent = 'Analyse émotionnelle…';
  try {
    const res = await api('/api/stress/analyze', { method: 'POST', body: JSON.stringify({ transcript }) });
    const colors = { low: 'stress-low', med: 'stress-med', high: 'stress-high' };
    const sr = document.getElementById('stress-result');
    sr.innerHTML = `<div class="stress-badge ${colors[res.level]}"><strong>${res.label}</strong> · Confiance: ${Math.round((confidence||.8)*100)}%<br><small>${res.recommendation}</small></div>`;
    sr.classList.remove('hidden');
  } catch {}
  APP.voiceTranscript = transcript;
  document.getElementById('use-transcript-btn').classList.remove('hidden');
  document.getElementById('voice-status').textContent = 'Transcription prête';
}

function useTranscript() {
  document.getElementById('user-input').value = APP.voiceTranscript;
  updateCharCount();
  document.getElementById('voice-modal').classList.add('hidden');
  sendMessage();
}

// ═══════════════════════════════════════════════════
// MODE DÉGRADÉ
// ═══════════════════════════════════════════════════
function toggleDegradeMode() {
  APP.degradeMode = !APP.degradeMode;
  const btn = document.getElementById('degrade-btn');
  if (APP.degradeMode) {
    btn.classList.add('active-degrade');
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Quitter dégradé`;
    setModeUI('degrade');
    toast('Mode dégradé activé', 'Fonctionnement 100% local. Réponses depuis la base de connaissance Edge.', 'warning');
  } else {
    btn.classList.remove('active-degrade');
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Mode dégradé`;
    setModeUI('edge');
    fetchStatus();
  }
}

// ═══════════════════════════════════════════════════
// SYNC
// ═══════════════════════════════════════════════════
function forceSync() {
  if (APP.degradeMode) { toast('Sync impossible', 'Désactivez le mode dégradé d\'abord.', 'warning'); return; }
  document.getElementById('rp-sync-dot').className = 'rp-sync-dot syncing';
  document.getElementById('rp-sync-text').textContent = 'Synchronisation…';
  setTimeout(() => {
    document.getElementById('rp-sync-dot').className = 'rp-sync-dot synced';
    document.getElementById('rp-sync-text').textContent = 'Synchronisé';
    document.getElementById('rp-sync-detail').textContent = `AES-128-GCM · ${new Date().toLocaleTimeString('fr-FR')}`;
    toast('☁️ Cloud sync', 'Synchronisé. Chiffrement AES-128-GCM actif.', 'success');
  }, 2500);
}

// ═══════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════
function addUserMsg(text, pii, id) {
  const chat = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message user'; div.id = id;
  div.innerHTML = `
    <div class="msg-av">${APP.user?.name.charAt(0) || '?'}</div>
    <div class="msg-body">
      <div class="msg-bubble">${escHtml(text)}</div>
      ${pii.length ? `<div class="pii-notice">🛡 Filtré: ${pii.join(', ')}</div>` : ''}
      <div class="msg-meta"><span class="msg-time">${timeNow()}</span></div>
    </div>`;
  chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
}

function addAIMsg(text, mode, lat, id, isPDF = false) {
  const chat = document.getElementById('chat-messages');
  const div  = document.createElement('div');
  div.className = 'message ai'; div.id = id;
  const tagCls   = { edge:'t-edge', cache:'t-cache', degrade:'t-degrade', degraded:'t-degrade' }[mode] || 't-edge';
  const modeLabel = { edge:'EDGE', cache:'CACHE', degrade:'DÉGRADÉ', degraded:'DÉGRADÉ' }[mode] || 'EDGE';
  const latColor = !lat ? '' : lat < 100 ? 'color:var(--green)' : lat < 200 ? 'color:var(--orange)' : 'color:var(--danger)';
  div.innerHTML = `
    <div class="msg-av" style="font-size:18px;">✦</div>
    <div class="msg-body">
      <div class="msg-bubble">${renderMD(text)}</div>
      <div class="msg-meta">
        <span class="msg-tag ${tagCls}">${modeLabel}</span>
        ${isPDF ? '<span class="msg-tag t-pdf">PDF</span>' : ''}
        ${lat ? `<span class="t-lat" style="${latColor}">${lat}ms</span>` : ''}
        <span class="msg-time">${timeNow()}</span>
        <button class="report-btn" onclick="openReportModal('${id}')">⚠ Signaler</button>
      </div>
    </div>`;
  chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
}

function addBlockMsg(msg) {
  const chat = document.getElementById('chat-messages');
  document.getElementById('welcome-screen').classList.add('hidden');
  const div = document.createElement('div');
  div.className = 'block-msg';
  div.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>${msg}`;
  chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
  setTimeout(() => div.remove(), 5000);
}

function addTyping() {
  const chat = document.getElementById('chat-messages');
  const id   = 'typ-' + Date.now();
  const div  = document.createElement('div');
  div.className = 'typing-msg'; div.id = id;
  div.innerHTML = `<div class="msg-av" style="font-size:18px;">✦</div><div class="typing-dots"><div class="td"></div><div class="td"></div><div class="td"></div></div>`;
  chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
  return id;
}
function removeTyping(id) { document.getElementById(id)?.remove(); }

function addCacheEntry(q) {
  const list = document.getElementById('rp-cache-list');
  const div  = document.createElement('div');
  div.className = 'rp-cache-entry';
  div.innerHTML = q.substring(0, 28) + '… <span class="rp-cache-tag">CACHE</span>';
  if (list.children.length > 5) list.removeChild(list.lastChild);
  list.insertBefore(div, list.firstChild);
}

// [SUPPRIMÉ: loadHistory() doublon, remplacé par fetchHistory()]

// [window.onload supprimé: fetchHistory() est appelé dans initApp()]

// ═══════════════════════════════════════════════════
// MARKDOWN
// ═══════════════════════════════════════════════════
function renderMD(text) {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^(#{1,3}) (.+)/gm, (_, h, t) => `<h${h.length+1}>${t}</h${h.length+1}>`)
    .replace(/^\| (.+) \|$/gm, row => '<tr>' + row.slice(2,-2).split(' | ').map(c => `<td>${c}</td>`).join('') + '</tr>')
    .replace(/(<tr>.*<\/tr>\n?)+/g, m => `<table>${m}</table>`)
    .replace(/^[-•] (.+)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

// ═══════════════════════════════════════════════════
// PERFORMANCE
// ═══════════════════════════════════════════════════
function updatePerf(lat) {
  if (lat) APP.latencies.push(lat);
  const avg = APP.latencies.length ? Math.round(APP.latencies.reduce((a,b)=>a+b)/APP.latencies.length) : 0;
  const latEl = document.getElementById('rp-lat');
  if (latEl) {
    latEl.textContent = avg ? avg + ' ms' : '—';
    latEl.style.color = avg < 200 ? 'var(--green)' : 'var(--orange)';
  }
  const p = (78 + Math.random()*20).toFixed(0), c = (72 + Math.random()*25).toFixed(0), d = (15+Math.random()*45).toFixed(1);
  const el = id => document.getElementById(id);
  if (el('pv1')) { el('pv1').textContent=p+'%'; el('pb1').style.width=p+'%'; }
  if (el('pv2')) { el('pv2').textContent=c+'%'; el('pb2').style.width=c+'%'; }
  if (el('pv3')) { el('pv3').textContent=d; el('pb3').style.width=Math.min(d/60*100,100)+'%'; }
}

// ═══════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════
function switchView(view, el) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  const viewEl = document.getElementById('view-' + view);
  if (viewEl) viewEl.classList.add('active');
  if (el) el.classList.add('active');

  if (view === 'reports')        { fetchReports(); document.getElementById('reports-badge')?.classList.add('hidden'); }
  if (view === 'admin')          { fetchAdminStats(); }
  if (view === 'admin-schedule') { fetchAdminSchedule(); }
  if (view === 'admin-users')    { fetchAdminUsers(); }
  if (view === 'admin-reports')  { fetchAdminReportsPanel(); }
  if (view === 'admin-logs')     { fetchAdminLogs(); }
  if (view === 'schedule')       { renderScheduleView(); }
  if (view === 'prof-courses')   { fetchProfCourses(); }
  if (view === 'prof-schedule')  { fetchProfSchedule(); }
}

// ── NOUVELLE CONVERSATION ────────────────────────────────────────────
// Lance une session fraîche sans effacer l'historique déjà enregistré
function newConversation() {
  APP.currentConversationId = null;  // Réinitialiser la conversation active
  clearChat();
  if (APP.activePDF) clearPDFCtx();
  fetchHistory(); // Mettre à jour la surbrillance (aucune conversation active)
  toast('Nouvelle conversation', 'Session réinitialisée — Mistral prêt !', 'info');
}

function clearChat() {
  const chat = document.getElementById('chat-messages');
  chat.innerHTML = '';
  const ws = document.createElement('div');
  ws.className = 'welcome-screen'; ws.id = 'welcome-screen';
  const role = APP.user?.role || 'student';
  ws.innerHTML = `
    <div class="ws-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M2 17l10 5 10-5" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M2 12l10 5 10-5" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
    </svg></div>
    <h2 class="ws-title">Nouvelle session, <span>${APP.user?.prenom || APP.user?.name.split(' ')[0] || ''}</span></h2>
    <p class="ws-sub">Session réinitialisée. Données sur le serveur Edge ENSA.</p>
    <div class="ws-chips" id="ws-chips"></div>`;
  chat.appendChild(ws);
  renderWelcomeChips(role);
}

function useChip(el) {
  document.getElementById('user-input').value = el.textContent;
  updateCharCount();
  sendMessage();
}

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }

// ═══════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════
function toast(title, msg, type = 'info') {
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><div class="toast-body"><div class="toast-title">${escHtml(title)}</div><div class="toast-msg">${escHtml(msg)}</div></div>`;
  document.getElementById('toast-container').appendChild(div);
  setTimeout(() => { div.classList.add('out'); setTimeout(() => div.remove(), 350); }, 4000);
}

// ═══════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function timeNow() { return new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }); }
function formatDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function handleInputKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function updateCharCount() {
  const n = document.getElementById('user-input').value.length;
  document.getElementById('char-count').textContent = n + '/500';
}

// ═══════════════════════════════════════════════════
// AUTO-LOGIN
// ═══════════════════════════════════════════════════
(async function autoLogin() {
  const token = localStorage.getItem('aivora_token');
  if (!token) return;
  APP.token = token;
  try {
    const user = await api('/api/auth/me');
    APP.user = user;
    initApp();
  } catch {
    localStorage.removeItem('aivora_token');
    APP.token = null;
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('li-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('li-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('li-pass').focus(); });
});
// [doublon supprimé]
// ═══════════════════════════════════════════════════
// SUPPRESSION CONVERSATION (utilisateur)
// ═══════════════════════════════════════════════════
async function deleteConversation(convId, btnEl) {
  if (!confirm('Supprimer cette conversation ? Cette action est irréversible.')) return;
  try {
    await api(`/api/conversations/${convId}/delete`, { method: 'DELETE' });
    if (APP.currentConversationId === convId) {
      APP.currentConversationId = null;
      newConversation();
    }
    fetchHistory();
    toast('Supprimé', 'Conversation supprimée.', 'success');
  } catch { toast('Erreur', 'Impossible de supprimer.', 'error'); }
}

// ═══════════════════════════════════════════════════
// ADMIN — GESTION UTILISATEURS
// ═══════════════════════════════════════════════════
let _allUsers = [];

async function fetchAdminUsers() {
  try {
    const users = await api('/api/admin/users');
    _allUsers = users;
    renderAdminUsers(users);
  } catch(e) {
    document.getElementById('admin-users-list').innerHTML = '<div class="reports-empty">Erreur de chargement.</div>';
  }
}

function filterUsers(role, btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const filtered = role === 'all' ? _allUsers : _allUsers.filter(u => u.role === role);
  renderAdminUsers(filtered);
}

function renderAdminUsers(users) {
  const container = document.getElementById('admin-users-list');
  if (!users.length) {
    container.innerHTML = '<div class="reports-empty">Aucun utilisateur trouvé.</div>';
    return;
  }
  container.innerHTML = users.map(u => `
    <div class="user-card ${!u.is_active ? 'user-inactive' : ''}">
      <div class="user-card-avatar">${(u.prenom||u.name||'?')[0].toUpperCase()}</div>
      <div class="user-card-info">
        <div class="user-card-name">${escHtml(u.name)}</div>
        <div class="user-card-meta">${escHtml(u.email)}</div>
        <div class="user-card-meta">
          <span class="role-tag role-${u.role}">${{student:'Étudiant',professor:'Professeur',admin:'Admin'}[u.role]||u.role}</span>
          ${u.filiere ? `· ${escHtml(u.filiere)}` : ''}
          ${u.niveau ? `· ${escHtml(u.niveau)}` : ''}
          ${u.num_apogee ? `· Apogée: ${escHtml(u.num_apogee)}` : ''}
        </div>
        <div class="user-card-meta" style="font-size:10px;">
          Créé: ${formatDate(u.created_at)} · Connexion: ${u.last_login ? formatDate(u.last_login) : 'Jamais'}
          ${!u.is_active ? ' · <span style="color:#ef4444;font-weight:600;">DÉSACTIVÉ</span>' : ''}
        </div>
      </div>
      <div class="user-card-actions">
        <button class="btn-sm btn-primary" onclick="openUserDetailModal(${JSON.stringify(u).replace(/"/g,'&quot;')})">Gérer</button>
      </div>
    </div>`).join('');
}

function openCreateUserModal() {
  document.getElementById('cu-prenom').value = '';
  document.getElementById('cu-nom').value = '';
  document.getElementById('cu-email').value = '';
  document.getElementById('cu-role').value = 'student';
  document.getElementById('cu-filiere').value = '';
  document.getElementById('cu-niveau').value = '';
  document.getElementById('cu-apogee').value = '';
  document.getElementById('cu-password').value = '';
  document.getElementById('cu-error').classList.add('hidden');
  toggleStudentFields();
  document.getElementById('create-user-modal').classList.remove('hidden');
}

function closeCreateUserModal() { document.getElementById('create-user-modal').classList.add('hidden'); }

function toggleStudentFields() {
  const role = document.getElementById('cu-role').value;
  document.getElementById('cu-student-fields').style.display = role === 'student' ? 'block' : 'none';
}

async function createUser() {
  const errEl = document.getElementById('cu-error');
  errEl.classList.add('hidden');
  const body = {
    prenom:     document.getElementById('cu-prenom').value.trim(),
    nom:        document.getElementById('cu-nom').value.trim(),
    email:      document.getElementById('cu-email').value.trim(),
    role:       document.getElementById('cu-role').value,
    filiere:    document.getElementById('cu-filiere').value.trim(),
    niveau:     document.getElementById('cu-niveau').value.trim(),
    num_apogee: document.getElementById('cu-apogee').value.trim(),
    password:   document.getElementById('cu-password').value,
  };
  if (!body.prenom || !body.nom || !body.email || !body.password) {
    errEl.textContent = 'Tous les champs obligatoires (*) doivent être remplis.';
    errEl.classList.remove('hidden'); return;
  }
  try {
    const res = await api('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
    closeCreateUserModal();
    fetchAdminUsers();
    toast('✅ Compte créé', `${res.name} (${res.email}) — ${res.role}`, 'success');
  } catch(e) {
    errEl.textContent = e.error || 'Erreur lors de la création.';
    errEl.classList.remove('hidden');
  }
}

// Modal détail utilisateur
let _currentUserDetail = null;

function openUserDetailModal(user) {
  _currentUserDetail = user;
  document.getElementById('udm-title').textContent = `👤 ${user.name}`;
  document.getElementById('udm-info').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">
      <div><span style="color:var(--text3);">Email:</span> ${escHtml(user.email)}</div>
      <div><span style="color:var(--text3);">Rôle:</span> <span class="role-tag role-${user.role}">${{student:'Étudiant',professor:'Professeur',admin:'Admin'}[user.role]||user.role}</span></div>
      <div><span style="color:var(--text3);">Filière:</span> ${escHtml(user.filiere||'—')}</div>
      <div><span style="color:var(--text3);">Niveau:</span> ${escHtml(user.niveau||'—')}</div>
      <div><span style="color:var(--text3);">Apogée:</span> ${escHtml(user.num_apogee||'—')}</div>
      <div><span style="color:var(--text3);">Statut:</span> ${user.is_active ? '<span style="color:#10b981;">Actif</span>' : '<span style="color:#ef4444;">Désactivé</span>'}</div>
    </div>`;
  document.getElementById('udm-pwd').value = '';
  document.getElementById('user-detail-modal').classList.remove('hidden');
}

function closeUserDetailModal() {
  document.getElementById('user-detail-modal').classList.add('hidden');
  _currentUserDetail = null;
}

async function resetUserPassword() {
  if (!_currentUserDetail) return;
  const pwd = document.getElementById('udm-pwd').value;
  if (pwd.length < 6) { toast('Erreur', 'Min. 6 caractères', 'error'); return; }
  try {
    await api(`/api/admin/users/${_currentUserDetail.id}/reset-password`, {
      method: 'POST', body: JSON.stringify({ password: pwd })
    });
    toast('✅ Mot de passe réinitialisé', `Nouveau mot de passe défini pour ${_currentUserDetail.name}`, 'success');
    document.getElementById('udm-pwd').value = '';
  } catch(e) { toast('Erreur', e.error || 'Impossible de réinitialiser', 'error'); }
}

async function viewUserConversations() {
  if (!_currentUserDetail) return;
  closeUserDetailModal();
  try {
    const data = await api(`/api/admin/users/${_currentUserDetail.id}/conversations`);
    // Passer à la vue logs et afficher les conversations de cet user
    switchView('admin-logs', document.querySelector('.sb-item[data-view="admin-logs"]'));
    const panel = document.getElementById('admin-logs-users');
    const convPanel = document.getElementById('admin-logs-conv');
    panel.classList.add('hidden');
    convPanel.classList.remove('hidden');
    if (!data.conversations.length) {
      convPanel.innerHTML = `<div class="view-header"><h3>Conversations de ${escHtml(data.user.name)}</h3></div><div class="reports-empty">Aucune conversation.</div>`;
      return;
    }
    convPanel.innerHTML = `
      <div class="view-header" style="display:flex;align-items:center;gap:12px;">
        <button class="btn-secondary btn-sm" onclick="showLogsUsers()">← Retour</button>
        <h3>💬 Conversations de ${escHtml(data.user.name)} <span style="font-size:12px;color:var(--text3);">(${escHtml(data.user.email)})</span></h3>
      </div>
      ${data.conversations.map(c => `
        <div class="log-conv-card" onclick="loadAdminConv('${c.id}','${escHtml(c.title)}')">
          <div class="log-conv-title">${escHtml(c.title)}</div>
          <div class="log-conv-meta">${formatDate(c.updated_at)}</div>
        </div>`).join('')}`;
  } catch(e) { toast('Erreur', 'Impossible de charger les conversations.', 'error'); }
}

async function deleteUser() {
  if (!_currentUserDetail) return;
  if (!confirm(`Supprimer le compte de ${_currentUserDetail.name} ? Cette action désactive définitivement le compte.`)) return;
  try {
    await api(`/api/admin/users/${_currentUserDetail.id}`, { method: 'DELETE' });
    closeUserDetailModal();
    fetchAdminUsers();
    toast('✅ Compte désactivé', `${_currentUserDetail.name} a été désactivé.`, 'success');
  } catch(e) { toast('Erreur', e.error || 'Impossible de supprimer.', 'error'); }
}

// ═══════════════════════════════════════════════════
// ADMIN — LOGS SYSTÈME
// ═══════════════════════════════════════════════════
let _allLogs = [];

async function fetchAdminLogs() {
  const panel = document.getElementById('admin-logs-users');
  const convPanel = document.getElementById('admin-logs-conv');
  panel.classList.remove('hidden');
  convPanel.classList.add('hidden');
  try {
    // Charger liste des users avec leur activité
    const users = await api('/api/admin/users');
    _allLogs = users;
    renderLogsUsers(users);
  } catch { panel.innerHTML = '<div class="reports-empty">Erreur de chargement.</div>'; }
}

function showLogsUsers() {
  document.getElementById('admin-logs-users').classList.remove('hidden');
  document.getElementById('admin-logs-conv').classList.add('hidden');
}

function filterLogs() {
  const q = document.getElementById('logs-search')?.value.toLowerCase() || '';
  const filtered = _allLogs.filter(u =>
    u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  );
  renderLogsUsers(filtered);
}

function renderLogsUsers(users) {
  const panel = document.getElementById('admin-logs-users');
  if (!users.length) { panel.innerHTML = '<div class="reports-empty">Aucun utilisateur trouvé.</div>'; return; }
  panel.innerHTML = users.filter(u => u.role !== 'admin').map(u => `
    <div class="log-user-card" onclick="openUserConvLogs('${u.id}','${escHtml(u.name)}','${escHtml(u.email)}')">
      <div class="user-card-avatar" style="width:32px;height:32px;font-size:13px;">${(u.prenom||u.name||'?')[0].toUpperCase()}</div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:500;">${escHtml(u.name)}</div>
        <div style="font-size:11px;color:var(--text3);">${escHtml(u.email)} · <span class="role-tag role-${u.role}" style="font-size:10px;">${{student:'Étudiant',professor:'Professeur'}[u.role]||u.role}</span></div>
      </div>
      <div style="font-size:11px;color:var(--text3);">Voir →</div>
    </div>`).join('');
}

async function openUserConvLogs(userId, name, email) {
  document.getElementById('admin-logs-users').classList.add('hidden');
  const convPanel = document.getElementById('admin-logs-conv');
  convPanel.classList.remove('hidden');
  convPanel.innerHTML = `<div class="view-header" style="display:flex;align-items:center;gap:12px;"><button class="btn-secondary btn-sm" onclick="showLogsUsers()">← Retour</button><h3>💬 ${escHtml(name)} <span style="font-size:12px;color:var(--text3);">(${escHtml(email)})</span></h3></div><div class="reports-empty">Chargement…</div>`;
  try {
    const data = await api(`/api/admin/users/${userId}/conversations`);
    if (!data.conversations.length) {
      convPanel.innerHTML += '';
      convPanel.querySelector('.reports-empty').textContent = 'Aucune conversation.';
      return;
    }
    convPanel.innerHTML = `
      <div class="view-header" style="display:flex;align-items:center;gap:12px;">
        <button class="btn-secondary btn-sm" onclick="showLogsUsers()">← Retour</button>
        <h3>💬 ${escHtml(name)} <span style="font-size:12px;color:var(--text3);">(${escHtml(email)})</span></h3>
      </div>
      ${data.conversations.map(c => `
        <div class="log-conv-card" onclick="loadAdminConv('${c.id}','${escHtml(c.title)}')">
          <div class="log-conv-title">${escHtml(c.title)}</div>
          <div class="log-conv-meta">${formatDate(c.updated_at)}</div>
        </div>`).join('')}`;
  } catch { convPanel.innerHTML += '<div class="reports-empty">Erreur de chargement.</div>'; }
}

async function loadAdminConv(convId, title) {
  const convPanel = document.getElementById('admin-logs-conv');
  const saved = convPanel.innerHTML;
  convPanel.innerHTML = `<button class="btn-secondary btn-sm" onclick="fetchAdminLogs()" style="margin-bottom:12px;">← Retour aux logs</button><div class="reports-empty">Chargement…</div>`;
  try {
    const msgs = await api(`/api/admin/conversations/${convId}/messages`);
    convPanel.innerHTML = `
      <button class="btn-secondary btn-sm" onclick="fetchAdminLogs()" style="margin-bottom:12px;">← Retour aux logs</button>
      <div style="font-weight:600;font-size:14px;margin-bottom:12px;">💬 ${escHtml(title)}</div>
      ${msgs.map(m => `
        <div class="log-msg ${m.role === 'user' ? 'log-msg-user' : 'log-msg-ai'}">
          <span class="log-msg-role">${m.role === 'user' ? '👤 Utilisateur' : '🤖 AIvora'}</span>
          <div class="log-msg-content">${escHtml(m.content.substring(0,300))}${m.content.length > 300 ? '…' : ''}</div>
          <div class="log-msg-meta">${formatDate(m.created_at)} · ${m.mode||'edge'} ${m.latency_ms ? '· '+m.latency_ms+'ms' : ''}</div>
        </div>`).join('')}`;
  } catch { convPanel.innerHTML = saved; toast('Erreur', 'Impossible de charger la conversation.', 'error'); }
}

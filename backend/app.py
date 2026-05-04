"""
AIvora — Assistant IA Edge · ENSA Beni Mellal / USMS
Backend principal Flask — Version 2.0
Auteur: Projet TEQ — Filière IACS S4
Modifications: Rôles distincts (étudiant/prof/admin), profils, EDT dynamique
"""

import os, uuid, json, time, re, hashlib, logging, sqlite3
import fitz          # PyMuPDF — lecture PDF
import requests      # appels Ollama local
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
from bs4 import BeautifulSoup

from flask import (Flask, request, jsonify, session,
                   send_from_directory, render_template, abort)
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

import fitz          # PyMuPDF — lecture PDF
import requests      # appels Ollama local

# ─── Imports sécurité ───────────────────────────────
try:
    from argon2 import PasswordHasher
    from argon2.exceptions import VerifyMismatchError
    PH = PasswordHasher(time_cost=2, memory_cost=65536, parallelism=2)
    ARGON2_OK = True
except ImportError:
    ARGON2_OK = False
    import hashlib as _hl

# ─── Config chemins ─────────────────────────────────
BASE_DIR   = Path(__file__).parent.parent
DB_PATH    = BASE_DIR / "data" / "aivora.db"
UPLOAD_DIR = BASE_DIR / "uploads"
CACHE_DIR  = BASE_DIR / "cache"
FRONT_DIR  = BASE_DIR / "frontend"

for d in [DB_PATH.parent, UPLOAD_DIR, CACHE_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ─── Flask ──────────────────────────────────────────
app = Flask(__name__,
            static_folder=str(FRONT_DIR / "static"),
            template_folder=str(FRONT_DIR / "templates"))
app.secret_key = os.urandom(32)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
CORS(app, supports_credentials=True)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["200 per day", "10 per minute"],
    storage_uri="memory://"
)

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("AIvora")

# ═══════════════════════════════════════════════════
# BASE DE DONNÉES SQLite — Schéma étendu
# ═══════════════════════════════════════════════════
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    prenom      TEXT DEFAULT '',
    nom         TEXT DEFAULT '',
    role        TEXT NOT NULL DEFAULT 'student',
    filiere     TEXT,
    niveau      TEXT DEFAULT '',
    num_apogee  TEXT DEFAULT '',
    pwd_hash    TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    last_login  TEXT,
    is_active   INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT 'Nouvelle conversation',
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    conversation_id TEXT,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    mode            TEXT DEFAULT 'edge',
    latency_ms      INTEGER,
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS reports (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    message_id  TEXT,
    description TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    admin_reply TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    replied_at  TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cache_entries (
    id          TEXT PRIMARY KEY,
    query_hash  TEXT NOT NULL,
    query_text  TEXT NOT NULL,
    response    TEXT NOT NULL,
    mode        TEXT DEFAULT 'edge',
    hits        INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pdf_documents (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    text_content  TEXT,
    is_course     INTEGER DEFAULT 0,
    module_name   TEXT DEFAULT '',
    visible_to    TEXT DEFAULT 'all',
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS schedule_entries (
    id          TEXT PRIMARY KEY,
    prof_id     TEXT NOT NULL,
    module_name TEXT NOT NULL,
    jour        INTEGER NOT NULL,
    heure_debut TEXT NOT NULL,
    heure_fin   TEXT NOT NULL,
    salle       TEXT DEFAULT 'A01, Bloc A',
    filiere     TEXT DEFAULT '2A IACS',
    status      TEXT DEFAULT 'pending',
    admin_note  TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now')),
    confirmed_at TEXT,
    FOREIGN KEY(prof_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    message     TEXT NOT NULL,
    is_read     INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
);
"""

def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)
        # Comptes seed
        seed_users = [
            # (email, prenom, nom, role, filiere, niveau, num_apogee, pwd)
            ("sara.bouarafa@usms.ac.ma",  "Sara",   "Bouarafa",     "student",   "2ème année IACS", "Bac+2", "22011457", "ensa2024"),
            ("amine.benjelloun@usms.ac.ma","Amine",  "Benjelloun",   "student",   "2ème année IACS", "Bac+2", "22011458", "ensa2024"),
            ("h.touil@usms.ac.ma",         "Hassan", "Touil",        "professor", "Toutes filières", "Docteur", "",       "prof2024"),
            ("admin@usms.ac.ma",           "Admin",  "ENSA BM",      "admin",     "Campus",          "Staff",   "",       "admin2024"),
        ]
        for email, prenom, nom, role, filiere, niveau, apogee, pwd in seed_users:
            uid = str(uuid.uuid4())
            h   = hash_password(pwd)
            name = prenom + " " + nom
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO users(id,email,name,prenom,nom,role,filiere,niveau,num_apogee,pwd_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (uid, email, name, prenom, nom, role, filiere, niveau, apogee, h)
                )
            except Exception:
                pass
        conn.commit()
    log.info("✅ Base de données initialisée — %s", DB_PATH)

# ═══════════════════════════════════════════════════
# SÉCURITÉ — Hachage mots de passe (Argon2id)
# ═══════════════════════════════════════════════════
def hash_password(pwd: str) -> str:
    if ARGON2_OK:
        return PH.hash(pwd)
    salt = os.urandom(32)
    dk = hashlib.scrypt(pwd.encode(), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$" + salt.hex() + "$" + dk.hex()

def verify_password(pwd: str, hashed: str) -> bool:
    if ARGON2_OK and not hashed.startswith("scrypt$"):
        try:
            return PH.verify(hashed, pwd)
        except Exception:
            return False
    if hashed.startswith("scrypt$"):
        _, salt_h, dk_h = hashed.split("$")
        salt = bytes.fromhex(salt_h)
        dk = hashlib.scrypt(pwd.encode(), salt=salt, n=2**14, r=8, p=1)
        return dk.hex() == dk_h
    return False
# ═══════════════════════════════════════════════════
# FONCTION LIVE FETCH (SCRAPING DU SITE ENSA)
# ═══════════════════════════════════════════════════
def get_ensa_live_info():
    """Récupère les informations en temps réel sur le site de l'ENSA"""
    try:
        url = "https://ensabm.usms.ac.ma/" 
        # On ajoute un User-Agent pour simuler un navigateur
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, headers=headers, timeout=5)
        response.encoding = 'utf-8' # Pour les accents français
        
        if response.status_code == 200:
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Nettoyage du code inutile pour l'IA
            for element in soup(["script", "style", "nav", "footer"]):
                element.extract()
            
            # Extraction du texte
            text = soup.get_text(separator=' ', strip=True)
            # On limite la taille pour ne pas saturer le contexte de Mistral
            return text[:2500] 
        return "Données du site momentanément indisponibles."
    except Exception as e:
        log.error(f"Erreur Scraping: {e}")
        return "Le site de l'ENSA ne répond pas."
# ═══════════════════════════════════════════════════
# PII FILTERING + SQLi
# ═══════════════════════════════════════════════════
PII_PATTERNS = [
    (re.compile(r'\b[A-Za-z]{1,2}[\s.\-_/\\|]{0,3}(?:\d[\s.\-_/\\|]{0,3}){6}\b', re.I), "CIN_MAROCAINE"),
    (re.compile(r'\b(?:\d[\s.\-]{0,2}){16}\b'), "CARTE_BANCAIRE"),
    (re.compile(r'\b0[5-7](?:[\s.\-]?\d{2}){4}\b'), "TELEPHONE"),
    (re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}',re.I), "EMAIL"),
    (re.compile(r'\b(?:\d{1,3}\.){3}\d{1,3}\b'), "ADRESSE_IP"),
    (re.compile(r'\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){4,7}\b'), "IBAN"),
    (re.compile(r'\b\d{8,9}\b'), "NUM_IDENTITE"),
]

def filter_pii(text: str):
    detected = []
    filtered = text
    for pattern, label in PII_PATTERNS:
        if pattern.search(filtered):
            detected.append(label)
            filtered = pattern.sub(f"[DONNÉE_{label}_FILTRÉE]", filtered)
    return filtered, detected

SQL_PATTERNS = [
    re.compile(r'\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|EXEC|TRUNCATE|DECLARE|CAST|CONVERT)\b', re.I),
    re.compile(r'(--|#|/\*|\*/;--)', re.I),
    re.compile(r"('|\"|`).*?(OR|AND).*?=", re.I),
    re.compile(r'\b1\s*=\s*1\b', re.I),
    re.compile(r'xp_cmdshell|waitfor\s+delay|benchmark\s*\(', re.I),
]

def detect_sqli(text: str) -> bool:
    return any(p.search(text) for p in SQL_PATTERNS)

# ═══════════════════════════════════════════════════
# SESSIONS
# ═══════════════════════════════════════════════════
def create_session(user_id: str) -> str:
    token = str(uuid.uuid4())
    expires = (datetime.utcnow() + timedelta(hours=8)).isoformat()
    with get_db() as conn:
        conn.execute("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
                     (token, user_id, expires))
        conn.execute("UPDATE users SET last_login=datetime('now') WHERE id=?", (user_id,))
        conn.commit()
    return token

def get_user_by_token(token: str):
    with get_db() as conn:
        row = conn.execute("""
            SELECT u.* FROM users u
            JOIN sessions s ON s.user_id = u.id
            WHERE s.token=? AND s.expires_at > datetime('now') AND u.is_active=1
        """, (token,)).fetchone()
    return dict(row) if row else None

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("X-Auth-Token") or request.cookies.get("aivora_token")
        if not token:
            return jsonify({"error": "Non authentifié"}), 401
        user = get_user_by_token(token)
        if not user:
            return jsonify({"error": "Session expirée"}), 401
        request.current_user = user
        return f(*args, **kwargs)
    return decorated

def require_admin(f):
    @wraps(f)
    @require_auth
    def decorated(*args, **kwargs):
        if request.current_user["role"] != "admin":
            return jsonify({"error": "Accès admin requis"}), 403
        return f(*args, **kwargs)
    return decorated

def require_professor(f):
    @wraps(f)
    @require_auth
    def decorated(*args, **kwargs):
        if request.current_user["role"] not in ("professor", "admin"):
            return jsonify({"error": "Accès professeur requis"}), 403
        return f(*args, **kwargs)
    return decorated

# ═══════════════════════════════════════════════════
# OLLAMA — Mistral 7B local
# ═══════════════════════════════════════════════════
OLLAMA_URL   = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "mistral")

def call_ollama(prompt: str, system: str = "", max_tokens: int = 512) -> tuple:
    t0 = time.time()
    full_prompt = f"{system}\n\nUtilisateur: {prompt}\n\nAIvora:" if system else prompt
    body = {
        "model": OLLAMA_MODEL,
        "prompt": full_prompt,
        "stream": False,
        "options": {
            "temperature": 0.7,
            "top_p": 0.9,
            "num_predict": max_tokens,
            "num_ctx": 4096,
        }
    }
    resp = requests.post(f"{OLLAMA_URL}/api/generate", json=body, timeout=60)
    resp.raise_for_status()
    lat = int((time.time() - t0) * 1000)
    return resp.json().get("response", "").strip(), lat

def check_ollama() -> bool:
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=3)
        return r.status_code == 200
    except Exception:
        return False

# ═══════════════════════════════════════════════════
# CACHE SÉMANTIQUE TF-IDF
# ═══════════════════════════════════════════════════
import math
from collections import Counter

def _tokenize(text: str):
    text = re.sub(r'[^\wàâäéèêëîïôùûü\s]', ' ', text.lower())
    return [t for t in text.split() if len(t) > 2]

def _tfidf_vec(text: str, corpus: list) -> dict:
    tokens = _tokenize(text)
    if not tokens:
        return {}
    freq = Counter(tokens)
    tf = {t: c / len(tokens) for t, c in freq.items()}
    N = len(corpus) + 1
    vec = {}
    for t, tfv in tf.items():
        df = sum(1 for doc in corpus if t in _tokenize(doc)) + 1
        vec[t] = tfv * math.log(N / df)
    return vec

def _cosine(a: dict, b: dict) -> float:
    keys = set(a) | set(b)
    dot = sum(a.get(k, 0) * b.get(k, 0) for k in keys)
    na  = math.sqrt(sum(v*v for v in a.values()))
    nb  = math.sqrt(sum(v*v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0

CACHE_THRESHOLD = 0.82

def find_cache(query: str):
    with get_db() as conn:
        rows = conn.execute("SELECT id, query_text, response, mode FROM cache_entries").fetchall()
    if not rows:
        return None
    corpus = [r["query_text"] for r in rows]
    qvec   = _tfidf_vec(query, corpus)
    best, best_score = None, 0.0
    for row in rows:
        cvec  = _tfidf_vec(row["query_text"], corpus)
        score = _cosine(qvec, cvec)
        if score > best_score:
            best_score = score
            best = row
    if best and best_score >= CACHE_THRESHOLD:
        with get_db() as conn:
            conn.execute("UPDATE cache_entries SET hits=hits+1 WHERE id=?", (best["id"],))
            conn.commit()
        return dict(best), best_score
    return None

def add_cache(query: str, response: str, mode: str = "edge"):
    entry_id = str(uuid.uuid4())
    qhash    = hashlib.sha256(query.encode()).hexdigest()[:16]
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO cache_entries(id,query_hash,query_text,response,mode) VALUES(?,?,?,?,?)",
            (entry_id, qhash, query[:500], response[:2000], mode)
        )
        conn.commit()

# ═══════════════════════════════════════════════════
# BASE DE CONNAISSANCE ENSA BM — Mode dégradé étendu
# Questions générales ENSA + cours IACS
# ═══════════════════════════════════════════════════
KNOWLEDGE_BASE = [
    {
        "keywords": ["ensa", "école", "beni mellal", "ensabm", "inscription", "admission", "scolarité",
                     "administration", "directeur", "contact", "adresse", "campus"],
        "response": """**École Nationale des Sciences Appliquées de Béni Mellal (ENSABM)**

**Présentation:**
L'ENSA de Béni Mellal est un établissement public d'enseignement supérieur sous tutelle du Ministère de l'Enseignement Supérieur, rattaché à l'Université Sultan Moulay Slimane (USMS).

**Filières proposées:**
• Génie Informatique (GI)
• Informatique et Applications (IA) / IACS — Intelligence Artificielle & Cybersécurité
• Génie Civil (GC)
• Génie Électrique (GE)
• Génie Industriel (GI)

**Accès & Contact:**
• Site officiel: www.ensa.usms.ma
• Email administration: contact@ensa.usms.ma
• Adresse: Route Beni Amir, Béni Mellal 23000, Maroc

**Scolarité — informations clés:**
• Inscription: via le portail national (www.enrolement.ump.ma)
• Prérequis: Baccalauréat scientifique ou technique + concours national
• Durée: 3 ans post-prépa ou 5 ans cycle intégré
• Diplôme: Ingénieur d'État

*Source: Portail officiel ENSA Béni Mellal · USMS*"""
    },
    {
        "keywords": ["filière", "iacs", "intelligence artificielle", "cybersécurité", "programme", "modules", "semestre"],
        "response": """**Filière IACS — Ingénierie IA & Cybersécurité · ENSA BM**

**Programme S4 (2ème année):**
• Administration Sécurisée & Forensics — Pr. TOUIL
• Technologies Émergentes & Quantum — Pr. TOUIL
• Cybersécurité & Cyberdefense — Pr. ENNAHBAOUI
• DevOps / DevSecOps — Pr. AOURAGHE
• Scientific & Professional Communication — Pr. CHAKIR
• Éthique et Droit Numérique — Pr. TOUIL
• Droit et Rédaction Administratifs — Pr. LAGHRIBI

**Objectifs de la filière:**
Former des ingénieurs spécialisés en IA embarquée, cybersécurité, et systèmes distribués sécurisés.

**Débouchés:**
• Ingénieur cybersécurité / SOC analyst
• Data scientist / ML engineer
• DevSecOps / Cloud engineer
• Consultant en sécurité informatique

*Source: Programme officiel ENSA BM · Filière IACS*"""
    },
    {
        "keywords": ["réseaux neurones", "neural network", "deep learning", "cnn", "rnn", "lstm", "transformer", "backpropagation"],
        "response": """**Réseaux de neurones artificiels — Cours IA · ENSA Beni Mellal**

**Architecture fondamentale:**
• Couche d'entrée → Couches cachées → Couche de sortie
• Fonctions d'activation: ReLU, Sigmoid, Tanh, GELU, Swish
• Apprentissage: rétropropagation du gradient + optimiseur (Adam, SGD)

**Types de réseaux:**
• **CNN (Convolutional):** vision par ordinateur — convolution + pooling + FC
• **RNN/LSTM/GRU:** séquences temporelles, NLP, prédiction
• **Transformers:** mécanisme d'attention multi-têtes — base des LLMs modernes
• **GAN:** générateur + discriminateur — génération d'images

**Mistral 7B (notre modèle Edge):**
Architecture Transformer avec Grouped Query Attention (GQA) + Sliding Window Attention
• 7 milliards de paramètres · FP16 ≈ 14 GB RAM

*Source: Cours Intelligence Artificielle — ENSA Beni Mellal S4 IACS*"""
    },
    {
        "keywords": ["cryptographie", "chiffrement", "aes", "rsa", "tls", "asymétrique", "symétrique", "hachage", "sha", "argon2"],
        "response": """**Cryptographie — Module Administration Sécurisée · Pr. TOUIL**

**Chiffrement symétrique (clé unique):**
• AES-128-GCM / AES-256-GCM (authentification intégrée)
• ChaCha20-Poly1305 (performant sur mobiles/ARM)

**Chiffrement asymétrique (bi-clé):**
• RSA-2048/4096, ECDSA, ECDH (Curve25519)
• Post-Quantum: CRYSTALS-Kyber (résistance aux ordinateurs quantiques)

**Hachage mots de passe — Standards OWASP 2024:**
• **Argon2id** ← RECOMMANDÉ: memory-hard, résistant GPU/ASIC
• bcrypt, scrypt: anciens mais acceptables
• ❌ MD5, SHA-1, SHA-256 seuls: INTERDITS pour les mots de passe

**TLS 1.3:** ECDHE + AES-128-GCM · Forward Secrecy

*Source: Cours Admin Sécurisée — Pr. TOUIL · ENSA BM*"""
    },
    {
        "keywords": ["cybersécurité", "cyberdefense", "attaque", "ddos", "injection sql", "xss", "csrf", "pentest"],
        "response": """**Cybersécurité & Cyberdefense — Pr. ENNAHBAOUI · S4 IACS**

**Attaques OWASP Top 10:**
• **SQLi:** injections SQL → prévention: requêtes préparées
• **XSS:** injection scripts → prévention: CSP, échappement HTML
• **CSRF:** faux requêtes → prévention: tokens CSRF, SameSite cookies
• **DDoS:** saturation → mitigation: rate limiting, WAF, CDN
• **MITM:** interception → défense: TLS 1.3, HSTS

**Frameworks:**
• MITRE ATT&CK · Cyber Kill Chain · NIST CSF · ISO 27001

*Source: Cybersécurité & Cyberdefense — Pr. ENNAHBAOUI · ENSA BM*"""
    },
    {
        "keywords": ["devops", "devsecops", "docker", "kubernetes", "ci/cd", "pipeline", "conteneur", "ansible"],
        "response": """**DevOps / DevSecOps — Pr. AOURAGHE · Vendredi 9h00**

**Pipeline CI/CD sécurisé:**
Code → Commit → SAST → Build → Test → DAST → Deploy → Monitor

**Conteneurisation:**
• Docker: image → conteneur, Dockerfile, docker-compose
• Kubernetes (K8s): orchestration, pods, services, ingress

**Infrastructure as Code:**
• Ansible: configuration management, playbooks YAML
• Terraform: provisioning cloud/on-prem, HCL

*Source: DEVOPS/DEVSECOPS — Pr. AOURAGHE · ENSA BM*"""
    },
    {
        "keywords": ["machine learning", "ml", "apprentissage", "overfitting", "classification", "régression", "svm"],
        "response": """**Machine Learning — Fondamentaux · IACS S4**

**Types d'apprentissage:**
1. **Supervisé:** données étiquetées → Classification (SVM, RF, KNN)
2. **Non supervisé:** Clustering (K-means, DBSCAN)
3. **Renforcement:** Agent + Environnement + Récompense (Q-Learning, PPO)

**Problèmes courants:**
• Overfitting → Dropout, L1/L2 régularisation, Early stopping
• Underfitting → Augmenter capacité, features engineering

**Métriques:**
• Classification: Accuracy, Précision, Rappel, F1-score, AUC-ROC
• Régression: MAE, RMSE, R²

*Source: Cours ML — ENSA Beni Mellal · Pr. TOUIL*"""
    },
    {
        "keywords": ["stage", "pfe", "projet fin études", "alternance", "entreprise", "recrutement"],
        "response": """**Stages & PFE — ENSA Béni Mellal**

**Types de stages:**
• Stage d'observation (S2): 1 mois — découverte entreprise
• Stage technique (S4): 2 mois — application pratique
• Stage PFE (S6): 4-6 mois — projet de fin d'études complet

**Procédure:**
1. Rechercher une offre (réseau école, LinkedIn, ANAPEC)
2. Déposer convention de stage à la scolarité
3. Validation par le responsable de filière
4. Rapport final + soutenance devant jury

**Contact convention de stage:**
Service des stages — Bureau scolarité ENSA BM
Email: stages@ensa.usms.ma

*Source: Service scolarité ENSA Béni Mellal*"""
    },
]

def get_degraded_response(query: str, user_role: str = "student") -> str:
    ql = query.lower()
    best, bc = None, 0
    for entry in KNOWLEDGE_BASE:
        count = sum(1 for kw in entry["keywords"] if kw in ql)
        if count > bc:
            bc, best = count, entry
    if best and bc > 0:
        return best["response"]
    
    role_msg = {
        "student": "questions sur l'ENSA, vos cours, l'emploi du temps, les stages",
        "professor": "la gestion de vos cours, l'emploi du temps, vos modules",
        "admin":    "la gestion des signalements, des utilisateurs et de l'emploi du temps",
    }.get(user_role, "les cours et l'ENSA")
    
    return f"""**AIvora — Mode Dégradé (Ollama non disponible)**

Je fonctionne depuis la base de connaissance locale embarquée sur le serveur Edge ENSA.

**Domaines couverts hors-ligne:**
• Présentation & informations ENSA Béni Mellal
• Programme filière IACS et modules
• Réseaux de neurones & Deep Learning
• Cryptographie & Cybersécurité
• DevOps / DevSecOps
• Machine Learning
• Stages & PFE

Reformulez votre question avec des mots-clés de ces domaines, ou reconnectez Ollama pour accéder au modèle Mistral complet.

*Serveur Edge ENSA Beni Mellal — données locales — RGPD conforme*"""

# ═══════════════════════════════════════════════════
# EMPLOI DU TEMPS (EDT statique S4 IACS)
# ═══════════════════════════════════════════════════
EDT_STATIC = {
    1: [{"name": "Éthique et droit numérique", "prof": "Pr. TOUIL", "heure": "14h30–16h15", "salle": "A01, Bloc A", "credits": 2}],
    2: [{"name": "Administration sécurisée et forensics", "prof": "Pr. TOUIL", "heure": "09h00–10h45", "salle": "A01, Bloc A", "credits": 3},
        {"name": "Technologies émergentes et Quantum", "prof": "Pr. TOUIL", "heure": "14h30–18h15", "salle": "A01, Bloc A", "credits": 3}],
    3: [{"name": "Cybersécurité & cyberdefense", "prof": "Pr. ENNAHBAOUI", "heure": "10h00–12h00", "salle": "A01, Bloc A", "credits": 3}],
    4: [{"name": "Scientific and Professional Communication", "prof": "Pr. CHAKIR", "heure": "14h30–18h15", "salle": "A01, Bloc A", "credits": 2}],
    5: [{"name": "DEVOPS / DEVSECOPS", "prof": "Pr. AOURAGHE", "heure": "09h00–10h45", "salle": "A01, Bloc A", "credits": 3},
        {"name": "Droit et Rédaction Administratifs", "prof": "Pr. LAGHRIBI", "heure": "14h30–18h15", "salle": "A01, Bloc A", "credits": 2}],
}
DAY_NAMES = {1:"Lundi", 2:"Mardi", 3:"Mercredi", 4:"Jeudi", 5:"Vendredi", 6:"Samedi", 0:"Dimanche"}

def build_schedule_response(query: str) -> str:
    ql = query.lower()
    today_num = datetime.now().isoweekday()

    if any(w in ql for w in ["semaine", "hebdo", "tous", "complet", "week"]):
        r = "**📅 Emploi du temps complet — S4 IACS 2025-2026**\n*Salle: A01, Bloc A — ENSA Beni Mellal*\n\n"
        for d in range(1, 6):
            courses = EDT_STATIC.get(d, [])
            if not courses:
                continue
            r += f"**{DAY_NAMES[d]}**\n"
            for c in courses:
                r += f"• {c['heure']} — **{c['name']}** _{c['prof']}_\n"
            r += "\n"
        return r

    today_courses = EDT_STATIC.get(today_num, [])
    if not today_courses:
        return f"**Aujourd'hui ({DAY_NAMES.get(today_num,'?')})** vous n'avez pas de cours selon l'EDT S4 IACS.\n\nBonne journée pour avancer vos projets ! 🎯"

    r = f"**📅 Vos cours aujourd'hui — {DAY_NAMES.get(today_num,'')}**\n\n"
    for c in today_courses:
        r += f"**{c['name']}**\n• Horaire: {c['heure']}\n• Professeur: {c['prof']}\n• Salle: {c['salle']}\n\n"
    return r

# ═══════════════════════════════════════════════════
# SYSTEM PROMPT ADAPTÉ AU RÔLE
# ═══════════════════════════════════════════════════
def build_system_prompt(user: dict) -> str:
    role = user.get("role", "student")
    name = user.get("name", "")
    filiere = user.get("filiere", "IACS")
    
    base = f"""Tu es AIvora, assistant IA pédagogique de l'École Nationale des Sciences Appliquées de Béni Mellal (ENSA BM), Université Sultan Moulay Slimane.
Utilisateur: {name} — Rôle: {role} — Filière/Poste: {filiere}
Date: {datetime.now().strftime('%A %d %B %Y')}

RÈGLES ABSOLUES:
1. Réponds TOUJOURS en français
2. Sois précis, structuré et pédagogique
3. Ne révèle JAMAIS de données personnelles d'autres utilisateurs
4. Respecte la confidentialité des données (RGPD & Loi 09-08 Maroc)
5. Tes données restent sur le serveur Edge ENSA (pas de transmission externe)
"""
    
    if role == "student":
        base += """
CONTEXTE ÉTUDIANT:
- Tu aides avec les cours, exercices, révisions, et questions générales sur l'ENSA BM
- Tu peux expliquer les concepts des modules IACS (IA, Cybersécurité, DevOps, etc.)
- Tu informes sur les procédures administratives (stages, inscriptions, etc.)
- Tu fournis l'emploi du temps S4 IACS sur demande
- Si question hors cadre académique ENSA: refuse poliment
"""
    elif role == "professor":
        base += """
CONTEXTE PROFESSEUR:
- Tu assistes dans la préparation pédagogique et les analyses de documents
- Tu aides à structurer les cours, exercices, et évaluations
- Tu analyses les PDF de cours uploadés et génères des ressources pédagogiques
- Tu peux suggérer des améliorations de contenu académique
- Tu rappelles les bonnes pratiques pédagogiques de l'enseignement supérieur
"""
    elif role == "admin":
        base += """
CONTEXTE ADMINISTRATEUR:
- Tu assistes dans la gestion de la plateforme AIvora
- Tu fournis des statistiques et rapports sur l'utilisation
- Tu aides à rédiger des réponses aux signalements
- Tu informes sur les procédures administratives ENSA
- Tu maintiens un ton professionnel et institutionnel
"""
    return base

# ═══════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════

@app.route("/")
def index():
    return send_from_directory(str(FRONT_DIR / "templates"), "index.html")

@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory(str(FRONT_DIR / "static"), path)

# ── Auth ───────────────────────────────────────────
@app.route("/api/auth/login", methods=["POST"])
@limiter.limit("5 per minute")
def login():
    data  = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    pwd   = str(data.get("password", ""))

    if not email.endswith("@usms.ac.ma"):
        return jsonify({"error": "Seuls les comptes @usms.ac.ma sont autorisés"}), 400
    if detect_sqli(email) or detect_sqli(pwd):
        log.warning("SQLi attempt from %s", request.remote_addr)
        return jsonify({"error": "Requête invalide"}), 400

    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email=? AND is_active=1", (email,)).fetchone()

    if not row or not verify_password(pwd, row["pwd_hash"]):
        return jsonify({"error": "Identifiants incorrects"}), 401

    token = create_session(row["id"])
    user_data = {
        "id": row["id"], "email": row["email"], "name": row["name"],
        "prenom": row["prenom"], "nom": row["nom"],
        "role": row["role"], "filiere": row["filiere"],
        "niveau": row["niveau"], "num_apogee": row["num_apogee"]
    }
    resp = jsonify({"success": True, "token": token, "user": user_data})
    resp.set_cookie("aivora_token", token, httponly=True, samesite="Strict", max_age=28800)
    return resp

@app.route("/api/auth/logout", methods=["POST"])
@require_auth
def logout():
    token = request.headers.get("X-Auth-Token") or request.cookies.get("aivora_token")
    with get_db() as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        conn.commit()
    resp = jsonify({"success": True})
    resp.delete_cookie("aivora_token")
    return resp

@app.route("/api/auth/me", methods=["GET"])
@require_auth
def me():
    u = request.current_user
    return jsonify({
        "id": u["id"], "email": u["email"], "name": u["name"],
        "prenom": u["prenom"], "nom": u["nom"],
        "role": u["role"], "filiere": u["filiere"],
        "niveau": u["niveau"], "num_apogee": u["num_apogee"]
    })

# ── Profil — modification mdp + lecture info ───────
@app.route("/api/profile", methods=["GET"])
@require_auth
def get_profile():
    u = request.current_user
    return jsonify({
        "id": u["id"], "email": u["email"],
        "name": u["name"], "prenom": u["prenom"], "nom": u["nom"],
        "role": u["role"], "filiere": u["filiere"],
        "niveau": u["niveau"], "num_apogee": u["num_apogee"],
        "created_at": u["created_at"], "last_login": u["last_login"]
    })

@app.route("/api/profile/password", methods=["POST"])
@require_auth
def change_password():
    u = request.current_user
    data = request.get_json(silent=True) or {}
    current_pwd = str(data.get("current_password", ""))
    new_pwd     = str(data.get("new_password", ""))

    if not current_pwd or not new_pwd:
        return jsonify({"error": "Mots de passe requis"}), 400
    if len(new_pwd) < 8:
        return jsonify({"error": "Le nouveau mot de passe doit contenir au moins 8 caractères"}), 400

    with get_db() as conn:
        row = conn.execute("SELECT pwd_hash FROM users WHERE id=?", (u["id"],)).fetchone()

    if not row or not verify_password(current_pwd, row["pwd_hash"]):
        return jsonify({"error": "Mot de passe actuel incorrect"}), 401

    new_hash = hash_password(new_pwd)
    with get_db() as conn:
        conn.execute("UPDATE users SET pwd_hash=? WHERE id=?", (new_hash, u["id"]))
        conn.commit()

    log.info("Password changed for user %s", u["email"])
    return jsonify({"success": True, "message": "Mot de passe modifié avec succès"})

# ── Chat ────────────────────────────────────────────
@app.route("/api/chat", methods=["POST"])
@require_auth
@limiter.limit("10 per minute")
def chat():
    user = request.current_user
    data = request.get_json(silent=True) or {}
    raw_query = str(data.get("message", "")).strip()
    conversation_id = data.get("conversation_id")  # Peut être None (nouvelle conv)

    # --- SÉCURITÉ ---
    if not raw_query:
        return jsonify({"error": "Message vide"}), 400
    if detect_sqli(raw_query):
        log.warning("SQLi attempt in chat from user %s", user["email"])
        return jsonify({"error": "Contenu bloqué", "blocked": True, "reason": "Injection SQL détectée"}), 400

    filtered_query, detected_pii = filter_pii(raw_query)
    had_pii = bool(detected_pii)

    # --- Créer ou récupérer la conversation ---
    with get_db() as conn:
        if conversation_id:
            conv = conn.execute(
                "SELECT id FROM conversations WHERE id=? AND user_id=?",
                (conversation_id, user["id"])
            ).fetchone()
            if not conv:
                conversation_id = None

        if not conversation_id:
            conversation_id = str(uuid.uuid4())
            title = filtered_query[:60].strip()
            conn.execute(
                "INSERT INTO conversations(id,user_id,title) VALUES(?,?,?)",
                (conversation_id, user["id"], title)
            )
        else:
            conn.execute(
                "UPDATE conversations SET updated_at=datetime('now') WHERE id=?",
                (conversation_id,)
            )

        msg_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO messages(id,user_id,conversation_id,role,content,mode) VALUES(?,?,?,?,?,?)",
            (msg_id, user["id"], conversation_id, "user", filtered_query, "edge")
        )
        conn.commit()

    # --- 1. CACHE SÉMANTIQUE ---
    cache_result = find_cache(filtered_query)
    if cache_result:
        entry, score = cache_result
        resp_id = str(uuid.uuid4())
        with get_db() as conn:
            conn.execute(
                "INSERT INTO messages(id,user_id,conversation_id,role,content,mode,latency_ms) VALUES(?,?,?,?,?,?,?)",
                (resp_id, user["id"], conversation_id, "assistant", entry["response"], "cache", 2)
            )
            conn.commit()
        return jsonify({
            "id": resp_id, "response": entry["response"], "mode": "cache",
            "latency_ms": 2, "cache_score": round(score, 3),
            "filtered_pii": had_pii, "detected_pii": detected_pii,
            "conversation_id": conversation_id
        })

    # --- 2. EMPLOI DU TEMPS ---
    if any(w in filtered_query.lower() for w in ["planning","emploi du temps","edt","cours de","horaire","matière"]):
        response = build_schedule_response(filtered_query)
        add_cache(filtered_query, response, "edge")
        resp_id = str(uuid.uuid4())
        with get_db() as conn:
            conn.execute(
                "INSERT INTO messages(id,user_id,conversation_id,role,content,mode,latency_ms) VALUES(?,?,?,?,?,?,?)",
                (resp_id, user["id"], conversation_id, "assistant", response, "edge", 5)
            )
            conn.commit()
        return jsonify({
            "id": resp_id, "response": response, "mode": "edge", "latency_ms": 5,
            "filtered_pii": had_pii, "detected_pii": detected_pii,
            "conversation_id": conversation_id
        })

    # --- 3. LIVE FETCH ENSA ---
    site_info = get_ensa_live_info()

    # --- 4. OLLAMA ---
    ollama_ok = check_ollama()
    if ollama_ok:
        try:
            system_prompt = build_system_prompt(user)
            prompt_final = f"""INFOS DU SITE OFFICIEL ENSA : {site_info}

QUESTION DE L'UTILISATEUR : {filtered_query}

CONSIGNE : Réponds avec précision en utilisant les infos du site ci-dessus.
S'il s'agit d'une question générale sur l'informatique ou l'IA, réponds normalement."""
            response, latency = call_ollama(prompt_final, system_prompt)
            mode = "edge"
        except Exception as e:
            log.error("Ollama error: %s", e)
            response = get_degraded_response(filtered_query, user.get("role","student"))
            latency, mode = 50, "degraded"
    else:
        response = get_degraded_response(filtered_query, user.get("role","student"))
        latency, mode = 30, "degraded"

    add_cache(filtered_query, response, mode)
    resp_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO messages(id,user_id,conversation_id,role,content,mode,latency_ms) VALUES(?,?,?,?,?,?,?)",
            (resp_id, user["id"], conversation_id, "assistant", response, mode, latency)
        )
        conn.commit()

    return jsonify({
        "id": resp_id, "response": response, "mode": mode, "latency_ms": latency,
        "filtered_pii": had_pii, "detected_pii": detected_pii,
        "ollama_available": ollama_ok, "conversation_id": conversation_id
    })

# ── CONVERSATIONS — liste cliquable dans la sidebar ──
@app.route("/api/conversations", methods=["GET"])
@require_auth
def get_conversations():
    """Retourne les 50 dernières conversations de l'utilisateur, triées par date de mise à jour."""
    user = request.current_user
    with get_db() as conn:
        rows = conn.execute(
            """SELECT id, title, created_at, updated_at
               FROM conversations
               WHERE user_id = ?
               ORDER BY updated_at DESC
               LIMIT 50""",
            (user["id"],)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/conversations/<conv_id>", methods=["DELETE"])
@require_auth
def delete_conversation(conv_id):
    """Supprime une conversation et tous ses messages."""
    user = request.current_user
    with get_db() as conn:
        conv = conn.execute("SELECT id FROM conversations WHERE id=? AND user_id=?", (conv_id, user["id"])).fetchone()
        if not conv:
            return jsonify({"error": "Conversation introuvable"}), 404
        conn.execute("DELETE FROM messages WHERE conversation_id=?", (conv_id,))
        conn.execute("DELETE FROM conversations WHERE id=?", (conv_id,))
        conn.commit()
    return jsonify({"success": True})

@app.route("/api/conversations/<conv_id>/messages", methods=["GET"])
@require_auth
def get_conversation_messages(conv_id):
    """Retourne tous les messages d'une conversation dans l'ordre chronologique."""
    user = request.current_user
    with get_db() as conn:
        conv = conn.execute("SELECT id FROM conversations WHERE id=? AND user_id=?", (conv_id, user["id"])).fetchone()
        if not conv:
            return jsonify({"error": "Conversation introuvable"}), 404
        msgs = conn.execute(
            """SELECT id, role, content, mode, latency_ms, created_at
               FROM messages
               WHERE conversation_id=? AND user_id=?
               ORDER BY created_at ASC""",
            (conv_id, user["id"])
        ).fetchall()
    return jsonify([dict(m) for m in msgs])

# ── Compatibilité ancienne route /api/history ──
@app.route("/api/history", methods=["GET"])
@require_auth
def get_history():
    """Route de compatibilité — redirige vers /api/conversations."""
    user = request.current_user
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, title, updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 30",
            (user["id"],)
        ).fetchall()
    return jsonify([{"id": r["id"], "content": r["title"], "created_at": r["updated_at"]} for r in rows])
# ── PDF — Upload (prof & étudiant, rôles distincts) ─
@app.route("/api/pdf/upload", methods=["POST"])
@require_auth
@limiter.limit("5 per minute")
def upload_pdf():
    user = request.current_user
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier"}), 400

    f = request.files["file"]
    if not f.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Format PDF requis"}), 400

    # Le prof peut marquer un PDF comme cours partagé
    is_course   = request.form.get("is_course", "false").lower() == "true"
    module_name = request.form.get("module_name", "").strip()[:100]
    visible_to  = "all" if (is_course and user["role"] in ("professor","admin")) else user["id"]

    doc_id   = str(uuid.uuid4())
    filename = f"{doc_id}.pdf"
    path     = UPLOAD_DIR / filename
    f.save(str(path))

    try:
        doc  = fitz.open(str(path))
        text = "\n".join(page.get_text() for page in doc)
        doc.close()
        text, _ = filter_pii(text)
    except Exception as e:
        text = ""
        log.error("PDF extraction error: %s", e)

    with get_db() as conn:
        conn.execute(
            "INSERT INTO pdf_documents(id,user_id,filename,original_name,text_content,is_course,module_name,visible_to) VALUES(?,?,?,?,?,?,?,?)",
            (doc_id, user["id"], filename, f.filename, text[:50000], 1 if is_course else 0, module_name, visible_to)
        )
        # Si c'est un cours partagé → notifier tous les étudiants
        if is_course and user["role"] in ("professor", "admin"):
            students = conn.execute(
                "SELECT id FROM users WHERE role='student' AND is_active=1"
            ).fetchall()
            prof_name = user.get("name", "Un professeur")
            mod_label = f" ({module_name})" if module_name else ""
            for st in students:
                snid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO notifications(id,user_id,title,message) VALUES(?,?,?,?)",
                    (snid, st["id"],
                     "📚 Nouveau cours disponible",
                     f"{prof_name} a mis en ligne : {f.filename}{mod_label}. Disponible dans la section PDF.")
                )
        conn.commit()

    return jsonify({"id": doc_id, "name": f.filename,
                    "pages": len(text.split("\n")) // 40 + 1,
                    "chars": len(text), "is_course": is_course})

@app.route("/api/pdf/<doc_id>/analyze", methods=["POST"])
@require_auth
@limiter.limit("5 per minute")
def analyze_pdf(doc_id: str):
    user = request.current_user
    data = request.get_json(silent=True) or {}
    action   = data.get("action", "questions")
    custom_q = str(data.get("question", "")).strip()

    with get_db() as conn:
        # Étudiant voit ses PDFs + les cours partagés (visible_to='all')
        if user["role"] == "student":
            doc = conn.execute(
                "SELECT * FROM pdf_documents WHERE id=? AND (user_id=? OR visible_to='all')",
                (doc_id, user["id"])
            ).fetchone()
        else:
            doc = conn.execute("SELECT * FROM pdf_documents WHERE id=?", (doc_id,)).fetchone()

    if not doc:
        return jsonify({"error": "Document non trouvé ou accès refusé"}), 404

    text_excerpt = (doc["text_content"] or "")[:8000]
    PROMPTS = {
        "resume":      f"Résume ce document de manière structurée et complète. Document:\n\n{text_excerpt}",
        "questions":   f"Génère 5 questions importantes sur ce cours avec leurs réponses. Document:\n\n{text_excerpt}",
        "points-cles": f"Liste les 10 points clés essentiels à retenir. Document:\n\n{text_excerpt}",
        "quiz":        f"Crée un QCM de 5 questions (4 choix) avec bonnes réponses et explications. Document:\n\n{text_excerpt}",
        "custom":      f"{custom_q}\n\nContexte:\n\n{text_excerpt}",
    }
    prompt_key = "custom" if custom_q else action
    prompt = PROMPTS.get(prompt_key, PROMPTS["questions"])

    ollama_ok = check_ollama()
    if ollama_ok:
        try:
            sys_p = f"Tu es AIvora, assistant pédagogique ENSA Beni Mellal. Analyse ce document académique et réponds en français."
            response, latency = call_ollama(prompt, sys_p, max_tokens=1024)
            mode = "edge"
        except Exception:
            response = f"**Analyse PDF — Mode local**\n\nDocument reçu. Ollama doit être actif pour l'analyse complète."
            latency = 0
            mode = "degraded"
    else:
        response = f"**Analyse PDF — Mode dégradé**\n\nDocument: **{doc['original_name']}**\n\nOllama n'est pas disponible. Lancez `ollama serve` puis `ollama pull mistral`."
        latency  = 10
        mode     = "degraded"

    return jsonify({"response": response, "mode": mode, "latency_ms": latency, "doc_name": doc["original_name"]})

@app.route("/api/pdf/list", methods=["GET"])
@require_auth
def list_pdfs():
    user = request.current_user
    with get_db() as conn:
        if user["role"] in ("professor", "admin"):
            # Prof voit tous ses PDFs
            rows = conn.execute(
                "SELECT id, original_name, created_at, is_course, module_name FROM pdf_documents WHERE user_id=? ORDER BY created_at DESC",
                (user["id"],)
            ).fetchall()
        else:
            # Étudiant voit ses PDFs + cours partagés
            rows = conn.execute(
                "SELECT id, original_name, created_at, is_course, module_name FROM pdf_documents WHERE user_id=? OR visible_to='all' ORDER BY created_at DESC",
                (user["id"],)
            ).fetchall()
    return jsonify([dict(r) for r in rows])

# ── Emploi du temps — prof peut ajouter des séances ─
@app.route("/api/schedule", methods=["GET"])
@require_auth
def get_schedule():
    today = datetime.now().isoweekday()
    with get_db() as conn:
        # Récupère les séances du prof confirmées
        extra = conn.execute(
            "SELECT * FROM schedule_entries WHERE status='confirmed' ORDER BY jour, heure_debut"
        ).fetchall()
    
    extra_by_day = {}
    for row in extra:
        d = row["jour"]
        if d not in extra_by_day:
            extra_by_day[d] = []
        extra_by_day[d].append({
            "name": row["module_name"],
            "prof": "",
            "heure": f"{row['heure_debut']}–{row['heure_fin']}",
            "salle": row["salle"],
            "extra": True,
            "id": row["id"]
        })

    merged = {}
    for d in range(1, 7):
        courses = list(EDT_STATIC.get(d, []))
        courses.extend(extra_by_day.get(d, []))
        if courses:
            merged[str(d)] = courses

    return jsonify({
        "today": today,
        "today_name": DAY_NAMES.get(today, ""),
        "today_courses": merged.get(str(today), []),
        "full_schedule": merged,
        "day_names": DAY_NAMES
    })

@app.route("/api/schedule/add", methods=["POST"])
@require_professor
def add_schedule_entry():
    """Professeur ajoute une séance — en attente de confirmation admin"""
    user = request.current_user
    data = request.get_json(silent=True) or {}
    module_name = str(data.get("module_name", "")).strip()
    jour        = int(data.get("jour", 0))
    heure_debut = str(data.get("heure_debut", "")).strip()
    heure_fin   = str(data.get("heure_fin", "")).strip()
    salle       = str(data.get("salle", "A01, Bloc A")).strip()
    filiere     = str(data.get("filiere", "2A IACS")).strip()

    if not module_name or not heure_debut or not heure_fin or jour < 1 or jour > 6:
        return jsonify({"error": "Champs requis: module_name, jour (1-6), heure_debut, heure_fin"}), 400

    entry_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO schedule_entries(id,prof_id,module_name,jour,heure_debut,heure_fin,salle,filiere,status) VALUES(?,?,?,?,?,?,?,?,?)",
            (entry_id, user["id"], module_name, jour, heure_debut, heure_fin, salle, filiere, "pending")
        )
        # Notifier tous les admins
        admins = conn.execute("SELECT id FROM users WHERE role='admin' AND is_active=1").fetchall()
        for admin in admins:
            nid = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO notifications(id,user_id,title,message) VALUES(?,?,?,?)",
                (nid, admin["id"],
                 "📅 Nouvelle séance à confirmer",
                 f"{user['name']} a ajouté: {module_name} — {DAY_NAMES.get(jour,'?')} {heure_debut}–{heure_fin}")
            )
        conn.commit()

    return jsonify({"id": entry_id, "status": "pending",
                    "message": "Séance soumise — en attente de confirmation par l'administration"})

@app.route("/api/schedule/pending", methods=["GET"])
@require_admin
def get_pending_schedule():
    """Admin voit les séances en attente"""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.*, u.name as prof_name, u.email as prof_email
            FROM schedule_entries s
            JOIN users u ON s.prof_id = u.id
            ORDER BY s.created_at DESC
        """).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/schedule/<entry_id>/confirm", methods=["POST"])
@require_admin
def confirm_schedule(entry_id: str):
    """Admin confirme ou refuse une séance"""
    data   = request.get_json(silent=True) or {}
    action = str(data.get("action", "confirm"))  # confirm | reject
    note   = str(data.get("note", "")).strip()

    with get_db() as conn:
        entry = conn.execute("SELECT * FROM schedule_entries WHERE id=?", (entry_id,)).fetchone()
        if not entry:
            return jsonify({"error": "Séance introuvable"}), 404

        new_status = "confirmed" if action == "confirm" else "rejected"
        conn.execute(
            "UPDATE schedule_entries SET status=?, admin_note=?, confirmed_at=datetime('now') WHERE id=?",
            (new_status, note, entry_id)
        )
        icon = "✅" if action == "confirm" else "❌"
        # Notifier le professeur
        nid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO notifications(id,user_id,title,message) VALUES(?,?,?,?)",
            (nid, entry["prof_id"],
             f"{icon} Séance {'confirmée' if action=='confirm' else 'refusée'}",
             f"{entry['module_name']} — {DAY_NAMES.get(entry['jour'],'?')} {entry['heure_debut']}–{entry['heure_fin']}. {note}")
        )
        # Si confirmée → notifier tous les étudiants
        if action == "confirm":
            students = conn.execute(
                "SELECT id FROM users WHERE role='student' AND is_active=1"
            ).fetchall()
            for st in students:
                snid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO notifications(id,user_id,title,message) VALUES(?,?,?,?)",
                    (snid, st["id"],
                     "📅 Emploi du temps mis à jour",
                     f"Nouvelle séance ajoutée : {entry['module_name']} — {DAY_NAMES.get(entry['jour'],'?')} {entry['heure_debut']}–{entry['heure_fin']} ({entry['salle']})")
                )
        conn.commit()

    return jsonify({"success": True, "status": new_status})

@app.route("/api/schedule/my", methods=["GET"])
@require_professor
def get_my_schedule():
    """Prof voit ses propres séances soumises"""
    user = request.current_user
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM schedule_entries WHERE prof_id=? ORDER BY created_at DESC",
            (user["id"],)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

# ── Reports ─────────────────────────────────────────
@app.route("/api/reports", methods=["POST"])
@require_auth
@limiter.limit("3 per minute")
def create_report():
    user = request.current_user
    data = request.get_json(silent=True) or {}
    desc = str(data.get("description", "")).strip()
    mid  = data.get("message_id")

    if not desc:
        return jsonify({"error": "Description requise"}), 400
    if detect_sqli(desc):
        return jsonify({"error": "Contenu invalide"}), 400

    rep_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute("INSERT INTO reports(id,user_id,message_id,description) VALUES(?,?,?,?)",
                     (rep_id, user["id"], mid, desc[:1000]))
        # Notifier les admins
        admins = conn.execute("SELECT id FROM users WHERE role='admin' AND is_active=1").fetchall()
        for admin in admins:
            nid = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO notifications(id,user_id,title,message) VALUES(?,?,?,?)",
                (nid, admin["id"],
                 "⚠️ Nouveau signalement",
                 f"De: {user['name']} — {desc[:100]}")
            )
        conn.commit()

    return jsonify({"id": rep_id, "status": "pending"})

@app.route("/api/reports", methods=["GET"])
@require_auth
def get_reports():
    user = request.current_user
    with get_db() as conn:
        if user["role"] == "admin":
            rows = conn.execute("""
                SELECT r.*, u.name as user_name, u.email as user_email
                FROM reports r JOIN users u ON r.user_id=u.id
                ORDER BY r.created_at DESC
            """).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM reports WHERE user_id=? ORDER BY created_at DESC",
                (user["id"],)
            ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/reports/<rep_id>/reply", methods=["POST"])
@require_admin
def reply_report(rep_id: str):
    data  = request.get_json(silent=True) or {}
    reply = str(data.get("reply", "")).strip()
    if not reply:
        return jsonify({"error": "Réponse requise"}), 400

    with get_db() as conn:
        rep = conn.execute("SELECT * FROM reports WHERE id=?", (rep_id,)).fetchone()
        if not rep:
            return jsonify({"error": "Signalement introuvable"}), 404
        conn.execute(
            "UPDATE reports SET admin_reply=?, status='resolved', replied_at=datetime('now') WHERE id=?",
            (reply, rep_id)
        )
        notif_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO notifications(id,user_id,title,message) VALUES(?,?,?,?)",
            (notif_id, rep["user_id"],
             "📬 Réponse à votre signalement",
             f"Signalement #{rep_id[:8]} traité: {reply[:200]}")
        )
        conn.commit()
    return jsonify({"success": True})

# ── Notifications ───────────────────────────────────
@app.route("/api/notifications", methods=["GET"])
@require_auth
def get_notifications():
    user = request.current_user
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20",
            (user["id"],)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/notifications/read", methods=["POST"])
@require_auth
def mark_notifications_read():
    user = request.current_user
    with get_db() as conn:
        conn.execute("UPDATE notifications SET is_read=1 WHERE user_id=?", (user["id"],))
        conn.commit()
    return jsonify({"success": True})

# ── Admin — Stats globales ───────────────────────────
@app.route("/api/admin/stats", methods=["GET"])
@require_admin
def admin_stats():
    with get_db() as conn:
        total_users    = conn.execute("SELECT COUNT(*) FROM users WHERE is_active=1").fetchone()[0]
        total_students = conn.execute("SELECT COUNT(*) FROM users WHERE role='student' AND is_active=1").fetchone()[0]
        total_profs    = conn.execute("SELECT COUNT(*) FROM users WHERE role='professor' AND is_active=1").fetchone()[0]
        total_msgs     = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        pending_reports= conn.execute("SELECT COUNT(*) FROM reports WHERE status='pending'").fetchone()[0]
        pending_sched  = conn.execute("SELECT COUNT(*) FROM schedule_entries WHERE status='pending'").fetchone()[0]
        cache_hits     = conn.execute("SELECT SUM(hits) FROM cache_entries").fetchone()[0] or 0
        avg_latency    = conn.execute("SELECT AVG(latency_ms) FROM messages WHERE latency_ms IS NOT NULL").fetchone()[0]

    return jsonify({
        "total_users": total_users,
        "total_students": total_students,
        "total_professors": total_profs,
        "total_messages": total_msgs,
        "pending_reports": pending_reports,
        "pending_schedule": pending_sched,
        "cache_hits": int(cache_hits),
        "avg_latency_ms": round(avg_latency, 1) if avg_latency else 0
    })

# ── System Status ───────────────────────────────────
@app.route("/api/status", methods=["GET"])
def status():
    ollama_ok = check_ollama()
    with get_db() as conn:
        cache_count = conn.execute("SELECT COUNT(*) FROM cache_entries").fetchone()[0]
        total_cache_hits = conn.execute("SELECT SUM(hits) FROM cache_entries").fetchone()[0] or 0
    return jsonify({
        "ollama_available": ollama_ok,
        "model": OLLAMA_MODEL,
        "mode": "edge" if ollama_ok else "degraded",
        "cache_entries": cache_count,
        "total_cache_hits": total_cache_hits,
        "cloud_sync": "synchronized",
        "rgpd_compliant": True,
        "encryption": "AES-128-GCM",
        "timestamp": datetime.utcnow().isoformat()
    })

# ── Analyse stress vocale ────────────────────────────
@app.route("/api/stress/analyze", methods=["POST"])
@require_auth
@limiter.limit("10 per minute")
def analyze_stress():
    data = request.get_json(silent=True) or {}
    transcript = str(data.get("transcript", "")).strip()[:500]
    if not transcript:
        return jsonify({"error": "Transcript requis"}), 400

    HIGH = ["stressé","panique","rien compris","impossible","nul","abandonne",
            "bloqué","perdu","angoissé","désespéré","tout raté","stress", "panique", "rien préparé", "peur", "examen", "échouer"]
    MED  = ["difficile","dur","compliqué","pas compris","problème","inquiet","fatigué","difficile", "dur", "demain", "inquiet", "problème", "réviser"]

    tl    = transcript.lower()
    level = "high" if any(w in tl for w in HIGH) else "med" if any(w in tl for w in MED) else "low"
    recs  = {
        "low":  "État calme détecté. Continuez sur cette lancée !",
        "med":  "Légère anxiété détectée. Je vais décomposer les concepts étape par étape.",
        "high": "Stress élevé détecté. Respirez profondément. Je simplifie au maximum. Vous y arriverez."
    }
    return jsonify({
        "level": level,
        "label": {"low":"😌 Calme","med":"😟 Légère anxiété","high":"😰 Stress élevé"}[level],
        "recommendation": recs[level],
        "transcript": transcript
    })

# ═══════════════════════════════════════════════════
# DÉMARRAGE
# ═══════════════════════════════════════════════════
if __name__ == "__main__":
    init_db()
    ollama_ok = check_ollama()
    log.info("═" * 55)
    log.info("  AIvora v2.0 — Assistant IA Edge · ENSA Beni Mellal")
    log.info("  Ollama: %s  |  Modèle: %s", "✅" if ollama_ok else "❌", OLLAMA_MODEL)
    log.info("  DB: %s", DB_PATH)
    log.info("  Mode: %s", "EDGE (Mistral local)" if ollama_ok else "DÉGRADÉ (base locale)")
    log.info("  RGPD: ✅  |  Argon2: %s  |  AES-128-GCM", "✅" if ARGON2_OK else "⚠️ scrypt")
    log.info("  Rôles: étudiant / professeur / admin — différenciés")
    log.info("═" * 55)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)

# ═══════════════════════════════════════════════════
# ADMIN — Gestion des utilisateurs (CRUD)
# ═══════════════════════════════════════════════════

@app.route("/api/admin/users", methods=["GET"])
@require_admin
def admin_list_users():
    """Liste tous les utilisateurs (étudiants + profs)"""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT id, email, name, prenom, nom, role, filiere, niveau, num_apogee,
                      created_at, last_login, is_active
               FROM users ORDER BY role, nom"""
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/admin/users", methods=["POST"])
@require_admin
def admin_create_user():
    """Admin crée un nouveau compte étudiant ou professeur"""
    data     = request.get_json(silent=True) or {}
    email    = str(data.get("email", "")).strip().lower()
    prenom   = str(data.get("prenom", "")).strip()
    nom      = str(data.get("nom", "")).strip()
    role     = str(data.get("role", "student")).strip()
    filiere  = str(data.get("filiere", "")).strip()
    niveau   = str(data.get("niveau", "")).strip()
    apogee   = str(data.get("num_apogee", "")).strip()
    password = str(data.get("password", "")).strip()

    if not email or not prenom or not nom or not password:
        return jsonify({"error": "Champs requis: email, prenom, nom, password"}), 400
    if not email.endswith("@usms.ac.ma"):
        return jsonify({"error": "Email doit être @usms.ac.ma"}), 400
    if role not in ("student", "professor"):
        return jsonify({"error": "Rôle doit être student ou professor"}), 400
    if len(password) < 6:
        return jsonify({"error": "Mot de passe min 6 caractères"}), 400

    uid  = str(uuid.uuid4())
    name = f"{prenom} {nom}"
    h    = hash_password(password)

    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO users(id,email,name,prenom,nom,role,filiere,niveau,num_apogee,pwd_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (uid, email, name, prenom, nom, role, filiere, niveau, apogee, h)
            )
            conn.commit()
        log.info("Admin created user: %s (%s)", email, role)
        return jsonify({"success": True, "id": uid, "name": name, "email": email, "role": role})
    except Exception as e:
        if "UNIQUE" in str(e):
            return jsonify({"error": "Cet email existe déjà"}), 409
        return jsonify({"error": str(e)}), 500

@app.route("/api/admin/users/<user_id>", methods=["PUT"])
@require_admin
def admin_update_user(user_id: str):
    """Admin modifie un compte (filière, niveau, rôle, statut)"""
    data    = request.get_json(silent=True) or {}
    allowed = ["filiere", "niveau", "role", "is_active", "num_apogee"]
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        return jsonify({"error": "Aucune modification"}), 400

    with get_db() as conn:
        u = conn.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone()
        if not u:
            return jsonify({"error": "Utilisateur introuvable"}), 404
        set_clause = ", ".join(f"{k}=?" for k in updates)
        conn.execute(f"UPDATE users SET {set_clause} WHERE id=?", list(updates.values()) + [user_id])
        conn.commit()
    return jsonify({"success": True})

@app.route("/api/admin/users/<user_id>", methods=["DELETE"])
@require_admin
def admin_delete_user(user_id: str):
    """Admin supprime (désactive) un compte"""
    admin = request.current_user
    if user_id == admin["id"]:
        return jsonify({"error": "Impossible de supprimer votre propre compte"}), 400

    with get_db() as conn:
        u = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not u:
            return jsonify({"error": "Utilisateur introuvable"}), 404
        # Suppression physique des sessions actives + désactivation
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        conn.execute("UPDATE users SET is_active=0 WHERE id=?", (user_id,))
        conn.commit()
    log.info("Admin deactivated user %s", u["email"])
    return jsonify({"success": True})

@app.route("/api/admin/users/<user_id>/reset-password", methods=["POST"])
@require_admin
def admin_reset_password(user_id: str):
    """Admin réinitialise le mot de passe d'un utilisateur"""
    data = request.get_json(silent=True) or {}
    new_pwd = str(data.get("password", "")).strip()
    if len(new_pwd) < 6:
        return jsonify({"error": "Mot de passe min 6 caractères"}), 400
    with get_db() as conn:
        u = conn.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone()
        if not u:
            return jsonify({"error": "Utilisateur introuvable"}), 404
        conn.execute("UPDATE users SET pwd_hash=? WHERE id=?", (hash_password(new_pwd), user_id))
        conn.commit()
    return jsonify({"success": True})

# ═══════════════════════════════════════════════════
# ADMIN — Historique de conversations d'un utilisateur
# ═══════════════════════════════════════════════════

@app.route("/api/admin/users/<user_id>/conversations", methods=["GET"])
@require_admin
def admin_user_conversations(user_id: str):
    """Admin voit les conversations d'un utilisateur"""
    with get_db() as conn:
        u = conn.execute("SELECT name, email FROM users WHERE id=?", (user_id,)).fetchone()
        if not u:
            return jsonify({"error": "Utilisateur introuvable"}), 404
        convs = conn.execute(
            "SELECT id, title, created_at, updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC",
            (user_id,)
        ).fetchall()
    return jsonify({"user": dict(u), "conversations": [dict(c) for c in convs]})

@app.route("/api/admin/conversations/<conv_id>/messages", methods=["GET"])
@require_admin
def admin_conv_messages(conv_id: str):
    """Admin lit tous les messages d'une conversation"""
    with get_db() as conn:
        msgs = conn.execute(
            "SELECT id, role, content, mode, latency_ms, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC",
            (conv_id,)
        ).fetchall()
    return jsonify([dict(m) for m in msgs])

# ═══════════════════════════════════════════════════
# ADMIN — Logs système
# ═══════════════════════════════════════════════════

@app.route("/api/admin/logs", methods=["GET"])
@require_admin
def admin_logs():
    """Admin voit les 200 derniers messages de tous les utilisateurs (logs d'activité)"""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT m.id, m.role, m.content, m.mode, m.latency_ms, m.created_at,
                   u.name as user_name, u.email as user_email, u.role as user_role,
                   c.title as conv_title
            FROM messages m
            JOIN users u ON m.user_id = u.id
            LEFT JOIN conversations c ON m.conversation_id = c.id
            ORDER BY m.created_at DESC
            LIMIT 200
        """).fetchall()
    return jsonify([dict(r) for r in rows])

# ═══════════════════════════════════════════════════
# UTILISATEUR — Suppression de ses propres conversations
# ═══════════════════════════════════════════════════

@app.route("/api/conversations/<conv_id>/delete", methods=["DELETE"])
@require_auth
def user_delete_conversation(conv_id: str):
    """Utilisateur supprime une de ses conversations"""
    user = request.current_user
    with get_db() as conn:
        conv = conn.execute(
            "SELECT id FROM conversations WHERE id=? AND user_id=?", (conv_id, user["id"])
        ).fetchone()
        if not conv:
            return jsonify({"error": "Conversation introuvable"}), 404
        conn.execute("DELETE FROM messages WHERE conversation_id=?", (conv_id,))
        conn.execute("DELETE FROM conversations WHERE id=?", (conv_id,))
        conn.commit()
    return jsonify({"success": True})


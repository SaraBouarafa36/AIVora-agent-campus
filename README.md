###### \# AIVora — Assistant IA Génératif Edge pour un Campus Intelligent

###### 

###### Assistant IA génératif embarqué (edge), conçu pour les étudiants et le personnel d'un campus intelligent — traitement en temps réel, sans dépendance cloud.

###### 

###### \## Fonctionnalités

###### \- Interface conversationnelle avec historique des conversations (sidebar)

###### \- Questions libres sur des documents PDF uploadés

###### \- Authentification multi-rôles (étudiant, professeur, administrateur)

###### \- Déploiement edge avec Ollama/Mistral (mode IA complet optionnel)

###### \- Cache sémantique TF-IDF pour optimiser les réponses

###### \- Gestion de l'emploi du temps et notifications

###### 

###### \## Technologies

###### Python, Flask, SQLite, Ollama (Mistral), HTML/CSS/JS

###### 

###### \## Installation

###### 

###### ```bash

###### \# 1. Aller dans le dossier

###### cd AIvora\_v4

###### 

###### \# 2. Installer les dépendances

###### pip install -r backend/requirements.txt

###### 

###### \# 3. (Optionnel) Lancer Ollama avec Mistral

###### ollama serve

###### ollama pull mistral

###### 

###### \# 4. Lancer le serveur

###### python backend/app.py

###### 

###### \# 5. Ouvrir dans le navigateur

###### \# http://127.0.0.1:5000

###### ```

###### 

###### \## Structure du projet

AIvora\_v4/

├── backend/

│   ├── app.py              ← Serveur Flask (API + logique IA)

│   └── requirements.txt    ← Dépendances Python

├── frontend/

│   ├── static/

│   │   ├── css/main.css    ← Styles de l'interface

│   │   └── js/app.js       ← Logique frontend

│   └── templates/

│       └── index.html      ← Page principale

├── data/                   ← Base SQLite (générée au lancement, exclue du repo)

├── uploads/                ← PDFs uploadés (exclus du repo)

├── cache/                  ← Cache sémantique (exclu du repo)

└── README.md


// PATCH APPLIQUÉ — remplace les fonctions cassées dans app.js
// Les 4 bugs corrigés :
// 1. fetchHistory() → appelle /api/history (route maintenant existante)
// 2. loadConversation() → utilise addUserMsg/addAIMsg (pas appendMessage)  
// 3. Bouton "Nouvelle conversation" → ajouté dans la sidebar
// 4. updateRateBar() → utilise les bons IDs (#rate-counter et #rate-fill déjà corrects)

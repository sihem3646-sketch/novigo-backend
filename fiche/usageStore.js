// fiche/usageStore.js
// Compteur d'usage quotidien par utilisateur (plafond de messages /api/nova).
// Persisté dans data/usage.json pour survivre à un redémarrage du serveur.
// (Même réserve que ficheStore : disque local -> à migrer avec la persistance.)

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'usage.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

let counts = load();

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(counts), 'utf8');
  } catch {
    // En cas d'échec d'écriture, on ne bloque pas la requête (le quota est
    // best-effort) ; l'erreur sera visible via les logs d'accès au disque.
  }
}

function today() {
  return new Date().toISOString().slice(0, 10); // AAAA-MM-JJ
}

/**
 * Consomme 1 unité du quota du jour. Renvoie { allowed, count, limit }.
 * count = nombre de messages déjà comptés aujourd'hui (après incrément si permis).
 */
function checkAndIncrement(userId, limit) {
  const key = String(userId);
  const d = today();
  let entry = counts[key];
  if (entry == null || entry.date !== d) {
    entry = { date: d, count: 0 };
  }
  if (entry.count >= limit) {
    counts[key] = entry;
    return { allowed: false, count: entry.count, limit };
  }
  entry.count += 1;
  counts[key] = entry;
  persist();
  return { allowed: true, count: entry.count, limit };
}

module.exports = { checkAndIncrement };

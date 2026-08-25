// fiche/ficheStore.js
// Persistance des fiches projet.
//
// ⚠️ IMPORTANT (déploiement) : l'adaptateur par défaut écrit des fichiers JSON
// sur le disque LOCAL (data/fiches/<userId>.json). C'est fiable en local, mais
// sur un hébergement à disque ÉPHÉMÈRE (Render free, Railway, Fly sans volume,
// serverless…), les fiches sont PERDUES à chaque redéploiement.
// Avant tout déploiement : remplacer par un adaptateur Supabase (voir README).
// Le reste du code n'utilise que loadFiche / saveFiche : un seul fichier à changer.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'fiches');

/** Fiche vierge (copie légère du helper `ficheVide` de l'app). */
function ficheVide(utilisateurId) {
  return {
    utilisateurId,
    misAJourLe: new Date().toISOString(),
    profil: {},
    contraintes: {},
    projet: { stade: 'idee' },
    preuves: [],
    hypothesesATester: [],
    progression: { leconsTerminees: 0, missionsRealisees: [], missionsEnAttente: [] },
    decisions: [],
    blocages: [],
    notes: [],
  };
}

// Un identifiant peut contenir des caractères inattendus : on ne garde que
// l'alphanumérique + tiret/underscore pour construire un nom de fichier sûr.
function safeName(userId) {
  return String(userId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

function filePath(userId) {
  return path.join(DIR, `${safeName(userId)}.json`);
}

/** Renvoie la fiche de l'utilisateur, ou une fiche vierge si aucune. */
function loadFiche(userId) {
  try {
    const raw = fs.readFileSync(filePath(userId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return ficheVide(userId);
  }
}

/** Écrit la fiche (crée le dossier au besoin). Force le bon utilisateurId. */
function saveFiche(userId, fiche) {
  fs.mkdirSync(DIR, { recursive: true });
  const toWrite = { ...fiche, utilisateurId: userId };
  fs.writeFileSync(filePath(userId), JSON.stringify(toWrite, null, 2), 'utf8');
  return toWrite;
}

module.exports = { ficheVide, loadFiche, saveFiche };

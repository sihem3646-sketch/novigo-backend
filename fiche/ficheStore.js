// fiche/ficheStore.js
// Persistance des fiches projet (la « mémoire » de Nova sur chaque utilisateur).
//
// 1) Supabase (table nova_fiches) dès qu'elle existe : survit aux redémarrages
//    et redéploiements.
// 2) Sinon, fichiers JSON sur le disque LOCAL (data/fiches/<userId>.json). Fiable
//    en local, mais PERDU à chaque redémarrage sur un hébergement à disque
//    éphémère (Render free…).
// Le reste du code n'utilise que loadFiche / saveFiche (asynchrones).

const fs = require('fs');
const path = require('path');

const sb = require('./supabase');

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

function loadFromFile(userId) {
  try {
    return JSON.parse(fs.readFileSync(filePath(userId), 'utf8'));
  } catch {
    return ficheVide(userId);
  }
}

function saveToFile(userId, fiche) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(filePath(userId), JSON.stringify(fiche, null, 2), 'utf8');
}

/** Renvoie la fiche de l'utilisateur, ou une fiche vierge si aucune. */
async function loadFiche(userId) {
  if (await sb.available()) {
    try {
      const rows = await sb.request(`nova_fiches?user_id=eq.${encodeURIComponent(userId)}&select=fiche`);
      return Array.isArray(rows) && rows[0] != null ? rows[0].fiche : ficheVide(userId);
    } catch (e) {
      console.error('[nova] lecture fiche Supabase échouée, repli fichier :', String(e.message).slice(0, 160));
      sb.invalidate();
    }
  }
  return loadFromFile(userId);
}

/** Écrit la fiche. Force le bon utilisateurId (jamais celui du contenu). */
async function saveFiche(userId, fiche) {
  const toWrite = { ...fiche, utilisateurId: userId };
  if (await sb.available()) {
    try {
      await sb.request('nova_fiches?on_conflict=user_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, fiche: toWrite, updated_at: new Date().toISOString() }),
      });
      return toWrite;
    } catch (e) {
      console.error('[nova] écriture fiche Supabase échouée, repli fichier :', String(e.message).slice(0, 160));
      sb.invalidate();
    }
  }
  saveToFile(userId, toWrite);
  return toWrite;
}

module.exports = { ficheVide, loadFiche, saveFiche };

// fiche/ficheStore.js
// Mémoire de Nova (la « fiche » de chaque PROFIL) dans Supabase (nova_memory).
// Une fiche par profil, rattachée au compte : la même sur l'ordinateur, le
// téléphone et les futures apps ; jamais mélangée entre deux profils. La base
// revérifie que le profil appartient au compte (fonctions nova_memory_*).

const sb = require('./supabase');

/** Fiche vierge (copie légère du helper `ficheVide` de l'app). */
function ficheVide() {
  return {
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

/** Fiche du profil (vierge s'il n'en a pas encore). Lève une erreur si Supabase est injoignable. */
async function loadFiche(accountId, learnerId) {
  const fiche = await sb.rpc('nova_memory_load', { p_account: accountId, p_learner: learnerId });
  return fiche != null && typeof fiche === 'object' && !Array.isArray(fiche) ? fiche : ficheVide();
}

/**
 * Enregistre la fiche du profil. Ni identifiant technique (la ligne est déjà
 * rangée par profil) ni prénom (inutile au coaching) n'y sont gardés.
 */
async function saveFiche(accountId, learnerId, fiche) {
  const { utilisateurId, ...rest } = fiche;
  const toWrite = rest.profil != null && typeof rest.profil === 'object'
    ? { ...rest, profil: (({ prenom, ...p }) => p)(rest.profil) }
    : rest;
  await sb.rpc('nova_memory_save', { p_account: accountId, p_learner: learnerId, p_fiche: toWrite });
  return toWrite;
}

module.exports = { ficheVide, loadFiche, saveFiche };

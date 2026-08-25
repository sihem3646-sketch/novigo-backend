// fiche/ficheSchema.js
// Copie LÉGÈRE côté serveur du type FicheProjet (défini en TS dans l'app :
// novigo/src/types/ficheProjet.ts). On la reflète en Zod pour valider le JSON
// renvoyé par le LLM AVANT tout enregistrement. Toute violation des limites ou
// du schéma => validation en échec => on garde la fiche précédente inchangée.

const { z } = require('zod');

// Limites — identiques à LIMITES_FICHE côté app.
const LIMITES = {
  preuves: 30,
  hypothesesATester: 15,
  decisions: 20,
  blocages: 10,
  notes: 20,
  longueurTexte: 300,
};

// Texte libre borné (anti-fiche qui gonfle + anti-injection de pavés).
const txt = z.string().max(LIMITES.longueurTexte);
const txtOpt = txt.optional();

const Stade = z.enum(['idee', 'exploration', 'test', 'premiers_clients', 'lance']);
const Moteur = z.enum(['revenu_complementaire', 'reconversion', 'impact', 'autonomie']);
const Tolerance = z.enum(['faible', 'moyenne', 'forte']);

const Preuve = z.object({ quoi: txt, date: txt, source: txt });
const Decision = z.object({ quoi: txt, pourquoi: txtOpt, date: txt });

// Les objets Zod « strippent » par défaut les clés inconnues : un champ en trop
// renvoyé par le LLM est ignoré, il n'entre pas dans la fiche.
const FicheProjetSchema = z.object({
  utilisateurId: txt,
  misAJourLe: txt,

  profil: z.object({
    prenom: txtOpt,
    moteur: Moteur.optional(),
    momentDeVie: txtOpt,
  }),

  contraintes: z.object({
    heuresParSemaine: z.number().nonnegative().max(168).optional(),
    budgetPerdable: z.number().nonnegative().optional(),
    toleranceRisque: Tolerance.optional(),
  }),

  projet: z.object({
    nom: txtOpt,
    probleme: txtOpt,
    pourQui: txtOpt,
    solution: txtOpt,
    stade: Stade,
    modeleEconomique: txtOpt,
    prix: txtOpt,
  }),

  preuves: z.array(Preuve).max(LIMITES.preuves),
  hypothesesATester: z.array(txt).max(LIMITES.hypothesesATester),

  progression: z.object({
    mondeActuel: z.number().int().nonnegative().optional(),
    leconsTerminees: z.number().int().nonnegative(),
    missionsRealisees: z.array(txt).max(500),
    missionsEnAttente: z.array(txt).max(500),
  }),

  decisions: z.array(Decision).max(LIMITES.decisions),
  blocages: z.array(txt).max(LIMITES.blocages),

  prochaineAction: z
    .object({ quoi: txt, pourQuand: txtOpt, definiLe: txt })
    .optional(),

  notes: z.array(txt).max(LIMITES.notes),
});

/** Valide un objet inconnu. { ok:true, data } ou { ok:false, error }. */
function parseFiche(value) {
  const r = FicheProjetSchema.safeParse(value);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error };
}

module.exports = { FicheProjetSchema, parseFiche, LIMITES };

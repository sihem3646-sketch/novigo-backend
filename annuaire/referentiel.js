// annuaire/referentiel.js
// Référentiel de l'annuaire, UNE source côté serveur (miroir de la migration 0007
// de l'app : mêmes valeurs, mêmes contrôles). Sert aux filtres de la route et à
// la validation des fiches avant chargement.

const { z } = require('zod');

/** Les 18 régions françaises (codes officiels INSEE). */
const REGIONS = [
  { code: '11', nom: 'Île-de-France' },
  { code: '24', nom: 'Centre-Val de Loire' },
  { code: '27', nom: 'Bourgogne-Franche-Comté' },
  { code: '28', nom: 'Normandie' },
  { code: '32', nom: 'Hauts-de-France' },
  { code: '44', nom: 'Grand Est' },
  { code: '52', nom: 'Pays de la Loire' },
  { code: '53', nom: 'Bretagne' },
  { code: '75', nom: 'Nouvelle-Aquitaine' },
  { code: '76', nom: 'Occitanie' },
  { code: '84', nom: 'Auvergne-Rhône-Alpes' },
  { code: '93', nom: "Provence-Alpes-Côte d'Azur" },
  { code: '94', nom: 'Corse' },
  { code: '01', nom: 'Guadeloupe' },
  { code: '02', nom: 'Martinique' },
  { code: '03', nom: 'Guyane' },
  { code: '04', nom: 'La Réunion' },
  { code: '06', nom: 'Mayotte' },
];
const REGION_CODES = REGIONS.map((r) => r.code);

const TYPES = ['concours', 'incubateur', 'aide_financiere', 'accompagnement', 'formation'];
const PORTEES = ['national', 'regional', 'departemental', 'local'];
/** Filtre principal de l'écran : tout, le national, sa région (+ national), le local. */
const FILTRES_PORTEE = ['tous', 'national', 'region', 'local'];
const ETAPES = ['idee', 'test', 'creation', 'lancement', 'croissance'];
const PUBLICS = ['tous', 'jeune', 'etudiant', 'demandeur_emploi', 'salarie', 'createur', 'femme', 'senior', 'handicap', 'quartier_prioritaire'];

/** Identifiant stable d'une fiche (même règle que annuaire_slug() en base). */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const httpUrl = z.string().regex(/^https?:\/\/\S+$/, 'lien http(s) attendu');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date AAAA-MM-JJ attendue');

/** Une fiche du fichier data/dispositifs.seed.json (format 0007). */
const FicheSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug en minuscules et tirets'),
    nom: z.string().min(2).max(160),
    type: z.enum(TYPES),
    organisme: z.string().max(200).nullable(),
    description: z.string().max(600).nullable(),
    public_cible: z.array(z.enum(PUBLICS)).default([]),
    portee: z.enum(PORTEES),
    region_code: z.enum(REGION_CODES).nullable(),
    region: z.string().max(80).optional(),
    departements: z.array(z.string().regex(/^([0-9]{2}|2A|2B|97[1-6])$/, 'code département')).default([]),
    ville: z.string().max(120).nullable(),
    etapes: z.array(z.enum(ETAPES)).default([]),
    url: httpUrl.nullable(),
    source_url: httpUrl.nullable(),
    verifie_le: isoDate.nullable(),
    date_limite: isoDate.nullable(),
    // null = non précisé par la source (ni gratuité ni coût confirmés).
    gratuit: z.boolean().nullable(),
    actif: z.boolean().default(true),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.portee === 'national' && f.region_code != null) ctx.addIssue({ code: 'custom', message: 'une fiche nationale n’a pas de région' });
    if (f.portee !== 'national' && f.region_code == null) ctx.addIssue({ code: 'custom', message: 'region_code obligatoire hors national' });
    if (f.slug !== slugify(f.nom)) ctx.addIssue({ code: 'custom', message: `slug attendu : ${slugify(f.nom)}` });
  });

/** Nom lisible de la région (colonne « region » conservée pour compatibilité). */
function regionLabel(code) {
  if (code == null) return 'national';
  return REGIONS.find((r) => r.code === code)?.nom ?? 'national';
}

module.exports = { REGIONS, REGION_CODES, TYPES, PORTEES, FILTRES_PORTEE, ETAPES, PUBLICS, FicheSchema, slugify, regionLabel };

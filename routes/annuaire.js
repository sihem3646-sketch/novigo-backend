// routes/annuaire.js
// Annuaire des dispositifs d'accompagnement (lecture publique, données saisies à
// la main et vérifiées — jamais de scraping).
//   GET /api/annuaire/filtres     -> référentiel (régions, types, publics, étapes) + compteurs
//   GET /api/annuaire/recherche   -> une page de résultats filtrés côté serveur
//        ?portee=tous|national|region|local &region=<code INSEE> &type= &public= &etape= &q=
//        &limit=1..50 &offset=
//        « region » = les fiches de la région choisie + les fiches nationales.
//   GET /api/annuaire/:id         -> une fiche
//   GET /api/annuaire             -> liste complète (ancien format, pour l'app déjà en ligne)
// Les filtres sont appliqués par la base (fonctions annuaire_recherche /
// annuaire_filtres, migration 0007). Erreurs : jamais le texte brut de Supabase.

const express = require('express');

const sb = require('../fiche/supabase');
const { logError, errorMeta } = require('../lib/log');
const { REGIONS, REGION_CODES, TYPES, FILTRES_PORTEE, ETAPES, PUBLICS, PORTEES, regionLabel } = require('../annuaire/referentiel');

const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id,slug,nom,type,organisme,description,public_cible,portee,region_code,departements,ville,etapes,url,source_url,verifie_le,date_limite,gratuit';
const UNAVAILABLE = { error: 'Annuaire momentanément indisponible. Réessaie dans un instant.', code: 'annuaire_unavailable' };

/** Une fiche telle que l'app la reçoit (le nom de la région est ajouté). */
function toFiche(row) {
  return {
    id: row.id,
    slug: row.slug,
    nom: row.nom,
    type: row.type,
    organisme: row.organisme ?? null,
    description: row.description ?? null,
    public_cible: Array.isArray(row.public_cible) ? row.public_cible : [],
    portee: row.portee,
    region_code: row.region_code ?? null,
    region: regionLabel(row.region_code ?? null),
    departements: Array.isArray(row.departements) ? row.departements : [],
    ville: row.ville ?? null,
    etapes: Array.isArray(row.etapes) ? row.etapes : [],
    url: row.url ?? null,
    source_url: row.source_url ?? null,
    verifie_le: row.verifie_le ?? null,
    date_limite: row.date_limite ?? null,
    // true = gratuit, false = payant, null = non précisé par la source.
    gratuit: typeof row.gratuit === 'boolean' ? row.gratuit : null,
    actif: true,
  };
}

const pick = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : null);
const toInt = (value, def, min, max) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

/** Filtres de la requête, validés ; { error } si une valeur est inconnue. */
function readFilters(query) {
  const raw = { portee: query.portee, region: query.region, type: query.type, public: query.public, etape: query.etape };
  const f = {
    portee: pick(raw.portee, FILTRES_PORTEE) ?? 'tous',
    region: pick(raw.region, REGION_CODES),
    type: pick(raw.type, TYPES),
    public: pick(raw.public, PUBLICS),
    etape: pick(raw.etape, ETAPES),
    q: typeof query.q === 'string' ? query.q.trim().slice(0, 80) : '',
    limit: toInt(query.limit, 20, 1, 50),
    offset: toInt(query.offset, 0, 0, 10000),
  };
  const allowed = { portee: FILTRES_PORTEE, region: REGION_CODES, type: TYPES, public: PUBLICS, etape: ETAPES };
  for (const [key, list] of Object.entries(allowed)) {
    if (raw[key] != null && raw[key] !== '' && pick(raw[key], list) == null) return { error: `Filtre inconnu : ${key}.` };
  }
  if (f.portee === 'region' && f.region == null) return { error: 'Choisis une région.' };
  return { filters: f };
}

async function search(f) {
  const rows = await sb.rpc('annuaire_recherche', {
    p_portee: f.portee,
    p_region: f.region,
    p_type: f.type,
    p_public: f.public,
    p_etape: f.etape,
    p_q: f.q || null,
    p_limit: f.limit,
    p_offset: f.offset,
  });
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length > 0 ? Number(list[0].total) : f.offset === 0 ? 0 : null;
  return { items: list.map(toFiche), total };
}

function notConfigured(res) {
  return res.status(503).json({ ...UNAVAILABLE, code: 'not_configured' });
}

// -------------------------------------------------------------------------
// GET /api/annuaire/filtres
// -------------------------------------------------------------------------
router.get('/api/annuaire/filtres', async (_req, res) => {
  if (!sb.configured()) return notConfigured(res);
  try {
    const compteurs = await sb.rpc('annuaire_filtres', {});
    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ regions: REGIONS, portees: PORTEES, types: TYPES, publics: PUBLICS, etapes: ETAPES, compteurs: compteurs ?? {} });
  } catch (e) {
    logError('annuaire', 'filtres_failed', errorMeta(e));
    return res.status(503).json(UNAVAILABLE);
  }
});

// -------------------------------------------------------------------------
// GET /api/annuaire/recherche
// -------------------------------------------------------------------------
router.get('/api/annuaire/recherche', async (req, res) => {
  if (!sb.configured()) return notConfigured(res);
  const { filters, error } = readFilters(req.query);
  if (error) return res.status(400).json({ error, code: 'filtre_invalide' });
  try {
    const { items, total } = await search(filters);
    return res.json({ items, total, limit: filters.limit, offset: filters.offset });
  } catch (e) {
    logError('annuaire', 'recherche_failed', errorMeta(e));
    return res.status(503).json(UNAVAILABLE);
  }
});

// -------------------------------------------------------------------------
// GET /api/annuaire — ancien format (tableau complet) : l'app déjà en ligne
// filtre la région elle-même avec le champ « region » (nom de la région).
// -------------------------------------------------------------------------
router.get('/api/annuaire', async (req, res) => {
  if (!sb.configured()) return notConfigured(res);
  const base = {
    portee: 'tous',
    region: null,
    type: pick(req.query.type, TYPES),
    public: pick(req.query.public, PUBLICS),
    etape: null,
    q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '',
    limit: 50,
    offset: 0,
  };
  try {
    const all = [];
    for (let page = 0; page < 40; page++) {
      const { items, total } = await search({ ...base, offset: page * 50 });
      all.push(...items);
      if (items.length < 50 || (total != null && all.length >= total)) break;
    }
    return res.json(all);
  } catch (e) {
    logError('annuaire', 'liste_failed', errorMeta(e));
    return res.status(503).json(UNAVAILABLE);
  }
});

// -------------------------------------------------------------------------
// GET /api/annuaire/:id
// -------------------------------------------------------------------------
router.get('/api/annuaire/:id', async (req, res) => {
  if (!sb.configured()) return notConfigured(res);
  const id = String(req.params.id || '');
  if (!UUID.test(id)) return res.status(404).json({ error: 'Dispositif introuvable.', code: 'not_found' });
  try {
    const rows = await sb.request(`dispositifs?id=eq.${encodeURIComponent(id)}&actif=eq.true&select=${COLUMNS}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row == null) return res.status(404).json({ error: 'Dispositif introuvable.', code: 'not_found' });
    return res.json(toFiche(row));
  } catch (e) {
    logError('annuaire', 'fiche_failed', errorMeta(e));
    return res.status(503).json(UNAVAILABLE);
  }
});

module.exports = router;

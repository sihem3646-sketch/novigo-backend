// routes/annuaire.js
// Annuaire des dispositifs d'accompagnement (lecture publique).
//  GET /api/annuaire        -> liste filtrée/triée
//  GET /api/annuaire/:id    -> détail d'un dispositif
//
// Deux sources possibles :
//  1) Supabase (si SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY sont définis) : source
//     de vérité à terme, données éditables en base.
//  2) SINON : repli sur le seed JSON versionné (data/dispositifs.seed.json) →
//     l'annuaire fonctionne immédiatement, sans base. Le seed reste la source
//     de vérité des données saisies à la main.

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TYPES = ['concours', 'incubateur', 'aide_financiere', 'accompagnement', 'formation'];

const isConfigured = () => Boolean(SUPABASE_URL && SERVICE_KEY);
const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` });
const restBase = () => `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/dispositifs`;

// --- Repli local (seed JSON) ---------------------------------------------

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

let SEED = null;
function loadSeed() {
  if (SEED) return SEED;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'dispositifs.seed.json'), 'utf8');
    const arr = JSON.parse(raw);
    // On dérive un id STABLE (slug du nom) pour la navigation liste -> détail.
    SEED = arr.map((d, i) => ({ actif: true, updated_at: null, ...d, id: slug(d.nom) || `dispositif-${i}` }));
  } catch {
    SEED = [];
  }
  return SEED;
}

function localFilterSort(list, { type, region, pub, q }) {
  const today = new Date().toISOString().slice(0, 10);
  let out = list.filter((d) => d.actif !== false);
  out = out.filter((d) => !d.date_limite || d.date_limite >= today);
  if (type && TYPES.includes(type)) out = out.filter((d) => d.type === type);
  if (region) out = out.filter((d) => d.region === region);
  if (pub) out = out.filter((d) => Array.isArray(d.public_cible) && d.public_cible.includes(pub));
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter((d) => `${d.nom} ${d.organisme || ''} ${d.description || ''}`.toLowerCase().includes(needle));
  }
  // Tri : échéances proches d'abord, permanents (null) ensuite.
  out.sort((a, b) => {
    if (!a.date_limite && !b.date_limite) return 0;
    if (!a.date_limite) return 1;
    if (!b.date_limite) return -1;
    return a.date_limite.localeCompare(b.date_limite);
  });
  return out;
}

// --- Routes ---------------------------------------------------------------

// GET /api/annuaire?type=&region=&public=&q=
router.get('/api/annuaire', async (req, res) => {
  const { type, region, public: pub, q } = req.query;

  // Repli seed JSON si Supabase non configuré.
  if (!isConfigured()) {
    return res.json(localFilterSort(loadSeed(), { type, region, pub, q }));
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const params = ['select=*', 'actif=eq.true', `or=(date_limite.is.null,date_limite.gte.${today})`];
    if (type && TYPES.includes(String(type))) params.push(`type=eq.${encodeURIComponent(String(type))}`);
    if (region) params.push(`region=eq.${encodeURIComponent(String(region))}`);
    if (pub) params.push(`public_cible=cs.${encodeURIComponent('{' + String(pub) + '}')}`);
    if (q) params.push(`search_tsv=plfts(french).${encodeURIComponent(String(q))}`);
    params.push('order=date_limite.asc.nullslast');

    const r = await fetch(`${restBase()}?${params.join('&')}`, { headers: sbHeaders() });
    if (!r.ok) return res.status(502).json({ error: 'Erreur Supabase', status: r.status, detail: (await r.text()).slice(0, 300) });
    return res.json(await r.json());
  } catch (e) {
    return res.status(500).json({ error: 'Erreur serveur annuaire', detail: String(e).slice(0, 200) });
  }
});

// GET /api/annuaire/:id
router.get('/api/annuaire/:id', async (req, res) => {
  // Repli seed JSON si Supabase non configuré.
  if (!isConfigured()) {
    const item = loadSeed().find((d) => d.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Dispositif introuvable.' });
    return res.json(item);
  }

  try {
    const id = encodeURIComponent(req.params.id);
    const r = await fetch(`${restBase()}?id=eq.${id}&select=*`, {
      headers: { ...sbHeaders(), Accept: 'application/vnd.pgrst.object+json' },
    });
    if (r.status === 406 || r.status === 404) return res.status(404).json({ error: 'Dispositif introuvable.' });
    if (!r.ok) return res.status(502).json({ error: 'Erreur Supabase', status: r.status, detail: (await r.text()).slice(0, 300) });
    return res.json(await r.json());
  } catch (e) {
    return res.status(500).json({ error: 'Erreur serveur annuaire', detail: String(e).slice(0, 200) });
  }
});

module.exports = router;

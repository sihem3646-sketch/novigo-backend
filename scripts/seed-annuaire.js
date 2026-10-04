// scripts/seed-annuaire.js
// Charge data/dispositifs.seed.json dans Supabase (table public.dispositifs), en
// toute sécurité :
//   • chaque fiche est d'abord VALIDÉE (annuaire/referentiel.js) : une seule
//     erreur et rien n'est envoyé ;
//   • mise à jour FICHE PAR FICHE sur son identifiant stable (slug) : une fiche
//     existante est mise à jour, une nouvelle est ajoutée ;
//   • la table n'est JAMAIS vidée ; une fiche retirée du fichier reste en base,
//     sauf avec --desactiver-absents (elle est alors masquée : actif = false).
// Le fichier versionné est la source des fiches, saisies à la main et vérifiées.
//
//   npm run seed:annuaire -- --verifier             (validation seule, aucun envoi)
//   npm run seed:annuaire                            (validation + mise à jour)
//   npm run seed:annuaire -- --desactiver-absents   (+ masque les fiches retirées)
// Prérequis .env : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (jamais dans le code).

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { FicheSchema, regionLabel } = require('../annuaire/referentiel');

const BATCH = 50;

/** Valide toutes les fiches ; renvoie { fiches, erreurs } (aucun envoi). */
function validate(raw) {
  const erreurs = [];
  const fiches = [];
  if (!Array.isArray(raw)) return { fiches, erreurs: ['le fichier doit contenir une liste de fiches'] };
  const seen = new Set();
  raw.forEach((item, i) => {
    const r = FicheSchema.safeParse(item);
    const label = `fiche ${i + 1}${item && item.nom ? ` (${item.nom})` : ''}`;
    if (!r.success) {
      for (const issue of r.error.issues) erreurs.push(`${label} : ${issue.path.join('.') || '—'} ${issue.message}`);
      return;
    }
    if (seen.has(r.data.slug)) erreurs.push(`${label} : slug en double « ${r.data.slug} »`);
    seen.add(r.data.slug);
    fiches.push({ ...r.data, region: regionLabel(r.data.region_code) });
  });
  return { fiches, erreurs };
}

async function upsert({ url, key, fiches, desactiverAbsents }) {
  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/dispositifs`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  for (let i = 0; i < fiches.length; i += BATCH) {
    const lot = fiches.slice(i, i + BATCH);
    const r = await fetch(`${endpoint}?on_conflict=slug`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(lot),
    });
    if (!r.ok) throw new Error(`mise à jour refusée (HTTP ${r.status}) pour les fiches ${i + 1} à ${i + lot.length}`);
  }
  let desactivees = 0;
  if (desactiverAbsents) {
    const r = await fetch(`${endpoint}?select=slug&actif=eq.true`, { headers });
    if (!r.ok) throw new Error(`lecture impossible (HTTP ${r.status})`);
    const enBase = (await r.json()).map((d) => d.slug);
    const garder = new Set(fiches.map((f) => f.slug));
    for (const slug of enBase.filter((s) => !garder.has(s))) {
      const u = await fetch(`${endpoint}?slug=eq.${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ actif: false }),
      });
      if (!u.ok) throw new Error(`masquage refusé (HTTP ${u.status}) pour « ${slug} »`);
      desactivees += 1;
    }
  }
  return { envoyees: fiches.length, desactivees };
}

async function main(argv = process.argv.slice(2)) {
  const seedPath = path.join(__dirname, '..', 'data', 'dispositifs.seed.json');
  const { fiches, erreurs } = validate(JSON.parse(fs.readFileSync(seedPath, 'utf8')));
  if (erreurs.length > 0) {
    console.error(`❌ ${erreurs.length} problème(s) — rien n'a été envoyé :`);
    erreurs.slice(0, 50).forEach((e) => console.error(`   • ${e}`));
    process.exitCode = 1;
    return;
  }
  console.log(`✅ ${fiches.length} fiches valides.`);
  if (argv.includes('--verifier')) return;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('❌ SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis dans .env');
    process.exitCode = 1;
    return;
  }
  const r = await upsert({ url, key, fiches, desactiverAbsents: argv.includes('--desactiver-absents') });
  console.log(`✅ ${r.envoyees} fiches mises à jour ou ajoutées${r.desactivees ? `, ${r.desactivees} masquée(s)` : ''}. Aucune fiche supprimée.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌', e.message);
    process.exitCode = 1;
  });
}

module.exports = { validate, upsert, main };

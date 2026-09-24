// scripts/seed-annuaire.js
// Charge data/dispositifs.seed.json dans Supabase (table public.dispositifs)
// via l'API REST, avec la clé SERVICE_ROLE (jamais côté client, jamais dans le
// code — uniquement dans .env). Le JSON versionné est la SOURCE DE VÉRITÉ :
// le script remplace le contenu de la table (vide puis réinsère).
//
// Lancer :  novigo-backend> npm run seed:annuaire
// Prérequis .env : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('❌ SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis dans .env');
    process.exit(1);
  }

  const seedPath = path.join(__dirname, '..', 'data', 'dispositifs.seed.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  if (!Array.isArray(seed) || seed.length === 0) {
    console.error('❌ Seed vide ou invalide :', seedPath);
    process.exit(1);
  }

  const endpoint = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/dispositifs`;
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  // 1) Vider la table (remplacement complet — le JSON fait foi).
  const del = await fetch(`${endpoint}?id=not.is.null`, {
    method: 'DELETE',
    headers: { ...headers, Prefer: 'return=minimal' },
  });
  if (!del.ok) {
    console.error('❌ Échec suppression :', del.status, (await del.text()).slice(0, 300));
    process.exit(1);
  }

  // 2) Insérer le seed (insertion en lot).
  const ins = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(seed),
  });
  if (!ins.ok) {
    console.error('❌ Échec insertion :', ins.status, (await ins.text()).slice(0, 300));
    process.exit(1);
  }

  console.log(`✅ ${seed.length} dispositifs chargés dans Supabase.`);
}

main().catch((e) => {
  console.error('❌ Erreur inattendue :', e);
  process.exit(1);
});

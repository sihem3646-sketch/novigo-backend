// fiche/supabase.js
// Accès serveur aux tables Nova de Supabase (nova_fiches, nova_usage, fonction
// nova_consume — voir supabase/nova.sql), via l'API REST avec la clé serveur.
//
// Tant que les tables n'existent pas (SQL pas encore lancé) ou si Supabase n'est
// pas configuré, `available()` renvoie false et les stores retombent sur les
// fichiers locaux. On revérifie toutes les 10 minutes : dès que le SQL est lancé,
// le serveur bascule tout seul sur Supabase, sans redéploiement.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RECHECK_MS = 10 * 60 * 1000;

let state = { ok: false, checkedAt: 0 };

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

function headers(extra) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra };
}

async function request(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: headers(init.headers) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Supabase ${res.status}: ${detail.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Les tables Nova sont-elles utilisables ? (résultat mis en cache 10 min) */
async function available() {
  if (!configured()) return false;
  const now = Date.now();
  if (now - state.checkedAt < RECHECK_MS) return state.ok;
  try {
    await request('nova_fiches?select=user_id&limit=1');
    if (!state.ok) console.log('[nova] Stockage Supabase actif (nova_fiches / nova_usage).');
    state = { ok: true, checkedAt: now };
  } catch (e) {
    if (state.ok || state.checkedAt === 0) console.log('[nova] Stockage Supabase indisponible, repli sur fichiers :', String(e.message).slice(0, 160));
    state = { ok: false, checkedAt: now };
  }
  return state.ok;
}

/** À appeler si une requête échoue : on reteste la disponibilité au prochain appel. */
function invalidate() {
  state = { ok: false, checkedAt: 0 };
}

module.exports = { available, invalidate, request };

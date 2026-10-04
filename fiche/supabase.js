// fiche/supabase.js
// Accès SERVEUR aux données Nova dans Supabase (migration 0005 de l'app :
// nova_memory, nova_usage_account, nova_usage_global + fonctions nova_*), via
// l'API REST avec la clé serveur (service_role), qui ne quitte jamais ce serveur.
// Plus aucun repli sur le disque : sur un hébergement à disque temporaire, la
// mémoire et les quotas y étaient perdus à chaque redémarrage. Si Supabase est
// injoignable, Nova le dit (503) au lieu de compter ou retenir n'importe où.

function baseUrl() {
  return (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
}

function serviceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function configured() {
  return Boolean(baseUrl() && serviceKey());
}

function headers(extra) {
  const key = serviceKey();
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

async function request(path, init = {}) {
  if (!configured()) {
    const err = new Error('Supabase non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${baseUrl()}/rest/v1/${path}`, { ...init, headers: headers(init.headers) });
  if (!res.ok) {
    // On ne garde que le CODE de l'erreur (ex. 23514), jamais son texte : Postgres y
    // recopie la ligne refusée (« Failing row contains … »), donc des données.
    const detail = await res.text().catch(() => '');
    let pgCode;
    try {
      const parsed = JSON.parse(detail);
      if (parsed && typeof parsed.code === 'string') pgCode = parsed.code;
    } catch {
      // corps illisible : aucun code
    }
    const err = new Error(`Supabase ${res.status}`);
    err.status = res.status;
    if (pgCode) err.pgCode = pgCode;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Appel d'une fonction SQL (POST /rest/v1/rpc/<nom>, arguments nommés). */
function rpc(name, args) {
  return request(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
}

/**
 * Suppression DÉFINITIVE d'un compte Supabase Auth (API d'administration, clé
 * serveur). Les données liées partent par les clés étrangères ON DELETE CASCADE
 * (migrations 0001, 0003, 0004, 0005), dans la même transaction que la
 * suppression du compte. Renvoie 'deleted' ou 'missing' (compte déjà absent).
 */
async function adminDeleteUser(userId) {
  if (!configured()) {
    const err = new Error('Supabase non configuré');
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${baseUrl()}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: headers(),
    body: JSON.stringify({ should_soft_delete: false }),
  });
  if (res.ok) return 'deleted';
  if (res.status === 404) return 'missing';
  let code;
  try {
    const parsed = JSON.parse(await res.text());
    if (parsed && typeof parsed.error_code === 'string') code = parsed.error_code;
  } catch {
    // corps illisible : aucun code
  }
  const err = new Error(`Supabase Auth ${res.status}`);
  err.status = res.status;
  if (code) err.pgCode = code;
  throw err;
}

module.exports = { configured, request, rpc, adminDeleteUser };

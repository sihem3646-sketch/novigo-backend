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
    const detail = await res.text().catch(() => '');
    const err = new Error(`Supabase ${res.status}: ${detail.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Appel d'une fonction SQL (POST /rest/v1/rpc/<nom>, arguments nommés). */
function rpc(name, args) {
  return request(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
}

module.exports = { configured, request, rpc };

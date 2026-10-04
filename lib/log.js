// lib/log.js
// Journalisation MINIMALE et non sensible. Les journaux partent chez l'hébergeur
// (Render) : on n'y écrit JAMAIS de contenu utilisateur — ni message, ni fiche
// Nova, ni réponse de l'IA, ni corps d'erreur brut (Postgres renvoie par exemple
// « Failing row contains (…) », c'est-à-dire la ligne entière). Seulement : où,
// quoi (un code court), et des métadonnées techniques sûres (statut HTTP, code
// d'erreur Postgres/PostgREST, nombre).

const SAFE_KEYS = new Set(['status', 'code', 'count', 'kind']);
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,40}$/;

/** Ne garde que des métadonnées sûres (clé connue, valeur courte sans espace). */
function safeMeta(meta) {
  const out = {};
  if (meta == null || typeof meta !== 'object') return out;
  for (const [k, v] of Object.entries(meta)) {
    if (!SAFE_KEYS.has(k) || v == null) continue;
    const s = String(v);
    if (SAFE_VALUE.test(s)) out[k] = s;
  }
  return out;
}

/** Métadonnées sûres d'une erreur : statut HTTP et code (jamais son message). */
function errorMeta(e) {
  if (e == null || typeof e !== 'object') return {};
  return safeMeta({ status: e.status, code: e.pgCode || e.code || (e.name === 'AbortError' ? 'aborted' : undefined) });
}

/** Une ligne d'erreur : « [scope] event status=… code=… ». */
function logError(scope, event, meta) {
  const m = safeMeta(meta);
  const tail = Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ');
  // eslint-disable-next-line no-console
  console.error(`[${scope}] ${event}${tail ? ` ${tail}` : ''}`);
}

module.exports = { logError, errorMeta, safeMeta };

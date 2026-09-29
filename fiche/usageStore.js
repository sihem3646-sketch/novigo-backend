// fiche/usageStore.js
// Compteurs d'usage quotidiens (plafonds de messages /api/nova).
//
// `consume(checks)` vérifie TOUS les plafonds avant d'en consommer un seul :
// une demande refusée ne coûte rien. Exemple :
//   consume([{ key: 'device:…', limit: 20 }, { key: 'global', limit: 1000 }])
//
// 1) Supabase (fonction nova_consume, atomique) dès que les tables existent :
//    les compteurs survivent aux redémarrages.
// 2) Sinon, data/usage.json sur le disque local (perdu à chaque redémarrage sur
//    un hébergement à disque éphémère).

const fs = require('fs');
const path = require('path');

const sb = require('./supabase');

const FILE = path.join(__dirname, '..', 'data', 'usage.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

let counts = load();

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(counts), 'utf8');
  } catch {
    // Quota best-effort : un échec d'écriture ne bloque pas la requête.
  }
}

function today() {
  return new Date().toISOString().slice(0, 10); // AAAA-MM-JJ (UTC)
}

function consumeInFile(checks) {
  const d = today();
  for (const c of checks) {
    const entry = counts[c.key];
    const count = entry != null && entry.date === d ? entry.count : 0;
    if (count >= c.limit) return { allowed: false, blockedKey: c.key, limit: c.limit };
  }
  for (const c of checks) {
    const entry = counts[c.key];
    const count = entry != null && entry.date === d ? entry.count : 0;
    counts[c.key] = { date: d, count: count + 1 };
  }
  persist();
  return { allowed: true };
}

/**
 * Consomme 1 unité sur chaque compteur si AUCUN plafond n'est atteint.
 * Renvoie { allowed: true } ou { allowed: false, blockedKey, limit }.
 */
async function consume(checks) {
  if (await sb.available()) {
    try {
      const rows = await sb.request('rpc/nova_consume', {
        method: 'POST',
        body: JSON.stringify({ p_keys: checks.map((c) => c.key), p_limits: checks.map((c) => c.limit), p_day: today() }),
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row && row.allowed === false) {
        const blocked = checks.find((c) => c.key === row.blocked_key);
        return { allowed: false, blockedKey: row.blocked_key, limit: blocked ? blocked.limit : undefined };
      }
      return { allowed: true };
    } catch (e) {
      console.error('[nova] quota Supabase échoué, repli fichier :', String(e.message).slice(0, 160));
      sb.invalidate();
    }
  }
  return consumeInFile(checks);
}

/**
 * Rend 1 unité sur chaque compteur (l'appel à l'IA a échoué : la personne ne
 * doit pas perdre un message pour une panne qui n'est pas de son fait).
 */
async function refund(keys) {
  if (await sb.available()) {
    try {
      await sb.request('rpc/nova_refund', { method: 'POST', body: JSON.stringify({ p_keys: keys, p_day: today() }) });
      return;
    } catch (e) {
      console.error('[nova] remboursement Supabase échoué :', String(e.message).slice(0, 160));
      sb.invalidate();
      return;
    }
  }
  const d = today();
  for (const key of keys) {
    const entry = counts[key];
    if (entry != null && entry.date === d && entry.count > 0) counts[key] = { date: d, count: entry.count - 1 };
  }
  persist();
}

/** Compteurs du jour, SANS rien consommer (affichage « messages restants »). */
async function peek(keys) {
  const d = today();
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  if (await sb.available()) {
    try {
      const list = keys.map((k) => `"${String(k).replace(/"/g, '')}"`).join(',');
      const rows = await sb.request(`nova_usage?select=key,count&day=eq.${d}&key=in.(${encodeURIComponent(list)})`);
      for (const r of Array.isArray(rows) ? rows : []) out[r.key] = r.count;
      return out;
    } catch (e) {
      console.error('[nova] lecture compteurs Supabase échouée, repli fichier :', String(e.message).slice(0, 160));
      sb.invalidate();
    }
  }
  for (const key of keys) {
    const entry = counts[key];
    out[key] = entry != null && entry.date === d ? entry.count : 0;
  }
  return out;
}

module.exports = { consume, refund, peek };

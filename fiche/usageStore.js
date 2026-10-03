// fiche/usageStore.js
// Compteurs de Nova par COMPTE dans Supabase (nova_usage_account, nova_usage_global),
// par jour et par mois, heure de Paris, calculés par la base. Jamais par appareil :
// changer de navigateur ou de téléphone ne remet rien à zéro.
//
//   consume(compte, 'chat' | 'memory', { daily, monthly, global })
//     → { allowed, reason: 'daily'|'monthly'|'global'|null, usedToday, usedMonth, day }
//   refund(compte, kind, day)   — l'IA n'a pas répondu : l'unité est rendue
//   status(compte)              — utilisés aujourd'hui / ce mois-ci (affichage)

const sb = require('./supabase');

const asInt = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const limitOrNull = (v) => (v == null ? null : Math.max(0, Math.floor(Number(v))));

async function consume(accountId, kind, limits) {
  const rows = await sb.rpc('nova_consume', {
    p_account: accountId,
    p_kind: kind,
    p_daily: limitOrNull(limits.daily),
    p_monthly: limitOrNull(limits.monthly),
    p_global: limitOrNull(limits.global),
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (row == null) throw new Error('nova_consume : réponse vide');
  return {
    allowed: row.allowed === true,
    reason: row.reason || null,
    usedToday: asInt(row.used_today),
    usedMonth: asInt(row.used_month),
    day: row.day,
  };
}

async function refund(accountId, kind, day) {
  await sb.rpc('nova_refund', { p_account: accountId, p_kind: kind, p_day: day });
}

async function status(accountId) {
  const rows = await sb.rpc('nova_usage_status', { p_account: accountId });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { usedToday: asInt(row && row.used_today), usedMonth: asInt(row && row.used_month), day: row ? row.day : null };
}

module.exports = { consume, refund, status };

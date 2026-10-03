// nova/plans.js
// Plafonds de Nova par FORMULE — seule source des quotas : le serveur décide,
// jamais l'app ni l'appareil. Tous réglables par variables d'environnement.
//   • free    : aujourd'hui, tout compte (20 messages par mois, 5 par jour au plus) ;
//   • tester  : code testeur vérifié par le serveur — pas de compteur affiché,
//               seulement une sécurité invisible contre les abus ;
//   • premium : prêt (plafonds plus hauts, réglables) mais attribué à personne
//               tant que les abonnements n'existent pas.
// Les mises à jour de la mémoire (appel IA en coulisse) ont leurs propres
// plafonds : elles ne consomment pas les messages de la personne.

function num(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function plans() {
  return {
    free: {
      visible: true,
      chat: { daily: num('NOVA_FREE_DAILY_LIMIT', 5), monthly: num('NOVA_FREE_MONTHLY_LIMIT', 20) },
      memory: { daily: num('NOVA_FREE_MEMORY_DAILY_LIMIT', 8), monthly: null },
    },
    premium: {
      visible: true,
      chat: { daily: num('NOVA_PREMIUM_DAILY_LIMIT', 50), monthly: num('NOVA_PREMIUM_MONTHLY_LIMIT', 500) },
      memory: { daily: num('NOVA_PREMIUM_MEMORY_DAILY_LIMIT', 60), monthly: null },
    },
    tester: {
      visible: false,
      chat: { daily: num('NOVA_UNLIMITED_DAILY_LIMIT', 500), monthly: null },
      memory: { daily: num('NOVA_UNLIMITED_DAILY_LIMIT', 500), monthly: null },
    },
  };
}

/** Garde-fous de coût, tous comptes confondus, par jour. */
function globalLimit(kind) {
  return kind === 'memory' ? num('NOVA_GLOBAL_MEMORY_DAILY_LIMIT', 3000) : num('NOVA_GLOBAL_DAILY_LIMIT', 3000);
}

function planLimits(planName, kind) {
  const plan = plans()[planName] || plans().free;
  return { ...plan[kind], global: globalLimit(kind) };
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Message clair quand un plafond est atteint (day = jour de Paris, AAAA-MM-JJ). */
function limitMessage(planName, reason, day) {
  const plan = plans()[planName] || plans().free;
  if (!plan.visible || reason === 'global') return 'Nova est très demandée aujourd’hui. Reviens un peu plus tard, elle sera là !';
  if (reason === 'monthly') {
    const month = Number(String(day || '').slice(5, 7));
    const next = Number.isFinite(month) && month >= 1 && month <= 12 ? MONTHS[month % 12] : null;
    return `Tu as utilisé tes ${plan.chat.monthly} messages Nova de ce mois-ci. Ils reviennent le 1er ${next ?? 'du mois prochain'}.`;
  }
  return `Tu as utilisé tes ${plan.chat.daily} messages Nova d’aujourd’hui. Ils reviennent demain.`;
}

/** Ce que l'app affiche : restant aujourd'hui et ce mois-ci (rien pour un accès testeur). */
function quotaView(planName, usage) {
  const plan = plans()[planName] || plans().free;
  if (!plan.visible) return { plan: planName, unlimited: true, limit: null, remaining: null, daily: null, monthly: null, reason: null };
  const left = (limit, used) => (limit == null ? null : Math.max(0, limit - used));
  const daily = { limit: plan.chat.daily, used: usage.usedToday, remaining: left(plan.chat.daily, usage.usedToday) };
  const monthly = { limit: plan.chat.monthly, used: usage.usedMonth, remaining: left(plan.chat.monthly, usage.usedMonth) };
  const remaining = [daily.remaining, monthly.remaining].filter((v) => v != null).reduce((a, b) => Math.min(a, b), Infinity);
  const reason = monthly.remaining === 0 ? 'monthly' : daily.remaining === 0 ? 'daily' : null;
  return {
    plan: planName,
    unlimited: false,
    // Compatibilité : « limit » = plafond du mois, « remaining » = ce qui reste vraiment (le plus serré).
    limit: monthly.limit ?? daily.limit,
    remaining: Number.isFinite(remaining) ? remaining : null,
    daily,
    monthly,
    reason,
    message: reason != null ? limitMessage(planName, reason, usage.day) : null,
  };
}

module.exports = { plans, planLimits, limitMessage, quotaView };

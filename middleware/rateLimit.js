// middleware/rateLimit.js
// Limiteur de débit EN MÉMOIRE (fenêtre fixe) contre les rafales : scripts,
// double-clics, boucles d'une app défectueuse. Les vrais quotas (jour, mois) sont
// dans Supabase ; ce garde-fou-ci peut repartir à zéro au redémarrage sans risque.

function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  return (req, res, next) => {
    const k = key(req);
    if (!k) return next();
    const now = Date.now();
    let entry = hits.get(k);
    if (entry == null || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (hits.size > 20000) {
      for (const [key2, e] of hits) if (now - e.start >= windowMs) hits.delete(key2);
    }
    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000))));
      return res.status(429).json({ error: 'Trop de demandes d’un coup. Patiente une minute, puis réessaie.', code: 'rate_limited' });
    }
    return next();
  };
}

module.exports = { rateLimit };

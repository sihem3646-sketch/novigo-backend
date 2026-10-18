// pass/catalog.js
// Les Pass en vente : prix en centimes d'euro, places Fondateur. Le prix vient
// TOUJOURS d'ici (serveur), jamais de l'app : impossible de payer moins.
// Modèle décidé par Sarah (2026-10-18) : le parcours est acquis À VIE ; Nova en
// utilisation étendue est incluse la première année (NOVA_MONTHS) ; la suite
// (renouvellement de Nova, nouveaux programmes) sera vendue à part.
// Prix décidés par Sarah : Pass Novigo 119 € / Fondateur 49,99 € (2026-10-13),
// Pass Ado 59 € / Fondateur 39 €, Pass Kids 29,99 € par enfant (2026-10-17).
//
// Réglages (Render › Environment) :
//   PASS_PRODUCTS            Pass ouverts à la vente, séparés par des virgules
//                            (défaut : novigo — Kids et Ado ne sont pas prêts).
//   PASS_FOUNDER_CAP_NOVIGO  Places Fondateur du Pass Novigo (défaut 100).
//   PASS_FOUNDER_CAP_ADO     Places Fondateur du Pass Ado (défaut 100).

/** Durée de Nova en utilisation étendue incluse avec un Pass (mois). */
const NOVA_MONTHS = 12;

const CATALOG = {
  novigo: {
    name: 'Pass Novigo',
    description: 'La Traversée : les 12 mondes et toutes les missions, à vie. Nova en utilisation étendue la première année.',
    price: 11900,
    founderPrice: 4999,
    founderCap: 100,
  },
  ado: {
    name: 'Pass Ado',
    description: 'Novigo Ados : les 10 mondes et le dossier projet, à vie.',
    price: 5900,
    founderPrice: 3900,
    founderCap: 100,
  },
  kids: {
    name: 'Pass Kids',
    description: 'Novigo Kids : les 10 mondes, pour un enfant, à vie.',
    price: 2999,
    founderPrice: null,
    founderCap: 0,
  },
};

const PRODUCTS = Object.keys(CATALOG);

/** Pass ouverts à la vente (les autres sont refusés, même par une requête écrite à la main). */
function openProducts(env = process.env) {
  const raw = (env.PASS_PRODUCTS || 'novigo').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return raw.filter((p) => PRODUCTS.includes(p));
}

/** Nombre de places Fondateur d'un Pass (0 = pas de prix Fondateur). */
function founderCap(product, env = process.env) {
  const item = CATALOG[product];
  if (item == null || item.founderPrice == null) return 0;
  const fromEnv = Number(env[`PASS_FOUNDER_CAP_${product.toUpperCase()}`]);
  return Number.isInteger(fromEnv) && fromEnv >= 0 ? fromEnv : item.founderCap;
}

module.exports = { CATALOG, PRODUCTS, NOVA_MONTHS, openProducts, founderCap };

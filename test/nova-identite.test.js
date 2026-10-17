// test/nova-identite.test.js — `npm test`.
// Ce qui part chez Mistral ne contient ni l'identifiant technique du profil ni le
// prénom ; la fiche enregistrée non plus. Les anciennes fiches restent lisibles.

const test = require('node:test');
const assert = require('node:assert');

const { buildSystemPrompt, buildMemoryPrompt, ficheSansIdentite } = require('../nova/prompt');
const { parseFiche } = require('../fiche/ficheSchema');
const sb = require('../fiche/supabase');
const { saveFiche, ficheVide } = require('../fiche/ficheStore');

const PROFIL_ID = '7b1e2c3d-4f50-4a6b-8c9d-0e1f2a3b4c5d';
const PRENOM = 'Prénomtest';

const ancienneFiche = () => ({
  ...ficheVide(),
  utilisateurId: PROFIL_ID,
  profil: { prenom: PRENOM, moteur: 'reconversion' },
  projet: { stade: 'test', nom: 'Atelier vélo' },
});

test('prompt du coach : ni identifiant de profil ni prénom', () => {
  const p = buildSystemPrompt({ fiche: ancienneFiche(), lessonContext: 'PROFIL : espace Adulte.' });
  assert.ok(!p.includes(PROFIL_ID), 'identifiant envoyé');
  assert.ok(!p.includes(PRENOM), 'prénom envoyé');
  assert.ok(!p.includes('utilisateurId'));
  assert.ok(p.includes('Atelier vélo'), 'le projet doit rester');
  assert.ok(p.includes('reconversion'), 'le reste du profil doit rester');
});

test('prompt de mémoire : ni identifiant de profil ni prénom', () => {
  const p = buildMemoryPrompt({ fiche: ancienneFiche(), conversation: 'Utilisateur: bonjour' });
  assert.ok(!p.includes(PROFIL_ID));
  assert.ok(!p.includes(PRENOM));
  assert.ok(p.includes('Atelier vélo'));
});

test('ficheSansIdentite ne modifie pas la fiche d’origine', () => {
  const f = ancienneFiche();
  ficheSansIdentite(f);
  assert.strictEqual(f.utilisateurId, PROFIL_ID);
  assert.strictEqual(f.profil.prenom, PRENOM);
});

test('fiche renvoyée sans identifiant ni date : valide', () => {
  const { utilisateurId, misAJourLe, ...sans } = ficheVide();
  assert.strictEqual(utilisateurId, undefined);
  assert.ok(parseFiche(sans).ok);
  assert.ok(parseFiche(ancienneFiche()).ok, 'ancienne fiche toujours valide');
});

test('fiche enregistrée : ni identifiant ni prénom', async () => {
  const original = sb.rpc;
  let envoye = null;
  sb.rpc = async (_name, args) => {
    envoye = args.p_fiche;
    return null;
  };
  try {
    const saved = await saveFiche('compte', PROFIL_ID, ancienneFiche());
    assert.strictEqual(saved.utilisateurId, undefined);
    assert.strictEqual(saved.profil.prenom, undefined);
    assert.strictEqual(saved.profil.moteur, 'reconversion');
    assert.ok(!JSON.stringify(envoye).includes(PROFIL_ID));
    assert.ok(!JSON.stringify(envoye).includes(PRENOM));
  } finally {
    sb.rpc = original;
  }
});

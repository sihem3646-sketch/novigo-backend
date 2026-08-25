// nova/prompt.js
// Charge prompts/nova-adultes.md, en extrait les DEUX prompts (système coach /
// mise à jour de la fiche) et remplit les placeholders {{FICHE_PROJET}},
// {{CONTEXTE_LECON}}, {{CONVERSATION}}.

const fs = require('fs');
const path = require('path');

const PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'nova-adultes.md');

let raw = null;
function loadRaw() {
  if (raw == null) raw = fs.readFileSync(PROMPT_FILE, 'utf8');
  return raw;
}

// Sépare le fichier en { system, memory } (le 2e prompt commence à "## Second prompt").
function parts() {
  const md = loadRaw();
  const idx = md.indexOf('## Second prompt');
  const systemRaw = idx >= 0 ? md.slice(0, idx) : md;
  const memoryRaw = idx >= 0 ? md.slice(idx) : '';

  // Système : on garde le contenu après le titre "## Prompt" (on jette l'entête méta).
  const pIdx = systemRaw.indexOf('## Prompt');
  const system = (pIdx >= 0 ? systemRaw.slice(pIdx + '## Prompt'.length) : systemRaw).trim();

  // Mémoire : on retire la ligne de titre "## Second prompt…" et le bloc de note (>).
  let memory = memoryRaw.replace(/^##[^\n]*\n/, '');
  memory = memory.replace(/^\s*(>[^\n]*\n)+/, '').trim();

  return { system, memory };
}

function fill(tpl, map) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in map ? map[key] : m));
}

/** Prompt système du coach, fiche + contexte de leçon injectés. */
function buildSystemPrompt({ fiche, lessonContext }) {
  const ctx = lessonContext != null && String(lessonContext).trim().length > 0
    ? String(lessonContext).trim()
    : '(conversation libre — aucune leçon en cours)';
  return fill(parts().system, {
    FICHE_PROJET: JSON.stringify(fiche, null, 2),
    CONTEXTE_LECON: ctx,
  });
}

/** Prompt de mise à jour de la fiche (2e prompt), fiche + conversation injectées. */
function buildMemoryPrompt({ fiche, conversation }) {
  return fill(parts().memory, {
    FICHE_PROJET: JSON.stringify(fiche, null, 2),
    CONVERSATION: conversation,
  });
}

module.exports = { buildSystemPrompt, buildMemoryPrompt };

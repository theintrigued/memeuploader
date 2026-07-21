const crypto = require('crypto');
const log = require('./logger');
const { getJSON, setJSON } = require('./upstash-client');

const KEY = 'clipvault_prompts';
const MAX_STORED = 500; // prune oldest USED prompts first if this is exceeded

async function getPromptsList() {
  return getJSON(KEY, []);
}

// Adds newly generated suggestions, skipping near-duplicate taglines already
// stored (case-insensitive match) so repeated "suggest more" taps don't pile
// up the same idea over and over.
async function addPrompts(suggestions, mode) {
  const existing = await getJSON(KEY, []);
  const existingTaglines = new Set(existing.map((p) => p.tagline.toLowerCase().trim()));

  const fresh = suggestions
    .filter((s) => s.tagline && !existingTaglines.has(s.tagline.toLowerCase().trim()))
    .map((s) => ({
      id: crypto.randomUUID(),
      mode,
      topic: s.topic || '',
      tagline: s.tagline,
      newsHook: s.newsHook || null,
      used: false,
      createdAt: Date.now(),
      usedAt: null,
    }));

  let combined = [...existing, ...fresh];

  if (combined.length > MAX_STORED) {
    combined.sort((a, b) => {
      if (a.used !== b.used) return a.used ? -1 : 1; // used ones sort first (candidates for removal)
      return a.createdAt - b.createdAt;
    });
    combined = combined.slice(combined.length - MAX_STORED);
  }

  await setJSON(KEY, combined);
  log.info('prompt-store', `Added ${fresh.length} new prompt(s), ${combined.length} total stored`);
  return combined;
}

async function markPromptUsed(id) {
  if (!id) return;
  try {
    const list = await getJSON(KEY, []);
    const prompt = list.find((p) => p.id === id);
    if (!prompt) {
      log.warn('prompt-store', `Tried to mark unknown prompt id as used: ${id}`);
      return;
    }
    prompt.used = true;
    prompt.usedAt = Date.now();
    await setJSON(KEY, list);
  } catch (err) {
    log.warn('prompt-store', `Could not mark prompt used: ${err.message}`);
  }
}

// Picks the oldest unused prompt (FIFO) — used by the "auto-pick" feature and
// by the autopilot when it wants to draw from manually-curated suggestions.
async function pickOldestUnused() {
  const list = await getJSON(KEY, []);
  const unused = list.filter((p) => !p.used).sort((a, b) => a.createdAt - b.createdAt);
  return unused[0] || null;
}

module.exports = { getPromptsList, addPrompts, markPromptUsed, pickOldestUnused };

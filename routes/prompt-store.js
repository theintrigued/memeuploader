const axios = require('axios');
const crypto = require('crypto');
const log = require('./logger');

// Persists generated prompts across server restarts/redeploys using Upstash
// Redis (REST API, free tier). Render's own disk is ephemeral and gets wiped
// on every redeploy, so a local JSON file would not survive — this is why an
// external store is used instead.
const KEY = 'clipvault_prompts';
const MAX_STORED = 500; // prune oldest USED prompts first if this is exceeded

function config() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set — prompt storage is unavailable. Create a free database at upstash.com and add both to Render.');
  }
  return { url, token };
}

async function loadPrompts() {
  const { url, token } = config();
  const res = await axios.get(`${url}/get/${KEY}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  if (!res.data.result) return [];
  try {
    return JSON.parse(res.data.result);
  } catch (e) {
    log.warn('prompt-store', 'Stored prompt data was corrupted, starting fresh');
    return [];
  }
}

async function savePrompts(list) {
  const { url, token } = config();
  await axios.post(`${url}/set/${KEY}`, JSON.stringify(list), {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    timeout: 15000,
  });
}

async function getPromptsList() {
  return loadPrompts();
}

// Adds newly generated suggestions, skipping near-duplicate taglines already
// stored (case-insensitive match) so repeated "suggest more" taps don't pile
// up the same idea over and over.
async function addPrompts(suggestions, mode) {
  const existing = await loadPrompts();
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
    // prune oldest USED prompts first; unused ones are more valuable to keep
    combined.sort((a, b) => {
      if (a.used !== b.used) return a.used ? -1 : 1; // used ones sort first (candidates for removal)
      return a.createdAt - b.createdAt;
    });
    combined = combined.slice(combined.length - MAX_STORED);
  }

  await savePrompts(combined);
  log.info('prompt-store', `Added ${fresh.length} new prompt(s), ${combined.length} total stored`);
  return combined;
}

async function markPromptUsed(id) {
  if (!id) return;
  try {
    const list = await loadPrompts();
    const prompt = list.find((p) => p.id === id);
    if (!prompt) {
      log.warn('prompt-store', `Tried to mark unknown prompt id as used: ${id}`);
      return;
    }
    prompt.used = true;
    prompt.usedAt = Date.now();
    await savePrompts(list);
  } catch (err) {
    log.warn('prompt-store', `Could not mark prompt used: ${err.message}`);
  }
}

module.exports = { getPromptsList, addPrompts, markPromptUsed };

const axios = require('axios');
const { getCompactList } = require('./template-store');
const log = require('./logger');

const CANDIDATE_POOL_SIZE = 30;

function scoreOverlap(tagline, description) {
  const taglineWords = new Set(tagline.toLowerCase().match(/[a-z]+/g) || []);
  const descWords = (description.toLowerCase().match(/[a-z]+/g) || []);
  let score = 0;
  for (const w of descWords) if (taglineWords.has(w)) score++;
  return score;
}

// Cheap local narrowing (no Claude cost) down to a manageable candidate pool,
// then one Claude call to pick the actual best match from that pool.
async function pickBestTemplate(tagline) {
  const list = (await getCompactList()).filter((t) => t.type === 'video' && t.description);
  if (list.length === 0) {
    throw new Error('Template index is empty or not yet built — nothing to pick from');
  }

  const scored = list
    .map((t) => ({ ...t, score: scoreOverlap(tagline, t.description) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_POOL_SIZE);

  if (!process.env.ANTHROPIC_API_KEY) {
    // No Claude available — fall back to the top keyword-overlap match.
    log.warn('template-picker', 'ANTHROPIC_API_KEY not set, using keyword-overlap match only');
    return scored[0];
  }

  const candidateLines = scored.map((t, i) => `${i}: ${t.description}`).join('\n');
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: `Situation: "${tagline}"\n\nCandidate meme templates:\n${candidateLines}\n\nWhich candidate number best fits the situation emotionally? Reply with ONLY the number, nothing else.`,
        },
      ],
    },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 20000 }
  );

  const text = res.data.content.find((b) => b.type === 'text')?.text?.trim() || '';
  const idx = parseInt(text.match(/\d+/)?.[0], 10);
  const picked = Number.isInteger(idx) && scored[idx] ? scored[idx] : scored[0];
  log.info('template-picker', `Picked template ${picked.id} for "${tagline.slice(0, 60)}"`);
  return picked;
}

module.exports = { pickBestTemplate };

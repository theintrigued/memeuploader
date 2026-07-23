const axios = require('axios');
const { getCompactList } = require('./template-store');
const { getRecentTemplateIds, recordTemplateUsed } = require('./recent-templates-store');
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
//
// Two things beyond plain keyword relevance now shape the pick:
//  - Templates used in the last 20 uploads are excluded first, so the same
//    clip doesn't show up over and over even if it's a strong match.
//  - Among the remaining relevant candidates, higher attentionScore
//    (hook strength + duration fit — see template-indexer.js) is preferred.
//    A great score doesn't override relevance, but it breaks ties toward
//    the template more likely to actually hold a viewer.
async function pickBestTemplate(tagline) {
  const [fullList, recentIds] = await Promise.all([getCompactList(), getRecentTemplateIds().catch(() => [])]);
  const list = fullList.filter((t) => t.type === 'video' && t.description);
  if (list.length === 0) {
    throw new Error('Template index is empty or not yet built — nothing to pick from');
  }

  const recentSet = new Set(recentIds);
  let available = list.filter((t) => !recentSet.has(t.id));
  // If everything relevant happens to be in the recent-use window (small
  // index, or a very narrow topic), fall back to the full list rather than
  // failing — repeating a template beats having nothing to post.
  if (available.length === 0) {
    log.warn('template-picker', 'All templates were in the recent-use window — falling back to full list');
    available = list;
  }

  const scored = available
    .map((t) => ({ ...t, overlapScore: scoreOverlap(tagline, t.description) }))
    .sort((a, b) => {
      // Relevance first, then prefer the higher attention/retention score.
      if (b.overlapScore !== a.overlapScore) return b.overlapScore - a.overlapScore;
      return (b.attentionScore ?? 50) - (a.attentionScore ?? 50);
    })
    .slice(0, CANDIDATE_POOL_SIZE);

  let picked;
  if (!process.env.ANTHROPIC_API_KEY) {
    // No Claude available — fall back to the top keyword-overlap match.
    log.warn('template-picker', 'ANTHROPIC_API_KEY not set, using keyword-overlap match only');
    picked = scored[0];
  } else {
    const candidateLines = scored
      .map((t, i) => `${i}: ${t.description}${t.emotion ? ` [emotion: ${t.emotion}]` : ''} (attention score ${t.attentionScore ?? '?'}/100)`)
      .join('\n');
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-5',
        max_tokens: 50,
        messages: [
          {
            role: 'user',
            content: `Situation: "${tagline}"\n\nCandidate meme templates (higher attention score = more likely to hold a viewer's focus, per hook-strength and duration research):\n${candidateLines}\n\nWhich candidate number best fits the situation emotionally? If two are similarly good fits, prefer the higher attention score. Reply with ONLY the number, nothing else.`,
          },
        ],
      },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    const text = res.data.content.find((b) => b.type === 'text')?.text?.trim() || '';
    const idx = parseInt(text.match(/\d+/)?.[0], 10);
    picked = Number.isInteger(idx) && scored[idx] ? scored[idx] : scored[0];
  }

  log.info('template-picker', `Picked template ${picked.id} (attentionScore=${picked.attentionScore ?? '?'}) for "${tagline.slice(0, 60)}"`);
  try {
    await recordTemplateUsed(picked.id);
  } catch (err) {
    log.warn('template-picker', `Could not record template usage: ${err.message}`);
  }
  return picked;
}

module.exports = { pickBestTemplate };

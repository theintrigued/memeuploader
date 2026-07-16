const axios = require('axios');
const log = require('./logger');

let categoryCache = { list: null, fetchedAt: 0 };
const CATEGORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getInsiderMemesCategories() {
  if (categoryCache.list && Date.now() - categoryCache.fetchedAt < CATEGORY_CACHE_TTL_MS) {
    return categoryCache.list;
  }
  try {
    const res = await axios.get('https://backend.insidermemes.com/v1/categories/', {
      headers: { Authorization: `Token ${process.env.INSIDERMEMES_API_TOKEN}` },
      timeout: 15000,
    });
    categoryCache = { list: res.data.data.map((c) => c.slug), fetchedAt: Date.now() };
    return categoryCache.list;
  } catch (err) {
    log.warn('trending', `Could not fetch Insider Memes categories, proceeding without them: ${err.message}`);
    return [];
  }
}

function buildSystemPrompt(categories) {
  const categoryLine = categories.length > 0
    ? `Insider Memes' template library is organized into these categories: ${categories.join(', ')}. Favor topics whose emotional tone clearly fits one of these — it improves template matching.`
    : '';

  return `You suggest viral short-form video topics for a meme-video channel that turns
Twitch/streamer clips into TikTok/Reels/Shorts. Style: "operatic reaction meets petty modern stakes" —
high-drama visuals paired with absurdly low-stakes captions. Broad, relatable humor, not niche.

Search the web for what's trending RIGHT NOW in gaming, Twitch, streamer drama, and general meme
culture (last few days). Then propose 8 short video concepts.

IMPORTANT — how the "tagline" field gets used: it is NOT the final caption. It is fed as a raw text
prompt into Insider Memes' generator, which does keyword extraction to pick a matching template and
writes its OWN caption. A fully-written joke confuses that matching step. Write "tagline" the way
Insider Memes' own examples do — a short, vivid SITUATION or EMOTION, not a punchline:
  Good: "streamer rage quits after losing to a bot"
  Good: "finding out your ex is dating your friend"
  Bad: "Watch him crumble like a disgraced king losing his throne to a peasant" (too written, too long)
Keep each tagline under 12 words, concrete, keyword-rich, one clear emotional beat.
${categoryLine}

Respond ONLY with a raw JSON array, no markdown fences, no preamble. Each item:
{ "topic": "3-6 word trending topic", "tagline": "a short situational prompt, under 12 words, ready to paste into Insider Memes" }`;
}

async function getTrendingSuggestions() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — trending suggestions are unavailable');
  }

  const categories = await getInsiderMemesCategories();

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: buildSystemPrompt(categories),
      messages: [{ role: 'user', content: 'Give me 8 trending video ideas for right now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  const textBlock = res.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const cleaned = textBlock.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Full array didn't parse (often truncation mid-object) — salvage whatever complete entries exist.
    const objectMatches = cleaned.match(/\{\s*"topic"[\s\S]*?\}/g) || [];
    const salvaged = [];
    for (const chunk of objectMatches) {
      try { salvaged.push(JSON.parse(chunk)); } catch (_) { /* incomplete, skip */ }
    }
    if (salvaged.length > 0) {
      log.warn('trending', `Response was truncated/malformed — salvaged ${salvaged.length} of the intended suggestions`);
      return salvaged;
    }
    throw new Error('Could not parse any trending suggestions from Claude response');
  }
}

module.exports = { getTrendingSuggestions };

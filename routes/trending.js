const axios = require('axios');
const log = require('./logger');
const { getPerformanceSummary } = require('./analytics-feedback');

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

function buildSystemPrompt(categories, performanceSummary, mode, learnings) {
  const categoryLine = categories.length > 0
    ? `Insider Memes' template library is organized into these categories: ${categories.join(', ')}. Favor topics whose emotional tone clearly fits one of these — it improves template matching.`
    : '';

  const performanceLine = performanceSummary && performanceSummary.length > 0
    ? `\nHere's what has actually performed well on this channel recently, best first (caption — platform, engagement score):\n${performanceSummary.map((p) => `- "${p.caption.slice(0, 80)}" — ${p.platform}, score ${p.engagementScore}`).join('\n')}\nLean into similar emotional beats, pacing, or subject matter where it fits a current trend — don't just repeat the same topic, but notice what's working.`
    : '';

  const learningsLine = learnings
    ? `\nNotes from yesterday's autonomous run (what worked, what to try again, what to drop):\n${learnings}\n`
    : '';

  const sharedRules = `IMPORTANT — how the "tagline" field gets used: it is NOT the final caption. It is fed as a raw text
prompt into Insider Memes' generator, which does keyword extraction to pick a matching template and
writes its OWN caption. A fully-written joke confuses that matching step. Write "tagline" the way
Insider Memes' own examples do — a short, vivid SITUATION or EMOTION, not a punchline:
  Good: "stuck in traffic for two hours on a Friday"
  Good: "finding out your ex is dating your friend"
  Bad: "Watch him crumble like a disgraced king losing his throne to a peasant" (too written, too long)
Keep each tagline under 12 words, concrete, keyword-rich, one clear emotional beat.
${categoryLine}
${performanceLine}
${learningsLine}
Respond ONLY with a raw JSON array, no markdown fences, no preamble. Each item:
{ "topic": "3-6 word topic", "tagline": "a short situational prompt, under 12 words, ready to paste into Insider Memes" }`;

  if (mode === 'relatable') {
    return `You suggest EVERYDAY-RELATABLE video topics for a meme-video channel. Style: "operatic reaction
meets petty modern stakes" — high-drama visuals paired with absurdly low-stakes captions.

Your job right now is specifically to find UNIVERSAL, WIDELY-RELATABLE situations — the kind almost
anyone has lived through, regardless of whether they follow gaming or internet culture. This is
different from chasing niche internet trends: a video about a streamer losing a match only lands with
people who watch that streamer, but "stuck in traffic for two hours" lands with almost everyone.

Search the web for big news or viral events happening right now that a lot of people are personally
experiencing or reacting to — extreme weather, travel chaos, a massive traffic jam, a price spike, a
long queue/wait somewhere, a widespread outage, back-to-school/holiday stress, a sports event most
casual people have an opinion on, etc. Then translate each into a small, funny, universally-relatable
personal situation tied to that real event — the news event gives it timeliness and grounding, but the
tagline itself should describe the everyday moment, not the news headline.

Example chain: real event = "major highway pileup causes 3-hour delays" -> tagline = "stuck in traffic
for two hours with a dying phone battery"

Propose 8 concepts, each grounded in something actually happening right now.

${sharedRules}`;
  }

  // default: 'viral' — original gaming/streamer/internet-culture mode
  return `You suggest viral short-form video topics for a meme-video channel that turns
Twitch/streamer clips into TikTok/Reels/Shorts. Style: "operatic reaction meets petty modern stakes" —
high-drama visuals paired with absurdly low-stakes captions. Broad, relatable humor, not niche.

Search the web for what's trending RIGHT NOW in gaming, Twitch, streamer drama, and general meme
culture (last few days). Then propose 8 short video concepts.

${sharedRules}`;
}

async function getTrendingSuggestions(mode = 'viral', learnings = null) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — trending suggestions are unavailable');
  }

  const categories = await getInsiderMemesCategories();
  const performanceSummary = await getPerformanceSummary();

  const userMessage = mode === 'relatable'
    ? 'Find real news/events happening right now and give me 8 relatable everyday-situation video ideas grounded in them.'
    : 'Give me 8 trending video ideas for right now.';

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: buildSystemPrompt(categories, performanceSummary, mode, learnings),
      messages: [{ role: 'user', content: userMessage }],
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

// Generates N new taglines "branching" from a small set of already-researched
// base topics — no web_search tool, so it's cheap. Used by the autopilot to
// stretch one day's research into many distinct posts without re-searching.
async function generateBranchedTaglines(baseTopics, count) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot generate branched taglines');
  }
  if (baseTopics.length === 0) {
    throw new Error('No base topics to branch from');
  }

  const topicList = baseTopics.map((t, i) => `${i + 1}. [${t.mode}] "${t.topic}" — example angle: "${t.tagline}"`).join('\n');

  const system = `You write short video prompts for Insider Memes, a meme-video generator. It does
keyword extraction on your text to pick a matching template and writes its own on-screen caption —
so your job is to give it a short, vivid SITUATION or EMOTION (under 12 words), not a finished joke.

You'll be given a small list of already-researched base topics (each already vetted as trending or
broadly relatable). Generate ${count} NEW taglines total by branching off these — different specific
angles, moments, or phrasings on the same underlying themes, so the batch doesn't feel repetitive
even though it's drawn from a small topic set. Distribute roughly evenly across the given topics.
Stay in the same style as the example angle for each topic (don't drift into unrelated new subjects).

Respond ONLY with a raw JSON array, no markdown fences, no preamble. Each item:
{ "topic": "which base topic this branches from, 3-6 words", "tagline": "a new short situational prompt, under 12 words", "mode": "viral or relatable, matching its base topic" }`;

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: `Base topics:\n${topicList}\n\nGenerate ${count} branched taglines now.` }],
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
    const objectMatches = cleaned.match(/\{\s*"topic"[\s\S]*?\}/g) || [];
    const salvaged = [];
    for (const chunk of objectMatches) {
      try { salvaged.push(JSON.parse(chunk)); } catch (_) { /* incomplete, skip */ }
    }
    if (salvaged.length > 0) return salvaged;
    throw new Error('Could not parse any branched taglines from Claude response');
  }
}

module.exports = { getTrendingSuggestions, generateBranchedTaglines };

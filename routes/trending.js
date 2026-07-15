const axios = require('axios');

const SYSTEM_PROMPT = `You suggest viral short-form video topics for a meme-video channel that turns
Twitch/streamer clips into TikTok/Reels/Shorts. Style: "operatic reaction meets petty modern stakes" —
high-drama visuals paired with absurdly low-stakes captions. Broad, relatable humor, not niche.

Search the web for what's trending RIGHT NOW in gaming, Twitch, streamer drama, and general meme
culture (last few days). Then propose 8 short video concepts.

Respond ONLY with a raw JSON array, no markdown fences, no preamble. Each item:
{ "topic": "3-6 word trending topic", "tagline": "a punchy 1-sentence prompt ready to paste into a meme video generator" }`;

async function getTrendingSuggestions() {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Give me 8 trending video ideas for right now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );

  const textBlock = res.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const cleaned = textBlock.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Claude sometimes wraps JSON with a sentence despite instructions — try to salvage it.
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse trending suggestions: ' + cleaned.slice(0, 200));
  }
}

module.exports = { getTrendingSuggestions };

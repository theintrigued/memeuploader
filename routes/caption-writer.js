const axios = require('axios');

// Used only on the deliberate-template-match path, where we bypass Insider
// Memes' /v1/generate/ entirely (and its built-in caption AI along with it)
// — so something has to write the actual on-screen line ourselves.
async function writeCaptionForTemplate(tagline, templateDescription) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 60,
      system: `You write short on-screen captions for meme videos. Given a real-life situation and a
description of the video template it'll be overlaid on, write ONE punchy caption line (under 10 words)
that fits both. Respond with ONLY the caption text, no quotes, no preamble.`,
      messages: [{ role: 'user', content: `Situation: "${tagline}"\nVideo template shows: ${templateDescription}` }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  return res.data.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim().replace(/^"|"$/g, '');
}

module.exports = { writeCaptionForTemplate };

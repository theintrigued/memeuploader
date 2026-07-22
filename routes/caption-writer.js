const axios = require('axios');

// Used on the template-match path, where we bypass Insider Memes' own
// caption AI entirely — so something has to write the actual on-screen line.
// Grounded in how real memes are actually captioned (not a description of
// the situation, but one of a handful of recognizable formats):
//   - "POV: <you're in this exact situation>"
//   - "me when <thing happens>"
//   - "nobody:\nme:" (setup/punchline two-liner)
//   - "day <n> of <ongoing thing>"
//   - "that one friend who <specific behavior>"
//   - "the way I <reaction>" / "me realizing <thing>"
// These work because they're SHORT, FIRST-PERSON OR DIRECT-ADDRESS, and land
// on one specific absurd/relatable beat — not a narrated description.
const SYSTEM_PROMPT = `You write on-screen captions for meme videos, in the actual style real memes use online —
not a description of what's happening, a proper meme caption.

Real meme captions almost always use one of these recognizable formats:
- "POV: <you're in this exact situation>" — e.g. "POV: you said you'd sleep at 10pm"
- "me when <thing happens>" — e.g. "me when the wifi buffers for one second"
- "nobody:\\nme:" — a two-line setup/punchline where the punchline is the absurd reaction
- "day <n> of <ongoing thing>" — e.g. "day 47 of waiting for payday"
- "that one friend who <specific behavior>"
- "the way I <reaction>" / "me realizing <thing>"

Rules:
- Pick whichever format best fits the situation given — don't force POV if "me when" lands better.
- Stay under 10 words (two lines max if using the nobody/me format).
- Be SPECIFIC and a little absurd, not a flat restatement of the situation. "POV: stuck in traffic"
  is weak. "POV: the GPS says 4 more minutes for the last 20 minutes" is a real caption.
- No hashtags, no emoji, no quotation marks around the output.
- Respond with ONLY the caption text, nothing else.`;

async function writeCaptionForTemplate(tagline, templateDescription) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 60,
      system: SYSTEM_PROMPT,
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

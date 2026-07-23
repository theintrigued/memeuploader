const axios = require('axios');
const { pickNextFormat, recordFormatUsed } = require('./caption-format-store');

// Used on the template-match path, where we bypass Insider Memes' own
// caption AI entirely — so something has to write the actual on-screen line.
//
// The format (POV / me when / nobody-me / etc.) is chosen deterministically
// by pickNextFormat() BEFORE calling Claude, rotating away from whatever was
// used most recently — this is what actually guarantees variety across
// posts, rather than leaving format choice up to the model each time (which
// in practice tended to default to the same one or two formats repeatedly).
function buildSystemPrompt(format) {
  return `You write ONE on-screen caption for a meme video, in the actual style real memes use online —
not a description of what's happening, a proper meme caption.

${format.instruction}

Rules:
- Stay under 10 words (two lines max if using the nobody/me format).
- Be SPECIFIC and a little absurd, not a flat restatement of the situation. "POV: stuck in traffic"
  is weak. "POV: the GPS says 4 more minutes for the last 20 minutes" is a real caption.
- No hashtags, no emoji, no quotation marks around the output.
- Respond with ONLY the caption text, nothing else.`;
}

async function writeCaptionForTemplate(tagline, templateDescription) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const format = await pickNextFormat();

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 60,
      system: buildSystemPrompt(format),
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
  const caption = res.data.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim().replace(/^"|"$/g, '');

  // Record after a successful generation, not before — a failed call shouldn't
  // count as having "used" that format.
  recordFormatUsed(format.id).catch(() => {}); // best-effort, never block on this

  return caption;
}

module.exports = { writeCaptionForTemplate };

const axios = require('axios');
const { getRecentFormats, recordFormatUsed, FORMATS } = require('./caption-format-store');

// Used on the template-match path, where we bypass Insider Memes' own
// caption AI entirely — so something has to write the actual on-screen line.
//
// IMPORTANT: format is NOT force-assigned. Earlier this locked each caption
// to one specific structure (POV / me-when / etc.), which made things feel
// same-y AND produced overly terse, confusing captions when a situation got
// squeezed into a structure that didn't actually fit it well. Now the
// formats are shown as loose inspiration, Claude picks or invents freely,
// and recently-used structures are shown only as a soft "maybe try something
// different" nudge — never a requirement.
function buildSystemPrompt(recentFormatIds) {
  const recentLabels = recentFormatIds
    .map((id) => FORMATS.find((f) => f.id === id)?.label)
    .filter(Boolean)
    .slice(0, 3);
  const varietyNote = recentLabels.length > 0
    ? `\nRecently used structures (for awareness only, not a rule): ${recentLabels.join(', ')}. If one of those happens to be the best fit here, use it anyway — clarity and funniness always win over forcing variety.`
    : '';

  const inspirationList = FORMATS.map((f) => `- ${f.label}: e.g. ${f.example}`).join('\n');

  return `You write ONE on-screen caption for a meme video, in the actual style real memes use online.

YOUR ONLY REAL JOB: make it as funny as possible AND make sure a total stranger scrolling past,
with zero context, immediately understands what's happening and why it's funny. If you have to
choose between being clever/terse and being clear, choose clear — a joke nobody understands isn't
a joke.

Concrete example of the failure mode to avoid: "POV: the site says 12:00 PM and it's 12:01" — a
real viewer has no idea what site, what happens at 12:01, or why that's funny. It's too compressed
to land. A fixed version would spell out the actual stakes, e.g. "POV: you refreshed at 12:00:01 and
the concert tickets were already sold out" — same joke, but a stranger gets it instantly.

Some structures that tend to work well (pick whichever fits best, or invent your own — you are not
limited to this list, and a fresh structure is often funnier than a familiar one):
${inspirationList}
${varietyNote}

Rules:
- Typically 6-16 words. Use as many as you actually need to make the situation and punchline
  land clearly — don't pad, but don't sacrifice clarity to hit a word count either.
- Be SPECIFIC. Name the concrete detail that makes it funny, not a vague gesture at the situation.
- No hashtags, no emoji, no quotation marks around the output.
- Respond with ONLY the caption text, nothing else.`;
}

async function writeCaptionForTemplate(tagline, templateDescription) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  let recentFormats = [];
  try {
    recentFormats = await getRecentFormats();
  } catch (err) {
    // Upstash unreachable — proceed without the variety nudge rather than failing
  }

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 100,
      system: buildSystemPrompt(recentFormats),
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

  // Best-effort guess at which structure it used, purely so the next call's
  // "recently used" nudge has something to work with — not used to enforce
  // anything, so a wrong guess here is harmless.
  const guessedFormat = FORMATS.find((f) => caption.toLowerCase().startsWith(f.label.split(' ')[0].toLowerCase()));
  if (guessedFormat) recordFormatUsed(guessedFormat.id).catch(() => {});

  return caption;
}

module.exports = { writeCaptionForTemplate };

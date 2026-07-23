const axios = require('axios');
const { getRecentFormats, recordFormatUsed, FORMATS } = require('./caption-format-store');
const { getPerformanceSummary } = require('./analytics-feedback');
const log = require('./logger');

// Comedy craft grounded in actual technique, not vibes — see the four
// principles below. This is also the practical answer to "how do you train
// Claude to write better memes": you can't fine-tune it here, so the real
// lever is (a) a strong technique guide baked into the prompt, and (b) real
// in-context examples — ideally OUR OWN actual top performers, which is what
// the "proven winners" section below does when performance data exists.
const CRAFT_GUIDE = `Comedy craft — use these, don't just state the situation:
- SPECIFICITY beats vagueness. "The number seven is funnier than 'too many'." A precise, weirdly
  specific detail is funnier than a general one. "12 unread texts" beats "a lot of texts."
- EXAGGERATION must be grounded in a real, recognizable truth — heighten an emotional reality to
  absurd proportions, don't just be random. The audience should think "that's not literally true,
  but it's exactly how it FEELS."
- CONTRAST works both directions: overstatement (ordinary situation -> blown wildly out of
  proportion) AND understatement (extraordinary/dramatic situation -> downplayed flatly). Both are
  funny; pick whichever fits the template's energy better.
- SURPRISE/misdirection — the funniest captions have a small twist or a turn the reader doesn't
  see coming until the last few words, not a flat description read top to bottom.`;

const EXAMPLE_CAPTIONS = [
  '"POV: you said \'one more episode\' four hours ago" (specific number, relatable exaggeration)',
  '"me explaining to HR why I have 6 tabs open titled \'is this normal\'" (gratuitous specificity)',
  '"the group chat went from planning a trip to fighting about a group chat" (surprise/escalation twist)',
  '"my bank account after one (1) DoorDash order" (understatement of dramatic financial reality)',
];

function buildSystemPrompt(recentFormatIds, provenWinners) {
  const recentLabels = recentFormatIds
    .map((id) => FORMATS.find((f) => f.id === id)?.label)
    .filter(Boolean)
    .slice(0, 3);
  const varietyNote = recentLabels.length > 0
    ? `\nRecently used structures (for awareness only, not a rule): ${recentLabels.join(', ')}. If one of those happens to be the best fit here, use it anyway — clarity and funniness always win over forcing variety.`
    : '';

  const inspirationList = FORMATS.map((f) => `- ${f.label}: e.g. ${f.example}`).join('\n');

  const provenSection = provenWinners && provenWinners.length > 0
    ? `\nWhat's actually performed well on THIS channel recently (real captions, best engagement first —
lean into whatever pattern you notice here, this is real audience data, not a guess):
${provenWinners.map((w) => `- "${w.caption.slice(0, 100)}"`).join('\n')}`
    : '';

  return `You write ONE on-screen caption for a meme video, in the actual style real memes use online.

YOUR ONLY REAL JOB: make it as funny as possible AND make sure a total stranger scrolling past,
with zero context, immediately understands what's happening and why it's funny. If you have to
choose between being clever/terse and being clear, choose clear — a joke nobody understands isn't
a joke.

Concrete example of the failure mode to avoid: "POV: the site says 12:00 PM and it's 12:01" — a
real viewer has no idea what site, what happens at 12:01, or why that's funny. It's too compressed
to land. A fixed version would spell out the actual stakes, e.g. "POV: you refreshed at 12:00:01 and
the concert tickets were already sold out" — same joke, but a stranger gets it instantly.

${CRAFT_GUIDE}

Examples that use these techniques well:
${EXAMPLE_CAPTIONS.map((e) => `- ${e}`).join('\n')}

Some structures that tend to work well (pick whichever fits best, or invent your own — you are not
limited to this list, and a fresh structure is often funnier than a familiar one):
${inspirationList}
${varietyNote}
${provenSection}

Rules:
- Typically 6-16 words. Use as many as you actually need to make the situation and punchline
  land clearly — don't pad, but don't sacrifice clarity to hit a word count either.
- Be SPECIFIC. Name the concrete detail that makes it funny, not a vague gesture at the situation.
- No hashtags, no emoji, no quotation marks around the output.
- Respond with ONLY the caption text, nothing else.`;
}

async function writeCaptionForTemplate(tagline, templateDescription) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const [recentFormats, provenWinners] = await Promise.all([
    getRecentFormats().catch(() => []),
    getPerformanceSummary().catch((err) => {
      log.warn('caption-writer', `Could not load performance data, proceeding without it: ${err.message}`);
      return null;
    }),
  ]);

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 100,
      system: buildSystemPrompt(recentFormats, provenWinners?.slice(0, 3)),
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

  const guessedFormat = FORMATS.find((f) => caption.toLowerCase().startsWith(f.label.split(' ')[0].toLowerCase()));
  if (guessedFormat) recordFormatUsed(guessedFormat.id).catch(() => {});

  return caption;
}

module.exports = { writeCaptionForTemplate };

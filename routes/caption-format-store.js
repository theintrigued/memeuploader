const { getJSON, setJSON } = require('./upstash-client');

const KEY = 'clipvault_recent_caption_formats';
const HISTORY_LENGTH = 12; // how many recent picks we remember
const AVOID_LAST_N = 2;    // how many of the most recent picks are excluded from the next pick

const FORMATS = [
  {
    id: 'pov',
    label: 'POV',
    instruction: `Use the format "POV: <you're in this exact situation>". Example: "POV: you said you'd sleep at 10pm"`,
  },
  {
    id: 'me-when',
    label: 'me when',
    instruction: `Use the format "me when <thing happens>". Example: "me when the wifi buffers for one second"`,
  },
  {
    id: 'nobody-me',
    label: 'nobody: / me:',
    instruction: `Use the two-line setup/punchline format "nobody:\\nme:" where the punchline is the absurd reaction.`,
  },
  {
    id: 'day-n',
    label: 'day N of',
    instruction: `Use the format "day <n> of <ongoing thing>". Example: "day 47 of waiting for payday"`,
  },
  {
    id: 'that-friend',
    label: 'that one friend who',
    instruction: `Use the format "that one friend who <specific behavior>".`,
  },
  {
    id: 'the-way',
    label: 'the way I / me realizing',
    instruction: `Use the format "the way I <reaction>" or "me realizing <thing>".`,
  },
];

async function getRecentFormats() {
  return getJSON(KEY, []);
}

async function recordFormatUsed(id) {
  const history = await getRecentFormats();
  const updated = [id, ...history].slice(0, HISTORY_LENGTH);
  await setJSON(KEY, updated);
}

// Picks a format for the next caption, deterministically avoiding whichever
// formats were used most recently — this is what actually guarantees
// rotation, rather than just asking Claude to "pick something different"
// and hoping it doesn't default to the same one every time.
async function pickNextFormat() {
  let recent = [];
  try {
    recent = await getRecentFormats();
  } catch (err) {
    // Upstash unreachable — fall back to a fully random pick rather than failing
  }
  const avoidIds = new Set(recent.slice(0, AVOID_LAST_N));
  let candidates = FORMATS.filter((f) => !avoidIds.has(f.id));
  if (candidates.length === 0) candidates = FORMATS; // safety net, shouldn't normally happen
  return candidates[Math.floor(Math.random() * candidates.length)];
}

module.exports = { pickNextFormat, recordFormatUsed, getRecentFormats, FORMATS };

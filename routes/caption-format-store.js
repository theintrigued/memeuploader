const { getJSON, setJSON } = require('./upstash-client');

const KEY = 'clipvault_recent_caption_formats';
const HISTORY_LENGTH = 12;

// These are INSPIRATION, not a menu to force-select from — caption-writer.js
// shows them as examples of structures that work, but explicitly tells
// Claude it can invent something else entirely if it's funnier or clearer.
// Kept intentionally broader than a strict rotation list.
const FORMATS = [
  { id: 'pov', label: 'POV', example: `"POV: you said you'd sleep at 10pm"` },
  { id: 'me-when', label: 'me when', example: `"me when the wifi buffers for one second"` },
  { id: 'nobody-me', label: 'nobody: / me:', example: `two-line setup/punchline, "nobody:\\nme:"` },
  { id: 'day-n', label: 'day N of', example: `"day 47 of waiting for payday"` },
  { id: 'that-friend', label: 'that one friend who', example: `"that one friend who confirms plans then goes silent"` },
  { id: 'the-way', label: 'the way I / me realizing', example: `"the way I sprinted when I heard my name in a meeting"` },
  { id: 'comparison', label: 'X vs Y comparison', example: `"what I ordered vs what I got"` },
  { id: 'direct-quote', label: 'dialogue/quote style', example: `caption written as something someone actually said out loud`  },
  { id: 'audacity', label: 'the audacity of', example: `"the audacity of my alarm going off like I asked"` },
  { id: 'no-context', label: 'blunt, no setup', example: `just states the absurd fact/situation directly, no "POV" or "me when" framing at all` },
];

async function getRecentFormats() {
  return getJSON(KEY, []);
}

async function recordFormatUsed(id) {
  if (!id) return;
  const history = await getRecentFormats();
  const updated = [id, ...history].slice(0, HISTORY_LENGTH);
  await setJSON(KEY, updated);
}

module.exports = { getRecentFormats, recordFormatUsed, FORMATS };

const log = require('./logger');

// DISABLED FOR NOW — we don't currently have a working way to pull real
// engagement analytics from our social platforms. What was here before
// (reading metrics off ShortSync's GET /posts) didn't work: verified against
// a real API response that ShortSync's API returns no views/likes/comments
// fields at all — their analytics are dashboard-only. Rather than fake data
// or half-wire a partial YouTube-only version, this is switched off cleanly
// until there's an actual source of real numbers to use.
//
// Both callers (caption-writer.js's "proven winners" section, and
// autopilot.js's end-of-day analysis) already handle a null result
// gracefully — they just skip the performance-based guidance when this
// returns null, same as before analytics existed at all.
async function getPerformanceSummary() {
  return null;
}

module.exports = { getPerformanceSummary };

const axios = require('axios');
const { extractFrame, downloadToTemp, cleanupFile, getDurationSeconds } = require('./video-processing');
const { getManifest, setManifest, appendToCompactList } = require('./template-store');
const log = require('./logger');

const BASE = 'https://backend.insidermemes.com/v1';
const BATCH_SIZE = Number(process.env.TEMPLATE_INDEX_BATCH_SIZE) || 10;

// Duration scoring is grounded in short-form retention research (2026 data):
// completion rate drops sharply as length increases past the first ~15-20s,
// and the algorithm's own distribution decision is driven mostly by
// completion rate. Sub-15s clips see ~92% avg completion, 16-30s ~84%,
// 31-60s drops to ~68%. So shorter templates score higher, with a floor for
// clips too short to land a beat (under ~2s can't deliver a hook + payoff).
function scoreDuration(seconds) {
  if (!seconds || seconds < 2) return 20; // too short to land anything
  if (seconds <= 15) return 100;
  if (seconds <= 30) return 85;
  if (seconds <= 60) return 65;
  if (seconds <= 90) return 45;
  return 25;
}

function authHeaders() {
  return { Authorization: `Token ${process.env.INSIDERMEMES_API_TOKEN}` };
}

async function fetchTemplatePage(cursor) {
  const params = { limit: BATCH_SIZE };
  if (cursor) params.cursor = cursor;
  const res = await axios.get(`${BASE}/templates/`, { headers: authHeaders(), params, timeout: 30000 });
  return res.data; // { data: [...], nextCursor }
}

// Single vision call gathers everything we can actually assess from one
// representative frame: what's happening (for matching), the primary
// emotion shown, whether it reads as scripted/movie-or-show footage vs
// candid/other, and a hook-strength read (does this frame alone read as an
// exaggerated, attention-grabbing beat, or a flat/neutral one). Duration and
// its retention-fit score are computed separately via ffprobe — that part
// needs no vision call, it's just measured.
const ANALYSIS_PROMPT = `Look at this meme template frame and respond with ONLY a raw JSON object, no markdown fences,
no preamble, in exactly this shape:
{
  "description": "under 20 words — the situation/emotion depicted, for matching against future captions",
  "emotion": "one or two words — the primary emotion visible (e.g. shock, joy, anger, disgust, smirk/sarcasm, confusion, deadpan, fear, excitement)",
  "sourceType": "movie", "tv", "influencer/candid", "news/broadcast", "animation", or "other" — best guess at where this footage is from,
  "hookStrength": an integer 0-100 — how much does THIS FRAME ALONE grab attention on first glance? Exaggerated
    facial expression, clear single focal point, and visual intensity score high. A flat, neutral, or
    cluttered/ambiguous frame scores low. Base this only on what a viewer would perceive in the first
    fraction of a second, not on the situation's inherent humor.
}`;

async function analyzeWithClaude(imageBase64, mediaType) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: ANALYSIS_PROMPT },
          ],
        },
      ],
    },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  const text = res.data.content.find((b) => b.type === 'text')?.text?.trim() || '{}';
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) { /* fall through */ }
    }
    log.warn('template-indexer', `Could not parse analysis JSON, using description-only fallback: ${cleaned.slice(0, 150)}`);
    return { description: cleaned.slice(0, 150), emotion: null, sourceType: null, hookStrength: 50 };
  }
}

async function analyzeTemplate(template) {
  if (template.type === 'image') {
    const imgRes = await axios.get(template.imageUrl || template.thumbnailUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const base64 = Buffer.from(imgRes.data).toString('base64');
    const mediaType = (imgRes.headers['content-type'] || 'image/jpeg').split(';')[0];
    const analysis = await analyzeWithClaude(base64, mediaType);
    return { ...analysis, durationSeconds: null, durationScore: null }; // images have no duration
  }

  // video template — download briefly, measure duration, pull one frame, analyze that
  const inputPath = await downloadToTemp(template.previewUrl);
  try {
    const [durationSeconds, framePath] = await Promise.all([
      getDurationSeconds(inputPath),
      extractFrame(inputPath, 1),
    ]);
    try {
      const buf = require('fs').readFileSync(framePath);
      const analysis = await analyzeWithClaude(buf.toString('base64'), 'image/jpeg');
      return { ...analysis, durationSeconds, durationScore: scoreDuration(durationSeconds) };
    } finally {
      cleanupFile(framePath);
    }
  } finally {
    cleanupFile(inputPath);
  }
}

// Overall attention-retention score: blends hook strength (grabs attention
// in the first instant) with duration fit (completion-rate research). For
// images, duration doesn't apply, so hook strength alone determines the score.
function computeAttentionScore({ hookStrength, durationScore }) {
  const hook = Number.isFinite(hookStrength) ? hookStrength : 50;
  if (durationScore === null || durationScore === undefined) return Math.round(hook);
  return Math.round(hook * 0.65 + durationScore * 0.35);
}

// Indexes up to BATCH_SIZE templates per call, resuming from the stored
// cursor. Meant to be called on every /cron/tick — spreads the one-time cost
// of indexing ~2000 templates across many small ticks instead of one huge job.
async function indexNextBatch() {
  const manifest = await getManifest();
  if (manifest.done) return { done: true, indexedThisBatch: 0, totalIndexed: manifest.indexedCount };

  let page;
  try {
    page = await fetchTemplatePage(manifest.cursor);
  } catch (err) {
    log.warn('template-indexer', `Could not fetch template page: ${err.message}`);
    return { done: false, error: err.message, indexedThisBatch: 0, totalIndexed: manifest.indexedCount };
  }

  const templates = page.data || [];
  const compactRecords = [];
  let indexed = 0;

  for (const t of templates) {
    try {
      const analysis = await analyzeTemplate(t);
      const attentionScore = computeAttentionScore(analysis);
      const record = {
        id: t.id,
        type: t.type,
        categories: t.categories || [],
        mediaUrl: t.type === 'video' ? t.previewUrl : t.imageUrl,
        description: analysis.description || '',
        emotion: analysis.emotion || null,
        sourceType: analysis.sourceType || null,
        durationSeconds: analysis.durationSeconds ?? null,
        attentionScore,
      };
      compactRecords.push(record);
      indexed++;
    } catch (err) {
      log.warn('template-indexer', `Failed to analyze template ${t.id}: ${err.message}`);
    }
  }

  if (compactRecords.length > 0) await appendToCompactList(compactRecords);

  const nextManifest = {
    cursor: page.nextCursor || null,
    indexedCount: manifest.indexedCount + indexed,
    total: manifest.total,
    done: !page.nextCursor,
    lastRunAt: Date.now(),
  };
  await setManifest(nextManifest);

  log.info('template-indexer', `Indexed ${indexed} template(s), ${nextManifest.indexedCount} total, done=${nextManifest.done}`);
  return { done: nextManifest.done, indexedThisBatch: indexed, totalIndexed: nextManifest.indexedCount };
}

module.exports = { indexNextBatch, computeAttentionScore, scoreDuration };

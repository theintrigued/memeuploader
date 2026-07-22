const axios = require('axios');
const { extractFrame, downloadToTemp, cleanupFile } = require('./video-processing');
const { getManifest, setManifest, appendToCompactList, setTemplateDetail } = require('./template-store');
const log = require('./logger');

const BASE = 'https://backend.insidermemes.com/v1';
const BATCH_SIZE = Number(process.env.TEMPLATE_INDEX_BATCH_SIZE) || 10;

function authHeaders() {
  return { Authorization: `Token ${process.env.INSIDERMEMES_API_TOKEN}` };
}

async function fetchTemplatePage(cursor) {
  const params = { limit: BATCH_SIZE };
  if (cursor) params.cursor = cursor;
  const res = await axios.get(`${BASE}/templates/`, { headers: authHeaders(), params, timeout: 30000 });
  return res.data; // { data: [...], nextCursor }
}

async function describeWithClaude(imageBase64, mediaType) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: 'Describe what is happening in this meme template in under 20 words. Focus on the emotion/situation depicted, not the exact image details. No preamble, just the description.' },
          ],
        },
      ],
    },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return res.data.content.find((b) => b.type === 'text')?.text?.trim() || '';
}

async function describeTemplate(template) {
  if (template.type === 'image') {
    const imgRes = await axios.get(template.imageUrl || template.thumbnailUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const base64 = Buffer.from(imgRes.data).toString('base64');
    const mediaType = (imgRes.headers['content-type'] || 'image/jpeg').split(';')[0];
    return describeWithClaude(base64, mediaType);
  }

  // video template — download briefly, pull one frame, describe that
  const inputPath = await downloadToTemp(template.previewUrl);
  try {
    const framePath = await extractFrame(inputPath, 1);
    try {
      const buf = require('fs').readFileSync(framePath);
      return await describeWithClaude(buf.toString('base64'), 'image/jpeg');
    } finally {
      cleanupFile(framePath);
    }
  } finally {
    cleanupFile(inputPath);
  }
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
      const description = await describeTemplate(t);
      const record = {
        id: t.id,
        name: t.name,
        type: t.type,
        categories: t.categories || [],
        mediaUrl: t.type === 'video' ? t.previewUrl : t.imageUrl,
        description,
        indexedAt: Date.now(),
      };
      await setTemplateDetail(t.id, record);
      compactRecords.push({ id: t.id, type: t.type, categories: t.categories || [], description, mediaUrl: record.mediaUrl });
      indexed++;
    } catch (err) {
      log.warn('template-indexer', `Failed to describe template ${t.id}: ${err.message}`);
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

module.exports = { indexNextBatch };

require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const log = require('./routes/logger');
const { checkEnv } = require('./routes/env-check');
const { getTrendingSuggestions } = require('./routes/trending');
const { getPromptsList, addPrompts, markPromptUsed, pickOldestUnused, pickOldestUnusedBatch, countUnused } = require('./routes/prompt-store');
const { newJob, getJob } = require('./routes/job-store');
const { runVideoJob } = require('./routes/generate-and-post');
const { tick } = require('./routes/autopilot');
const { indexNextBatch } = require('./routes/template-indexer');
const { getManifest, setManifest, getCompactList, getRandomVideoTemplate } = require('./routes/template-store');
const { FONTS, downloadToTemp, burnTextOverlay, cleanupFile, PROCESSED_DIR } = require('./routes/video-processing');
const { getDefaults: getTemplateMatchDefaults, setDefaults: setTemplateMatchDefaults } = require('./routes/template-match-settings');
const { getState: getAutopilotState, getEnabled: getAutopilotEnabled, setEnabled: setAutopilotEnabled, getLearnings: getAutopilotLearnings } = require('./routes/autopilot-store');

// Crash guards: log and keep running instead of the process dying silently
// mid-job (which is exactly what made a previous TikTok upload look like it
// vanished — a restart killed the in-memory job with no trace).
process.on('unhandledRejection', (err) => log.error('process', 'Unhandled rejection:', err));
process.on('uncaughtException', (err) => log.error('process', 'Uncaught exception:', err));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets/fonts', express.static(path.join(__dirname, 'assets', 'fonts')));
app.use(require('./routes/tiktok-oauth'));

const MAX_PROMPT_LEN = 500;

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireSecret(req, res) {
  const provided = req.body?.secret ?? req.query?.secret;
  if (!process.env.APP_SECRET || !timingSafeEqual(provided, process.env.APP_SECRET)) {
    res.status(401).json({ error: 'Bad secret' });
    return false;
  }
  return true;
}

function resolveTextOptions(rawOpts, saved) {
  const font = Object.keys(FONTS).includes(rawOpts.font) ? rawOpts.font : (saved?.font || 'poppins');

  const clampOr = (raw, min, max, fallback) => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const fontSize = Math.round(clampOr(rawOpts.fontSize, 20, 160, saved?.fontSize ?? 74));
  const x = clampOr(rawOpts.x, 0, 100, saved?.x ?? 50);
  const y = clampOr(rawOpts.y, 0, 100, saved?.y ?? 12);
  const width = clampOr(rawOpts.width, 10, 100, saved?.width ?? 96);
  const videoHeight = clampOr(rawOpts.videoHeight, 10, 100, saved?.videoHeight ?? 72);
  const videoAnchor = ['top', 'center', 'bottom'].includes(rawOpts.videoAnchor) ? rawOpts.videoAnchor : (saved?.videoAnchor || 'bottom');
  return { font, fontSize, x, y, width, videoHeight, videoAnchor };
}

async function validatedCreateParams(body) {
  const prompt = (body.prompt || '').trim();
  if (!prompt) throw { status: 400, message: 'prompt is required' };
  if (prompt.length > MAX_PROMPT_LEN) throw { status: 400, message: `prompt too long (max ${MAX_PROMPT_LEN} chars)` };

  const description = (body.description || '').trim();
  const hashtags = (body.hashtags || '').trim();
  const mediaType = ['videos', 'images', 'all'].includes(body.mediaType) ? body.mediaType : 'videos';
  let count = parseInt(body.count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 12) count = 1;

  const { platforms, missing } = checkEnv();
  if (platforms.length > 0 && missing.length > 0) {
    throw { status: 500, message: `Server is misconfigured — missing env vars: ${missing.join(', ')}` };
  }

  const useTemplateIndex = !!body.useTemplateIndex;
  let textOptions = {};
  if (useTemplateIndex) {
    const saved = await getTemplateMatchDefaults().catch(() => null);
    textOptions = resolveTextOptions(body.textOptions || {}, saved);
  }

  const customCaption = useTemplateIndex ? (body.customCaption || '').trim().slice(0, 120) || null : null;

  return { prompt, description, hashtags, mediaType, count, platforms, useTemplateIndex, textOptions, customCaption };
}

app.post('/create', async (req, res) => {
  if (!requireSecret(req, res)) return;

  let params;
  try {
    params = await validatedCreateParams(req.body);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const job = newJob('manual');
  res.json({ jobId: job.id }); // respond immediately, background work continues after

  const promptId = req.body.promptId;
  if (promptId) {
    markPromptUsed(promptId).catch((err) => log.warn('create', `Could not mark prompt ${promptId} used: ${err.message}`));
  }

  runVideoJob(job, params).catch((err) => {
    job.status = 'error';
    job.error = err.message;
    log.error('create', `Job ${job.id} failed fatally:`, err.message);
  });
});

// Template-match mode's main flow: consumes N unused saved prompts (instead
// of typing one prompt), one video per prompt, all in one job.
app.post('/create-from-saved', async (req, res) => {
  if (!requireSecret(req, res)) return;

  let count = parseInt(req.body.promptCount, 10);
  if (!Number.isInteger(count) || count < 1) count = 1;
  if (count > 20) count = 20;

  const { platforms, missing } = checkEnv();
  if (platforms.length > 0 && missing.length > 0) {
    return res.status(500).json({ error: `Server is misconfigured — missing env vars: ${missing.join(', ')}` });
  }

  let picked;
  try {
    picked = await pickOldestUnusedBatch(count);
  } catch (err) {
    return res.status(500).json({ error: `Could not read saved prompts: ${err.message}` });
  }
  if (picked.length === 0) {
    return res.status(400).json({ error: 'please generate more prompts to continue' });
  }

  const saved = await getTemplateMatchDefaults().catch(() => null);
  const textOptions = resolveTextOptions(req.body.textOptions || {}, saved);
  const customCaption = (req.body.customCaption || '').trim().slice(0, 120) || null;

  const job = newJob('manual');
  res.json({ jobId: job.id, promptsUsed: picked.map((p) => ({ topic: p.topic, tagline: p.tagline })) });

  for (const p of picked) {
    markPromptUsed(p.id).catch((err) => log.warn('create-from-saved', `Could not mark prompt ${p.id} used: ${err.message}`));
  }

  runVideoJob(job, {
    prompts: picked.map((p) => ({ id: p.id, tagline: p.tagline })),
    useTemplateIndex: true,
    textOptions,
    customCaption,
    platforms,
  }).catch((err) => {
    job.status = 'error';
    job.error = err.message;
    log.error('create-from-saved', `Job ${job.id} failed fatally:`, err.message);
  });
});

// Picks the oldest unused saved prompt and immediately generates+posts from
// it — the "surprise me" button, no browsing required.
app.post('/auto-pick', async (req, res) => {
  if (!requireSecret(req, res)) return;

  let picked;
  try {
    picked = await pickOldestUnused();
  } catch (err) {
    return res.status(500).json({ error: `Could not read saved prompts: ${err.message}` });
  }
  if (!picked) return res.status(404).json({ error: 'No unused saved prompts — generate some first' });

  let params;
  try {
    params = await validatedCreateParams({ prompt: picked.tagline });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const job = newJob('manual');
  res.json({ jobId: job.id, picked: { topic: picked.topic, tagline: picked.tagline } });

  markPromptUsed(picked.id).catch((err) => log.warn('auto-pick', `Could not mark prompt used: ${err.message}`));

  runVideoJob(job, params).catch((err) => {
    job.status = 'error';
    job.error = err.message;
    log.error('auto-pick', `Job ${job.id} failed fatally:`, err.message);
  });
});

app.get('/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job — server may have restarted, or the job expired after 2 hours' });
  res.json(job);
});

app.get('/trending', async (req, res) => {
  if (!requireSecret(req, res)) return;
  const mode = req.query.mode === 'relatable' ? 'relatable' : 'viral';
  try {
    const suggestions = await getTrendingSuggestions(mode);
    let responseSuggestions = suggestions;
    let persisted = false;
    try {
      const stored = await addPrompts(suggestions, mode);
      const newTaglines = new Set(suggestions.map((s) => s.tagline.toLowerCase().trim()));
      responseSuggestions = stored.filter((p) => newTaglines.has(p.tagline.toLowerCase().trim()));
      persisted = true;
    } catch (err) {
      log.warn('trending', `Generated suggestions but could not persist them: ${err.message}`);
    }
    res.json({ suggestions: responseSuggestions, mode, persisted });
  } catch (err) {
    log.error('trending', `Failed (mode=${mode}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/prompts', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const prompts = await getPromptsList();
    res.json({ prompts });
  } catch (err) {
    log.error('prompts', 'Failed to load stored prompts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hit by an external scheduler (e.g. cron-job.org) every few minutes. Cheap
// no-op most of the time — only does real work at a day boundary or when a
// scheduled post's time has arrived. Also keeps the Render free instance
// awake, which autonomous posting requires.
app.get('/prompts/unused-count', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    res.json({ count: await countUnused() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/cron/tick', async (req, res) => {
  if (!requireSecret(req, res)) return;
  const result = { autopilot: null, templateIndexing: null };
  try {
    result.autopilot = await tick();
  } catch (err) {
    log.error('cron', 'Autopilot tick failed:', err.message);
    result.autopilot = { error: err.message };
  }
  // Runs regardless of autopilot on/off — building the template library is a
  // background task independent of whether we're actively posting.
  try {
    result.templateIndexing = await indexNextBatch();
  } catch (err) {
    log.warn('cron', 'Template indexing batch failed:', err.message);
    result.templateIndexing = { error: err.message };
  }
  res.json(result);
});

app.get('/admin/template-index-status', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const [manifest, compactList] = await Promise.all([getManifest(), getCompactList()]);
    const withScores = compactList.filter((t) => t.attentionScore !== undefined);

    const trim = (t) => ({
      id: t.id,
      description: t.description,
      emotion: t.emotion ?? null,
      sourceType: t.sourceType ?? null,
      durationSeconds: t.durationSeconds ?? null,
      attentionScore: t.attentionScore ?? null,
    });

    const byScoreDesc = [...withScores].sort((a, b) => (b.attentionScore ?? 0) - (a.attentionScore ?? 0));
    const topScored = byScoreDesc.slice(0, 5).map(trim);
    const bottomScored = byScoreDesc.slice(-5).reverse().map(trim);
    const mostRecent = compactList.slice(-5).reverse().map(trim); // last appended = most recently indexed

    const avgScore = withScores.length > 0
      ? Math.round(withScores.reduce((sum, t) => sum + (t.attentionScore || 0), 0) / withScores.length)
      : null;

    res.json({
      indexedCount: manifest.indexedCount,
      discoveryDone: manifest.done,
      withDescriptions: compactList.length,
      withRichMetadata: withScores.length, // has emotion/sourceType/attentionScore — post-upgrade schema
      averageAttentionScore: avgScore,
      lastRunAt: manifest.lastRunAt,
      sample: { topScored, bottomScored, mostRecent },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restarts indexing from the beginning — existing entries get upgraded in
// place (appendToCompactList upserts by id), not duplicated. Needed once
// after a schema change like adding attentionScore/emotion/sourceType, so
// templates indexed before that change get the new fields too.
app.post('/admin/template-index-reindex', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    await setManifest({ cursor: null, indexedCount: 0, total: null, done: false, lastRunAt: null });
    res.json({ ok: true, note: 'Re-indexing will resume on the next /cron/tick, upgrading existing entries in place.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/autopilot/status', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const [enabled, state, learnings] = await Promise.all([
      getAutopilotEnabled(),
      getAutopilotState(),
      getAutopilotLearnings(),
    ]);
    const remaining = state?.scheduledPosts?.filter((p) => !p.executed) || [];
    const nextPost = remaining.length > 0 ? remaining.reduce((a, b) => (a.time < b.time ? a : b)) : null;
    res.json({
      enabled,
      date: state?.date || null,
      totalScheduledToday: state?.scheduledPosts?.length || 0,
      postedToday: (state?.scheduledPosts?.length || 0) - remaining.length,
      nextPostTime: nextPost?.time || null,
      nextPostTopic: nextPost?.topic || null,
      learnings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/autopilot/toggle', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    await setAutopilotEnabled(!!req.body.enabled);
    log.info('autopilot', `Autopilot ${req.body.enabled ? 'ENABLED' : 'disabled'} via frontend toggle`);
    res.json({ enabled: !!req.body.enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/settings/template-match', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    res.json(await getTemplateMatchDefaults());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/settings/template-match', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const clamp = (raw, min, max) => {
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return null;
      return Math.min(max, Math.max(min, n));
    };
    const partial = {};
    if (Object.keys(FONTS).includes(req.body.font)) partial.font = req.body.font;
    const fontSize = clamp(req.body.fontSize, 20, 160);
    if (fontSize !== null) partial.fontSize = Math.round(fontSize);
    const x = clamp(req.body.x, 0, 100);
    if (x !== null) partial.x = x;
    const y = clamp(req.body.y, 0, 100);
    if (y !== null) partial.y = y;
    const width = clamp(req.body.width, 10, 100);
    if (width !== null) partial.width = width;
    const videoHeight = clamp(req.body.videoHeight, 10, 100);
    if (videoHeight !== null) partial.videoHeight = videoHeight;
    if (['top', 'center', 'bottom'].includes(req.body.videoAnchor)) partial.videoAnchor = req.body.videoAnchor;
    const saved = await setTemplateMatchDefaults(partial);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/processed', express.static(PROCESSED_DIR));

// Renders an actual short ffmpeg output using a random real indexed template
// + your current text settings — an accurate preview of what will actually
// get posted, not a CSS approximation. No Insider Memes credits used.
app.post('/preview-render', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const template = await getRandomVideoTemplate();
    if (!template) {
      return res.status(400).json({ error: 'No indexed templates with descriptions yet — check /admin/template-index-status' });
    }

    const saved = await getTemplateMatchDefaults().catch(() => null);
    const textOptions = resolveTextOptions(req.body.textOptions || {}, saved);
    const text = (req.body.text || '').trim() || 'POV: the GPS says 4 more minutes for 20 minutes';

    const inputPath = await downloadToTemp(template.mediaUrl);
    let outputPath;
    try {
      outputPath = await burnTextOverlay(inputPath, { text, ...textOptions });
    } finally {
      cleanupFile(inputPath);
    }

    const filename = path.basename(outputPath);
    setTimeout(() => cleanupFile(outputPath), 10 * 60 * 1000).unref();
    res.json({ previewUrl: `/processed/${filename}`, templateId: template.id });
  } catch (err) {
    log.error('preview-render', 'Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/fonts', (req, res) => {
  res.json({
    fonts: Object.entries(FONTS).map(([key, v]) => ({
      key,
      label: v.label,
      family: v.family,
      url: `/assets/fonts/${v.file}`,
    })),
  });
});

// Diagnostic endpoint — shows which env vars are present WITHOUT leaking values.
app.get('/health', async (req, res) => {
  const { platforms, missing } = checkEnv();

  const upstashConfigured = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  const anthropicConfigured = !!process.env.ANTHROPIC_API_KEY;

  const subsystems = {
    posting: { ok: missing.length === 0, postTo: platforms, missingEnvVars: missing },
    persistence: {
      ok: upstashConfigured,
      note: upstashConfigured ? 'Upstash configured' : 'UPSTASH_REDIS_REST_URL/TOKEN missing — saved prompts, autopilot state, and template index will not persist across restarts',
    },
    aiFeatures: {
      ok: anthropicConfigured,
      note: anthropicConfigured ? 'Anthropic configured' : 'ANTHROPIC_API_KEY missing — trending suggestions, template matching, and meme caption writing are unavailable',
    },
  };

  if (upstashConfigured) {
    try {
      const [autopilotEnabled, templateStatus, unusedPrompts] = await Promise.all([
        getAutopilotEnabled(),
        getManifest(),
        countUnused(),
      ]);
      subsystems.autopilot = { enabled: autopilotEnabled };
      subsystems.templateIndex = { indexedCount: templateStatus.indexedCount, discoveryDone: templateStatus.done };
      subsystems.savedPrompts = { unused: unusedPrompts };
    } catch (err) {
      subsystems.persistence.ok = false;
      subsystems.persistence.note = `Upstash configured but unreachable: ${err.message}`;
    }
  }

  const overallOk = Object.values(subsystems).every((s) => s.ok !== false);
  res.json({ ok: overallOk, uptimeSeconds: Math.round(process.uptime()), ...subsystems });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  log.info('startup', `ClipVault poster listening on :${port}`);
  checkEnv();
});

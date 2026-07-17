require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const log = require('./routes/logger');
const { checkEnv } = require('./routes/env-check');
const { generateVideoMemes } = require('./routes/memes');
const { getTrendingSuggestions } = require('./routes/trending');
const { postToAllPlatforms } = require('./routes/platforms/shortsync');
const { postToTikTok } = require('./routes/platforms/tiktok');

// Crash guards: log and keep running instead of the process dying silently
// mid-job (which is exactly what made a previous TikTok upload look like it
// vanished — a restart killed the in-memory job with no trace).
process.on('unhandledRejection', (err) => log.error('process', 'Unhandled rejection:', err));
process.on('uncaughtException', (err) => log.error('process', 'Uncaught exception:', err));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(require('./routes/tiktok-oauth'));

const DEFAULT_HASHTAGS = '#fyp #comedy #memes #viral #funny';
const MAX_PROMPT_LEN = 500;
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — old jobs get swept to avoid an unbounded memory leak

const jobs = {};

function sweepOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of Object.entries(jobs)) {
    if (job.createdAt < cutoff) delete jobs[id];
  }
}
setInterval(sweepOldJobs, 30 * 60 * 1000).unref();

function newJob() {
  const id = crypto.randomUUID();
  jobs[id] = {
    id,
    createdAt: Date.now(),
    status: 'starting', // starting | generating | posting | done | error
    step: 'Generating video(s)...',
    totalSteps: 1,
    completedSteps: 0,
    videos: [],
    error: null,
  };
  return jobs[id];
}

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

app.post('/create', (req, res) => {
  if (!requireSecret(req, res)) return;

  const prompt = (req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  if (prompt.length > MAX_PROMPT_LEN) return res.status(400).json({ error: `prompt too long (max ${MAX_PROMPT_LEN} chars)` });

  const description = (req.body.description || '').trim();
  const hashtags = [DEFAULT_HASHTAGS, (req.body.hashtags || '').trim()].filter(Boolean).join(' ');
  const mediaType = ['videos', 'images', 'all'].includes(req.body.mediaType) ? req.body.mediaType : 'videos';
  let count = parseInt(req.body.count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 12) count = 1;

  const { platforms, missing } = checkEnv();
  if (platforms.length > 0 && missing.length > 0) {
    return res.status(500).json({ error: `Server is misconfigured — missing env vars: ${missing.join(', ')}` });
  }

  const job = newJob();
  res.json({ jobId: job.id }); // respond immediately, background work continues after

  runJob(job, { prompt, description, hashtags, mediaType, count, platforms }).catch((err) => {
    job.status = 'error';
    job.error = err.message;
    log.error('create', `Job ${job.id} failed fatally:`, err.message);
  });
});

async function runJob(job, { prompt, description, hashtags, mediaType, count, platforms }) {
  job.status = 'generating';
  job.step = `Generating ${count} video(s) with Insider Memes...`;
  log.info('create', `[${job.id}] generating: "${prompt}" (mediaType=${mediaType}, count=${count})`);

  const memes = await generateVideoMemes(prompt, { mediaType, count });
  log.info('create', `[${job.id}] ${memes.length} video(s) ready`);

  job.totalSteps = memes.length * (platforms.length || 1);
  job.videos = memes.map((m) => ({
    videoUrl: m.url,
    tagline: m.tagline,
    platforms: Object.fromEntries(platforms.map((p) => [p, 'pending'])),
  }));
  job.status = 'posting';

  for (let i = 0; i < memes.length; i++) {
    const meme = memes[i];
    const shortSyncPlatforms = platforms.filter((p) => p !== 'tiktok');

    if (shortSyncPlatforms.length > 0) {
      job.step = `Posting video ${i + 1}/${memes.length} to ${shortSyncPlatforms.join(', ')}...`;
      log.info('create', `[${job.id}] posting video ${i + 1} via ShortSync to: ${shortSyncPlatforms.join(', ')}`);

      try {
        const byPlatform = await postToAllPlatforms(
          meme.url,
          { hookTagline: meme.tagline, description, hashtags },
          shortSyncPlatforms
        );
        for (const platform of shortSyncPlatforms) {
          const result = byPlatform[platform];
          job.videos[i].platforms[platform] = result?.status === 'done' ? 'done' : `error: ${result?.error || 'unknown error'}`;
          job.completedSteps += 1;
        }
      } catch (err) {
        log.error('create', `[${job.id}] ShortSync post failed for video ${i + 1}:`, err.message);
        for (const platform of shortSyncPlatforms) {
          job.videos[i].platforms[platform] = `error: ${err.message}`;
          job.completedSteps += 1;
        }
      }
    }

    // TikTok posts directly via TikTok's own Content Posting API (not
    // through ShortSync, which wasn't posting TikTok reliably). Lands as a
    // draft in your TikTok inbox until the app is audited for direct publish.
    if (platforms.includes('tiktok')) {
      job.step = `Posting video ${i + 1}/${memes.length} to tiktok...`;
      log.info('create', `[${job.id}] attempting tiktok for video ${i + 1}...`);
      try {
        const baseCaption = [meme.tagline, description, hashtags].filter(Boolean).join('\n\n');
        const result = await postToTikTok(meme.url, baseCaption);
        job.videos[i].platforms.tiktok = 'done';
        log.info('create', `[${job.id}] tiktok publish_id: ${result.publishId}`);
      } catch (err) {
        log.error('create', `[${job.id}] tiktok failed:`, err.message);
        job.videos[i].platforms.tiktok = `error: ${err.message}`;
      }
      job.completedSteps += 1;
    }
  }

  job.status = 'done';
  job.step = 'All done!';
  log.info('create', `[${job.id}] job complete`);
}

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Unknown job — server may have restarted, or the job expired after 2 hours' });
  res.json(job);
});

app.get('/trending', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const suggestions = await getTrendingSuggestions();
    res.json({ suggestions });
  } catch (err) {
    log.error('trending', 'Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic endpoint — shows which env vars are present WITHOUT leaking values.
app.get('/health', (req, res) => {
  const { platforms, missing } = checkEnv();
  res.json({ ok: missing.length === 0, postTo: platforms, missingEnvVars: missing, uptimeSeconds: Math.round(process.uptime()) });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  log.info('startup', `ClipVault poster listening on :${port}`);
  checkEnv();
});

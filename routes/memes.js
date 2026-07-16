const axios = require('axios');
const log = require('./logger');

const BASE = 'https://backend.insidermemes.com/v1';
const REQUEST_TIMEOUT_MS = 30000;

function authHeaders() {
  return {
    Authorization: `Token ${process.env.INSIDERMEMES_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retries transient failures (network errors, 429, 5xx) with backoff.
// Does NOT retry 4xx errors other than 429, since those won't fix themselves.
async function withRetry(fn, { retries = 3, baseDelayMs = 1500, label = 'request' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === retries) throw err;
      const delay = baseDelayMs * attempt;
      log.warn('memes', `${label} failed (attempt ${attempt}/${retries}, status=${status || 'network'}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function generateVideoMemes(prompt, { mediaType = 'videos', count = 1 } = {}) {
  if (!process.env.INSIDERMEMES_API_TOKEN) {
    throw new Error('INSIDERMEMES_API_TOKEN is not set — cannot generate memes');
  }

  const res = await withRetry(
    () => axios.post(
      `${BASE}/generate/`,
      { text: prompt, mediaType, count },
      { headers: authHeaders(), timeout: REQUEST_TIMEOUT_MS }
    ),
    { label: 'generate' }
  );

  const memes = res.data.memes || [];
  if (memes.length === 0) throw new Error('Insider Memes returned zero results for this prompt');

  const results = [];
  for (const meme of memes) {
    try {
      if (meme.file) {
        results.push({ url: meme.file, tagline: meme.tagline || '' });
        continue;
      }
      if (meme.jobInfo?.jobId) {
        const url = await pollForVideo(meme);
        results.push({ url, tagline: meme.tagline || '' });
        continue;
      }
      log.warn('memes', `Skipping meme with no file and no jobInfo (id=${meme.id || 'unknown'})`);
    } catch (err) {
      // One failed/timed-out video job shouldn't kill the whole batch when count > 1.
      log.error('memes', `Meme ${meme.id || 'unknown'} failed to produce a file:`, err.message);
    }
  }

  if (results.length === 0) throw new Error('None of the returned memes produced a usable video file');
  return results;
}

// NOTE: Insider Memes' public docs do not publish a job-status endpoint as of
// this writing. This assumes one exists at GET /v1/jobs/{jobId}/ — confirm
// the real path with Insider Memes support and adjust POLL_PATH if it errors.
const POLL_PATH = (jobId) => `${BASE}/jobs/${jobId}/`;

async function pollForVideo(meme, { intervalMs = 5000, timeoutMs = 6 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    attempts++;
    let res;
    try {
      res = await axios.get(POLL_PATH(meme.jobInfo.jobId), { headers: authHeaders(), timeout: REQUEST_TIMEOUT_MS });
    } catch (err) {
      // Transient poll failure — keep trying until the deadline, don't abort the whole job over one bad poll.
      log.warn('memes', `Poll attempt ${attempts} for job ${meme.jobInfo.jobId} errored: ${err.message}`);
      continue;
    }
    const status = res.data.status || res.data.state;
    if (res.data.file || res.data.fileUrl) return res.data.file || res.data.fileUrl;
    if (status === 'failed' || status === 'error') {
      throw new Error(`Video generation job ${meme.jobInfo.jobId} failed on Insider Memes' side`);
    }
  }
  throw new Error(`Timed out after ${attempts} polls waiting for job ${meme.jobInfo.jobId}`);
}

module.exports = { generateVideoMemes };

const axios = require('axios');
const log = require('./logger');

const BASE = 'https://api.shortsync.app/v1';
let cache = { summary: null, fetchedAt: 0 };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — analytics don't change that fast

// Pulls recent posts + engagement metrics from ShortSync and summarizes what's
// actually performed well, so the trending-topic generator can lean into
// patterns that are working instead of guessing blind every time.
async function getPerformanceSummary() {
  if (cache.summary && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.summary;
  }

  const apiKey = (process.env.SHORTSYNC_API_KEY || '').trim();
  if (!apiKey) return null; // silently skip — this is a nice-to-have, not required

  try {
    const res = await axios.get(`${BASE}/posts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { limit: 50 },
      timeout: 20000,
    });
    const posts = res.data.data || res.data || [];

    const scored = posts
      .map((p) => {
        // Analytics field names aren't fully nailed down in ShortSync's public docs
        // (beta API), so read defensively across the shapes their dashboard implies.
        const metrics = p.analytics || p.metrics || {};
        const views = metrics.views ?? metrics.view_count ?? 0;
        const likes = metrics.likes ?? metrics.like_count ?? 0;
        const comments = metrics.comments ?? metrics.comment_count ?? 0;
        const caption = p.caption || p.title || '';
        const engagementScore = views + likes * 5 + comments * 10; // weight interaction over passive views
        return { caption, platform: p.platform || p.target?.platform, engagementScore, views, likes, comments };
      })
      .filter((p) => p.caption && p.engagementScore > 0)
      .sort((a, b) => b.engagementScore - a.engagementScore)
      .slice(0, 6);

    cache = { summary: scored, fetchedAt: Date.now() };
    return scored;
  } catch (err) {
    log.warn('analytics-feedback', `Could not fetch performance data, proceeding without it: ${err.message}`);
    return null;
  }
}

module.exports = { getPerformanceSummary };

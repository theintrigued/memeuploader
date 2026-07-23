const axios = require('axios');
const log = require('./logger');

const SHORTSYNC_BASE = 'https://api.shortsync.app/v1';
let cache = { summary: null, fetchedAt: 0 };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — analytics don't change that fast

// IMPORTANT — verified directly against a real API response: ShortSync's
// GET /posts does NOT include any views/likes/comments fields. Their
// analytics are dashboard-only (shortsync.app -> Analytics tab), not exposed
// via their public API. So real numbers have to come from the platforms
// directly instead.
//
// YouTube's Data API supports public video statistics via a plain API key —
// no OAuth, no per-channel token, works for any public video ID. That's the
// one platform we can get genuinely real numbers from without re-engaging
// Instagram/TikTok's own developer platforms (which is exactly what
// switching to ShortSync was meant to avoid). Instagram/TikTok posts are
// still listed for caption variety, just without a real engagement score.
function extractYouTubeVideoId(url) {
  const match = (url || '').match(/(?:shorts\/|watch\?v=)([a-zA-Z0-9_-]{6,})/);
  return match ? match[1] : null;
}

async function fetchYouTubeStats(videoIds) {
  const apiKey = (process.env.YOUTUBE_API_KEY || '').trim();
  if (!apiKey || videoIds.length === 0) return {};

  const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
    params: { part: 'statistics', id: videoIds.join(','), key: apiKey },
    timeout: 20000,
  });

  const statsById = {};
  for (const item of res.data.items || []) {
    statsById[item.id] = {
      views: Number(item.statistics.viewCount || 0),
      likes: Number(item.statistics.likeCount || 0),
      comments: Number(item.statistics.commentCount || 0),
    };
  }
  return statsById;
}

async function getPerformanceSummary() {
  if (cache.summary && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.summary;
  }

  const apiKey = (process.env.SHORTSYNC_API_KEY || '').trim();
  if (!apiKey) return null; // nice-to-have, not required

  try {
    const res = await axios.get(`${SHORTSYNC_BASE}/posts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: { limit: 50 },
      timeout: 20000,
    });
    const posts = (res.data.data || res.data || []).filter((p) => p.status === 'published');

    const youtubePosts = posts.filter((p) => p.platform === 'youtube');
    const videoIds = youtubePosts.map((p) => extractYouTubeVideoId(p.platform_url)).filter(Boolean);

    let ytStats = {};
    try {
      ytStats = await fetchYouTubeStats(videoIds);
    } catch (err) {
      log.warn('analytics-feedback', `YouTube stats fetch failed, proceeding without real numbers: ${err.message}`);
    }

    const scored = youtubePosts
      .map((p) => {
        const id = extractYouTubeVideoId(p.platform_url);
        const stats = ytStats[id];
        if (!stats) return null; // no real data for this one — don't fabricate a score
        const caption = p.caption || p.title || '';
        const engagementScore = stats.views + stats.likes * 5 + stats.comments * 10;
        return { caption, platform: 'youtube', engagementScore, ...stats };
      })
      .filter((p) => p && p.caption && p.engagementScore > 0)
      .sort((a, b) => b.engagementScore - a.engagementScore)
      .slice(0, 6);

    if (scored.length === 0) {
      log.info('analytics-feedback', 'No scored performance data yet (need YOUTUBE_API_KEY + published YouTube posts with real view counts)');
    }

    cache = { summary: scored, fetchedAt: Date.now() };
    return scored;
  } catch (err) {
    log.warn('analytics-feedback', `Could not fetch performance data, proceeding without it: ${err.message}`);
    return null;
  }
}

module.exports = { getPerformanceSummary };

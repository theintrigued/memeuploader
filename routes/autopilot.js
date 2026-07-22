const axios = require('axios');
const log = require('./logger');
const { newJob } = require('./job-store');
const { runVideoJob } = require('./generate-and-post');
const { getTrendingSuggestions, generateBranchedTaglines } = require('./trending');
const { addPrompts } = require('./prompt-store');
const { getPerformanceSummary } = require('./analytics-feedback');
const { getState, setState, getLearnings, setLearnings, getEnabled } = require('./autopilot-store');
const { getDefaults: getTemplateMatchDefaults } = require('./template-match-settings');

const WINDOW_HOURS = Number(process.env.AUTOPILOT_WINDOW_HOURS) || 2;
const TOTAL_POSTS_PER_DAY = Number(process.env.AUTOPILOT_POSTS_PER_DAY) || 20;
const TZ_OFFSET_HOURS = Number(process.env.AUTOPILOT_TZ_OFFSET_HOURS) || 0; // e.g. 4 for Gulf Standard Time

function localDateKey(nowMs) {
  const shifted = nowMs + TZ_OFFSET_HOURS * 3600000;
  return new Date(shifted).toISOString().slice(0, 10);
}

function localDayStartMs(nowMs) {
  const shifted = nowMs + TZ_OFFSET_HOURS * 3600000;
  const shiftedMidnight = Math.floor(shifted / 86400000) * 86400000;
  return shiftedMidnight - TZ_OFFSET_HOURS * 3600000;
}

// Splits TOTAL_POSTS_PER_DAY evenly across the day's WINDOW_HOURS-long blocks
// — e.g. 20 posts / 12 two-hour windows = 8 windows with 2 posts, 4 windows
// with 1, the extra-post windows chosen randomly each day so it's not always
// the same slots getting the bonus post. Each slot gets a random timestamp
// within its window. Windows (or partial windows) that have already fully
// passed by `now` are skipped, so a late server start doesn't dump a burst of
// overdue posts all at once.
function buildDaySchedule(nowMs, dayStartMs) {
  const windowMs = WINDOW_HOURS * 3600000;
  const windowCount = Math.round(24 / WINDOW_HOURS);

  const base = Math.floor(TOTAL_POSTS_PER_DAY / windowCount);
  const remainder = TOTAL_POSTS_PER_DAY % windowCount;
  const windowIndices = Array.from({ length: windowCount }, (_, i) => i);
  for (let i = windowIndices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [windowIndices[i], windowIndices[j]] = [windowIndices[j], windowIndices[i]];
  }
  const bonusWindows = new Set(windowIndices.slice(0, remainder));

  const slots = [];
  for (let w = 0; w < windowCount; w++) {
    const postsThisWindow = base + (bonusWindows.has(w) ? 1 : 0);
    if (postsThisWindow === 0) continue;
    const windowStart = dayStartMs + w * windowMs;
    const windowEnd = windowStart + windowMs;
    if (windowEnd <= nowMs) continue;
    const effectiveStart = Math.max(windowStart, nowMs);
    if (effectiveStart >= windowEnd) continue;
    const span = windowEnd - effectiveStart;
    for (let p = 0; p < postsThisWindow; p++) {
      slots.push({ time: effectiveStart + Math.floor(Math.random() * span) });
    }
  }

  slots.sort((a, b) => a.time - b.time);
  return slots;
}

function getAutopilotPlatforms() {
  const raw = process.env.AUTOPILOT_PLATFORMS || process.env.POST_TO || '';
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

async function runEndOfDayAnalysis(oldState) {
  const executedPosts = (oldState.scheduledPosts || []).filter((p) => p.executed);
  if (executedPosts.length === 0) {
    log.info('autopilot', 'No executed posts yesterday, skipping end-of-day analysis');
    return;
  }

  let performanceSummary = null;
  try {
    performanceSummary = await getPerformanceSummary();
  } catch (err) {
    log.warn('autopilot', `Could not fetch performance data for end-of-day analysis: ${err.message}`);
  }

  const system = `You analyze one day's short-form video performance for a meme channel and write
2-4 concise, specific sentences of notes for tomorrow's content planning — which topics, themes, or
tones to lean into or drop. Be concrete, not generic ("traffic/commute frustration posts did well" not
"relatable content works well"). If the data is too thin to say anything specific, say so briefly.`;

  const userPayload = {
    postedToday: executedPosts.map((p) => ({ topic: p.topic, tagline: p.tagline, mode: p.mode })),
    recentPerformance: performanceSummary || 'no performance data available',
  };

  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-5',
        max_tokens: 400,
        system,
        messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    const text = res.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    await setLearnings(text);
    log.info('autopilot', `End-of-day learnings updated: ${text.slice(0, 150)}...`);
  } catch (err) {
    log.warn('autopilot', `End-of-day analysis failed, keeping previous learnings: ${err.message}`);
  }
}

async function startNewDay(nowMs) {
  const todayKey = localDateKey(nowMs);
  const learnings = await getLearnings().catch(() => null);

  log.info('autopilot', `Starting new day (${todayKey}) — running daily research...`);
  const [viral, relatable] = await Promise.all([
    getTrendingSuggestions('viral', learnings),
    getTrendingSuggestions('relatable', learnings),
  ]);

  try {
    await addPrompts(viral, 'viral');
    await addPrompts(relatable, 'relatable');
  } catch (err) {
    log.warn('autopilot', `Could not persist daily research to prompt store: ${err.message}`);
  }

  const baseTopics = [
    ...viral.map((s) => ({ ...s, mode: 'viral' })),
    ...relatable.map((s) => ({ ...s, mode: 'relatable' })),
  ];

  const dayStartMs = localDayStartMs(nowMs);
  const slots = buildDaySchedule(nowMs, dayStartMs);

  let branched = [];
  if (slots.length > 0) {
    try {
      branched = await generateBranchedTaglines(baseTopics, slots.length);
    } catch (err) {
      log.warn('autopilot', `Branch generation failed, falling back to base topics directly: ${err.message}`);
    }
  }

  const scheduledPosts = slots.map((slot, i) => {
    const b = branched[i];
    const fallback = baseTopics[i % baseTopics.length];
    return {
      time: slot.time,
      topic: b?.topic || fallback.topic,
      tagline: b?.tagline || fallback.tagline,
      mode: b?.mode || fallback.mode,
      executed: false,
      jobId: null,
    };
  });

  const newState = {
    date: todayKey,
    dailySearchDone: true,
    baseTopics,
    scheduledPosts,
    endOfDayAnalysisDone: false,
    createdAt: nowMs,
  };
  await setState(newState);
  log.info('autopilot', `Day ${todayKey} scheduled: ${scheduledPosts.length} post(s) across the remaining day`);
  return newState;
}

async function triggerDuePosts(state) {
  const now = Date.now();
  const due = state.scheduledPosts.filter((p) => !p.executed && p.time <= now);
  if (due.length === 0) return [];

  const platforms = getAutopilotPlatforms();
  const triggered = [];

  for (const post of due) {
    // Mark executed BEFORE kicking off the job (and save immediately) so an
    // overlapping tick can't double-trigger the same slot.
    post.executed = true;
    const job = newJob('autopilot');
    post.jobId = job.id;
    triggered.push({ jobId: job.id, tagline: post.tagline });
  }
  await setState(state);

  for (const post of due) {
    const realJob = require('./job-store').getJob(post.jobId);
    log.info('autopilot', `Triggering scheduled post: "${post.tagline}" (job ${post.jobId})`);
    // Autopilot defaults to our own indexed templates (zero Insider Memes
    // credits, funnier/more deliberate matches) using your saved font/size/
    // position defaults. runVideoJob itself falls back to Insider Memes
    // generation automatically if no template match is found.
    const textOptions = await getTemplateMatchDefaults().catch(() => undefined);
    runVideoJob(realJob, { prompt: post.tagline, platforms, useTemplateIndex: true, textOptions }).catch((err) => {
      realJob.status = 'error';
      realJob.error = err.message;
      log.error('autopilot', `Scheduled post failed (job ${post.jobId}):`, err.message);
    });
  }

  return triggered;
}

// Called on every external cron ping. Cheap when there's nothing to do —
// only does real work (search/branch/post) when a day boundary is crossed or
// a scheduled time has actually arrived.
async function tick() {
  const enabled = await getEnabled().catch((err) => {
    log.warn('autopilot', `Could not read enabled flag, treating as off: ${err.message}`);
    return false;
  });
  if (!enabled) {
    return { enabled: false };
  }

  const now = Date.now();
  const todayKey = localDateKey(now);
  let state = await getState();
  let ranDailySearch = false;

  if (!state || state.date !== todayKey) {
    if (state && !state.endOfDayAnalysisDone) {
      await runEndOfDayAnalysis(state);
      state.endOfDayAnalysisDone = true;
      await setState(state); // keep the old day's record marked as analyzed, briefly, before overwrite below
    }
    state = await startNewDay(now);
    ranDailySearch = true;
  }

  const triggered = await triggerDuePosts(state);

  return {
    enabled: true,
    date: state.date,
    ranDailySearch,
    postsTriggeredThisTick: triggered.length,
    triggered,
    totalScheduledToday: state.scheduledPosts.length,
    remainingToday: state.scheduledPosts.filter((p) => !p.executed).length,
  };
}

module.exports = { tick, localDateKey, buildDaySchedule, localDayStartMs };

const { getCompactList, getManifest } = require('./template-store');
const { getPromptsList } = require('./prompt-store');
const { getState: getAutopilotState, getEnabled: getAutopilotEnabled, getLearnings } = require('./autopilot-store');
const { getRecentTemplateIds } = require('./recent-templates-store');
const { checkEnv } = require('./env-check');

function bucketize(values, buckets) {
  const counts = buckets.map((b) => ({ ...b, count: 0 }));
  for (const v of values) {
    for (const b of counts) {
      if (v >= b.min && v < b.max) { b.count++; break; }
    }
  }
  return counts.map(({ label, count }) => ({ label, count }));
}

function countBy(list, field) {
  const counts = {};
  for (const item of list) {
    const key = item[field];
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

function trimTemplate(t) {
  return { id: t.id, description: t.description, emotion: t.emotion ?? null, sourceType: t.sourceType ?? null, durationSeconds: t.durationSeconds ?? null, attentionScore: t.attentionScore ?? null };
}

async function computeDashboardStats() {
  const [compactList, manifest, prompts, autopilotState, autopilotEnabled, learnings, recentTemplateIds] = await Promise.all([
    getCompactList(),
    getManifest(),
    getPromptsList(),
    getAutopilotState(),
    getAutopilotEnabled(),
    getLearnings(),
    getRecentTemplateIds(),
  ]);

  const videos = compactList.filter((t) => t.type === 'video');
  const images = compactList.filter((t) => t.type === 'image');
  const scored = compactList.filter((t) => Number.isFinite(t.attentionScore));
  const scores = scored.map((t) => t.attentionScore);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  const scoreDistribution = bucketize(scores, [
    { label: '0-20', min: 0, max: 21 },
    { label: '21-40', min: 21, max: 41 },
    { label: '41-60', min: 41, max: 61 },
    { label: '61-80', min: 61, max: 81 },
    { label: '81-100', min: 81, max: 101 },
  ]);

  const durations = videos.filter((t) => Number.isFinite(t.durationSeconds)).map((t) => t.durationSeconds);
  const avgDuration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const durationDistribution = bucketize(durations, [
    { label: '<15s', min: 0, max: 15 },
    { label: '15-30s', min: 15, max: 30 },
    { label: '30-60s', min: 30, max: 60 },
    { label: '60-90s', min: 60, max: 90 },
    { label: '90s+', min: 90, max: Infinity },
  ]);

  const byScoreDesc = [...scored].sort((a, b) => b.attentionScore - a.attentionScore);

  const unusedPrompts = prompts.filter((p) => !p.used);
  const usedPrompts = prompts.filter((p) => p.used);
  const promptsByMode = {};
  for (const p of prompts) {
    promptsByMode[p.mode] = promptsByMode[p.mode] || { used: 0, unused: 0 };
    promptsByMode[p.mode][p.used ? 'used' : 'unused']++;
  }

  const { platforms, missing } = checkEnv();

  return {
    generatedAt: Date.now(),
    templates: {
      total: compactList.length,
      videoCount: videos.length,
      imageCount: images.length,
      discoveryDone: manifest.done,
      indexedCount: manifest.indexedCount,
      lastRunAt: manifest.lastRunAt,
      averageAttentionScore: avgScore,
      scoreDistribution,
      averageDurationSeconds: avgDuration,
      durationDistribution,
      emotionBreakdown: countBy(compactList, 'emotion'),
      sourceBreakdown: countBy(compactList, 'sourceType'),
      topScored: byScoreDesc.slice(0, 10).map(trimTemplate),
      bottomScored: byScoreDesc.slice(-10).reverse().map(trimTemplate),
      recentlyUsedCount: recentTemplateIds.length,
    },
    prompts: {
      total: prompts.length,
      unused: unusedPrompts.length,
      used: usedPrompts.length,
      byMode: promptsByMode,
      oldestUnusedAgeHours: unusedPrompts.length > 0
        ? Math.round((Date.now() - Math.min(...unusedPrompts.map((p) => p.createdAt))) / 3600000)
        : null,
    },
    autopilot: {
      enabled: autopilotEnabled,
      date: autopilotState?.date || null,
      totalScheduledToday: autopilotState?.scheduledPosts?.length || 0,
      postedToday: autopilotState?.scheduledPosts?.filter((p) => p.executed).length || 0,
      learnings: learnings || null,
    },
    system: {
      postingReady: missing.length === 0,
      configuredPlatforms: platforms,
      missingEnvVars: missing,
    },
  };
}

module.exports = { computeDashboardStats };

const crypto = require('crypto');
const log = require('./logger');

// In-memory job registry shared by the manual /create flow and the autopilot.
// Resets on redeploy/restart — fine, since these are just live-progress
// trackers, not the source of truth for anything durable.
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const jobs = {};

function sweepOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of Object.entries(jobs)) {
    if (job.createdAt < cutoff) delete jobs[id];
  }
}
setInterval(sweepOldJobs, 30 * 60 * 1000).unref();

function newJob(source = 'manual') {
  const id = crypto.randomUUID();
  jobs[id] = {
    id,
    source, // 'manual' | 'autopilot'
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

function getJob(id) {
  return jobs[id];
}

module.exports = { jobs, newJob, getJob };

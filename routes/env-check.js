const log = require('./logger');

// Each entry: [envVarName, required for these POST_TO platforms (empty = always required)]
const CHECKS = [
  ['APP_SECRET', []],
  ['INSIDERMEMES_API_TOKEN', []],
  ['SHORTSYNC_API_KEY', ['youtube', 'instagram']],
  ['TIKTOK_CLIENT_KEY', ['tiktok']],
  ['TIKTOK_CLIENT_SECRET', ['tiktok']],
  ['TIKTOK_REFRESH_TOKEN', ['tiktok']],
];

function checkEnv() {
  const platforms = (process.env.POST_TO || '').split(',').map((p) => p.trim()).filter(Boolean);
  const missing = [];

  for (const [name, requiredFor] of CHECKS) {
    const isRequired = requiredFor.length === 0 || requiredFor.some((p) => platforms.includes(p));
    if (isRequired && !process.env[name]) missing.push(name);
  }

  if (platforms.length === 0) {
    log.warn('startup', 'POST_TO is empty — videos will generate but nothing will be posted anywhere.');
  }
  if (missing.length > 0) {
    log.warn('startup', `Missing env vars for your configured POST_TO=${platforms.join(',')}: ${missing.join(', ')}`);
  } else {
    log.info('startup', 'All required env vars for the configured platforms are present.');
  }

  return { platforms, missing };
}

module.exports = { checkEnv };

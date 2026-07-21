const { getJSON, setJSON } = require('./upstash-client');

const STATE_KEY = 'clipvault_autopilot_state';
const LEARNINGS_KEY = 'clipvault_autopilot_learnings';
const ENABLED_KEY = 'clipvault_autopilot_enabled';

async function getState() {
  return getJSON(STATE_KEY, null);
}

async function setState(state) {
  await setJSON(STATE_KEY, state);
}

async function getLearnings() {
  return getJSON(LEARNINGS_KEY, null); // a plain string, wrapped in JSON by the shared client
}

async function setLearnings(text) {
  await setJSON(LEARNINGS_KEY, text);
}

// Live on/off switch — stored, not an env var, so it can be flipped from the
// frontend instantly without a redeploy. Defaults to OFF: autopilot never
// starts posting on its own just because the server booted.
async function getEnabled() {
  return getJSON(ENABLED_KEY, false);
}

async function setEnabled(value) {
  await setJSON(ENABLED_KEY, !!value);
}

module.exports = { getState, setState, getLearnings, setLearnings, getEnabled, setEnabled };

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const log = require('./logger');

const router = express.Router();

function redirectUri(req) {
  return `https://${req.get('host')}/tiktok/callback`;
}

// Visit this in the browser to start the TikTok login flow.
router.get('/tiktok/login', (req, res) => {
  if (req.query.secret !== process.env.APP_SECRET) return res.status(401).send('Bad secret');

  const state = crypto.randomBytes(8).toString('hex');
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    response_type: 'code',
    scope: 'video.upload,video.publish',
    redirect_uri: redirectUri(req),
    state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

// TikTok redirects back here after you approve. We exchange the code immediately
// and just show you the token to copy into Render — nothing is stored server-side.
router.get('/tiktok/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.status(400).send(`TikTok error: ${error} — ${error_description}`);
  if (!code) return res.status(400).send('No code received from TikTok');

  try {
    const tokenRes = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(req),
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    log.info('tiktok-oauth', 'New TikTok token pair issued via login flow');
    res.send(`
      <body style="font-family:sans-serif;padding:20px;">
        <h3>Success — copy this into Render's TIKTOK_ACCESS_TOKEN</h3>
        <textarea style="width:100%;height:80px;" onclick="this.select()">${access_token}</textarea>
        <p>Expires in ${expires_in} seconds (~${Math.round(expires_in / 3600)}h). Refresh token (save somewhere safe, needed to get a new access token later without re-logging in):</p>
        <textarea style="width:100%;height:80px;" onclick="this.select()">${refresh_token}</textarea>
      </body>
    `);
  } catch (err) {
    res.status(500).send('Token exchange failed: ' + JSON.stringify(err.response?.data || err.message));
  }
});

module.exports = router;

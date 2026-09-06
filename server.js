require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const fetch = require('node-fetch');
const { nanoid } = require('nanoid');

const {
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  DASHBOARD_PASSWORD,
  PORT = 3000,
  PUBLIC_BASE_URL = `http://localhost:${PORT}`,
} = process.env;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error('Missing CF_ACCOUNT_ID or CF_API_TOKEN in .env — see .env.example');
}
if (!DASHBOARD_PASSWORD) {
  console.error('Missing DASHBOARD_PASSWORD in .env — dashboard will be unprotected without it');
}

const CF_API_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream`;
const CONFIG_PATH = path.join(__dirname, 'stream-config.json');

// ---- tiny persisted state so we don't lose the live input across restarts ----
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { liveInput: null };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let state = loadConfig();

// ---- simple auth: one shared dashboard password, issues an opaque session token ----
const sessions = new Set();
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

async function cfFetch(pathSuffix, options = {}) {
  const res = await fetch(`${CF_API_BASE}${pathSuffix}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    const msg = data?.errors?.map((e) => e.message).join('; ') || res.statusText;
    throw new Error(`Cloudflare API error: ${msg}`);
  }
  return data.result;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- auth routes ----
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!DASHBOARD_PASSWORD || password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = nanoid(32);
  sessions.add(token);
  res.json({ token });
});

// ---- streamer: create (or recreate) a live input ----
app.post('/api/stream/create', requireAuth, async (req, res) => {
  try {
    const result = await cfFetch('/live_inputs', {
      method: 'POST',
      body: JSON.stringify({
        meta: { name: req.body?.name || 'My Stream' },
        recording: { mode: 'off' }, // set to 'automatic' if you want VOD recordings saved
      }),
    });

    const watchId = nanoid(10);
    state.liveInput = {
      uid: result.uid,
      rtmpsUrl: result.rtmps.url,
      rtmpsKey: result.rtmps.streamKey,
      watchId,
      createdAt: Date.now(),
    };
    saveConfig(state);

    res.json({
      rtmpsUrl: result.rtmps.url,
      rtmpsKey: result.rtmps.streamKey,
      watchLink: `${PUBLIC_BASE_URL}/watch/${watchId}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- streamer: fetch current credentials/link without recreating ----
app.get('/api/stream/current', requireAuth, async (req, res) => {
  if (!state.liveInput) return res.json({ liveInput: null });
  res.json({
    rtmpsUrl: state.liveInput.rtmpsUrl,
    rtmpsKey: state.liveInput.rtmpsKey,
    watchLink: `${PUBLIC_BASE_URL}/watch/${state.liveInput.watchId}`,
  });
});

// ---- streamer: check live status ----
app.get('/api/stream/status', requireAuth, async (req, res) => {
  if (!state.liveInput) return res.json({ live: false });
  try {
    const result = await cfFetch(`/live_inputs/${state.liveInput.uid}`);
    const live = result.status === 'connected' || result.status === 'reconnected';
    res.json({ live });
  } catch (err) {
    res.json({ live: false });
  }
});

// ---- public: resolve a watch link to playback info ----
app.get('/api/watch/:watchId', async (req, res) => {
  if (!state.liveInput || state.liveInput.watchId !== req.params.watchId) {
    return res.status(404).json({ error: 'Stream not found' });
  }
  // Cloudflare Stream's HLS manifest for a live input, once it's receiving video
  const hlsUrl = `https://customer-${CF_ACCOUNT_ID}.cloudflarestream.com/${state.liveInput.uid}/manifest/video.m3u8`;
  res.json({ hlsUrl, streamId: state.liveInput.watchId });
});

// ---- serve the watch page for any /watch/:id ----
app.get('/watch/:watchId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

const server = http.createServer(app);

// ---- chat over WebSocket, one room per watchId ----
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // watchId -> Set of ws connections

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const watchId = url.searchParams.get('room');
  const name = (url.searchParams.get('name') || 'Anonymous').slice(0, 24);
  if (!watchId) return ws.close();

  if (!rooms.has(watchId)) rooms.set(watchId, new Set());
  rooms.get(watchId).add(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'chat' || typeof msg.text !== 'string') return;
    const text = msg.text.slice(0, 500); // basic length cap, no content filtering
    const payload = JSON.stringify({
      type: 'chat',
      name,
      text,
      ts: Date.now(),
    });
    for (const client of rooms.get(watchId)) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  });

  ws.on('close', () => {
    rooms.get(watchId)?.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
});

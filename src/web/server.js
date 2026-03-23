/**
 * IPM Web Server
 * Serves the web dashboard and streams live updates via SSE.
 * Run with: npm run dev
 */

import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import * as dotenv from 'dotenv';
import { getConfig, setConfig } from '../db/index.js';
import { initNotion, listDocs } from '../agent/notion.js';
import { runBuild } from '../agent/runner.js';
import { ensureBridgeInstalled, waitForVision } from '../agent/ide.js';
import { spawnDaemons } from '../agent/daemons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const DATA_DIR = path.join(os.homedir(), '.ipm');
const FRAME_PATH = path.join(DATA_DIR, 'vision_frame.png');
const STATE_PATH = path.join(DATA_DIR, 'kiro_state.json');
const PORT = process.env.IPM_PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve logo
app.get('/logo.png', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../logo.png'));
});

// ── SSE: live event stream ────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Live frame endpoint ───────────────────────────────────────────────────────

app.get('/frame', (_req, res) => {
  if (!fs.existsSync(FRAME_PATH)) {
    return res.status(404).send('No frame yet');
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.send(fs.readFileSync(FRAME_PATH));
});

// ── Kiro state endpoint ───────────────────────────────────────────────────────

app.get('/state', (_req, res) => {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    res.json({ ok: true, ...state });
  } catch {
    res.json({ ok: true, state: 'idle', since: Date.now(), lastResponseText: '' });
  }
});

// ── Notion: list docs ─────────────────────────────────────────────────────────

app.get('/docs', async (_req, res) => {
  try {
    const token = getConfig('notion_token');
    if (!token) return res.json({ ok: false, error: 'no_token' });
    initNotion(token);
    const docs = await listDocs();
    res.json({ ok: true, docs });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Notion: save token ────────────────────────────────────────────────────────

app.post('/token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ ok: false, error: 'missing token' });
  try {
    initNotion(token);
    await listDocs(); // validate
    setConfig('notion_token', token);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Run build ─────────────────────────────────────────────────────────────────

let currentRun = null;

app.post('/run', async (req, res) => {
  const { docId, docTitle, ide = 'kiro' } = req.body;
  if (!docId) return res.json({ ok: false, error: 'missing docId' });
  if (currentRun) return res.json({ ok: false, error: 'already running' });

  currentRun = { docId, docTitle, ide, startedAt: Date.now() };
  broadcast('run_start', { docId, docTitle, ide });
  res.json({ ok: true });

  runBuild({
    docId,
    docTitle,
    ide,
    onStatus: ({ msg, type }) => broadcast('log', { msg, type }),
    onBusMessage: (entry) => broadcast('bus', entry),
    onDone: (projectPath) => {
      broadcast('run_done', { projectPath });
      currentRun = null;
    },
    onError: (err) => {
      broadcast('run_error', { error: err.message });
      currentRun = null;
    },
  });
});

app.get('/run/status', (_req, res) => {
  res.json({ running: !!currentRun, run: currentRun });
});

// ── Frame poller: broadcast state changes ─────────────────────────────────────

let lastState = null;
setInterval(() => {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    if (state.state !== lastState) {
      lastState = state.state;
      broadcast('kiro_state', state);
    }
  } catch {}
}, 300);

// ── Start ─────────────────────────────────────────────────────────────────────

ensureBridgeInstalled();
spawnDaemons();

app.listen(PORT, () => {
  console.log(`\n  IPM Web Dashboard → http://localhost:${PORT}\n`);
  try { execSync(`open http://localhost:${PORT}`); } catch {}
});

/**
 * IPM Web Server
 * Serves the web dashboard and streams live updates via SSE.
 * Architecture: TLI → PMC → CRM → TSP → DCL + MNC orchestrator
 * IDE: Cursor only (Kiro removed)
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
import { ensureIDEInstalled, waitForCursor, isCursorReady } from '../agent/ide.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const DATA_DIR = path.join(os.homedir(), '.ipm');
const CURSOR_STATE_PATH = path.join(DATA_DIR, 'cursor_state.json');
const PORT = process.env.IPM_PORT || 3000;
const ENV_PATH = path.join(__dirname, '../../.env');

function writeCursorKeyToEnv(key) {
  try {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    if (/^CURSOR_API_KEY=/m.test(content)) {
      content = content.replace(/^CURSOR_API_KEY=.*/m, `CURSOR_API_KEY=${key}`);
    } else {
      content = content.trimEnd() + `\nCURSOR_API_KEY=${key}\n`;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    process.env.CURSOR_API_KEY = key;
  } catch {}
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/logo.png', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../logo.png'));
});

// ── SSE: live event stream ────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const deadClients = new Set();
  for (const res of sseClients) {
    try { 
      res.write(payload); 
    } catch (e) {
      deadClients.add(res);
    }
  }
  for (const dead of deadClients) {
    sseClients.delete(dead);
  }
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  const clientData = {
    connectedAt: Date.now(),
    ip: req.ip || req.connection?.remoteAddress || 'unknown'
  };
  
  sseClients.add({ res, ...clientData });
  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected. Active clients: ${sseClients.size}`);
  });
  
  console.log(`[SSE] Client connected. Active clients: ${sseClients.size}`);
});

// ── Cursor state endpoint ───────────────────────────────────────────────────

app.get('/state', (_req, res) => {
  try {
    if (fs.existsSync(CURSOR_STATE_PATH)) {
      const state = JSON.parse(fs.readFileSync(CURSOR_STATE_PATH, 'utf8'));
      return res.json({ ok: true, ...state });
    }
  } catch {}
  res.json({ ok: true, state: 'idle', since: Date.now(), lastResponseText: '' });
});

// ── Notion: list docs ─────────────────────────────────────────────────────────

app.get('/docs', async (_req, res) => {
  try {
    const token = getConfig('notion_token');
    if (!token) return res.json({ ok: false, error: 'no_token' });
    const cursorKey = getConfig('cursor_api_key');
    if (!cursorKey) return res.json({ ok: false, error: 'no_cursor_key' });
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
    await listDocs();
    setConfig('notion_token', token);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Cursor: save API key ──────────────────────────────────────────────────────

app.post('/cursor-key', (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ ok: false, error: 'missing key' });
  setConfig('cursor_api_key', key);
  writeCursorKeyToEnv(key);
  res.json({ ok: true });
});

// ── Run build ─────────────────────────────────────────────────────────────────

let currentRun = null;

app.post('/run', async (req, res) => {
  const { docId, docTitle } = req.body;
  if (!docId) return res.json({ ok: false, error: 'missing docId' });
  if (currentRun) return res.json({ ok: false, error: 'already running' });

  currentRun = { docId, docTitle, ide: 'cursor', startedAt: Date.now() };
  broadcast('run_start', { docId, docTitle, ide: 'cursor' });
  res.json({ ok: true });

  runBuild({
    docId,
    docTitle,
    ide: 'cursor',
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

// ── Cursor state poller ───────────────────────────────────────────────────────

let lastState = null;
setInterval(() => {
  try {
    if (fs.existsSync(CURSOR_STATE_PATH)) {
      const raw = fs.readFileSync(CURSOR_STATE_PATH, 'utf8');
      const state = JSON.parse(raw);
      if (state.state !== lastState) {
        lastState = state.state;
        broadcast('cursor_state', state);
      }
    }
  } catch {}
}, 1000);

// ── Startup Validation ─────────────────────────────────────────────────────────

function validateEnvironment() {
  const errors = [];
  
  if (!process.env.OPENROUTER_API_KEY && !process.env.GROQ_API_KEY) {
    errors.push('OPENROUTER_API_KEY not set. Create a .env file with your OpenRouter API key.');
  }
  
  if (errors.length > 0) {
    console.error('\n❌ IPM Startup Failed:\n');
    errors.forEach(e => console.error(`  - ${e}`));
    console.error('\nPlease create a .env file in the project root:\n');
    console.error('  cp .env.example .env');
    console.error('  # Then edit .env and add your OpenRouter API key\n');
    process.exit(1);
  }
  
  console.log('✓ Environment validation passed');
  console.log('✓ Using Cursor IDE only (Kiro integration removed)');
  console.log('✓ Architecture: TLI → PMC → CRM → TSP → DCL + MNC');
}

// ── Start ─────────────────────────────────────────────────────────────────────

validateEnvironment();
ensureIDEInstalled();

app.listen(PORT, () => {
  console.log(`\n  IPM Web Dashboard → http://localhost:${PORT}\n`);
  console.log('  Agents: TLI | PMC | CRM | TSP | DCL | MNC\n');
  try { execSync(`open http://localhost:${PORT}`); } catch {}
});

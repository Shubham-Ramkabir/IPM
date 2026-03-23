/**
 * Cursor API integration
 * Uses the Cursor background agent API for direct prompt injection.
 */

import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CURSOR_API_KEY = 'crsr_78f9d725f3ef893ca3580339ffa19836a6011193a42044afb00415e5adfa89d2';
const CURSOR_API_HOST = 'api2.cursor.sh';
const DATA_DIR = path.join(os.homedir(), '.ipm');
const CURSOR_STATE_PATH = path.join(DATA_DIR, 'cursor_state.json');

let currentState = { state: 'idle', since: Date.now(), lastResponseText: '' };

// ── Send a prompt to Cursor via API ──────────────────────────────────────────

export async function sendCursorPrompt(text, projectPath) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: text }],
    workspacePath: projectPath || process.cwd(),
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: CURSOR_API_HOST,
      path: '/aiserver.v1.AiService/StreamChat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CURSOR_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      currentState = { state: 'writing', since: Date.now(), lastResponseText: '' };
      writeCursorState();

      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          // Parse streamed response — Cursor returns newline-delimited JSON
          let fullText = '';
          for (const line of data.split('\n')) {
            const l = line.trim();
            if (!l || l === 'data: [DONE]') continue;
            const raw = l.startsWith('data: ') ? l.slice(6) : l;
            try {
              const parsed = JSON.parse(raw);
              const delta = parsed.choices?.[0]?.delta?.content
                         || parsed.choices?.[0]?.message?.content
                         || parsed.text
                         || '';
              fullText += delta;
            } catch {}
          }
          currentState = { state: 'idle', since: Date.now(), lastResponseText: fullText };
          writeCursorState();
          resolve({ ok: true, text: fullText });
        } catch (e) {
          currentState = { state: 'idle', since: Date.now(), lastResponseText: '' };
          writeCursorState();
          reject(e);
        }
      });
    });

    req.on('error', (e) => {
      currentState = { state: 'idle', since: Date.now(), lastResponseText: '' };
      writeCursorState();
      reject(e);
    });

    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('Cursor API timeout'));
    });

    currentState = { state: 'thinking', since: Date.now(), lastResponseText: '' };
    writeCursorState();
    req.write(body);
    req.end();
  });
}

// ── Poll Cursor state ─────────────────────────────────────────────────────────

export function getCursorState() {
  return currentState;
}

export async function pollCursorState() {
  return currentState;
}

// ── Open project in Cursor ────────────────────────────────────────────────────

export async function openInCursor(folderPath) {
  const { execSync } = await import('child_process');
  try {
    execSync(`cursor "${folderPath}"`, { stdio: 'ignore' });
  } catch {
    try { execSync(`open -a Cursor "${folderPath}"`, { stdio: 'ignore' }); } catch {}
  }
  await sleep(3000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function writeCursorState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CURSOR_STATE_PATH, JSON.stringify(currentState));
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

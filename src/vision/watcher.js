#!/usr/bin/env node
/**
 * IPM Vision Watcher
 * ------------------
 * A persistent process that acts as the "eyes" of the computer.
 * - Captures the screen every 300ms
 * - Sends frames to Groq vision in a tight loop
 * - Classifies Kiro state in real time: idle | writing | thinking | waiting_for_input
 * - Caches input bar coordinates (re-detects if window moves)
 * - Writes state to ~/.ipm/kiro_state.json continuously
 * - Listens on ~/.ipm/vision.sock for commands from IPM:
 *     { type: 'send_prompt', text: '...' }  → waits for idle, then clicks + types
 *     { type: 'get_state' }                 → returns current state immediately
 */

import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';

const DATA_DIR = path.join(os.homedir(), '.ipm');
const KIRO_STATE_PATH = path.join(DATA_DIR, 'kiro_state.json');
const VISION_SOCK = path.join(DATA_DIR, 'vision.sock');
const SCREENSHOT_PATH = path.join(DATA_DIR, 'vision_frame.png');

const CAPTURE_INTERVAL_MS = 300;
const IDLE_STABILISE_MS = 1500;
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

const VALID_STATES = ['writing', 'thinking', 'waiting_for_input', 'idle'];

// ── Shared state ──────────────────────────────────────────────────────────────

let currentState = { state: 'idle', since: Date.now(), lastResponseText: '' };
let inputBarCoords = null;       // { x, y } — cached, re-detected on null
let lastWindowBounds = null;     // detect window moves to invalidate coords cache
let groqApiKey = null;

// Keep-alive HTTPS agent for Groq — avoids TCP handshake on every request
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  groqApiKey = readGroqApiKey();
  if (!groqApiKey) {
    console.error('[vision] GROQ_API_KEY not found — exiting');
    process.exit(1);
  }

  // Clean up stale socket
  if (fs.existsSync(VISION_SOCK)) fs.unlinkSync(VISION_SOCK);

  // Start command socket
  startCommandServer();

  // Detect input bar coords once before the loop
  console.log('[vision] Detecting input bar coordinates…');
  inputBarCoords = await detectInputBarCoords().catch(() => null);
  if (inputBarCoords) {
    console.log(`[vision] Input bar at (${inputBarCoords.x}, ${inputBarCoords.y})`);
  } else {
    console.log('[vision] Could not detect input bar — will retry on first prompt');
  }

  // Start the live capture loop
  console.log('[vision] Starting live state loop at 300ms');
  liveLoop();
}

// ── Live capture loop ─────────────────────────────────────────────────────────

// Prevent concurrent UI interaction attempts
let handlingUiInteraction = false;

async function liveLoop() {
  while (true) {
    const loopStart = Date.now();

    try {
      // Capture frame
      execSync(`screencapture -x "${SCREENSHOT_PATH}"`, { stdio: 'ignore' });

      // Check if window moved (invalidate coords cache)
      const bounds = getWindowBounds();
      if (bounds && JSON.stringify(bounds) !== JSON.stringify(lastWindowBounds)) {
        lastWindowBounds = bounds;
        inputBarCoords = null; // re-detect on next prompt
      }

      // Classify state via Groq vision
      const result = await classifyFrame(SCREENSHOT_PATH);
      const prevState = currentState.state;

      // Capture last response text when transitioning to idle
      let lastResponseText = currentState.lastResponseText;
      if (result.state === 'idle' && prevState !== 'idle') {
        lastResponseText = result.lastResponseText || currentState.lastResponseText;
      }

      currentState = {
        state: result.state,
        since: result.state !== prevState ? Date.now() : currentState.since,
        lastResponseText,
      };

      // Persist to disk
      fs.writeFileSync(KIRO_STATE_PATH, JSON.stringify(currentState));

      // ── Autonomous UI interaction ──────────────────────────────────────────
      // If Kiro is waiting for input (button click, option select, submit, etc.)
      // handle it immediately without waiting for a command from IPM
      if (result.state === 'waiting_for_input' && !handlingUiInteraction) {
        handlingUiInteraction = true;
        handleWaitingForInput()
          .catch(() => {})
          .finally(() => { handlingUiInteraction = false; });
      }

    } catch (e) {
      // Non-fatal — keep looping
    }

    // Maintain ~300ms cadence accounting for processing time
    const elapsed = Date.now() - loopStart;
    const wait = Math.max(0, CAPTURE_INTERVAL_MS - elapsed);
    await sleep(wait);
  }
}

// ── Groq vision: classify frame + extract last response in one call ───────────

async function classifyFrame(screenshotPath) {
  const base64 = fs.readFileSync(screenshotPath).toString('base64');

  const body = JSON.stringify({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `You are the real-time eyes of an automation system watching the Kiro IDE screen.

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "state": "<one of: writing | thinking | waiting_for_input | idle>",
  "lastResponseText": "<if state just became idle and a response finished, the full text of the last AI message — otherwise empty string>"
}

State classification rules (in priority order):
- waiting_for_input: ANY of these are visible and need a click/action:
    • A button (e.g. "Submit", "Continue", "Accept", "Approve", "Run", "Confirm", "Yes", "No", "OK")
    • A multiple-choice option or selectable item awaiting selection
    • A form field or text input awaiting user text entry (other than the main chat input)
    • Any interactive element highlighted or pulsing awaiting user action
- writing: text is actively streaming or appearing character by character in the chat
- thinking: a spinner, loading dots, or "thinking" indicator is visible but no new text is appearing
- idle: Kiro is not doing anything — no spinner, no streaming, no buttons waiting`,
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${base64}` },
        },
      ],
    }],
    temperature: 0.1,
    max_tokens: 256,
  });

  const text = await groqRequest(body);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON');
    const parsed = JSON.parse(match[0]);
    const state = VALID_STATES.includes(parsed.state) ? parsed.state : 'idle';
    return { state, lastResponseText: parsed.lastResponseText || '' };
  } catch {
    return { state: 'idle', lastResponseText: '' };
  }
}

// ── Groq vision: detect input bar coordinates ─────────────────────────────────

async function detectInputBarCoords() {
  execSync(`screencapture -x "${SCREENSHOT_PATH}"`, { stdio: 'ignore' });
  const base64 = fs.readFileSync(SCREENSHOT_PATH).toString('base64');

  const body = JSON.stringify({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'This is the Kiro IDE. Find the chat input text field at the bottom (where you type messages). Return ONLY JSON: {"x": number, "y": number} — the center pixel of that input box. No explanation.',
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${base64}` },
        },
      ],
    }],
    temperature: 0.1,
    max_tokens: 32,
  });

  const text = await groqRequest(body);
  const match = text.match(/\{[^}]*"x"\s*:\s*(\d+)[^}]*"y"\s*:\s*(\d+)[^}]*\}/);
  if (!match) throw new Error('no coords');
  return { x: parseInt(match[1]), y: parseInt(match[2]) };
}

// ── Send prompt: wait for idle → click → type → submit ───────────────────────

async function sendPrompt(text) {
  const start = Date.now();

  // Block until Kiro is stably idle — never inject while writing or thinking
  let idleSince = null;
  while (true) {
    if (Date.now() - start > PROMPT_TIMEOUT_MS) {
      throw new Error('Timed out waiting for Kiro to be idle');
    }

    const state = currentState.state;

    if (state === 'writing' || state === 'thinking') {
      console.log(`[vision] waiting — Kiro is ${state}…`);
      idleSince = null;
    } else if (state === 'waiting_for_input') {
      // The live loop handles this autonomously — just wait for it to resolve
      console.log('[vision] waiting — Kiro is waiting_for_input, auto-handling…');
      idleSince = null;
    } else {
      // idle
      if (idleSince === null) idleSince = Date.now();
      if (Date.now() - idleSince >= IDLE_STABILISE_MS) {
        console.log('[vision] Kiro is idle — sending prompt');
        break;
      }
    }

    await sleep(200);
  }

  // Ensure we have input bar coords
  if (!inputBarCoords) {
    inputBarCoords = await detectInputBarCoords().catch(() => getFallbackCoords());
  }

  // Write prompt to temp file
  const tmpFile = path.join(DATA_DIR, 'pending_prompt.txt');
  fs.writeFileSync(tmpFile, text, 'utf8');

  // Convert vision coords to logical screen coords (Retina correction)
  const lc = toLogical(inputBarCoords.x, inputBarCoords.y);

  // Click input, clear, paste, submit via AppleScript
  const script = `
tell application "System Events"
  tell process "Electron"
    set frontmost to true
    delay 0.4
    click at {${lc.x}, ${lc.y}}
    delay 0.4
    keystroke "a" using {command down}
    delay 0.1
    key code 51
    delay 0.2
    set the clipboard to (read POSIX file "${tmpFile}" as «class utf8»)
    delay 0.2
    keystroke "v" using {command down}
    delay 0.5
    key code 36
  end tell
end tell`;

  const scriptFile = path.join(DATA_DIR, 'send_prompt.applescript');
  fs.writeFileSync(scriptFile, script, 'utf8');
  execSync(`osascript "${scriptFile}"`);
}

// ── Auto-click waiting_for_input buttons ─────────────────────────────────────

async function handleWaitingForInput() {
  try {
    execSync(`screencapture -x "${SCREENSHOT_PATH}"`, { stdio: 'ignore' });
    const base64 = fs.readFileSync(SCREENSHOT_PATH).toString('base64');

    const body = JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `The Kiro IDE is waiting for user input. Your job is to identify every clickable element that needs a response and pick the best one to click.

Look for:
- Submit / Continue / Accept / Approve / Run / Confirm / Yes / OK buttons
- Multiple choice options (click the recommended or first one)
- Any highlighted or pulsing interactive element

Return ONLY a JSON array (no markdown):
[{"label":"<button text>","x":<center x pixel>,"y":<center y pixel>,"recommended":<true if highlighted/preferred>}]

Rules:
- recommended=true for anything visually highlighted, labelled "Recommended", or the primary action
- If multiple options, mark the safest/most-continue-forward one as recommended
- If nothing is visible, return []`,
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${base64}` },
          },
        ],
      }],
      temperature: 0.1,
      max_tokens: 512,
    });

    const text = await groqRequest(body);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;

    const elements = JSON.parse(match[0]);
    if (!Array.isArray(elements) || elements.length === 0) return;

    const target = elements.find(e => e.recommended) ?? elements[0];
    console.log(`[vision] clicking "${target.label}" at (${target.x}, ${target.y})`);
    const logical = toLogical(target.x, target.y);
    const script = `tell application "System Events" to tell process "Electron" to click at {${logical.x}, ${logical.y}}`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    await sleep(600);
  } catch (e) {
    console.error('[vision] handleWaitingForInput error:', e.message);
  }
}

// ── Command socket ────────────────────────────────────────────────────────────

function startCommandServer() {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);

      let msg;
      try { msg = JSON.parse(line); } catch {
        sock.write(JSON.stringify({ ok: false, error: 'invalid json' }) + '\n');
        return;
      }

      handleCommand(msg, sock);
    });
  });

  server.listen(VISION_SOCK, () => {
    console.log(`[vision] Command socket ready at ${VISION_SOCK}`);
    fs.writeFileSync(path.join(DATA_DIR, 'vision.ready'), '1');
  });
}

async function handleCommand(msg, sock) {
  const reply = (data) => sock.write(JSON.stringify(data) + '\n');

  switch (msg.type) {
    case 'get_state':
      reply({ ok: true, ...currentState });
      break;

    case 'send_prompt':
      try {
        await sendPrompt(msg.text);
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
      break;

    case 'ping':
      reply({ ok: true });
      break;

    default:
      reply({ ok: false, error: `unknown type: ${msg.type}` });
  }
}

// ── Groq HTTP (keep-alive) ────────────────────────────────────────────────────

function groqRequest(body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      agent: keepAliveAgent,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.choices?.[0]?.message?.content?.trim() ?? '');
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// Detect display scale factor (Retina = 2, standard = 1)
// screencapture produces physical pixels; AppleScript clicks use logical pixels
// so we divide vision coords by the scale factor before clicking
let _scaleFactor = null;
function getScaleFactor() {
  if (_scaleFactor !== null) return _scaleFactor;
  try {
    const out = execSync(
      `osascript -e 'tell application "System Events" to tell process "Electron" to get bounds of front window'`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
    const logical = out.match(/\d+/g)?.map(Number);

    // Compare logical window width to screenshot pixel width
    if (logical?.length === 4) {
      const logicalW = logical[2] - logical[0];
      execSync(`screencapture -x "${SCREENSHOT_PATH}"`, { stdio: 'ignore' });
      // Use sips to get image width in pixels
      const sipsOut = execSync(`sips -g pixelWidth "${SCREENSHOT_PATH}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const physicalW = parseInt(sipsOut.match(/pixelWidth:\s*(\d+)/)?.[1] ?? '0');
      if (physicalW > 0 && logicalW > 0) {
        _scaleFactor = physicalW / logicalW;
        console.log(`[vision] display scale factor: ${_scaleFactor}`);
        return _scaleFactor;
      }
    }
  } catch {}
  _scaleFactor = 1;
  return _scaleFactor;
}

// Convert vision model pixel coords (physical) to logical screen coords for AppleScript
function toLogical(x, y) {
  const scale = getScaleFactor();
  return { x: Math.round(x / scale), y: Math.round(y / scale) };
}

function getWindowBounds() {
  try {
    const out = execSync(`osascript -e 'tell application "System Events" to tell process "Electron" to get bounds of front window'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const nums = out.match(/\d+/g)?.map(Number);
    if (nums?.length === 4) return nums;
  } catch {}
  return null;
}

function getFallbackCoords() {
  const bounds = getWindowBounds();
  if (bounds) {
    const [left, , right, bottom] = bounds;
    return { x: Math.round((left + right) / 2), y: bottom - 40 };
  }
  return { x: 720, y: 860 };
}

function readGroqApiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'ipm-terminal-frontend', '.env'),
    path.join(os.homedir(), 'Documents', 'E2M', 'Internal AI Tools', 'IPM', '.env'),
    path.join(DATA_DIR, '.env'),
  ];
  for (const p of candidates) {
    try {
      const m = fs.readFileSync(p, 'utf8').match(/^GROQ_API_KEY\s*=\s*(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch {}
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main();

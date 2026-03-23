import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const SOCK_PATH = path.join(os.homedir(), '.ipm', 'ide.sock');
const VISION_SOCK = path.join(os.homedir(), '.ipm', 'vision.sock');
const READY_FILE = path.join(os.homedir(), '.ipm', 'bridge.ready');
const VISION_READY = path.join(os.homedir(), '.ipm', 'vision.ready');

// ── Connect to the IPM Bridge extension socket ────────────────────────────────
function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK_PATH);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

// Connect to the Vision Watcher socket
function connectVision() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(VISION_SOCK);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

// Send a JSON message and wait for a response line
function send(sock, msg) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        sock.off('data', onData);
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reject(e); }
      }
    };
    sock.on('data', onData);
    sock.write(JSON.stringify(msg) + '\n');
  });
}

// ── Auto-install the bridge extension ────────────────────────────────────────
// Copies ide-extension/ into ~/.kiro/extensions/ so the user doesn't have to
export function ensureBridgeInstalled() {
  try {
    const extDir = path.join(os.homedir(), '.kiro', 'extensions', 'ipm.ide-bridge-1.0.0');
    const srcDir = path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'ipm-terminal-frontend', 'ide-extension');

    // Also try local path (dev mode)
    const localSrc = new URL('../../ide-extension', import.meta.url).pathname;
    const src = fs.existsSync(localSrc) ? localSrc : srcDir;

    if (!fs.existsSync(src)) return; // can't find source, skip

    // Always copy — ensures latest extension is installed
    fs.mkdirSync(extDir, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, file), path.join(extDir, file));
    }

    // Register in extensions.json
    const extJson = path.join(os.homedir(), '.kiro', 'extensions', 'extensions.json');
    let list = [];
    try { list = JSON.parse(fs.readFileSync(extJson, 'utf8')); } catch {}
    const id = 'ipm.ide-bridge';
    if (!list.find(e => e.identifier?.id === id)) {
      list.push({
        identifier: { id },
        version: '1.0.0',
        location: {
          $mid: 1,
          fsPath: extDir,
          external: `file://${extDir}`,
          path: extDir,
          scheme: 'file',
        },
        relativeLocation: 'ipm.ide-bridge-1.0.0',
        metadata: { installedTimestamp: Date.now(), source: 'local' },
      });
      fs.writeFileSync(extJson, JSON.stringify(list, null, 2));
    }
  } catch {
    // Non-fatal — user can install manually
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function isBridgeReady() {
  return fs.existsSync(READY_FILE) && fs.existsSync(SOCK_PATH);
}

export function isVisionReady() {
  return fs.existsSync(VISION_READY);
}

export async function waitForBridge(timeoutMs = 15000, onStatus) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isBridgeReady()) return true;
    onStatus?.('Waiting for IDE to connect…');
    await sleep(1000);
  }
  return false;
}

export async function waitForVision(timeoutMs = 30000, onStatus) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isVisionReady()) return true;
    onStatus?.('Waiting for vision watcher…');
    await sleep(1000);
  }
  return false;
}

export async function openFolder(folderPath) {
  try {
    execSync(`kiro "${folderPath}"`, { stdio: 'ignore' });
  } catch {
    try { execSync(`open -a Kiro "${folderPath}"`, { stdio: 'ignore' }); } catch {}
  }
  await sleep(3000);
}

export async function sendPrompt(text) {
  // Vision watcher handles: wait for idle → click input → type → submit
  if (fs.existsSync(VISION_READY)) {
    try {
      const sock = await connectVision();
      const res = await send(sock, { type: 'send_prompt', text });
      sock.destroy();
      return res;
    } catch {
      // Fall through to legacy bridge path
    }
  }
  // Legacy: direct bridge socket
  const sock = await connect();
  const res = await send(sock, { type: 'prompt', text });
  sock.destroy();
  return res;
}

export async function readFile(filePath) {
  const sock = await connect();
  const res = await send(sock, { type: 'read_file', path: filePath });
  sock.destroy();
  if (!res.ok) throw new Error(res.error);
  return res.content;
}

export async function listFiles(dirPath, depth = 3) {
  const sock = await connect();
  const res = await send(sock, { type: 'list_files', path: dirPath, depth });
  sock.destroy();
  if (!res.ok) throw new Error(res.error);
  return res.files;
}

// Poll IDE for its current activity status
export async function pollKiroStatus() {
  try {
    const sock = await connect();
    const res = await send(sock, { type: 'get_status' });
    sock.destroy();
    return res.status || 'working';
  } catch {
    return 'working';
  }
}

// Poll current KiroState — prefers vision watcher, falls back to bridge
export async function pollKiroState() {
  // Try vision watcher first (real-time, live)
  if (fs.existsSync(VISION_READY)) {
    try {
      const sock = await connectVision();
      const res = await send(sock, { type: 'get_state' });
      sock.destroy();
      if (res.ok && res.state !== undefined) {
        return { state: res.state, since: res.since, lastResponseText: res.lastResponseText ?? '' };
      }
    } catch {}
  }
  // Fall back to bridge socket
  try {
    const sock = await connect();
    const res = await send(sock, { type: 'get_kiro_state' });
    sock.destroy();
    if (!res.ok || res.state === undefined) {
      return { state: 'idle', since: Date.now(), lastResponseText: '' };
    }
    return { state: res.state, since: res.since, lastResponseText: res.lastResponseText };
  } catch {
    return { state: 'idle', since: Date.now(), lastResponseText: '' };
  }
}

// Get the last captured response text
export async function getLastResponse() {
  if (fs.existsSync(VISION_READY)) {
    try {
      const sock = await connectVision();
      const res = await send(sock, { type: 'get_state' });
      sock.destroy();
      if (res.ok) return res.lastResponseText ?? '';
    } catch {}
  }
  try {
    const sock = await connect();
    const res = await send(sock, { type: 'get_last_response' });
    sock.destroy();
    if (!res.ok) return '';
    return res.text ?? '';
  } catch {
    return '';
  }
}

// Read terminal snapshot from disk (~/.ipm/terminal_snapshot.txt)
export async function readTerminalSnapshot() {
  const snapshotPath = path.join(os.homedir(), '.ipm', 'terminal_snapshot.txt');
  try {
    return fs.readFileSync(snapshotPath, 'utf8');
  } catch {
    return '';
  }
}

// Trigger UIInteractor — vision watcher handles this autonomously now,
// but this is kept for manual/fallback calls from runner.js
export async function handleUiInteraction() {
  // Vision watcher auto-handles waiting_for_input in its loop — nothing to do
  if (fs.existsSync(VISION_READY)) {
    return { ok: true, action: 'handled_by_vision_watcher' };
  }
  try {
    const sock = await connect();
    const res = await send(sock, { type: 'handle_ui_interaction' });
    sock.destroy();
    return { ok: res.ok ?? false, action: res.action ?? 'unknown' };
  } catch {
    return { ok: false, action: 'socket_error' };
  }
}

export async function ping() {
  try {
    const sock = await connect();
    const res = await send(sock, { type: 'ping' });
    sock.destroy();
    return res.ok;
  } catch { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

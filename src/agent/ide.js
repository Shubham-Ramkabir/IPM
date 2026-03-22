import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const SOCK_PATH = path.join(os.homedir(), '.ipm', 'ide.sock');
const READY_FILE = path.join(os.homedir(), '.ipm', 'bridge.ready');

// ── Connect to the IPM Bridge extension socket ────────────────────────────────
function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK_PATH);
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

export async function waitForBridge(timeoutMs = 15000, onStatus) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isBridgeReady()) return true;
    onStatus?.('Waiting for IDE to connect…');
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

export async function ping() {
  try {
    const sock = await connect();
    const res = await send(sock, { type: 'ping' });
    sock.destroy();
    return res.ok;
  } catch { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

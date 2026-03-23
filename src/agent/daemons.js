/**
 * daemons.js
 * Spawns the vision watcher as a detached background process when IPM starts.
 * Safe to call multiple times — checks if already running before spawning.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = path.join(os.homedir(), '.ipm');
const VISION_SOCK = path.join(DATA_DIR, 'vision.sock');
const VISION_READY = path.join(DATA_DIR, 'vision.ready');
const VISION_LOG = path.join(DATA_DIR, 'vision.log');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHER_PATH = path.join(__dirname, '../vision/watcher.js');

export function spawnDaemons() {
  spawnVisionWatcher();
}

function spawnVisionWatcher() {
  // Already running if socket exists and is connectable
  if (fs.existsSync(VISION_READY) && fs.existsSync(VISION_SOCK)) {
    return; // already up
  }

  // Clean up stale ready file
  try { fs.unlinkSync(VISION_READY); } catch {}

  if (!fs.existsSync(WATCHER_PATH)) {
    console.error('[daemons] vision watcher not found at', WATCHER_PATH);
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const logFd = fs.openSync(VISION_LOG, 'a');

  const child = spawn(process.execPath, [WATCHER_PATH], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });

  child.unref(); // don't keep IPM alive waiting for it
  fs.closeSync(logFd);
}

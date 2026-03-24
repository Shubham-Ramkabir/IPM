/**
 * IDE Integration - Cursor Only
 * Removed Kiro integration as per user request.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { sendCursorPrompt, pollCursorState, openInCursor, getCursorState } from './cursor.js';

const DATA_DIR = path.join(os.homedir(), '.ipm');
const CURSOR_STATE_PATH = path.join(DATA_DIR, 'cursor_state.json');

export function isCursorReady() {
  return fs.existsSync(CURSOR_STATE_PATH);
}

export async function waitForCursor(timeoutMs = 30000, onStatus) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isCursorReady()) return true;
    onStatus?.('Waiting for Cursor to be ready…');
    await sleep(2000);
  }
  return false;
}

export async function openInIDE(folderPath) {
  return openInCursor(folderPath);
}

export async function sendPromptToIDE(text) {
  return sendCursorPrompt(text);
}

export async function pollIDEState() {
  return pollCursorState();
}

export async function getIDEResponse() {
  const state = getCursorState();
  return state.lastResponseText || '';
}

export async function listProjectFiles(dirPath, depth = 3) {
  const files = [];
  try {
    collectFiles(dirPath, files, '', depth);
  } catch (e) {
    console.error('[ide] Error listing files:', e.message);
  }
  return files;
}

function collectFiles(dir, files, prefix, depth) {
  if (depth <= 0) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(relPath + '/');
        collectFiles(fullPath, files, relPath, depth - 1);
      } else {
        files.push(relPath);
      }
    }
  } catch {}
}

export async function readProjectFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export function ensureIDEInstalled() {
  console.log('[ide] Using Cursor as the IDE');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

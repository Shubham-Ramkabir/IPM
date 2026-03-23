/**
 * ScreenPreview
 * Renders a live terminal preview of the vision watcher's screen captures.
 *
 * Strategy (in priority order):
 * 1. iTerm2 / Kitty / WezTerm inline image protocol — best quality, zero deps
 * 2. chafa CLI — ASCII art fallback if installed
 * 3. Plain state text — last resort
 */

import { createElement as h, useState, useEffect, useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const FRAME_PATH = path.join(os.homedir(), '.ipm', 'vision_frame.png');
const STATE_PATH = path.join(os.homedir(), '.ipm', 'kiro_state.json');
const REFRESH_MS = 350;

const STATE_COLOR = {
  idle:              '#00ff88',
  writing:           '#00ccff',
  thinking:          '#ffcc00',
  waiting_for_input: '#ff6400',
};

// ── Detect terminal image support ─────────────────────────────────────────────

function supportsInlineImages() {
  const term = process.env.TERM_PROGRAM || '';
  const termEnv = process.env.TERM || '';
  return (
    term === 'iTerm.app' ||
    term === 'WezTerm' ||
    termEnv === 'xterm-kitty' ||
    process.env.KITTY_WINDOW_ID !== undefined ||
    process.env.ITERM_SESSION_ID !== undefined
  );
}

function chafaAvailable() {
  try { execSync('which chafa', { stdio: 'ignore' }); return true; } catch { return false; }
}

// ── Render strategies ─────────────────────────────────────────────────────────

// iTerm2 / Kitty inline image escape sequence
function renderInlineImage(pngBuffer, widthCols, heightRows) {
  const b64 = pngBuffer.toString('base64');
  // iTerm2 protocol
  const iterm = `\x1b]1337;File=inline=1;width=${widthCols};height=${heightRows};preserveAspectRatio=1:${b64}\x07`;
  // Kitty protocol (simpler fallback)
  const kitty = `\x1b_Ga=T,f=100,m=0,q=2,c=${widthCols},r=${heightRows};${b64}\x1b\\`;

  const term = process.env.TERM_PROGRAM || '';
  const termEnv = process.env.TERM || '';
  if (termEnv === 'xterm-kitty' || process.env.KITTY_WINDOW_ID) return kitty;
  return iterm;
}

// chafa CLI — renders to colored unicode block art
function renderChafa(framePath, widthCols, heightRows) {
  try {
    return execSync(
      `chafa --size=${widthCols}x${heightRows} --colors=256 --symbols=block "${framePath}"`,
      { encoding: 'utf8', timeout: 500 }
    );
  } catch {
    return null;
  }
}

// ── React component ───────────────────────────────────────────────────────────

export function ScreenPreview({ widthCols = 60, heightRows = 20 }) {
  const { stdout } = useStdout();
  const [kiroState, setKiroState] = useState('idle');
  const [frameSeq, setFrameSeq] = useState(0); // increment to trigger re-render
  const [renderMode, setRenderMode] = useState(null); // 'inline' | 'chafa' | 'text'
  const inlineRef = useRef(null);

  // Detect render mode once
  useEffect(() => {
    if (supportsInlineImages()) setRenderMode('inline');
    else if (chafaAvailable()) setRenderMode('chafa');
    else setRenderMode('text');
  }, []);

  // Poll for new frames
  useEffect(() => {
    const t = setInterval(() => {
      // Read state
      try {
        const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        setKiroState(s.state || 'idle');
      } catch {}

      // Trigger frame re-render
      if (fs.existsSync(FRAME_PATH)) {
        setFrameSeq(n => n + 1);
      }
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  // For inline image mode — write escape sequence directly to stdout
  useEffect(() => {
    if (renderMode !== 'inline') return;
    if (!fs.existsSync(FRAME_PATH)) return;

    try {
      const buf = fs.readFileSync(FRAME_PATH);
      const seq = renderInlineImage(buf, widthCols, heightRows);
      // Write to a ref div via raw stdout — Ink doesn't handle escape sequences
      // We use a placeholder Box and write above it
      if (inlineRef.current) {
        stdout.write('\x1b[s'); // save cursor
        stdout.write(seq);
        stdout.write('\x1b[u'); // restore cursor
      }
    } catch {}
  }, [frameSeq, renderMode]);

  const stateColor = STATE_COLOR[kiroState] || 'white';
  const stateLabel = {
    idle:              '● idle',
    writing:           '▶ writing',
    thinking:          '◌ thinking',
    waiting_for_input: '⚡ waiting for input',
  }[kiroState] || kiroState;

  if (renderMode === 'chafa') {
    let art = '';
    if (fs.existsSync(FRAME_PATH)) {
      art = renderChafa(FRAME_PATH, widthCols, heightRows) || '';
    }
    return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: stateColor, width: widthCols + 4 },
      h(Box, { paddingX: 1, justifyContent: 'space-between' },
        h(Text, { color: '#888' }, 'LIVE PREVIEW'),
        h(Text, { color: stateColor, bold: true }, stateLabel),
      ),
      art
        ? h(Text, null, art)
        : h(Text, { dimColor: true }, '  waiting for frame…'),
    );
  }

  if (renderMode === 'inline') {
    return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: stateColor, width: widthCols + 4 },
      h(Box, { paddingX: 1, justifyContent: 'space-between' },
        h(Text, { color: '#888' }, 'LIVE PREVIEW'),
        h(Text, { color: stateColor, bold: true }, stateLabel),
      ),
      h(Box, { ref: inlineRef, height: heightRows },
        h(Text, { dimColor: true }, ' ') // placeholder — image rendered via escape seq
      ),
    );
  }

  // Text fallback — show state + last response snippet
  let lastText = '';
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    lastText = (s.lastResponseText || '').slice(0, widthCols * 3);
  } catch {}

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: stateColor, width: widthCols + 4, paddingX: 1 },
    h(Box, { justifyContent: 'space-between' },
      h(Text, { color: '#888' }, 'KIRO STATUS'),
      h(Text, { color: stateColor, bold: true }, stateLabel),
    ),
    lastText
      ? h(Text, { wrap: 'wrap', dimColor: true }, lastText)
      : h(Text, { dimColor: true }, 'No response yet…'),
  );
}

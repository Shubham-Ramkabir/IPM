import { createElement as h, useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import figlet from 'figlet';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Transform } from 'stream';
import fs from 'fs';
import { getConfig, setConfig } from '../db/index.js';
import { initNotion, listDocs } from '../agent/notion.js';
import { runBuild } from '../agent/runner.js';
import { ensureIDEInstalled } from '../agent/ide.js';
import { ScreenPreview } from './ScreenPreview.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

const ENV_PATH = join(__dirname, '../../.env');

function validateEnvironment() {
  if (!process.env.OPENROUTER_API_KEY && !process.env.GROQ_API_KEY) {
    console.error('\n❌ IPM Startup Failed: OPENROUTER_API_KEY is not set.\n');
    console.error('Please create a .env file in the project root:');
    console.error('  cp .env.example .env');
    console.error('  # Then edit .env and add your OpenRouter API key\n');
    process.exit(1);
  }
  console.log('✓ Environment validated');
  console.log('✓ Using Cursor IDE only');
  console.log('✓ Architecture: TLI | PMC | CRM | TSP | DCL | MNC\n');
}
validateEnvironment();

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

let ipmArt = 'IPM';
try { ipmArt = figlet.textSync('IPM', { font: 'Small' }); } catch (_) {}

const ORANGE = '#FF6400';

const AGENT_COLOR = {
  TLI:            '#FF6400',
  PMC:            '#00ccff',
  CRM:            '#00ff88',
  TSP:            '#ffcc00',
  DCL:            '#ff4466',
  MNC:            '#cc88ff',
  cursor:         '#00ff88',
  tui:            '#ffffff',
  all:            '#888888',
  runner:         '#aaaaaa',
};

const AGENT_LABEL = {
  TLI:            'Agent TLI',
  PMC:            'Agent PMC',
  CRM:            'Agent CRM',
  TSP:            'Agent TSP',
  DCL:            'Agent DCL',
  MNC:            'Agent MNC',
  cursor:         'Cursor',
  tui:            'TUI',
  all:            'ALL',
  runner:         'Runner',
  responseAnalyst: 'ResponseAnalyst',
};

const LOBSTER = [
  [
    '              .  .  .  .  .  .  .  .              ',
    '         \\  . . . . . . . . . . . . .  /          ',
    '          \\ . . . . . . . . . . . . . /           ',
    '    +--+   +--------------------+   +--+          ',
    '   /    \\ .  +------------------+  /    \\         ',
    '  |  +--+ . |   O.        .O   | +--+  |         ',
    '  |  +--+ . |      .  .  .     | +--+  |         ',
    '   \\    / . |    +-----------+  |  \\    /         ',
    '    +--+  . |    +-----------+  |   +--+          ',
    '          . +----------+--------+ .               ',
    '          . . . . . . ===. . . . . .              ',
    '          . . . . .  ====  . . . . .              ',
    '          . . . . . =====. . . . . .              ',
    '          . . . . .  ====  . . . . .              ',
    '          . . . . . . . . . . . . . .             ',
  ],
  [
    '              .  .  .  .  .  .  .  .              ',
    '         \\  . . . . . . . . . . . . .  /          ',
    '          \\ . . . . . . . . . . . . . /           ',
    '    +--+   +--------------------+   +--+          ',
    '   /    \\ .  +------------------+  /    \\         ',
    '  |  +--+ . |  . O.      .O .   | +--+  |        ',
    '  |  +--+ . |      .  .  .      | +--+  |        ',
    '   \\    / . |    +-----------+   |  \\    /        ',
    '    +--+  . |    +-----------+   |   +--+         ',
    '          . +----------+--------+ .               ',
    '          . . . . . . ===. . . . . .              ',
    '          . . . . .  ====  . . . . .              ',
    '          . . . . . =====. . . . . .              ',
    '          . . . . .  ====  . . . . .              ',
    '          . . . . . . . . . . . . . .             ',
  ],
  [
    '              .  .  .  .  .  .  .  .              ',
    '         \\  . . . . . . . . . . . . .  /          ',
    '          \\ . . . . . . . . . . . . . /           ',
    '    +--+   +--------------------+   +--+          ',
    '   /    \\ .  +------------------+  /    \\         ',
    '  |  +--+ . |    . O.  . . .O   | +--+  |        ',
    '  |  +--+ . |      .  .  .      | +--+  |        ',
    '   \\    / . |    +-----------+   |  \\    /        ',
    '    +--+  . |    +-----------+   |   +--+         ',
    '          . +----------+--------+ .               ',
    '          . . . . . . ===. . . . . .              ',
    '          . . . . .  ====  . . . . .              ',
    '          . . . . . =====. . . . . .              ',
    '          . . . . .  ====  . . . . .              ',
    '          . . . . . . . . . . . . . .             ',
  ],
];

// Mouse scroll interceptor
let _mouseCallback = null;
function installMouseInterceptor() {
  const stdin = process.stdin;
  if (!stdin?.isTTY || stdin._mouseInterceptInstalled) return;
  stdin._mouseInterceptInstalled = true;
  process.stdout.write('\x1b[?1000h');
  process.stdout.write('\x1b[?1006h');
  const interceptor = new Transform({
    transform(chunk, _enc, cb) {
      let clean = chunk.toString('binary');
      clean = clean.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_f, btn) => {
        const b = parseInt(btn, 10);
        if (b === 64 && _mouseCallback) _mouseCallback(3);
        if (b === 65 && _mouseCallback) _mouseCallback(-3);
        return '';
      });
      let out = '';
      for (let i = 0; i < clean.length; i++) {
        if (clean[i] === '\x1b' && clean[i+1] === '[' && clean[i+2] === 'M' && i+5 < clean.length+1) {
          const b = clean.charCodeAt(i+3) - 32;
          if (b === 64 && _mouseCallback) _mouseCallback(3);
          if (b === 65 && _mouseCallback) _mouseCallback(-3);
          i += 5;
        } else { out += clean[i]; }
      }
      if (out) cb(null, Buffer.from(out, 'binary')); else cb();
    },
  });
  stdin.pipe(interceptor);
  stdin.unpipe?.();
  interceptor.on('data', buf => stdin.emit('data', buf));
  process.on('exit', () => {
    process.stdout.write('\x1b[?1000l');
    process.stdout.write('\x1b[?1006l');
  });
}
function useMouseScroll(onScroll) {
  useEffect(() => {
    _mouseCallback = onScroll;
    installMouseInterceptor();
    return () => { _mouseCallback = null; };
  }, [onScroll]);
}

// Splash screen
function Splash({ onDone }) {
  const [frame, setFrame] = useState(0);
  const [dots, setDots] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const seq = [0,1,2,1,0,1,2,1,0,1,2];
    let i = 0;
    const t = setInterval(() => {
      i++;
      if (i < seq.length) setFrame(seq[i]);
      else { clearInterval(t); setTimeout(() => { setDone(true); onDone(); }, 400); }
    }, 300);
    const d = setInterval(() => setDots(x => (x+1)%4), 220);
    return () => { clearInterval(t); clearInterval(d); };
  }, []);
  if (done) return h(Box, null);
  const dotStr = ('· ').repeat(dots+1).trimEnd();
  return h(Box, { flexDirection: 'column', alignItems: 'center', paddingY: 1 },
    ...LOBSTER[frame].map((line, i) => h(Text, { key: i, color: ORANGE, bold: true }, line)),
    h(Box, { marginTop: 1, flexDirection: 'column', alignItems: 'center' },
      h(Text, { color: ORANGE, bold: true }, '~  Welcome to IPM  ~'),
      h(Text, { dimColor: true }, 'Autonomous IDE Agent - powered by Groq'),
      h(Box, { marginTop: 1 }, h(Text, { color: ORANGE }, dotStr + '  loading  ' + dotStr))
    )
  );
}

// Token setup screen
function TokenSetup({ onDone }) {
  const [step, setStep] = useState('notion'); // 'notion' | 'cursor'
  const [notionToken, setNotionToken] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { exit } = useApp();

  useInput((inp, key) => {
    if (loading) return;
    if (key.escape || (key.ctrl && inp === 'c')) { exit(); return; }
    if (key.return) {
      const t = value.trim();
      if (!t) { setError('Cannot be empty'); return; }
      setLoading(true); setError('');

      if (step === 'notion') {
        initNotion(t);
        listDocs()
          .then(() => {
            setConfig('notion_token', t);
            setNotionToken(t);
            setValue('');
            setStep('cursor');
            setLoading(false);
          })
          .catch(e => { setLoading(false); setError('Invalid token: ' + e.message); });
      } else {
        // Cursor API key — store in db + write to .env
        setConfig('cursor_api_key', t);
        writeCursorKeyToEnv(t);
        setLoading(false);
        onDone(notionToken);
      }
      return;
    }
    if (key.backspace || key.delete) { setValue(v => v.slice(0, -1)); return; }
    if (inp && !key.ctrl && !key.meta) setValue(v => v + inp);
  });

  const isNotion = step === 'notion';
  const label    = isNotion ? 'Notion Integration Token' : 'Cursor API Key';
  const hint     = isNotion
    ? 'Create one at: notion.so/my-integrations'
    : 'Find yours at: cursor.com/settings → API Keys';
  const stepText = isNotion ? 'Step 1 of 2' : 'Step 2 of 2';

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: ORANGE, paddingX: 2, paddingY: 1 },
    h(Text, { color: ORANGE, bold: true }, '🦞 IPM - First Time Setup  (' + stepText + ')'),
    h(Box, { marginTop: 1 }),
    h(Text, { wrap: 'wrap' }, isNotion
      ? 'IPM needs your Notion Integration Token to read your project documentation.'
      : 'IPM needs your Cursor API Key to inject prompts directly into Cursor.'),
    h(Text, { dimColor: true }, hint),
    h(Box, { marginTop: 1 }),
    h(Text, { color: ORANGE }, 'Paste your ' + label + ':'),
    h(Box, { borderStyle: 'round', borderColor: loading ? 'gray' : ORANGE, paddingX: 1, marginTop: 1 },
      h(Text, { color: ORANGE, bold: true }, '> '),
      h(Text, null, loading ? 'Validating...' : (value || ' ')),
      !loading && h(Text, { dimColor: true }, '_')
    ),
    error && h(Text, { color: 'red', marginTop: 1 }, 'x ' + error),
    h(Text, { dimColor: true, marginTop: 1 }, 'Press Enter to confirm · Esc to exit')
  );
}

// Doc picker screen
function DocPicker({ docs, onSelect }) {
  const { stdout } = useStdout();
  const termHeight = stdout.rows || 30;
  const maxVisible = Math.max(3, Math.min(docs.length, termHeight - 14));
  const [cursor, setCursor] = useState(0);
  const [viewTop, setViewTop] = useState(0);
  const { exit } = useApp();
  useInput((_in, key) => {
    if (key.escape || (_in === 'c' && key.ctrl)) { exit(); return; }
    if (key.upArrow) {
      const n = Math.max(0, cursor - 1);
      setCursor(n);
      setViewTop(t => n < t ? n : t);
    }
    if (key.downArrow) {
      const n = Math.min(docs.length - 1, cursor + 1);
      setCursor(n);
      setViewTop(t => n >= t + maxVisible ? n - maxVisible + 1 : t);
    }
    if (key.return) onSelect(docs[cursor]);
  });
  const visible = docs.slice(viewTop, viewTop + maxVisible);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: ORANGE, paddingX: 2, paddingY: 1 },
    h(Text, { color: ORANGE, bold: true }, '🦞 IPM - Choose a Notion Document'),
    h(Text, { dimColor: true }, docs.length + ' pages  ·  up/down navigate  ·  Enter select  ·  Esc exit'),
    h(Box, { marginTop: 1 }),
    viewTop > 0 && h(Text, { color: ORANGE, dimColor: true }, '  ^ more above'),
    ...visible.map((doc, i) => {
      const ri = viewTop + i;
      const active = ri === cursor;
      return h(Box, { key: doc.id },
        h(Text, {
          color: active ? 'black' : 'white',
          backgroundColor: active ? ORANGE : undefined,
          bold: active,
        }, (active ? ' > ' : '   ') + doc.title)
      );
    }),
    viewTop + maxVisible < docs.length && h(Text, { color: ORANGE, dimColor: true }, '  v more below')
  );
}

// Live agent-to-agent communication panel
function AgentCommsPanel({ entries, scrollOffset, height }) {
  const start = Math.max(0, entries.length - height - scrollOffset);
  const visible = entries.slice(start, start + height);

  // Find the most recent cursorState entry to show above the panel
  const lastCursorState = [...entries].reverse().find(e => e.type === 'cursorState');

  return h(Box, { flexDirection: 'column', height, overflow: 'hidden' },
    lastCursorState && h(Text, { color: '#00ff88', bold: true }, 'Cursor: ' + lastCursorState.msg),
    visible.length === 0
      ? h(Text, { dimColor: true }, '  Waiting for agents...')
      : visible.map((e, i) => {
          if (e._bus) {
            const fromColor = AGENT_COLOR[e.from] || 'white';
            const toColor   = AGENT_COLOR[e.to]   || 'white';
            const fromLabel = AGENT_LABEL[e.from]  || e.from;
            const toLabel   = AGENT_LABEL[e.to]    || e.to;
            const typeIcon  = {
              status:   '.',
              plan:     '*',
              prompt:   '>',
              analysis: '#',
              check:    e.content.startsWith('v') ? 'v' : 'x',
              request:  '?',
              issues:   '!',
            }[e.type] || '.';
            const msgColor = e.type === 'check'
              ? (e.content.startsWith('v') ? 'green' : 'red')
              : 'white';
            return h(Box, { key: i },
              h(Text, { color: fromColor, bold: true }, fromLabel),
              h(Text, { dimColor: true }, ' -> '),
              h(Text, { color: toColor, bold: true }, toLabel),
              h(Text, { dimColor: true }, '  ' + typeIcon + '  '),
              h(Text, { color: msgColor, wrap: 'truncate' }, e.content)
            );
          }
          const typeColor = {
            info: 'white', thinking: ORANGE, prompting: 'cyan',
            cursor: 'green', reading: '#6699ff', detail: 'gray',
            done: 'green', error: 'red',
          }[e.type] || 'white';
          const typeIcon = {
            info: '.', thinking: '~', prompting: '>',
            cursor: '*', reading: '#', detail: ' ',
            done: 'v', error: 'x',
          }[e.type] || '.';
          return h(Box, { key: i },
            h(Text, { color: typeColor, wrap: 'truncate' }, typeIcon + ' ' + e.msg)
          );
        })
  );
}

// Main App
function App() {
  const [phase, setPhase] = useState('init');
  const [docs, setDocs] = useState([]);
  const [log, setLog] = useState([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [projectPath, setProjectPath] = useState('');
  const { stdout } = useStdout();
  const { exit } = useApp();

  const termHeight = stdout.rows || 30;
  const termWidth  = stdout.columns || 100;
  const ipmLines   = ipmArt.split('\n');
  const CHROME     = 2 + 2 + ipmLines.length + 1 + 1 + 2 + 1;
  const panelH     = Math.max(5, termHeight - CHROME);
  const innerWidth = Math.max(20, termWidth - 6);

  const addLog = useCallback((entry) => {
    setLog(prev => [...prev, entry]);
    setScrollOffset(0);
  }, []);

  useEffect(() => {
    if (phase !== 'init') return;
    ensureBridgeInstalled();
    spawnDaemons();
    const token = getConfig('notion_token');
    const cursorKey = getConfig('cursor_api_key');
    if (token && cursorKey) { initNotion(token); setPhase('loading_docs'); }
    else setPhase('token');
  }, [phase]);

  useEffect(() => {
    if (phase !== 'loading_docs') return;
    listDocs()
      .then(d => { setDocs(d); setPhase('docs'); })
      .catch(e => { addLog({ msg: 'Failed to load Notion docs: ' + e.message, type: 'error' }); setPhase('error'); });
  }, [phase]);

  useInput((_i, key) => {
    if (phase !== 'building' && phase !== 'done' && phase !== 'error') return;
    if (key.upArrow)   setScrollOffset(o => o + 2);
    if (key.downArrow) setScrollOffset(o => Math.max(0, o - 2));
    if (key.escape || (_i === 'c' && key.ctrl)) exit();
  });
  useMouseScroll(useCallback(delta => setScrollOffset(o => Math.max(0, o + delta)), []));

  function handleDocSelect(doc) {
    setPhase('building');
    runBuild({
      docId:        doc.id,
      docTitle:     doc.title,
      onStatus:     addLog,
      onBusMessage: (entry) => addLog({ ...entry, _bus: true }),
      onDone:       (p) => { setProjectPath(p); setPhase('done'); },
      onError:      (e) => { addLog({ msg: e.message, type: 'error' }); setPhase('error'); },
    });
  }

  if (phase === 'init') return h(Box, null, h(Text, { dimColor: true }, 'Loading...'));

  if (phase === 'token') {
    return h(Box, { flexDirection: 'column', height: termHeight, width: termWidth, paddingX: 2, paddingY: 1 },
      h(Box, { flexDirection: 'column', alignItems: 'center', marginBottom: 1 },
        ...ipmLines.map((line, i) => h(Text, { key: i, color: ORANGE, bold: true }, line))
      ),
      h(TokenSetup, { onDone: () => setPhase('loading_docs') })
    );
  }

  if (phase === 'loading_docs') {
    return h(Box, { flexDirection: 'column', height: termHeight, width: termWidth, alignItems: 'center', justifyContent: 'center' },
      h(Text, { color: ORANGE }, '🦞  Loading Notion documents...')
    );
  }

  if (phase === 'docs') {
    return h(Box, { flexDirection: 'column', height: termHeight, width: termWidth, paddingX: 2, paddingY: 1 },
      h(Box, { flexDirection: 'column', alignItems: 'center', marginBottom: 1 },
        ...ipmLines.map((line, i) => h(Text, { key: i, color: ORANGE, bold: true }, line))
      ),
      h(DocPicker, { docs, onSelect: handleDocSelect })
    );
  }

  const canUp   = scrollOffset < log.length - panelH;
  const canDown = scrollOffset > 0;
  const borderColor = phase === 'done' ? 'green' : phase === 'error' ? 'red' : ORANGE;

  // Reserve ~36 cols for the preview panel if terminal is wide enough
  const showPreview = termWidth >= 120;
  const previewCols = showPreview ? 52 : 0;
  const commsWidth  = termWidth - previewCols - 8; // 8 = borders + padding

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor,
    paddingX: 2,
    paddingY: 1,
    height: termHeight,
    width: termWidth,
    overflow: 'hidden',
  },
    h(Box, { flexDirection: 'column', alignItems: 'center', marginBottom: 1 },
      ...ipmLines.map((line, i) => h(Text, { key: i, color: ORANGE, bold: true }, line)),
      h(Text, { dimColor: true }, 'Agent Communications  ·  scroll: mouse/up-down  ·  Esc: exit')
    ),
    h(Box, { marginBottom: 1 },
      h(Text, { color: ORANGE, dimColor: true }, '-'.repeat(Math.min(innerWidth, 64)))
    ),
    // Main content row: agent comms + live preview side by side
    h(Box, { flexDirection: 'row', flexGrow: 1 },
      // Left: agent comms panel
      h(Box, { flexDirection: 'column', width: commsWidth },
        canUp   && h(Text, { color: ORANGE, dimColor: true }, '  ^ older messages'),
        h(AgentCommsPanel, { entries: log, scrollOffset, height: panelH }),
        canDown && h(Text, { color: ORANGE, dimColor: true }, '  v newer messages'),
      ),
      // Right: live screen preview (only if terminal wide enough)
      showPreview && h(Box, { marginLeft: 2 },
        h(ScreenPreview, { widthCols: previewCols, heightRows: panelH }),
      ),
    ),
    phase === 'done' && h(Box, { marginTop: 1 },
      h(Text, { color: 'green', bold: true }, 'v Build complete -> ' + projectPath)
    ),
    phase === 'error' && h(Box, { marginTop: 1 },
      h(Text, { color: 'red' }, 'x Build failed. Scroll up to see errors.')
    )
  );
}

// Root
function Root() {
  const [ready, setReady] = useState(false);
  return ready ? h(App, null) : h(Splash, { onDone: () => setReady(true) });
}

if (!process.stdout.isTTY) {
  process.stderr.write('IPM requires an interactive terminal.\n');
  process.exit(1);
}

render(h(Root, null));

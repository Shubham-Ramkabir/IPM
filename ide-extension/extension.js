// IPM Bridge Extension
// Listens on a Unix socket at ~/.ipm/ide.sock
// Receives JSON messages from IPM CLI and executes them in the IDE

const vscode = require('vscode');
const net = require('net');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execSync, exec } = require('child_process');

const SOCK_PATH = path.join(os.homedir(), '.ipm', 'ide.sock');
const DATA_DIR = path.join(os.homedir(), '.ipm');
const KIRO_STATE_PATH = path.join(os.homedir(), '.ipm', 'kiro_state.json');
const TERMINAL_SNAPSHOT_PATH = path.join(os.homedir(), '.ipm', 'terminal_snapshot.txt');

let server;
let outputChannel;
let lastKiroActivity = 'idle';
let lastKiroActivityTime = Date.now();

// StatePoller in-memory state
let currentKiroState = { state: 'idle', since: Date.now(), lastResponseText: '' };
let stateChangedAt = Date.now();

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('IPM Bridge');
  outputChannel.appendLine('IPM Bridge activating...');

  // Ensure data dir exists
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Remove stale socket
  if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH);

  server = net.createServer(handleConnection);
  server.listen(SOCK_PATH, () => {
    outputChannel.appendLine(`IPM Bridge listening on ${SOCK_PATH}`);
    fs.writeFileSync(path.join(DATA_DIR, 'bridge.ready'), '1');
  });

  context.subscriptions.push({ dispose: () => {
    server.close();
    if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH);
    const readyFile = path.join(DATA_DIR, 'bridge.ready');
    if (fs.existsSync(readyFile)) fs.unlinkSync(readyFile);
  }});

  startStatePoller();
}

function handleConnection(socket) {
  let buf = '';
  socket.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleMessage(msg, socket);
      } catch (e) {
        socket.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
      }
    }
  });
}

async function handleMessage(msg, socket) {
  const reply = (data) => socket.write(JSON.stringify(data) + '\n');

  try {
    switch (msg.type) {
      case 'ping':
        reply({ ok: true, type: 'pong' });
        break;

      case 'open_folder': {
        const uri = vscode.Uri.file(msg.path);
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
        reply({ ok: true });
        break;
      }

      case 'prompt': {
        lastKiroActivity = 'receiving prompt';
        lastKiroActivityTime = Date.now();

        const tmpFile = path.join(DATA_DIR, 'pending_prompt.txt');
        const scriptFile = path.join(DATA_DIR, 'send_prompt.applescript');
        fs.writeFileSync(tmpFile, msg.text, 'utf8');

        try {
          await sendPromptViaAppleScript(tmpFile, scriptFile);
          outputChannel.appendLine('Prompt sent successfully');
        } catch (e) {
          outputChannel.appendLine('Prompt delivery error: ' + e.message);
          reply({ ok: false, error: e.message });
          return;
        }

        lastKiroActivity = 'building';
        lastKiroActivityTime = Date.now();
        reply({ ok: true });
        break;
      }

      case 'read_file': {
        const content = fs.readFileSync(msg.path, 'utf8');
        reply({ ok: true, content });
        break;
      }

      case 'list_files': {
        const files = walkDir(msg.path, msg.depth || 3);
        reply({ ok: true, files });
        break;
      }

      case 'get_status': {
        const age = Date.now() - lastKiroActivityTime;
        const status = age < 10000 ? lastKiroActivity : 'idle';
        reply({ ok: true, status });
        break;
      }

      case 'get_kiro_state': {
        const kiroState = readKiroStateFile();
        reply({ ok: true, state: kiroState.state, since: kiroState.since, lastResponseText: kiroState.lastResponseText });
        break;
      }

      case 'handle_ui_interaction': {
        const result = await handleUiInteraction();
        reply({ ok: result.ok, action: result.action });
        break;
      }

      case 'get_last_response': {
        const stateForResponse = readKiroStateFile();
        reply({ ok: true, text: stateForResponse.lastResponseText });
        break;
      }

      default:
        reply({ ok: false, error: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    reply({ ok: false, error: err.message });
  }
}

// ── StatePoller ───────────────────────────────────────────────────────────────

const VALID_KIRO_STATES = ['writing', 'thinking', 'waiting_for_input', 'idle'];

async function classifyKiroState(screenshotFile) {
  try {
    const apiKey = readGroqApiKey();
    if (!apiKey) throw new Error('GROQ_API_KEY not found');

    const imageData = fs.readFileSync(screenshotFile);
    const base64Image = imageData.toString('base64');

    const body = JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This is a screenshot of the Kiro IDE chat panel. Classify the current state of the AI assistant. Reply with ONLY one of these exact strings — no explanation, no punctuation, no extra text:\n- writing (if text is actively streaming/appearing in the chat)\n- thinking (if a spinner or loading indicator is visible but no new text)\n- waiting_for_input (if a button or interactive element is visible awaiting user action)\n- idle (if none of the above)',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}` },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 16,
    });

    const responseText = await groqHttpRequest(body, apiKey);
    const classified = responseText.trim().toLowerCase();
    if (VALID_KIRO_STATES.includes(classified)) return classified;

    // If the model returned something unexpected, default to idle
    outputChannel.appendLine(`classifyKiroState: unexpected response "${classified}", defaulting to idle`);
    return 'idle';
  } catch (e) {
    outputChannel.appendLine('classifyKiroState error: ' + e.message);
    // Return previous known state as fallback
    return currentKiroState.state;
  }
}

async function captureLastResponse(screenshotFile) {
  try {
    const apiKey = readGroqApiKey();
    if (!apiKey) throw new Error('GROQ_API_KEY not found');

    const imageData = fs.readFileSync(screenshotFile);
    const base64Image = imageData.toString('base64');

    const body = JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This is a screenshot of the Kiro IDE chat panel. Extract and return the full visible text of the AI assistant\'s most recent (last) response message. Return ONLY the text content of that response — no labels, no formatting, no explanation. If no response is visible, return an empty string.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}` },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 2048,
    });

    return await groqHttpRequest(body, apiKey);
  } catch (e) {
    outputChannel.appendLine('captureLastResponse error: ' + e.message);
    return '';
  }
}

async function captureTerminalText() {
  try {
    // First try AppleScript to read terminal content from Kiro's integrated terminal
    const script = `
tell application "System Events"
  tell process "Electron"
    set frontmost to true
    delay 0.2
  end tell
end tell
-- Use screencapture to get terminal area, then fall back to clipboard method
do shell script "echo ''"`;

    // Attempt to get terminal text via AppleScript clipboard trick
    const clipboardScript = `
tell application "System Events"
  tell process "Electron"
    -- Focus the terminal panel and select all text
    keystroke "j" using {command down}
    delay 0.3
    keystroke "a" using {command down}
    delay 0.1
    keystroke "c" using {command down}
    delay 0.2
  end tell
end tell
return the clipboard`;

    try {
      const terminalText = execSync(`osascript -e '${clipboardScript.replace(/'/g, "'\\''")}'`, {
        timeout: 5000,
      }).toString().trim();
      if (terminalText) return terminalText;
    } catch {
      // AppleScript approach failed, fall through to vision
    }

    // Fallback: take a screenshot and use GroqVision to extract terminal text
    const screenshotFile = path.join(DATA_DIR, 'kiro_terminal.png');
    execSync(`screencapture -x "${screenshotFile}"`);
    await sleep(100);

    const apiKey = readGroqApiKey();
    if (!apiKey) return '';

    const imageData = fs.readFileSync(screenshotFile);
    const base64Image = imageData.toString('base64');

    const body = JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This is a screenshot of the Kiro IDE. Extract and return the full visible text content from the integrated terminal panel (the bottom panel showing command output). Return ONLY the terminal text — no explanation. If no terminal is visible, return an empty string.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}` },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 2048,
    });

    return await groqHttpRequest(body, apiKey);
  } catch (e) {
    outputChannel.appendLine('captureTerminalText error: ' + e.message);
    return '';
  }
}

function startStatePoller() {
  setInterval(async () => {
    try {
      const screenshotFile = path.join(DATA_DIR, 'kiro_screen.png');
      execSync(`screencapture -x "${screenshotFile}"`);
      await sleep(100);

      const newState = await classifyKiroState(screenshotFile);
      const prevState = currentKiroState.state;

      if (newState !== prevState) {
        stateChangedAt = Date.now();
      }

      // Capture last response text on idle transition
      let lastResponseText = currentKiroState.lastResponseText;
      if (newState === 'idle' && prevState !== 'idle') {
        lastResponseText = await captureLastResponse(screenshotFile);
      }

      currentKiroState = { state: newState, since: stateChangedAt, lastResponseText };

      // Write kiro_state.json
      try {
        fs.writeFileSync(KIRO_STATE_PATH, JSON.stringify(currentKiroState));
      } catch (e) {
        outputChannel.appendLine('startStatePoller: failed to write kiro_state.json: ' + e.message);
      }

      // Capture terminal text and write snapshot
      const terminalText = await captureTerminalText();
      try {
        fs.writeFileSync(TERMINAL_SNAPSHOT_PATH, terminalText);
      } catch (e) {
        outputChannel.appendLine('startStatePoller: failed to write terminal_snapshot.txt: ' + e.message);
      }
    } catch (e) {
      outputChannel.appendLine('startStatePoller tick error: ' + e.message);
    }
  }, 500);
}

// ── UIInteractor ──────────────────────────────────────────────────────────────

/**
 * Use GroqVision to identify all visible interactive elements in a screenshot.
 * Returns an array of { label, x, y, recommended } objects.
 * Returns empty array on failure.
 */
async function detectInteractiveElements(screenshotFile) {
  try {
    const apiKey = readGroqApiKey();
    if (!apiKey) throw new Error('GROQ_API_KEY not found');

    const imageData = fs.readFileSync(screenshotFile);
    const base64Image = imageData.toString('base64');

    const body = JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This is a screenshot of the Kiro IDE. Identify ALL visible interactive elements (buttons, options, checkboxes, links, etc.) that are awaiting user action. For each element return a JSON array where each item has: "label" (text on the element), "x" (center pixel x coordinate), "y" (center pixel y coordinate), "recommended" (true if the element is highlighted, labelled "Recommended", or visually emphasised as the preferred choice, otherwise false). Return ONLY the JSON array — no explanation, no markdown fences. Example: [{"label":"Accept","x":800,"y":600,"recommended":true},{"label":"Dismiss","x":900,"y":600,"recommended":false}]. If no interactive elements are visible, return [].',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}` },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 512,
    });

    const responseText = await groqHttpRequest(body, apiKey);

    // Extract JSON array from response
    const match = responseText.match(/\[[\s\S]*\]/);
    if (!match) {
      outputChannel.appendLine('detectInteractiveElements: no JSON array in response: ' + responseText.slice(0, 100));
      return [];
    }

    const elements = JSON.parse(match[0]);
    if (!Array.isArray(elements)) return [];

    // Normalise each element to ensure required fields
    return elements.map(el => ({
      label: String(el.label ?? ''),
      x: Number(el.x ?? 0),
      y: Number(el.y ?? 0),
      recommended: Boolean(el.recommended),
    }));
  } catch (e) {
    outputChannel.appendLine('detectInteractiveElements error: ' + e.message);
    return [];
  }
}

/**
 * Pick the best target from a list of interactive elements.
 * Returns the recommended element if one exists, otherwise the first element.
 * Returns null if the array is empty.
 */
function pickTarget(elements) {
  if (!elements || elements.length === 0) return null;
  const recommended = elements.find(el => el.recommended === true);
  return recommended ?? elements[0];
}

/**
 * Click at the given screen coordinates using AppleScript.
 */
async function clickViaAppleScript(x, y) {
  const script = `tell application "System Events" to tell process "Electron" to click at {${x}, ${y}}`;
  execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
}

/**
 * Handle a UI interaction: take screenshot → detect elements → pick target →
 * click → wait 800 ms → re-read state file.
 * Retries up to 3 times if state remains waiting_for_input.
 * Returns { ok: boolean, action: string }.
 */
async function handleUiInteraction() {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Take screenshot
      const screenshotFile = path.join(DATA_DIR, 'kiro_ui.png');
      execSync(`screencapture -x "${screenshotFile}"`);
      await sleep(100);

      // Detect interactive elements
      const elements = await detectInteractiveElements(screenshotFile);

      if (elements.length === 0) {
        outputChannel.appendLine(`handleUiInteraction attempt ${attempt}: no interactive elements detected`);
        await sleep(800);
        const state = readKiroStateFile();
        if (state.state !== 'waiting_for_input') {
          return { ok: true, action: 'No elements detected but state cleared' };
        }
        continue;
      }

      // Pick target
      const target = pickTarget(elements);
      outputChannel.appendLine(`handleUiInteraction attempt ${attempt}: clicking "${target.label}" at (${target.x}, ${target.y})`);

      // Click via AppleScript
      await clickViaAppleScript(target.x, target.y);

      // Wait and re-check state
      await sleep(800);
      const newState = readKiroStateFile();

      if (newState.state !== 'waiting_for_input') {
        const action = `Clicked: ${target.label}`;
        outputChannel.appendLine(`handleUiInteraction: success — ${action}`);
        return { ok: true, action };
      }

      outputChannel.appendLine(`handleUiInteraction attempt ${attempt}: state still waiting_for_input after click`);
    } catch (e) {
      outputChannel.appendLine(`handleUiInteraction attempt ${attempt} error: ${e.message}`);
    }
  }

  // All 3 attempts failed
  outputChannel.appendLine('handleUiInteraction: ui_stuck after 3 attempts');
  return { ok: false, action: 'ui_stuck' };
}

/**
 * Read the current KiroState from the state file, falling back to in-memory state.
 */
function readKiroStateFile() {
  try {
    const raw = fs.readFileSync(KIRO_STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return currentKiroState;
  }
}

// ── Shared Groq HTTP helper ───────────────────────────────────────────────────

function groqHttpRequest(body, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content ?? '';
          resolve(content.trim());
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Groq API timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Vision-guided prompt injection ───────────────────────────────────────────

async function sendPromptViaAppleScript(tmpFile, scriptFile) {
  // 1. Bring Electron (Kiro) to front
  execSync(`osascript -e 'tell application "System Events" to tell process "Electron" to set frontmost to true'`);
  await sleep(800);

  // 2. Take screenshot
  const screenshotFile = path.join(DATA_DIR, 'kiro_screen.png');
  execSync(`screencapture -x "${screenshotFile}"`);
  await sleep(200);

  // 3. Find input bar coordinates via vision
  let coords;
  try {
    coords = await findInputBarCoords(screenshotFile);
    outputChannel.appendLine(`Vision coords: ${JSON.stringify(coords)}`);
  } catch (e) {
    outputChannel.appendLine('Vision failed, using fallback coords: ' + e.message);
    // Fallback: use a heuristic — bottom-center of screen
    coords = await getFallbackCoords();
  }

  // 4. Click the input, clear it, paste, submit
  const script = `
tell application "System Events"
  tell process "Electron"
    set frontmost to true
    delay 0.4
    click at {${coords.x}, ${coords.y}}
    delay 0.5
    -- Select all existing text and delete it (avoid appending to previous prompt)
    keystroke "a" using {command down}
    delay 0.1
    key code 51
    delay 0.2
    -- Paste the new prompt
    set the clipboard to (read POSIX file "${tmpFile}" as «class utf8»)
    delay 0.2
    keystroke "v" using {command down}
    delay 0.5
    -- Submit with Enter
    key code 36
  end tell
end tell`;

  fs.writeFileSync(scriptFile, script, 'utf8');
  execSync(`osascript "${scriptFile}"`);
}

// ── Find input bar coordinates using Groq vision ─────────────────────────────

function findInputBarCoords(screenshotFile) {
  return new Promise((resolve, reject) => {
    const apiKey = readGroqApiKey();
    if (!apiKey) return reject(new Error('GROQ_API_KEY not found'));

    const imageData = fs.readFileSync(screenshotFile);
    const base64Image = imageData.toString('base64');

    const body = JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This is a screenshot of the Kiro IDE. Find the chat input text field at the bottom of the screen (the text box where you type messages to the AI assistant). Return ONLY a JSON object with the center pixel coordinates of that input field: {"x": number, "y": number}. No explanation, just JSON.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}` },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 64,
    });

    groqHttpRequest(body, apiKey).then(content => {
      const match = content.match(/\{[^}]*"x"\s*:\s*(\d+)[^}]*"y"\s*:\s*(\d+)[^}]*\}/);
      if (!match) throw new Error('No coords in response: ' + content.slice(0, 100));
      resolve({ x: parseInt(match[1]), y: parseInt(match[2]) });
    }).catch(reject);
  });
}

// ── Fallback: estimate input bar position from screen size ───────────────────

function getFallbackCoords() {
  return new Promise((resolve) => {
    try {
      // Get screen dimensions via AppleScript
      const out = execSync(`osascript -e 'tell application "System Events" to tell process "Electron" to get bounds of front window'`).toString().trim();
      // bounds = {left, top, right, bottom}
      const nums = out.match(/\d+/g).map(Number);
      if (nums.length === 4) {
        const [left, top, right, bottom] = nums;
        // Input bar is typically ~40px from the bottom, horizontally centered
        resolve({ x: Math.round((left + right) / 2), y: bottom - 40 });
        return;
      }
    } catch {}
    // Last resort: hardcoded center-bottom for a typical 1440x900 display
    resolve({ x: 720, y: 860 });
  });
}

// ── Read GROQ_API_KEY from .env file ─────────────────────────────────────────

function readGroqApiKey() {
  // Try process.env first (in case it was set before extension loaded)
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;

  // Try reading from known .env locations
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'ipm-terminal-frontend', '.env'),
    path.join(os.homedir(), 'Documents', 'E2M', 'Internal AI Tools', 'IPM', '.env'),
    path.join(DATA_DIR, '.env'),
  ];

  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^GROQ_API_KEY\s*=\s*(.+)$/m);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    } catch {}
  }
  return null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function walkDir(dir, maxDepth, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    results.push(full);
    if (e.isDirectory()) results.push(...walkDir(full, maxDepth, depth + 1));
  }
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function deactivate() {
  server?.close();
}

module.exports = { activate, deactivate };

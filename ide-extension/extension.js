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

let server;
let outputChannel;
let lastKiroActivity = 'idle';
let lastKiroActivityTime = Date.now();

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

      default:
        reply({ ok: false, error: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    reply({ ok: false, error: err.message });
  }
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
    // Read .env for API key (extension runs in a different env than the CLI)
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
          const match = content.match(/\{[^}]*"x"\s*:\s*(\d+)[^}]*"y"\s*:\s*(\d+)[^}]*\}/);
          if (!match) throw new Error('No coords in response: ' + content.slice(0, 100));
          resolve({ x: parseInt(match[1]), y: parseInt(match[2]) });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Vision API timeout')); });
    req.write(body);
    req.end();
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

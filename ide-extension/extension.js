// IPM Bridge Extension
// Listens on a Unix socket at ~/.ipm/ide.sock
// Receives JSON messages from IPM CLI and executes them in the IDE

const vscode = require('vscode');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    // Signal ready
    fs.writeFileSync(path.join(DATA_DIR, 'bridge.ready'), '1');
  });

  context.subscriptions.push({ dispose: () => {
    server.close();
    if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH);
    if (fs.existsSync(path.join(DATA_DIR, 'bridge.ready'))) {
      fs.unlinkSync(path.join(DATA_DIR, 'bridge.ready'));
    }
  }});
}

function handleConnection(socket) {
  let buf = '';
  socket.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line
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
        fs.writeFileSync(tmpFile, msg.text, 'utf8');

        // AppleScript: bring Kiro to front, click chat input, paste, submit
        // The chat input sits above the bottom toolbar (~55px from bottom)
        const script = `
set promptText to (read POSIX file "${tmpFile}" as «class utf8»)
tell application "System Events"
  set the clipboard to promptText
  tell process "Kiro"
    set frontmost to true
    delay 0.8
    set winBounds to bounds of front window
    set winLeft to item 1 of winBounds
    set winTop to item 2 of winBounds
    set winRight to item 3 of winBounds
    set winBottom to item 4 of winBounds
    set inputX to (winLeft + winRight) / 2
    set inputY to winBottom - 55
    click at {inputX, inputY}
    delay 0.5
    keystroke "a" using {command down}
    delay 0.1
    keystroke "v" using {command down}
    delay 0.4
    key code 36
  end tell
end tell`;

        try {
          const { execSync } = require('child_process');
          // Write script to file to avoid shell escaping issues
          const scriptFile = path.join(DATA_DIR, 'send_prompt.applescript');
          fs.writeFileSync(scriptFile, script, 'utf8');
          execSync(`osascript "${scriptFile}"`);
          outputChannel.appendLine('Prompt sent via AppleScript click');
        } catch (e) {
          outputChannel.appendLine('AppleScript error: ' + e.message);
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
        // Return current Kiro activity based on recency
        const age = Date.now() - lastKiroActivityTime;
        const status = age < 10000 ? lastKiroActivity : 'idle';
        reply({ ok: true, status });
        break;
      }

      case 'get_ui_info': {
        // Returns Kiro window bounds for debugging click coordinates
        try {
          const { execSync } = require('child_process');
          const out = execSync(`osascript -e 'tell application "System Events" to tell process "Kiro" to get bounds of front window'`).toString().trim();
          reply({ ok: true, bounds: out });
        } catch (e) {
          reply({ ok: false, error: e.message });
        }
        break;
      }

      default:
        reply({ ok: false, error: `Unknown message type: ${msg.type}` });
    }
  } catch (err) {
    reply({ ok: false, error: err.message });
  }
}

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

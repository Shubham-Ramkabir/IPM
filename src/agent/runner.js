import path from 'path';
import os from 'os';
import fs from 'fs';
import chokidar from 'chokidar';
import { readPage } from './notion.js';
import { openFolder, sendPrompt, listFiles, waitForBridge, pollKiroStatus } from './ide.js';
import { saveRun, updateRunStatus } from '../db/index.js';
import {
  MessageBus,
  orchestratorAgent,
  promptWriterAgent,
  fileAnalystAgent,
  checkerAgent,
  statusAgent,
  getModelAssignments,
} from './agents.js';

const PROJECTS_DIR = path.join(os.homedir(), 'Documents', 'IPM Projects');

// Map bus message types to TUI log types
function busEntryToLog(entry) {
  const typeMap = {
    status:   entry.from === 'checker'      ? 'info'
             : entry.from === 'promptWriter' ? 'prompting'
             : entry.from === 'fileAnalyst'  ? 'reading'
             : 'info',
    plan:     'thinking',
    prompt:   'prompting',
    analysis: 'reading',
    check:    entry.content.startsWith('✓') ? 'done' : 'error',
  };
  const icon = {
    orchestrator: '🧠',
    promptWriter:  '✍',
    fileAnalyst:   '📄',
    checker:       '🔍',
    statusAgent:   '·',
  };
  const ic = icon[entry.from] || '·';
  return {
    msg: `${ic} [${entry.from}→${entry.to}] ${entry.content}`,
    type: typeMap[entry.type] || 'info',
  };
}

export async function runBuild({ docId, docTitle, onStatus, onBusMessage, onDone, onError }) {
  const log = (msg, type = 'info') => onStatus({ msg, type });

  // Bus messages go to onBusMessage (rendered as agent comms in TUI)
  // Falls back to plain log if onBusMessage not provided
  const bus = new MessageBus((entry) => {
    if (onBusMessage) onBusMessage(entry);
    else onStatus(busEntryToLog(entry));
  });

  try {
    // ── 1. Read Notion doc ──────────────────────────────────────────────────
    log('📖 Reading Notion documentation…', 'reading');
    const docContent = await readPage(docId);
    log(`Read ${docContent.split('\n').length} lines from "${docTitle}"`, 'info');

    // ── 2. Orchestrator builds the plan ────────────────────────────────────
    const models = await getModelAssignments();
    log(`🧠 Thinking… analysing project documentation`, 'thinking');
    const plan = await orchestratorAgent({ docContent, docTitle, bus });
    log(`Plan ready: ${plan.steps.length} steps — ${plan.summary}`, 'info');

    // ── 3. Create project folder ────────────────────────────────────────────
    const projectPath = path.join(PROJECTS_DIR, plan.projectName);
    fs.mkdirSync(projectPath, { recursive: true });
    log(`📁 Project folder created: ${projectPath}`, 'info');
    const runId = saveRun(docId, docTitle, projectPath);

    // ── 4. Check bridge ─────────────────────────────────────────────────────
    log('🔌 Connecting to IDE…', 'kiro');
    const bridgeReady = await waitForBridge(20000, (msg) => log(msg, 'info'));
    if (!bridgeReady) throw new Error('IDE not connected. Make sure Kiro is open and the IPM Bridge extension is active.');
    log('✓ IDE connected', 'kiro');

    // ── 5. Open project in IDE ─────────────────────────────────────────────
    log('Opening project in IDE…', 'kiro');
    await openFolder(projectPath);
    log('✓ Project opened in IDE', 'kiro');

    // ── 6. File watcher ─────────────────────────────────────────────────────
    const watcher = chokidar.watch(projectPath, { ignoreInitial: true, ignored: /(^|[/\\])\../ });
    watcher.on('all', (event, filePath) => {
      const rel = path.relative(projectPath, filePath);
      const verb = event === 'add' ? 'created' : event === 'change' ? 'updated' : event === 'unlink' ? 'deleted' : event;
      log(`⚙ IDE ${verb}: ${rel}`, 'kiro');
    });

    // ── 7. Execute each step with all agents ────────────────────────────────
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      log(`── Step ${i + 1} of ${plan.steps.length} ──────────────────`, 'info');
      log(step, 'detail');

      // Get current file tree for context
      log('📄 Reading project files…', 'reading');
      const fileTree = await listFiles(projectPath).catch(() => []);
      if (fileTree.length) log(`Found ${fileTree.length} files`, 'detail');

      // Prompt Writer crafts the exact IDE prompt
      log(`🧠 Thinking… crafting prompt for IDE`, 'thinking');
      const kiroPrompt = await promptWriterAgent({
        step,
        stepIndex: i,
        totalSteps: plan.steps.length,
        projectName: plan.projectName,
        fileTree,
        bus,
      });

      // Send to IDE
      log('→ Prompting IDE…', 'prompting');
      await sendPrompt(kiroPrompt);
      log('✓ Prompt sent to IDE', 'prompting');

      // Poll IDE status while it works
      log('⚙ IDE is building…', 'kiro');
      await waitForKiroWithStatus(watcher, 8000, log);

      // File Analyst reviews what was built
      const updatedTree = await listFiles(projectPath).catch(() => []);
      log(`📄 Reading files… reviewing ${updatedTree.length} files`, 'reading');      const analysis = await fileAnalystAgent({
        fileTree: updatedTree,
        projectName: plan.projectName,
        expectedStep: step,
        bus,
      });

      // Checker validates the step
      log('🔍 Checking build quality…', 'info');      const check = await checkerAgent({ step, fileTree: updatedTree, analysis, bus });

      if (!check.passed && check.retry) {
        log(`↩ Step ${i + 1} needs retry: ${check.reason}`, 'error');
        i--; // retry this step
        continue;
      }

      // Status agent gives a human summary
      const statusLine = await statusAgent({
        context: `Step ${i+1} done. Analysis: ${analysis.summary}. Check: ${check.reason}`,
        bus,
      });
      log(statusLine, check.passed ? 'done' : 'info');
    }

    watcher.close();
    updateRunStatus(runId, 'done');
    log('✓ All steps complete!', 'done');
    onDone(projectPath);

  } catch (err) {
    log(`✗ ${err.message}`, 'error');
    onError(err);
  }
}

// Wait until no file changes for idleMs, showing live IDE status in the log
async function waitForKiroWithStatus(watcher, idleMs, log) {
  const KIRO_MESSAGES = [
    'IDE is building…',
    'IDE is writing code…',
    'IDE is thinking…',
    'IDE is generating files…',
    'IDE is working…',
  ];
  let msgIdx = 0;

  return new Promise(resolve => {
    let lastChange = Date.now();
    const onChange = () => { lastChange = Date.now(); };
    watcher.on('all', onChange);

    // Rotate status messages every 3s so the user sees activity
    const statusInterval = setInterval(() => {
      log(`⚙ ${KIRO_MESSAGES[msgIdx % KIRO_MESSAGES.length]}`, 'kiro');
      msgIdx++;
    }, 3000);

    const check = setInterval(() => {
      if (Date.now() - lastChange >= idleMs) {
        clearInterval(check);
        clearInterval(statusInterval);
        watcher.off('all', onChange);
        resolve();
      }
    }, 500);

    // Safety timeout: 5 min
    setTimeout(() => {
      clearInterval(check);
      clearInterval(statusInterval);
      watcher.off('all', onChange);
      resolve();
    }, 5 * 60 * 1000);
  });
}

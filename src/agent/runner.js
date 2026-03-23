import path from 'path';
import os from 'os';
import fs from 'fs';
import chokidar from 'chokidar';
import { readPage } from './notion.js';
import { openFolder, sendPrompt, listFiles, waitForBridge, waitForVision, pollKiroState, getLastResponse, readTerminalSnapshot } from './ide.js';
import { sendCursorPrompt, openInCursor, pollCursorState } from './cursor.js';
import { saveRun, updateRunStatus } from '../db/index.js';
import {
  MessageBus,
  orchestratorAgent,
  promptWriterAgent,
  fileAnalystAgent,
  checkerAgent,
  statusAgent,
  responseAnalystAgent,
  mistakePrompterAgent,
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
    orchestrator:    '🧠',
    promptWriter:    '✍',
    fileAnalyst:     '📄',
    checker:         '🔍',
    statusAgent:     '·',
    responseAnalyst: '🔬',
    mistakePrompter: '⚠',
  };
  const ic = icon[entry.from] || '·';
  return {
    msg: `${ic} [${entry.from}→${entry.to}] ${entry.content}`,
    type: typeMap[entry.type] || 'info',
  };
}

export async function runBuild({ docId, docTitle, ide = 'kiro', onStatus, onBusMessage, onDone, onError }) {
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

    // ── 4. Check bridge + vision ────────────────────────────────────────────
    if (ide === 'kiro') {
      log('🔌 Connecting to IDE…', 'kiro');
      const bridgeReady = await waitForBridge(20000, (msg) => log(msg, 'info'));
      if (!bridgeReady) throw new Error('IDE not connected. Make sure Kiro is open and the IPM Bridge extension is active.');
      log('✓ IDE connected', 'kiro');

      log('👁 Waiting for vision watcher…', 'kiro');
      const visionReady = await waitForVision(30000, (msg) => log(msg, 'info'));
      if (!visionReady) log('⚠ Vision watcher not running — falling back to bridge state polling', 'info');
      else log('✓ Vision watcher live', 'kiro');
    } else {
      log('✓ Using Cursor API — no bridge needed', 'kiro');
    }

    // ── 5. Open project in IDE ─────────────────────────────────────────────
    log('Opening project in IDE…', 'kiro');
    if (ide === 'cursor') await openInCursor(projectPath);
    else await openFolder(projectPath);
    log('✓ Project opened in IDE', 'kiro');

    // ── 6. File watcher + fileChangeLog ────────────────────────────────────
    // Task 7.1: initialise fileChangeLog before the step loop
    const fileChangeLog = [];

    const watcher = chokidar.watch(projectPath, { ignoreInitial: true, ignored: /(^|[/\\])\../ });
    watcher.on('all', (event, filePath) => {
      const rel = path.relative(projectPath, filePath);
      const verb = event === 'add' ? 'created' : event === 'change' ? 'updated' : event === 'unlink' ? 'deleted' : event;
      log(`⚙ IDE ${verb}: ${rel}`, 'kiro');

      // Task 7.1: push change event and keep only last 20 entries
      fileChangeLog.push({ path: filePath, ts: Date.now(), event });
      if (fileChangeLog.length > 20) fileChangeLog.splice(0, fileChangeLog.length - 20);
    });

    // ── Helper: IDE-aware send + poll ──────────────────────────────────────
    const ideSend = async (text) => {
      if (ide === 'cursor') return sendCursorPrompt(text, projectPath);
      return sendPrompt(text);
    };
    const idePollState = async () => {
      if (ide === 'cursor') return pollCursorState();
      return pollKiroState();
    };
    const ideGetLastResponse = async () => {
      if (ide === 'cursor') return (await pollCursorState()).lastResponseText ?? '';
      return getLastResponse();
    };

    // ── 7. Execute each step with all agents ────────────────────────────────
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      log(`── Step ${i + 1} of ${plan.steps.length} ──────────────────`, 'info');
      log(step, 'detail');

      // Get current file tree for context
      log('📄 Reading project files…', 'reading');
      const fileTree = await listFiles(projectPath).catch(() => []);
      if (fileTree.length) log(`Found ${fileTree.length} files`, 'detail');

      // Read terminal snapshot for shared context
      const terminalSnapshot = await readTerminalSnapshot();

      // ── Step 1: PromptWriter → draft prompt ──────────────────────────────
      log(`🧠 Thinking… crafting prompt for IDE`, 'thinking');
      bus.post('runner', 'promptWriter', 'start', `step ${i}`);
      const kiroPrompt = await promptWriterAgent({
        step,
        stepIndex: i,
        totalSteps: plan.steps.length,
        projectName: plan.projectName,
        fileTree,
        bus,
        kiroState: null,
        terminalSnapshot,
        fileChangeLog: [...fileChangeLog],
      });
      bus.post('runner', 'promptWriter', 'end', `step ${i}`);

      // ── Step 2: waitForKiroIdle → ensure idle before sending ─────────────
      log('⏳ Waiting for Kiro to be idle before sending…', 'kiro');
      await waitForKiroIdle(log, bus);

      // ── Step 3: ResponseAnalyst → approve/rewrite prompt ─────────────────
      let approvedPrompt = kiroPrompt;
      let analystResult;
      const kiroStateBeforeSend = await idePollState();
      const terminalSnapshotBeforeSend = await readTerminalSnapshot();

      bus.post('runner', 'responseAnalyst', 'start', `step ${i}`);
      analystResult = await responseAnalystAgent({
        lastResponseText: kiroStateBeforeSend.lastResponseText || '',
        step,
        fileChangeLog: [...fileChangeLog],
        terminalSnapshot: terminalSnapshotBeforeSend,
        busContext: bus.contextFor('responseAnalyst'),
        bus,
        kiroState: kiroStateBeforeSend,
      });
      bus.post('runner', 'responseAnalyst', 'end', `step ${i}`);

      if (analystResult.approved && analystResult.nextPrompt) {
        approvedPrompt = analystResult.nextPrompt;
      } else if (!analystResult.approved) {
        // Fallback already handled inside responseAnalystAgent (returns approved:true after 3 retries)
        log('⚠ ResponseAnalyst fallback triggered — using PromptWriter prompt', 'info');
        approvedPrompt = kiroPrompt;
      }

      // ── Step 4: sendPrompt → send approved prompt ─────────────────────────
      log('→ Prompting IDE…', 'prompting');
      await ideSend(approvedPrompt);
      log('✓ Prompt sent to IDE', 'prompting');

      // ── Step 5: waitForKiroIdle → wait for Kiro to finish ────────────────
      log('⚙ IDE is building…', 'kiro');
      await waitForKiroIdle(log, bus);

      // ── Step 6: getLastResponse → capture response text ──────────────────
      const lastResponseText = await ideGetLastResponse();
      const terminalSnapshotAfter = await readTerminalSnapshot();
      const kiroStateAfter = await idePollState();

      // ── Step 7: ResponseAnalyst → read response, write next-step context ─
      bus.post('runner', 'responseAnalyst', 'start', `step ${i} post-response`);
      await responseAnalystAgent({
        lastResponseText,
        step,
        fileChangeLog: [...fileChangeLog],
        terminalSnapshot: terminalSnapshotAfter,
        busContext: bus.contextFor('responseAnalyst'),
        bus,
        kiroState: kiroStateAfter,
      });
      bus.post('runner', 'responseAnalyst', 'end', `step ${i} post-response`);

      // ── Step 8: MistakePrompter → check for errors ────────────────────────
      bus.post('runner', 'mistakePrompter', 'start', `step ${i}`);
      const mistakeResult = await mistakePrompterAgent({
        step,
        terminalSnapshot: terminalSnapshotAfter,
        fileChangeLog: [...fileChangeLog],
        lastResponseText,
        bus,
        kiroState: kiroStateAfter,
      });
      bus.post('runner', 'mistakePrompter', 'end', `step ${i}`);

      if (mistakeResult.hasError) {
        log(`⚠ Error detected: ${mistakeResult.errorSummary}`, 'error');

        // Sub-step: ResponseAnalyst → approve correction prompt
        const correctionKiroState = await idePollState();
        const correctionTerminal = await readTerminalSnapshot();

        bus.post('runner', 'responseAnalyst', 'start', `step ${i} correction`);
        const correctionAnalyst = await responseAnalystAgent({
          lastResponseText,
          step: mistakeResult.correctionPrompt,
          fileChangeLog: [...fileChangeLog],
          terminalSnapshot: correctionTerminal,
          busContext: bus.contextFor('responseAnalyst'),
          bus,
          kiroState: correctionKiroState,
        });
        bus.post('runner', 'responseAnalyst', 'end', `step ${i} correction`);

        const correctionPromptToSend = correctionAnalyst.approved && correctionAnalyst.nextPrompt
          ? correctionAnalyst.nextPrompt
          : mistakeResult.correctionPrompt;

        // Sub-step: sendPrompt → send correction
        await ideSend(correctionPromptToSend);
        log('✓ Correction prompt sent', 'prompting');

        // Sub-step: waitForKiroIdle
        await waitForKiroIdle(log, bus);

        // Sub-step: MistakePrompter re-check (once)
        const recheckLastResponse = await ideGetLastResponse();
        const recheckTerminal = await readTerminalSnapshot();
        const recheckKiroState = await idePollState();

        bus.post('runner', 'mistakePrompter', 'start', `step ${i} recheck`);
        await mistakePrompterAgent({
          step,
          terminalSnapshot: recheckTerminal,
          fileChangeLog: [...fileChangeLog],
          lastResponseText: recheckLastResponse,
          bus,
          kiroState: recheckKiroState,
        });
        bus.post('runner', 'mistakePrompter', 'end', `step ${i} recheck`);
      }

      // ── Step 9: FileAnalyst → review file tree + terminal + change log ───
      const updatedTree = await listFiles(projectPath).catch(() => []);
      const fileAnalystTerminal = await readTerminalSnapshot();
      const fileAnalystKiroState = await idePollState();

      log(`📄 Reading files… reviewing ${updatedTree.length} files`, 'reading');
      bus.post('runner', 'fileAnalyst', 'start', `step ${i}`);
      const analysis = await fileAnalystAgent({
        fileTree: updatedTree,
        projectName: plan.projectName,
        expectedStep: step,
        bus,
        terminalSnapshot: fileAnalystTerminal,
        fileChangeLog: [...fileChangeLog],
        kiroState: fileAnalystKiroState,
      });
      bus.post('runner', 'fileAnalyst', 'end', `step ${i}`);

      // ── Step 10: Checker → quality gate (retry logic unchanged) ──────────
      log('🔍 Checking build quality…', 'info');
      const checkerKiroState = await idePollState();
      const checkerTerminal = await readTerminalSnapshot();

      bus.post('runner', 'checker', 'start', `step ${i}`);
      const check = await checkerAgent({
        step,
        fileTree: updatedTree,
        analysis,
        bus,
        kiroState: checkerKiroState,
        terminalSnapshot: checkerTerminal,
        fileChangeLog: [...fileChangeLog],
      });
      bus.post('runner', 'checker', 'end', `step ${i}`);

      if (!check.passed && check.retry) {
        log(`↩ Step ${i + 1} needs retry: ${check.reason}`, 'error');
        i--; // retry this step
        continue;
      }

      // ── Step 11: StatusAgent → TUI summary ───────────────────────────────
      const statusKiroState = await idePollState();
      const statusTerminal = await readTerminalSnapshot();

      bus.post('runner', 'statusAgent', 'start', `step ${i}`);
      const statusLine = await statusAgent({
        context: `Step ${i+1} done. Analysis: ${analysis.summary}. Check: ${check.reason}`,
        bus,
        kiroState: statusKiroState,
        terminalSnapshot: statusTerminal,
        fileChangeLog: [...fileChangeLog],
      });
      bus.post('runner', 'statusAgent', 'end', `step ${i}`);

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

// Task 7.3: waitForKiroIdle — replaces waitForKiroWithStatus
// Poll pollKiroState() every 500ms; handle waiting_for_input; return on idle ≥ 1500ms; timeout at 10 min
export async function waitForKiroIdle(log, bus) {
  const POLL_INTERVAL = 500;
  const IDLE_STABILISE_MS = 1500;
  const TIMEOUT_MS = 10 * 60 * 1000;
  const STATUS_INTERVAL_MS = 3000;
  const KNOWN_KIRO_STATES = ['writing', 'thinking', 'waiting_for_input', 'idle'];

  const startTime = Date.now();
  let idleSince = null;
  let lastStatusEmit = 0;

  while (true) {
    const elapsed = Date.now() - startTime;

    // Timeout guard
    if (elapsed >= TIMEOUT_MS) {
      log('⚠ waitForKiroIdle: 10-minute timeout reached — proceeding', 'info');
      return;
    }

    const kiroState = await pollKiroState();
    const now = Date.now();

    // Treat undefined/unknown state as idle to avoid infinite loops
    const resolvedState = KNOWN_KIRO_STATES.includes(kiroState.state) ? kiroState.state : 'idle';

    // Emit TUI status every 3s
    if (now - lastStatusEmit >= STATUS_INTERVAL_MS) {
      bus.post('runner', 'tui', 'kiroState', `Kiro state: ${resolvedState}`);
      lastStatusEmit = now;
    }

    if (resolvedState === 'waiting_for_input') {
      // Trigger UIInteractor via ide.js socket
      try {
        const { handleUiInteraction } = await import('./ide.js');
        const result = await handleUiInteraction();
        log(`⚙ Kiro UI interaction: ${result.action}`, 'kiro');
        bus.post('runner', 'kiro', 'kiro', `Clicked: ${result.action}`);
      } catch {
        // handleUiInteraction may not be exported yet — fall through
      }
      idleSince = null;
    } else if (resolvedState === 'idle') {
      if (idleSince === null) idleSince = now;
      if (now - idleSince >= IDLE_STABILISE_MS) {
        return; // stable idle
      }
    } else {
      // writing or thinking — reset idle timer
      idleSince = null;
    }

    await sleep(POLL_INTERVAL);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

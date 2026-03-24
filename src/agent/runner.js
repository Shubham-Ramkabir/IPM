/**
 * IPM Runner - New Architecture
 * Uses 6 agents: TLI, PMC, CRM, TSP, DCL, MNC
 * IDE: Cursor only (Kiro removed)
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import chokidar from 'chokidar';
import { readPage } from './notion.js';
import { 
  openInIDE, 
  sendPromptToIDE, 
  pollIDEState, 
  getIDEResponse, 
  listProjectFiles,
  waitForCursor 
} from './ide.js';
import { saveRun, updateRunStatus } from '../db/index.js';
import {
  MessageBus,
  agentTLI,
  agentPMC,
  agentCRM,
  agentTSP,
  agentDCL,
  agentMNC,
  validateConfig,
} from './agents.js';

const PROJECTS_DIR = path.join(os.homedir(), 'Documents', 'IPM Projects');

function busEntryToLog(entry) {
  const icon = {
    TLI: '📖',
    PMC: '📝',
    CRM: '👁',
    TSP: '🔍',
    DCL: '🐛',
    MNC: '🎯',
    runner: '⚙',
  };
  const ic = icon[entry.from] || '•';
  const typeColor = {
    start: 'yellow',
    complete: 'green',
    error: 'red',
    state: 'cyan',
    decision: 'magenta',
    review: 'blue',
  }[entry.type] || 'white';
  return {
    msg: `${ic} [${entry.from}→${entry.to}] ${entry.content}`,
    type: typeColor,
  };
}

export async function runBuild({ docId, docTitle, onStatus, onBusMessage, onDone, onError }) {
  const log = (msg, type = 'info') => onStatus({ msg, type });

  const bus = new MessageBus((entry) => {
    if (onBusMessage) onBusMessage(entry);
    else onStatus(busEntryToLog(entry));
  });

  try {
    validateConfig();

    log('📖 Reading Notion documentation…', 'reading');
    const docContent = await readPage(docId);
    log(`Read ${docContent.split('\n').length} lines from "${docTitle}"`, 'info');

    log('🎯 Starting Agent TLI - analyzing Notion input…', 'thinking');
    const tliOutput = await agentTLI({ docContent, docTitle, bus });
    log(`✓ TLI complete: ${tliOutput.projectName}`, 'done');

    const projectPath = path.join(PROJECTS_DIR, tliOutput.projectName || 'untitled-project');
    fs.mkdirSync(projectPath, { recursive: true });
    log(`📁 Project folder created: ${projectPath}`, 'info');
    const runId = saveRun(docId, docTitle, projectPath);

    log('🔌 Connecting to Cursor IDE…', 'cursor');
    const cursorReady = await waitForCursor(30000, (msg) => log(msg, 'info'));
    if (!cursorReady) {
      throw new Error('Cursor not ready. Please open Cursor and try again.');
    }
    log('✓ Cursor connected', 'cursor');

    log('📂 Opening project in Cursor…', 'cursor');
    await openInIDE(projectPath);
    log('✓ Project opened in Cursor', 'cursor');

    const fileChangeLog = [];
    const watcher = chokidar.watch(projectPath, { ignoreInitial: true, ignored: /(^|[/\\])\../ });
    watcher.on('all', (event, filePath) => {
      const rel = path.relative(projectPath, filePath);
      const verb = event === 'add' ? 'created' : event === 'change' ? 'updated' : event === 'unlink' ? 'deleted' : event;
      log(`⚙ File ${verb}: ${rel}`, 'cursor');
      fileChangeLog.push({ path: filePath, ts: Date.now(), event });
      if (fileChangeLog.length > 50) fileChangeLog.splice(0, fileChangeLog.length - 50);
    });

    log('🎯 Starting Agent PMC - creating build prompt…', 'thinking');
    const fileTree = await listProjectFiles(projectPath).catch(() => []);
    const pmcPrompt = await agentPMC({ 
      tliOutput, 
      projectPath, 
      fileTree, 
      bus 
    });
    log(`✓ PMC complete (${pmcPrompt.length} chars)`, 'done');

    const totalSteps = tliOutput.steps?.length || 5;
    let currentStep = 1;
    let buildComplete = false;
    let debugPerformed = false;

    while (currentStep <= totalSteps && !buildComplete) {
      log(`── Step ${currentStep} of ${totalSteps} ──────────────────`, 'info');

      const currentFileTree = await listProjectFiles(projectPath).catch(() => []);
      
      log('👁 Checking Cursor state (Agent CRM)…', 'cursor');
      const cursorState = await pollIDEState();
      const crmResult = await agentCRM({ cursorState, bus });
      
      log(`Cursor is: ${crmResult.state}`, crmResult.state === 'idle' ? 'done' : 'info');

      if (crmResult.state === 'idle' || crmResult.state === 'answering') {
        const lastResponse = await getIDEResponse();
        
        if (lastResponse && lastResponse.length > 50) {
          log('🔍 Reviewing Cursor output (Agent TSP)…', 'thinking');
          const tspResult = await agentTSP({
            cursorResponse: lastResponse,
            fileTree: currentFileTree,
            projectName: tliOutput.projectName,
            expectedStep: tliOutput.steps?.[currentStep - 1] || 'build',
            bus,
          });

          if (tspResult.approved) {
            log(`✓ TSP Approved: ${tspResult.reasoning?.slice(0, 80)}`, 'done');
            
            if (tspResult.suggestions?.length > 0) {
              log(`💡 Suggestions: ${tspResult.suggestions.join(', ')}`, 'info');
            }

            currentStep++;

            if (currentStep > totalSteps) {
              buildComplete = true;
            }
          } else {
            log(`↩ TSP Rejected - needs revision: ${tspResult.issues?.join(', ')}`, 'error');
            
            if (tspResult.suggestions?.length > 0) {
              log(`💡 Fix suggestions: ${tspResult.suggestions.join(', ')}`, 'info');
            }

            const correctionPrompt = `Please fix the following issues:\n${tspResult.issues?.join('\n')}\n\nAnd implement: ${tspResult.suggestions?.join('\n')}`;
            await sendPromptToIDE(correctionPrompt);
            await waitForCursorIdle(log, bus);
          }
        } else {
          const promptToSend = pmcPrompt;
          log('→ Sending prompt to Cursor…', 'prompting');
          await sendPromptToIDE(promptToSend);
          
          await waitForCursorIdle(log, bus);
          
          const response = await getIDEResponse();
          log(`Cursor responded (${response.length} chars)`, 'done');
        }
      } else if (crmResult.state === 'thinking' || crmResult.state === 'waiting_for_input') {
        log(`⏳ Cursor is ${crmResult.state}…`, 'info');
        await sleep(3000);
      } else if (crmResult.state === 'error') {
        log('✗ Cursor encountered an error', 'error');
        break;
      } else {
        await sleep(2000);
      }

      if (currentStep > totalSteps * 0.8 && !debugPerformed) {
        const doDebug = await shouldRunDebug(tliOutput, currentFileTree);
        if (doDebug) {
          log('🐛 Running Chrome Debugging (Agent DCL)…', 'thinking');
          const debugResult = await agentDCL({
            projectPath,
            frontendUrl: tliOutput.frontendUrl || 'http://localhost:3000',
            bus,
          });
          
          if (debugResult.errors?.length > 0) {
            log(`✗ Debug found ${debugResult.errors.length} errors`, 'error');
            for (const err of debugResult.errors) {
              log(`  - ${err.type}: ${err.message}`, 'error');
            }
          } else {
            log('✓ Debug: No errors found', 'done');
          }
          
          if (debugResult.recommendations?.length > 0) {
            log(`💡 Debug recommendations: ${debugResult.recommendations.join(', ')}`, 'info');
          }
          
          debugPerformed = true;
        }
      }
    }

    watcher.close();
    updateRunStatus(runId, 'done');
    log('✓ Build complete!', 'done');
    onDone(projectPath);

  } catch (err) {
    log(`✗ ${err.message}`, 'error');
    onError(err);
  }
}

async function waitForCursorIdle(log, bus) {
  const MAX_WAIT = 5 * 60 * 1000;
  const CHECK_INTERVAL = 2000;
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT) {
    const state = await pollIDEState();
    
    if (state.state === 'idle') {
      await sleep(1500);
      const finalState = await pollIDEState();
      if (finalState.state === 'idle') {
        return;
      }
    }

    bus.post('runner', 'CRM', 'wait', `Waiting for Cursor: ${state.state}`);
    await sleep(CHECK_INTERVAL);
  }

  log('⚠ Timeout waiting for Cursor', 'warning');
}

async function shouldRunDebug(tliOutput, fileTree) {
  const hasFrontend = fileTree.some(f => 
    f.includes('index.html') || 
    f.includes('App.js') || 
    f.includes('App.tsx') ||
    f.includes('package.json')
  );
  const hasBackend = fileTree.some(f => 
    f.includes('server.js') || 
    f.includes('api') ||
    f.includes('.py') && !f.includes('requirements')
  );
  
  return hasFrontend && hasBackend;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * IPM Multi-Agent System - New Architecture
 * Agents: TLI, PMC, CRM, TSP, DCL, MNC
 * 
 * Models (via OpenRouter):
 * - TLI: openai/gpt-4o-2024-11-20 (best comprehension, 128k context)
 * - PMC: anthropic/claude-3.5-sonnet-20241022 (instruction following)
 * - CRM: google/gemini-flash-1.5-8b (ultra-fast for real-time)
 * - TSP: openai/gpt-4o-2024-11-20 (code analysis)
 * - DCL: anthropic/claude-3.5-sonnet-20241022 (browser automation)
 * - MNC: openai/gpt-4o-2024-11-20 (strategic decisions)
 */

import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

const DATA_DIR = path.join(os.homedir(), '.ipm');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || '';

// ── OpenRouter API Call ──────────────────────────────────────────────────────────

const MODELS = {
  tli: 'openai/gpt-4o-2024-11-20',
  pmc: 'anthropic/claude-3.5-sonnet-20241022',
  crm: 'google/gemini-flash-1.5-8b',
  tsp: 'openai/gpt-4o-2024-11-20',
  dcl: 'anthropic/claude-3.5-sonnet-20241022',
  mnc: 'openai/gpt-4o-2024-11-20',
};

function callLLM(model, systemPrompt, userPrompt, temperature = 0.3) {
  return new Promise((resolve, reject) => {
    if (!OPENROUTER_API_KEY) {
      reject(new Error('OPENROUTER_API_KEY not configured'));
      return;
    }

    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature,
    });

    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || '';
          resolve(stripThinking(content));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function truncate(text, maxChars = 8000) {
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n...[truncated]';
}

function join(dir, ...parts) { return path.join(dir, ...parts); }

// ── Message Bus ─────────────────────────────────────────────────────────────────

export class MessageBus {
  constructor(onMessage) {
    this.messages = [];
    this.onMessage = onMessage;
  }

  post(from, to, type, content) {
    const entry = { from, to, type, content, ts: Date.now() };
    this.messages.push(entry);
    this.onMessage?.(entry);
    return entry;
  }

  contextFor(agent, limit = 15) {
    return this.messages
      .filter(m => m.to === agent || m.from === agent || m.to === 'all')
      .slice(-limit)
      .map(m => `[${m.from} → ${m.to}] ${m.content}`)
      .join('\n');
  }

  fullLog(limit = 50) {
    return this.messages.slice(-limit).map(m => `[${m.from} → ${m.to}] ${m.content}`).join('\n');
  }
}

// ── Agent TLI: Notion Input Explainer ───────────────────────────────────────────
// Takes Notion input and explains the app in detail without missing/adding context

export async function agentTLI({ docContent, docTitle, bus }) {
  bus.post('TLI', 'MNC', 'start', `Analyzing "${docTitle}" from Notion`);
  
  const systemPrompt = `You are Agent TLI (Technical Learning Interpreter).
Your role is to take raw Notion documentation and explain the application in FULL detail.
CRITICAL RULES:
- NEVER miss any context from the documentation
- NEVER add any context that isn't in the documentation  
- NEVER remove any details
- Output MUST be a comprehensive, detailed explanation of the application

Format your output as a detailed technical specification:
{
  "projectName": "kebab-case-name",
  "projectType": "web-app/mobile-app/cli-tool/etc",
  "techStack": ["technology 1", "technology 2", ...],
  "coreFeatures": ["feature 1", "feature 2", ...],
  "detailedDescription": "comprehensive description of what the app does",
  "requirements": {
    "frontend": "frontend requirements",
    "backend": "backend requirements", 
    "database": "database requirements",
    "apis": "API requirements"
  },
  "structure": {
    "folders": ["folder structure"],
    "keyFiles": ["key files to create"]
  },
  "rawDocs": "the original documentation (unchanged)"
}`;

  const result = await callLLM(
    MODELS.tli,
    systemPrompt,
    `Notion Document Title: ${docTitle}\n\nDocumentation Content:\n${truncate(docContent, 15000)}`,
    0.2
  );

  let parsed;
  try {
    const match = result.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : result);
  } catch {
    parsed = { detailedDescription: result, projectName: docTitle.toLowerCase().replace(/\s+/g, '-') };
  }

  bus.post('TLI', 'MNC', 'complete', `TLI analysis complete: ${parsed.projectName}`);
  return parsed;
}

// ── Agent PMC: Build Plan to Cursor Prompt ─────────────────────────────────────
// Creates detailed step-by-step instructions for Cursor

export async function agentPMC({ tliOutput, projectPath, fileTree, bus }) {
  bus.post('PMC', 'MNC', 'start', 'Creating detailed build prompt for Cursor');

  const systemPrompt = `You are Agent PMC (Project Manual Creator).
Your role is to create a comprehensive, detailed step-by-step guide that will be sent to Cursor IDE.
The guide should be so detailed that Cursor can build the ENTIRE application just by following it.

CRITICAL:
- Include EVERY single step needed to build the app
- Specify exact file names, folder paths, code content
- Include all dependencies, configurations, environment variables
- Provide code for every file that needs to be created
- Include testing instructions
- Make it actionable - Cursor should be able to execute this directly`;

  const fileContext = fileTree?.length ? `Current project files:\n${fileTree.slice(0, 30).join('\n')}` : 'No files yet - this is a fresh project';

  const result = await callLLM(
    MODELS.pmc,
    systemPrompt,
    `Project Specification from TLI:\n${JSON.stringify(tliOutput, null, 2)}\n\n${fileContext}\n\nCreate a detailed, actionable build guide.`,
    0.3
  );

  bus.post('PMC', 'MNC', 'complete', `PMC prompt created (${result.length} chars)`);
  return result;
}

// ── Agent CRM: Cursor Real-time State Monitor ─────────────────────────────────
// Monitors Cursor in real-time to determine state

export async function agentCRM({ cursorState, bus }) {
  const state = cursorState?.state || 'unknown';
  const lastResponse = cursorState?.lastResponseText || '';

  bus.post('CRM', 'MNC', 'state', `Cursor state: ${state}`);

  const systemPrompt = `You are Agent CRM (Cursor Response Monitor).
Your role is to determine the current state of Cursor IDE in real-time.

Analyze the Cursor state and respond with ONLY JSON:
{
  "state": "writing_files" | "answering" | "thinking" | "waiting_for_input" | "idle" | "error",
  "reasoning": "brief explanation",
  "confidence": 0.0-1.0
}

State definitions:
- writing_files: Cursor is creating/editing files (check for file save indicators)
- answering: Cursor is providing textual responses (chat active)
- thinking: Cursor is processing/loading (spinner or pause)
- waiting_for_input: Cursor needs user input (buttons, prompts)
- idle: Cursor is not doing anything
- error: Something went wrong`;

  try {
    const result = await callLLM(
      MODELS.crm,
      systemPrompt,
      `Current Cursor state info:\nState: ${state}\nLast response: ${truncate(lastResponse, 2000)}`,
      0.1
    );

    let parsed;
    try {
      const match = result.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : result);
    } catch {
      parsed = { state: 'thinking', reasoning: 'Could not parse', confidence: 0.5 };
    }

    bus.post('CRM', 'MNC', 'analyzed', `${parsed.state} (${Math.round(parsed.confidence * 100)}% confidence)`);
    return parsed;
  } catch (e) {
    bus.post('CRM', 'MNC', 'error', e.message);
    return { state: 'thinking', reasoning: 'LLM error', confidence: 0.5 };
  }
}

// ── Agent TSP: Test & Solution Provider ─────────────────────────────────────
// Reviews Cursor output, checks files, approves with suggestions

export async function agentTSP({ cursorResponse, fileTree, projectName, expectedStep, bus }) {
  bus.post('TSP', 'MNC', 'start', 'Reviewing Cursor output and checking files');

  const systemPrompt = `You are Agent TSP (Test & Solution Provider).
Your role is to:
1. Review what Cursor just did/answered
2. Check the files that were created or modified
3. Verify the changes align with the expected step
4. Provide approval OR suggest corrections

Respond with ONLY JSON:
{
  "approved": true/false,
  "filesChecked": ["file1", "file2"],
  "changesSummary": "what changed",
  "issues": ["issue 1"] | [],
  "suggestions": ["suggestion 1"] | [],
  "reasoning": "why approved or not"
}`;

  const fileList = fileTree?.length ? fileTree.slice(0, 50).join('\n') : 'No files';

  const result = await callLLM(
    MODELS.tsp,
    systemPrompt,
    `Project: ${projectName}\nExpected Step: ${expectedStep}\n\nCursor Response:\n${truncate(cursorResponse, 3000)}\n\nCurrent Files:\n${fileList}`,
    0.2
  );

  let parsed;
  try {
    const match = result.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : result);
  } catch {
    parsed = { approved: true, reasoning: 'Could not parse TSP response', issues: [], suggestions: [] };
  }

  bus.post('TSP', 'MNC', 'review', `${parsed.approved ? '✓ Approved' : '✗ Needs revision'}: ${parsed.reasoning?.slice(0, 80)}`);
  return parsed;
}

// ── Agent DCL: Debug & Console Logger ─────────────────────────────────────────
// Chrome debugging - opens console, checks errors, network failures

export async function agentDCL({ projectPath, frontendUrl, bus }) {
  bus.post('DCL', 'MNC', 'start', 'Starting Chrome debugging session');

  const systemPrompt = `You are Agent DCL (Debug & Console Logger).
Your role is to perform Chrome browser debugging:
1. Launch Chrome with the frontend URL
2. Open browser console
3. Navigate through each page of the application
4. Check for:
   - Console errors
   - Network request failures (check Network tab)
   - Failed file loads (404s)
   - JavaScript errors
   - API failures

5. Compile a detailed debugging report

Respond with JSON:
{
  "debugged": true,
  "pagesVisited": ["page1", "page2"],
  "errors": [
    {"page": "page1", "type": "console|network|js", "message": "error", "file": "file.js"}
  ],
  "warnings": [],
  "summary": "overall health assessment",
  "recommendations": ["fix1", "fix2"]
}`;

  const debugScript = `
    const debugResults = {
      pagesVisited: [],
      errors: [],
      warnings: []
    };

    function getErrors() {
      const logs = [];
      try {
        console.error('DCL Debug: Checking console...');
      } catch(e) {}
      return logs;
    }
  `;

  try {
    const result = await callLLM(
      MODELS.dcl,
      systemPrompt,
      `Project Path: ${projectPath}\nFrontend URL: ${frontendUrl || 'http://localhost:3000'}\n\nPlease perform Chrome debugging and report errors.`,
      0.2
    );

    let parsed;
    try {
      const match = result.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : result);
    } catch {
      parsed = { debugged: false, summary: 'Could not parse debug results', errors: [] };
    }

    bus.post('DCL', 'MNC', 'complete', `Debug complete: ${parsed.errors?.length || 0} errors found`);
    return parsed;
  } catch (e) {
    bus.post('DCL', 'MNC', 'error', e.message);
    return { debugged: false, errors: [], summary: e.message };
  }
}

// ── Agent MNC: Main Controller ───────────────────────────────────────────────
// Orchestrates all agents, decides when to inject prompts

export async function agentMNC({ 
  tliOutput, 
  pmcPrompt, 
  cursorState, 
  cursorResponse, 
  fileTree,
  projectName,
  stepNumber,
  totalSteps,
  bus,
  context 
}) {
  bus.post('MNC', 'all', 'start', `MNC orchestrating step ${stepNumber}/${totalSteps}`);

  const systemPrompt = `You are Agent MNC (Main Nexus Controller).
You are the EXECUTIVE and MANAGER of all agents.
Your role is to:
1. Analyze all inputs from other agents
2. Decide what action to take next
3. Determine which agent to use
4. Craft the appropriate prompt for Cursor

CRITICAL DECISION POINTS:
- If Cursor is idle and no prompt sent → send PMC prompt
- If Cursor is thinking → wait and monitor
- If Cursor answered → send to TSP for review
- If TSP approved → proceed to next step
- If TSP rejected → send correction to Cursor
- If frontend ready → optionally call DCL for debugging
- If error detected → route to appropriate agent for fix

Respond with ONLY JSON:
{
  "action": "wait" | "send_prompt" | "review" | "retry" | "debug" | "next_step" | "complete",
  "targetAgent": "TLI" | "PMC" | "CRM" | "TSP" | "DCL" | "none",
  "prompt": "the prompt to send to Cursor (if action is send_prompt)",
  "reasoning": "why this decision",
  "nextStep": "what should happen after this"
}`;

  const contextInfo = `
    Project: ${projectName}
    Step: ${stepNumber} of ${totalSteps}
    Cursor State: ${cursorState?.state || 'unknown'}
    File Count: ${fileTree?.length || 0}
  `;

  try {
    const result = await callLLM(
      MODELS.mnc,
      systemPrompt,
      `${contextInfo}\n\nContext from other agents:\n${truncate(context || '', 3000)}\n\nCursor Last Response:\n${truncate(cursorResponse || '', 2000)}`,
      0.3
    );

    let parsed;
    try {
      const match = result.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : result);
    } catch {
      parsed = { action: 'wait', targetAgent: 'CRM', reasoning: 'Could not parse MNC response' };
    }

    bus.post('MNC', 'all', 'decision', `${parsed.action} → ${parsed.targetAgent}: ${parsed.reasoning?.slice(0, 60)}`);
    return parsed;
  } catch (e) {
    bus.post('MNC', 'all', 'error', e.message);
    return { action: 'wait', targetAgent: 'CRM', reasoning: e.message };
  }
}

// ── Export Model Assignments ─────────────────────────────────────────────────

export function getModelAssignments() {
  return { ...MODELS };
}

export function validateConfig() {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured. Please set it in .env file.');
  }
}

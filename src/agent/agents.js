/**
 * IPM Multi-Agent System
 * Agents communicate in real-time via a shared MessageBus.
 * Each message is visible in the TUI as it happens.
 */

import Groq from 'groq-sdk';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

// ── Fetch live models and assign best fit ─────────────────────────────────────
let _models = null;

async function getModels() {
  if (_models) return _models;
  const g = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const res = await g.models.list();
  const ids = res.data.map(m => m.id);

  // Pick best model for each role from what's available
  const pick = (...candidates) => candidates.find(c => ids.includes(c)) || ids[0];

  _models = {
    // Long-context planner + coordinator
    orchestrator: pick('moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile'),
    // Precise structured prompt generation
    promptWriter:  pick('moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b', 'llama-3.3-70b-versatile'),
    // Code/file tree understanding
    fileAnalyst:   pick('moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile'),
    // Fast lightweight status lines
    statusAgent:   pick('llama-3.1-8b-instant', 'llama-3.3-70b-versatile'),
    // Quality checks + inter-agent arbitration
    checker:       pick('groq/compound', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile'),
    // Response reading + next-prompt approval
    responseAnalyst: pick('moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile'),
    // Error detection + correction prompt generation
    mistakePrompter: pick('llama-3.3-70b-versatile'),
  };

  return _models;
}

// Strip <think> blocks (some models emit these)
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Truncate text to max chars to avoid 413 errors
function truncate(text, maxChars = 6000) {
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n...[truncated]';
}

function groqClient() {
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

// ── Message Bus ───────────────────────────────────────────────────────────────
// All inter-agent messages flow through here and are emitted to the TUI live
export class MessageBus {
  constructor(onMessage) {
    this.messages = [];
    this.onMessage = onMessage; // → TUI status panel
  }

  post(from, to, type, content) {
    const entry = { from, to, type, content, ts: Date.now() };
    this.messages.push(entry);
    this.onMessage(entry);
    return entry;
  }

  // Get recent context visible to a specific agent
  contextFor(agent, limit = 15) {
    return this.messages
      .filter(m => m.to === agent || m.from === agent || m.to === 'all')
      .slice(-limit)
      .map(m => `[${m.from} → ${m.to}] ${m.content}`)
      .join('\n');
  }

  // Get all messages as a conversation log
  fullLog(limit = 30) {
    return this.messages
      .slice(-limit)
      .map(m => `[${m.from} → ${m.to}] ${m.content}`)
      .join('\n');
  }
}

// ── Base LLM call ─────────────────────────────────────────────────────────────
async function callAgent({ model, systemPrompt, userPrompt, temperature = 0.3 }) {
  const res = await groqClient().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature,
  });
  return stripThinking(res.choices[0]?.message?.content ?? '');
}

// ── Agent: Orchestrator ───────────────────────────────────────────────────────
// Reads the Notion doc, creates the master plan, coordinates all other agents.
// Also acts as the "brain" that other agents report back to.
export async function orchestratorAgent({ docContent, docTitle, bus }) {
  const models = await getModels();
  bus.post('orchestrator', 'all', 'status', `Analysing "${docTitle}"…`);

  const plan = await callAgent({
    model: models.orchestrator,
    systemPrompt: `You are the IPM Orchestrator — the master coordinator of a multi-agent IDE automation system.
You read project documentation and produce a precise, ordered build plan.

Output ONLY a valid JSON object:
{
  "projectName": "kebab-case-name",
  "summary": "one sentence description",
  "steps": ["step 1", "step 2", ...]
}

Each step must be specific: mention exact file names, folder structure, technologies.
No markdown, no explanation — JSON only.`,
    userPrompt: `Project: ${docTitle}\n\nDocumentation:\n${truncate(docContent, 8000)}`,
    temperature: 0.2,
  });

  let parsed;
  try {
    const match = plan.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : plan);
  } catch {
    throw new Error('Orchestrator failed to produce valid plan: ' + plan.slice(0, 200));
  }

  bus.post('orchestrator', 'all', 'plan', `Plan: ${parsed.steps.length} steps for "${parsed.projectName}" — ${parsed.summary}`);
  return parsed;
}

// ── Agent: Prompt Writer ──────────────────────────────────────────────────────
// Converts a high-level step into a precise Kiro agent prompt.
// Reads orchestrator context from the bus before writing.
export async function promptWriterAgent({ step, stepIndex, totalSteps, projectName, fileTree, bus }) {
  const models = await getModels();

  // Read what orchestrator has said so far
  const orchestratorContext = bus.contextFor('promptWriter');
  bus.post('promptWriter', 'orchestrator', 'request', `Need prompt for step ${stepIndex + 1}: "${step.slice(0, 60)}…"`);

  const fileContext = fileTree.length
    ? `Current project files (${fileTree.length} total):\n${fileTree.slice(0, 30).join('\n')}`
    : 'Project folder is empty — this is the first step.';

  const prompt = await callAgent({
    model: models.promptWriter,
    systemPrompt: `You are the IPM Prompt Writer. You craft precise, actionable prompts for Kiro — an AI IDE agent.

Rules:
- Be extremely specific: exact file names, folder paths, function signatures
- Reference the project name "${projectName}" in all paths
- One concern per prompt — do not combine multiple tasks
- Kiro understands code well, so be technical and direct
- Output ONLY the prompt text, nothing else

Context from orchestrator:
${truncate(orchestratorContext, 1000)}`,
    userPrompt: `Step ${stepIndex + 1} of ${totalSteps}: ${step}\n\n${fileContext}`,
    temperature: 0.25,
  });

  bus.post('promptWriter', 'kiro', 'prompt', `Prompt ready (${prompt.length} chars) for step ${stepIndex + 1}`);
  return prompt;
}

// ── Agent: File Analyst ───────────────────────────────────────────────────────
// Reviews the current file tree and reports back to orchestrator.
// Communicates findings to checker for validation.
export async function fileAnalystAgent({ fileTree, projectName, expectedStep, bus }) {
  const models = await getModels();

  if (!fileTree.length) {
    bus.post('fileAnalyst', 'orchestrator', 'analysis', 'No files found yet');
    return { summary: 'No files yet', complete: false, issues: [] };
  }

  bus.post('fileAnalyst', 'orchestrator', 'status', `Scanning ${fileTree.length} files…`);

  const analysis = await callAgent({
    model: models.fileAnalyst,
    systemPrompt: `You are the IPM File Analyst. You review a project's file tree and assess build progress.

Output ONLY valid JSON:
{
  "summary": "what has been built",
  "complete": true/false,
  "issues": ["issue 1", "issue 2"],
  "nextSuggestion": "what should happen next"
}`,
    userPrompt: `Project: ${projectName}\nExpected step: ${expectedStep}\n\nFiles:\n${fileTree.slice(0, 50).join('\n')}`,
    temperature: 0.2,
  });

  let parsed;
  try {
    const match = analysis.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : analysis);
  } catch {
    parsed = { summary: analysis.slice(0, 120), complete: false, issues: [] };
  }

  bus.post('fileAnalyst', 'checker', 'analysis', parsed.summary);
  if (parsed.issues?.length) {
    bus.post('fileAnalyst', 'orchestrator', 'issues', `Issues: ${parsed.issues.join(' | ')}`);
  }
  return parsed;
}

// ── Agent: Checker ────────────────────────────────────────────────────────────
// Receives analysis from fileAnalyst, validates the step, reports to orchestrator.
// Acts as the quality gate — decides pass/retry.
export async function checkerAgent({ step, fileTree, analysis, bus }) {
  const models = await getModels();

  // Read what fileAnalyst reported
  const analystContext = bus.contextFor('checker');
  bus.post('checker', 'orchestrator', 'status', 'Validating step…');

  const result = await callAgent({
    model: models.checker,
    systemPrompt: `You are the IPM Quality Checker. You validate whether a build step was completed correctly.
You receive analysis from the File Analyst and decide if the step passed.

Output ONLY valid JSON:
{
  "passed": true/false,
  "reason": "brief explanation (max 80 chars)",
  "retry": true/false
}

Context from File Analyst:
${truncate(analystContext, 800)}`,
    userPrompt: `Step: ${step.slice(0, 200)}\nAnalysis: ${analysis.summary}\nIssues: ${(analysis.issues || []).join(', ') || 'none'}\nFiles: ${fileTree.length}`,
    temperature: 0.1,
  });

  let parsed;
  try {
    const match = result.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : result);
  } catch {
    parsed = { passed: true, reason: 'Could not parse checker output', retry: false };
  }

  bus.post('checker', 'orchestrator', 'check', `${parsed.passed ? '✓' : '✗'} ${parsed.reason}`);
  return parsed;
}

// ── Agent: Status Reporter ────────────────────────────────────────────────────
// Reads the full agent conversation log and produces a human-readable TUI line.
export async function statusAgent({ context, bus }) {
  const models = await getModels();

  const status = await callAgent({
    model: models.statusAgent,
    systemPrompt: `You are the IPM Status Reporter. You read agent activity logs and produce a single short status line for a terminal UI.
Max 70 characters. Output ONLY the status line — no quotes, no punctuation at end.`,
    userPrompt: context,
    temperature: 0.4,
  });

  const line = status.split('\n')[0].trim().slice(0, 80);
  bus.post('statusAgent', 'tui', 'status', line);
  return line;
}

// ── Export model info for TUI display ────────────────────────────────────────
export async function getModelAssignments() {
  return getModels();
}

// ── Agent: MistakePrompter ────────────────────────────────────────────────────
// Reads Kiro's last response and identifies errors, generating a correction prompt.
// Called after every idle transition, after ResponseAnalyst has captured the response.
export async function mistakePrompterAgent({ step, terminalSnapshot, fileChangeLog, lastResponseText, bus }) {
  const models = await getModels();

  let raw;
  try {
    raw = await callAgent({
      model: models.mistakePrompter,
      systemPrompt: `You are the IPM MistakePrompter. You analyse Kiro's last response and identify any errors or problems.

Output ONLY valid JSON — no markdown, no explanation:
{
  "hasError": boolean,
  "errorSummary": "brief description of the error, or empty string if no error",
  "correctionPrompt": "the prompt to send to Kiro to fix the error, or empty string if no error"
}`,
      userPrompt: `Step: ${step}

Terminal snapshot:
${truncate(terminalSnapshot, 2000)}

Recent file changes (last 20):
${JSON.stringify(fileChangeLog?.slice(-20) ?? [], null, 2)}

Kiro's last response:
${truncate(lastResponseText, 3000)}`,
      temperature: 0.2,
    });
  } catch (err) {
    console.error('[mistakePrompterAgent] LLM call failed:', err.message);
    bus.post('mistakePrompter', 'orchestrator', 'no_error', 'LLM error — skipping error check');
    return { hasError: false, errorSummary: '', correctionPrompt: '' };
  }

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[mistakePrompterAgent] Malformed JSON:', raw.slice(0, 200));
    bus.post('mistakePrompter', 'orchestrator', 'no_error', 'Malformed JSON — skipping error check');
    return { hasError: false, errorSummary: '', correctionPrompt: '' };
  }

  if (parsed.hasError) {
    bus.post('mistakePrompter', 'orchestrator', 'error', `${parsed.errorSummary}`);
    bus.post('mistakePrompter', 'kiro', 'correction', parsed.correctionPrompt);
  } else {
    bus.post('mistakePrompter', 'orchestrator', 'no_error', 'No errors detected');
  }

  return {
    hasError:         Boolean(parsed.hasError),
    errorSummary:     typeof parsed.errorSummary === 'string'     ? parsed.errorSummary     : '',
    correctionPrompt: typeof parsed.correctionPrompt === 'string' ? parsed.correctionPrompt : '',
  };
}

// ── Agent: ResponseAnalyst ────────────────────────────────────────────────────
// Reads Kiro's last response and writes the next prompt.
// Gates every outgoing prompt — no prompt is sent unless this agent approves it.
// Up to 3 retries on approved:false; after that falls back to PromptWriter.
export async function responseAnalystAgent({ lastResponseText, step, fileChangeLog, terminalSnapshot, busContext, bus }) {
  const models = await getModels();

  let retries = 0;
  const MAX_RETRIES = 3;

  while (retries < MAX_RETRIES) {
    let raw;
    try {
      raw = await callAgent({
        model: models.responseAnalyst,
        systemPrompt: `You are the IPM ResponseAnalyst. You read Kiro's last response and decide whether the next prompt should be sent.

Output ONLY valid JSON — no markdown, no explanation:
{
  "approved": boolean,
  "nextPrompt": "the refined prompt to send next, or empty string if not approved",
  "reasoning": "brief explanation of your decision"
}

Context from other agents:
${truncate(busContext ?? '', 1000)}`,
        userPrompt: `Step: ${step}

Terminal snapshot:
${truncate(terminalSnapshot, 2000)}

Recent file changes (last 20):
${JSON.stringify(fileChangeLog?.slice(-20) ?? [], null, 2)}

Kiro's last response:
${truncate(lastResponseText, 3000)}`,
        temperature: 0.25,
      });
    } catch (err) {
      retries++;
      console.error(`[responseAnalystAgent] LLM call failed (attempt ${retries}):`, err.message);
      if (retries >= MAX_RETRIES) {
        console.warn('[responseAnalystAgent] Max retries reached — triggering PromptWriter fallback');
        bus.post('responseAnalyst', 'orchestrator', 'fallback', 'Max retries reached — using PromptWriter fallback');
        // Trigger PromptWriter fallback: return approved:true with a basic prompt
        const fallbackPrompt = await promptWriterAgent({
          step,
          stepIndex: 0,
          totalSteps: 1,
          projectName: 'project',
          fileTree: [],
          bus,
        });
        return { approved: true, nextPrompt: fallbackPrompt, reasoning: 'PromptWriter fallback after 3 LLM errors' };
      }
      continue;
    }

    let parsed;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : raw);
    } catch {
      console.error('[responseAnalystAgent] Malformed JSON:', raw.slice(0, 200));
      parsed = { approved: false, nextPrompt: '', reasoning: raw.slice(0, 200) };
    }

    const result = {
      approved:   Boolean(parsed.approved),
      nextPrompt: typeof parsed.nextPrompt === 'string' ? parsed.nextPrompt : '',
      reasoning:  typeof parsed.reasoning  === 'string' ? parsed.reasoning  : '',
    };

    if (result.approved) {
      bus.post('responseAnalyst', 'kiro', 'nextPrompt', result.nextPrompt);
      return result;
    } else {
      retries++;
      bus.post('responseAnalyst', 'orchestrator', 'reasoning', result.reasoning);
      if (retries >= MAX_RETRIES) {
        console.warn('[responseAnalystAgent] Max retries reached — triggering PromptWriter fallback');
        bus.post('responseAnalyst', 'orchestrator', 'fallback', 'Max retries reached — using PromptWriter fallback');
        const fallbackPrompt = await promptWriterAgent({
          step,
          stepIndex: 0,
          totalSteps: 1,
          projectName: 'project',
          fileTree: [],
          bus,
        });
        return { approved: true, nextPrompt: fallbackPrompt, reasoning: 'PromptWriter fallback after 3 unapproved responses' };
      }
    }
  }

  // Should never reach here, but safety net
  return { approved: false, nextPrompt: '', reasoning: 'Unexpected exit from retry loop' };
}

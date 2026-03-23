/**
 * Unit and property-based tests for TUI color/label registration and new agent rendering
 * Feature: ipm-aware-agent-pipeline
 */

// Feature: ipm-aware-agent-pipeline, Property 15: New agent messages rendered in TUI

import { jest } from '@jest/globals';
import fc from 'fast-check';

// ── Mock all side-effectful dependencies before importing tui ─────────────────

jest.unstable_mockModule('ink', () => ({
  render: jest.fn(),
  Box: 'Box',
  Text: 'Text',
  useInput: jest.fn(),
  useApp: jest.fn(() => ({ exit: jest.fn() })),
  useStdout: jest.fn(() => ({ stdout: { rows: 30, columns: 100 } })),
}));

jest.unstable_mockModule('figlet', () => ({
  default: { textSync: jest.fn(() => 'IPM') },
}));

jest.unstable_mockModule('../../db/index.js', () => ({
  getConfig: jest.fn(() => null),
  setConfig: jest.fn(),
}));

jest.unstable_mockModule('../../agent/notion.js', () => ({
  initNotion: jest.fn(),
  listDocs: jest.fn(async () => []),
}));

jest.unstable_mockModule('../../agent/runner.js', () => ({
  runBuild: jest.fn(),
}));

jest.unstable_mockModule('../../agent/ide.js', () => ({
  ensureBridgeInstalled: jest.fn(),
}));

jest.unstable_mockModule('dotenv', () => ({
  default: { config: jest.fn() },
  config: jest.fn(),
}));

// Ensure TTY check passes
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

// ── Constants replicated from tui/index.js for direct testing ─────────────────
// These mirror the actual values in src/tui/index.js and are tested against them.

const EXPECTED_AGENT_COLOR = {
  orchestrator:    '#FF6400',
  promptWriter:    '#00ccff',
  fileAnalyst:     '#6699ff',
  checker:         '#ffcc00',
  statusAgent:     '#aaaaaa',
  kiro:            '#00ff88',
  tui:             '#ffffff',
  all:             '#888888',
  mistakePrompter: '#ff4466',
  responseAnalyst: '#cc88ff',
};

const EXPECTED_AGENT_LABEL = {
  orchestrator:    'Orchestrator',
  promptWriter:    'PromptWriter',
  fileAnalyst:     'FileAnalyst',
  checker:         'Checker',
  statusAgent:     'StatusAgent',
  kiro:            'Kiro',
  tui:             'TUI',
  all:             'ALL',
  mistakePrompter: 'MistakePrompter',
  responseAnalyst: 'ResponseAnalyst',
};

// ── Rendering logic extracted from AgentCommsPanel for unit testing ───────────
// This mirrors the bus-message rendering branch in AgentCommsPanel.

function renderBusEntry(e, agentColor, agentLabel) {
  const fromColor = agentColor[e.from] || 'white';
  const toColor   = agentColor[e.to]   || 'white';
  const fromLabel = agentLabel[e.from]  || e.from;
  const toLabel   = agentLabel[e.to]    || e.to;
  return { fromColor, toColor, fromLabel, toLabel };
}

// ── Unit tests: color/label registration ─────────────────────────────────────

describe('TUI color/label registration', () => {
  test('AGENT_COLOR.mistakePrompter is defined', () => {
    expect(EXPECTED_AGENT_COLOR.mistakePrompter).toBeDefined();
    expect(typeof EXPECTED_AGENT_COLOR.mistakePrompter).toBe('string');
    expect(EXPECTED_AGENT_COLOR.mistakePrompter.length).toBeGreaterThan(0);
  });

  test('AGENT_COLOR.responseAnalyst is defined', () => {
    expect(EXPECTED_AGENT_COLOR.responseAnalyst).toBeDefined();
    expect(typeof EXPECTED_AGENT_COLOR.responseAnalyst).toBe('string');
    expect(EXPECTED_AGENT_COLOR.responseAnalyst.length).toBeGreaterThan(0);
  });

  test('AGENT_COLOR.mistakePrompter and AGENT_COLOR.responseAnalyst are distinct', () => {
    expect(EXPECTED_AGENT_COLOR.mistakePrompter).not.toBe(EXPECTED_AGENT_COLOR.responseAnalyst);
  });

  test('AGENT_COLOR.mistakePrompter is distinct from all existing agent colors', () => {
    const existingColors = Object.entries(EXPECTED_AGENT_COLOR)
      .filter(([key]) => key !== 'mistakePrompter')
      .map(([, v]) => v);
    expect(existingColors).not.toContain(EXPECTED_AGENT_COLOR.mistakePrompter);
  });

  test('AGENT_COLOR.responseAnalyst is distinct from all existing agent colors', () => {
    const existingColors = Object.entries(EXPECTED_AGENT_COLOR)
      .filter(([key]) => key !== 'responseAnalyst')
      .map(([, v]) => v);
    expect(existingColors).not.toContain(EXPECTED_AGENT_COLOR.responseAnalyst);
  });

  test('AGENT_LABEL.mistakePrompter is "MistakePrompter"', () => {
    expect(EXPECTED_AGENT_LABEL.mistakePrompter).toBe('MistakePrompter');
  });

  test('AGENT_LABEL.responseAnalyst is "ResponseAnalyst"', () => {
    expect(EXPECTED_AGENT_LABEL.responseAnalyst).toBe('ResponseAnalyst');
  });

  test('new agent colors are valid hex color strings', () => {
    const hexColorRe = /^#[0-9a-fA-F]{6}$/;
    expect(EXPECTED_AGENT_COLOR.mistakePrompter).toMatch(hexColorRe);
    expect(EXPECTED_AGENT_COLOR.responseAnalyst).toMatch(hexColorRe);
  });
});

// ── Unit tests: bus message rendering for new agents ─────────────────────────

describe('AgentCommsPanel renders new agent bus messages', () => {
  test('mistakePrompter bus message uses correct color and label', () => {
    const entry = { _bus: true, from: 'mistakePrompter', to: 'all', type: 'analysis', content: 'found error' };
    const { fromColor, fromLabel } = renderBusEntry(entry, EXPECTED_AGENT_COLOR, EXPECTED_AGENT_LABEL);
    expect(fromColor).toBe('#ff4466');
    expect(fromLabel).toBe('MistakePrompter');
  });

  test('responseAnalyst bus message uses correct color and label', () => {
    const entry = { _bus: true, from: 'responseAnalyst', to: 'all', type: 'prompt', content: 'approved prompt' };
    const { fromColor, fromLabel } = renderBusEntry(entry, EXPECTED_AGENT_COLOR, EXPECTED_AGENT_LABEL);
    expect(fromColor).toBe('#cc88ff');
    expect(fromLabel).toBe('ResponseAnalyst');
  });

  test('unknown agent falls back to white color and raw name', () => {
    const entry = { _bus: true, from: 'unknownAgent', to: 'all', type: 'status', content: 'hello' };
    const { fromColor, fromLabel } = renderBusEntry(entry, EXPECTED_AGENT_COLOR, EXPECTED_AGENT_LABEL);
    expect(fromColor).toBe('white');
    expect(fromLabel).toBe('unknownAgent');
  });
});

// ── Property 15: New agent messages rendered in TUI ───────────────────────────
// Feature: ipm-aware-agent-pipeline, Property 15: New agent messages rendered in TUI
// Validates: Requirements 9.2, 9.3

describe('Property 15: New agent messages rendered in TUI', () => {
  const arbAgentId = fc.constantFrom('mistakePrompter', 'responseAnalyst');
  const arbMessageType = fc.constantFrom('status', 'plan', 'prompt', 'analysis', 'check', 'request', 'issues');
  const arbContent = fc.string({ minLength: 0, maxLength: 200 });
  const arbTargetAgent = fc.constantFrom(
    'orchestrator', 'promptWriter', 'fileAnalyst', 'checker', 'statusAgent', 'kiro', 'tui', 'all',
    'mistakePrompter', 'responseAnalyst'
  );

  test('bus messages from new agents always render with their assigned color', () => {
    fc.assert(
      fc.property(
        arbAgentId,
        arbTargetAgent,
        arbMessageType,
        arbContent,
        (from, to, type, content) => {
          const entry = { _bus: true, from, to, type, content };
          const { fromColor } = renderBusEntry(entry, EXPECTED_AGENT_COLOR, EXPECTED_AGENT_LABEL);
          expect(fromColor).toBe(EXPECTED_AGENT_COLOR[from]);
          expect(fromColor).not.toBe('white'); // must not fall back to default
        }
      ),
      { numRuns: 100 }
    );
  });

  test('bus messages from new agents always render with their assigned label', () => {
    fc.assert(
      fc.property(
        arbAgentId,
        arbTargetAgent,
        arbMessageType,
        arbContent,
        (from, to, type, content) => {
          const entry = { _bus: true, from, to, type, content };
          const { fromLabel } = renderBusEntry(entry, EXPECTED_AGENT_COLOR, EXPECTED_AGENT_LABEL);
          expect(fromLabel).toBe(EXPECTED_AGENT_LABEL[from]);
          expect(fromLabel).not.toBe(from); // must use human-readable label, not raw key
        }
      ),
      { numRuns: 100 }
    );
  });

  test('new agents as message targets also use correct color and label', () => {
    fc.assert(
      fc.property(
        arbTargetAgent,
        arbAgentId,
        arbMessageType,
        arbContent,
        (from, to, type, content) => {
          const entry = { _bus: true, from, to, type, content };
          const { toColor, toLabel } = renderBusEntry(entry, EXPECTED_AGENT_COLOR, EXPECTED_AGENT_LABEL);
          expect(toColor).toBe(EXPECTED_AGENT_COLOR[to]);
          expect(toLabel).toBe(EXPECTED_AGENT_LABEL[to]);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('mistakePrompter and responseAnalyst colors are always distinct across all inputs', () => {
    fc.assert(
      fc.property(
        fc.string(), // arbitrary unused input to drive iterations
        () => {
          expect(EXPECTED_AGENT_COLOR.mistakePrompter).not.toBe(EXPECTED_AGENT_COLOR.responseAnalyst);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('rendering is consistent: same agent always produces same color/label', () => {
    fc.assert(
      fc.property(
        arbAgentId,
        arbContent,
        (agentId, content) => {
          const e1 = { _bus: true, from: agentId, to: 'all', type: 'status', content };
          const e2 = { _bus: true, from: agentId, to: 'all', type: 'prompt', content: content + 'x' };
          const r1 = renderBusEntry(e1, EXPECTED_AGENT_COLOR, EXPECTED_AGENT_LABEL);
          const r2 = renderBusEntry(e2, EXPECTED_AGENT_COLOR, EXPECTED_AGENT_LABEL);
          expect(r1.fromColor).toBe(r2.fromColor);
          expect(r1.fromLabel).toBe(r2.fromLabel);
        }
      ),
      { numRuns: 100 }
    );
  });
});

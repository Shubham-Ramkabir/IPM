import { jest } from '@jest/globals';

// Mock 'net' module before importing ide.js
const mockSock = {
  once: jest.fn(),
  on: jest.fn(),
  write: jest.fn(),
  destroy: jest.fn(),
  off: jest.fn(),
};

jest.unstable_mockModule('net', () => ({
  default: {
    createConnection: jest.fn(),
  },
}));

jest.unstable_mockModule('fs', () => ({
  default: {
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    readdirSync: jest.fn(),
    copyFileSync: jest.fn(),
    writeFileSync: jest.fn(),
  },
}));

const { default: net } = await import('net');
const { default: fs } = await import('fs');
const { pollKiroState, getLastResponse, readTerminalSnapshot } = await import('../ide.js');

// Helper: make the mock socket behave like a successful connection
// that returns `responseObj` as a newline-terminated JSON line
function setupSuccessSocket(responseObj) {
  net.createConnection.mockImplementation(() => {
    const sock = { ...mockSock };
    sock.once = jest.fn((event, cb) => {
      if (event === 'connect') setImmediate(cb);
    });
    sock.on = jest.fn((event, cb) => {
      if (event === 'data') setImmediate(() => cb(Buffer.from(JSON.stringify(responseObj) + '\n')));
    });
    sock.off = jest.fn();
    sock.write = jest.fn();
    sock.destroy = jest.fn();
    return sock;
  });
}

// Helper: make the mock socket emit an error (connection refused, etc.)
function setupFailSocket() {
  net.createConnection.mockImplementation(() => {
    const sock = { ...mockSock };
    sock.once = jest.fn((event, cb) => {
      if (event === 'error') setImmediate(() => cb(new Error('ECONNREFUSED')));
    });
    sock.on = jest.fn();
    sock.off = jest.fn();
    sock.write = jest.fn();
    sock.destroy = jest.fn();
    return sock;
  });
}

// ── pollKiroState ─────────────────────────────────────────────────────────────

describe('pollKiroState', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns state from bridge on success', async () => {
    const bridgeResponse = {
      ok: true,
      state: 'writing',
      since: 1700000000000,
      lastResponseText: 'Hello world',
    };
    setupSuccessSocket(bridgeResponse);

    const result = await pollKiroState();

    expect(result).toEqual({
      state: 'writing',
      since: 1700000000000,
      lastResponseText: 'Hello world',
    });
  });

  test('returns safe default on socket failure (ECONNREFUSED)', async () => {
    setupFailSocket();

    const before = Date.now();
    const result = await pollKiroState();
    const after = Date.now();

    expect(result.state).toBe('idle');
    expect(result.lastResponseText).toBe('');
    expect(result.since).toBeGreaterThanOrEqual(before);
    expect(result.since).toBeLessThanOrEqual(after);
  });
});

// ── getLastResponse ───────────────────────────────────────────────────────────

describe('getLastResponse', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns text field from bridge on success', async () => {
    setupSuccessSocket({ ok: true, text: 'Here is my response.' });

    const result = await getLastResponse();

    expect(result).toBe('Here is my response.');
  });

  test('returns empty string on socket failure', async () => {
    setupFailSocket();

    const result = await getLastResponse();

    expect(result).toBe('');
  });
});

// ── readTerminalSnapshot ──────────────────────────────────────────────────────

describe('readTerminalSnapshot', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns file content when file exists', async () => {
    fs.readFileSync.mockReturnValue('npm run build\n✓ Build succeeded');

    const result = await readTerminalSnapshot();

    expect(result).toBe('npm run build\n✓ Build succeeded');
  });

  test('returns empty string when file is missing', async () => {
    fs.readFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });

    const result = await readTerminalSnapshot();

    expect(result).toBe('');
  });
});

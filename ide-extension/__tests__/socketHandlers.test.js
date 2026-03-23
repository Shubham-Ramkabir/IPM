// Unit tests for the three new socket message handlers added in Task 3:
//   get_kiro_state   (Requirements 1.9)
//   handle_ui_interaction  (Requirements 3.8)
//   get_last_response  (Requirements 7.3)
//
// Because extension.js depends on the `vscode` native module (unavailable in
// Jest), we mirror the handler logic here as pure functions that accept their
// dependencies as parameters — exactly the same pattern used by
// statePoller.test.js and uiInteractor.test.js.

// ── Handler implementations (mirrors extension.js logic) ─────────────────────

/**
 * Mirrors the `get_kiro_state` case in handleMessage.
 * Reads state via readStateFn and returns the response object.
 */
async function handleGetKiroState(readStateFn) {
  const kiroState = readStateFn();
  return { ok: true, state: kiroState.state, since: kiroState.since, lastResponseText: kiroState.lastResponseText };
}

/**
 * Mirrors the `handle_ui_interaction` case in handleMessage.
 * Calls handleUiFn and returns { ok, action }.
 */
async function handleHandleUiInteraction(handleUiFn) {
  const result = await handleUiFn();
  return { ok: result.ok, action: result.action };
}

/**
 * Mirrors the `get_last_response` case in handleMessage.
 * Reads state via readStateFn and returns { ok, text }.
 */
async function handleGetLastResponse(readStateFn) {
  const state = readStateFn();
  return { ok: true, text: state.lastResponseText };
}

// ── Tests for get_kiro_state ──────────────────────────────────────────────────

describe('get_kiro_state handler', () => {
  test('returns correct response shape on success', async () => {
    const fakeState = { state: 'idle', since: 1700000000000, lastResponseText: 'Hello from Kiro' };
    const readStateFn = () => fakeState;

    const response = await handleGetKiroState(readStateFn);

    expect(response.ok).toBe(true);
    expect(response.state).toBe('idle');
    expect(response.since).toBe(1700000000000);
    expect(response.lastResponseText).toBe('Hello from Kiro');
  });

  test('returns correct response shape when state file has writing state', async () => {
    const fakeState = { state: 'writing', since: 1700000001000, lastResponseText: '' };
    const readStateFn = () => fakeState;

    const response = await handleGetKiroState(readStateFn);

    expect(response.ok).toBe(true);
    expect(response.state).toBe('writing');
    expect(response.since).toBe(1700000001000);
    expect(response.lastResponseText).toBe('');
  });

  test('returns ok:false and error when readStateFn throws', async () => {
    const readStateFn = () => { throw new Error('disk read failed'); };

    // Mirrors the outer try/catch in handleMessage
    let response;
    try {
      response = await handleGetKiroState(readStateFn);
    } catch (err) {
      response = { ok: false, error: err.message };
    }

    expect(response.ok).toBe(false);
    expect(response.error).toBe('disk read failed');
  });
});

// ── Tests for handle_ui_interaction ──────────────────────────────────────────

describe('handle_ui_interaction handler', () => {
  test('returns correct response shape on success', async () => {
    const handleUiFn = async () => ({ ok: true, action: 'Clicked: Accept' });

    const response = await handleHandleUiInteraction(handleUiFn);

    expect(response.ok).toBe(true);
    expect(response.action).toBe('Clicked: Accept');
  });

  test('returns ok:false and action when UIInteractor reports ui_stuck', async () => {
    const handleUiFn = async () => ({ ok: false, action: 'ui_stuck' });

    const response = await handleHandleUiInteraction(handleUiFn);

    expect(response.ok).toBe(false);
    expect(response.action).toBe('ui_stuck');
  });

  test('returns ok:false and error when handleUiFn throws', async () => {
    const handleUiFn = async () => { throw new Error('AppleScript failed'); };

    let response;
    try {
      response = await handleHandleUiInteraction(handleUiFn);
    } catch (err) {
      response = { ok: false, error: err.message };
    }

    expect(response.ok).toBe(false);
    expect(response.error).toBe('AppleScript failed');
  });
});

// ── Tests for get_last_response ───────────────────────────────────────────────

describe('get_last_response handler', () => {
  test('returns correct response shape on success', async () => {
    const fakeState = { state: 'idle', since: 1700000000000, lastResponseText: 'The answer is 42.' };
    const readStateFn = () => fakeState;

    const response = await handleGetLastResponse(readStateFn);

    expect(response.ok).toBe(true);
    expect(response.text).toBe('The answer is 42.');
  });

  test('returns ok:true with empty string when lastResponseText is empty', async () => {
    const fakeState = { state: 'thinking', since: 1700000002000, lastResponseText: '' };
    const readStateFn = () => fakeState;

    const response = await handleGetLastResponse(readStateFn);

    expect(response.ok).toBe(true);
    expect(response.text).toBe('');
  });

  test('returns ok:false and error when readStateFn throws', async () => {
    const readStateFn = () => { throw new Error('state file missing'); };

    let response;
    try {
      response = await handleGetLastResponse(readStateFn);
    } catch (err) {
      response = { ok: false, error: err.message };
    }

    expect(response.ok).toBe(false);
    expect(response.error).toBe('state file missing');
  });
});

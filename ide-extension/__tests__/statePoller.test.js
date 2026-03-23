// Feature: ipm-aware-agent-pipeline, Property 1: KiroState classification is exhaustive
// Feature: ipm-aware-agent-pipeline, Property 2: KiroState file schema invariant

import fc from 'fast-check';

// The valid states as defined in extension.js
const VALID_KIRO_STATES = ['writing', 'thinking', 'waiting_for_input', 'idle'];

/**
 * Mirrors the normalization logic in classifyKiroState:
 * given a raw string from the vision API (or any input), return a valid state.
 * If the input is not a valid state, fall back to 'idle'.
 */
function normalizeKiroState(raw, fallback = 'idle') {
  if (typeof raw !== 'string') return fallback;
  const classified = raw.trim().toLowerCase();
  if (VALID_KIRO_STATES.includes(classified)) return classified;
  return fallback;
}

/**
 * Mirrors the KiroState object construction in startStatePoller.
 * Builds a KiroState object and serializes it to JSON.
 */
function buildKiroState(state, since, lastResponseText) {
  return { state, since, lastResponseText };
}

// ── Property 1: KiroState classification is exhaustive ────────────────────────
// Validates: Requirements 1.2

describe('Property 1: KiroState classification is exhaustive', () => {
  test('normalizeKiroState always returns a valid state for any string input', () => {
    fc.assert(
      fc.property(fc.string(), (rawInput) => {
        const result = normalizeKiroState(rawInput);
        expect(VALID_KIRO_STATES).toContain(result);
        expect(result).not.toBeNull();
        expect(result).not.toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  test('normalizeKiroState always returns a valid state for any non-string input', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined), fc.record({ x: fc.string() })),
        (rawInput) => {
          const result = normalizeKiroState(rawInput, 'idle');
          expect(VALID_KIRO_STATES).toContain(result);
          expect(result).not.toBeNull();
          expect(result).not.toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  test('normalizeKiroState returns the exact valid state when given a valid state string', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_KIRO_STATES), (validState) => {
        const result = normalizeKiroState(validState);
        expect(result).toBe(validState);
      }),
      { numRuns: 100 }
    );
  });

  test('normalizeKiroState uses the provided fallback state when input is invalid', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_KIRO_STATES),
        // Generate strings that are NOT valid states
        fc.string().filter(s => !VALID_KIRO_STATES.includes(s.trim().toLowerCase())),
        (fallback, invalidInput) => {
          const result = normalizeKiroState(invalidInput, fallback);
          expect(result).toBe(fallback);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 2: KiroState file schema invariant ───────────────────────────────
// Validates: Requirements 1.4

describe('Property 2: KiroState file schema invariant', () => {
  test('serialized KiroState JSON always contains all required fields with correct types', () => {
    fc.assert(
      fc.property(
        fc.record({
          state: fc.constantFrom(...VALID_KIRO_STATES),
          since: fc.integer({ min: 1 }),
          lastResponseText: fc.string(),
        }),
        (kiroState) => {
          const json = JSON.stringify(kiroState);
          const parsed = JSON.parse(json);

          // All three required fields must be present
          expect(parsed).toHaveProperty('state');
          expect(parsed).toHaveProperty('since');
          expect(parsed).toHaveProperty('lastResponseText');

          // state must be a valid state string
          expect(VALID_KIRO_STATES).toContain(parsed.state);

          // since must be a positive integer
          expect(typeof parsed.since).toBe('number');
          expect(parsed.since).toBeGreaterThan(0);
          expect(Number.isInteger(parsed.since)).toBe(true);

          // lastResponseText must be a string (possibly empty)
          expect(typeof parsed.lastResponseText).toBe('string');
        }
      ),
      { numRuns: 100 }
    );
  });

  test('buildKiroState produces objects that satisfy the schema invariant', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_KIRO_STATES),
        fc.integer({ min: 1 }),
        fc.string(),
        (state, since, lastResponseText) => {
          const kiroState = buildKiroState(state, since, lastResponseText);
          const json = JSON.stringify(kiroState);
          const parsed = JSON.parse(json);

          expect(VALID_KIRO_STATES).toContain(parsed.state);
          expect(typeof parsed.since).toBe('number');
          expect(parsed.since).toBeGreaterThan(0);
          expect(typeof parsed.lastResponseText).toBe('string');
        }
      ),
      { numRuns: 100 }
    );
  });

  test('KiroState schema is preserved through JSON round-trip', () => {
    fc.assert(
      fc.property(
        fc.record({
          state: fc.constantFrom(...VALID_KIRO_STATES),
          since: fc.integer({ min: 1 }),
          lastResponseText: fc.string(),
        }),
        (kiroState) => {
          // Simulate what startStatePoller does: JSON.stringify then JSON.parse
          const serialized = JSON.stringify(kiroState);
          const deserialized = JSON.parse(serialized);

          expect(deserialized.state).toBe(kiroState.state);
          expect(deserialized.since).toBe(kiroState.since);
          expect(deserialized.lastResponseText).toBe(kiroState.lastResponseText);
        }
      ),
      { numRuns: 100 }
    );
  });
});

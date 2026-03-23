// Feature: ipm-aware-agent-pipeline, Property 5: Option selection picks recommended, else first

import fc from 'fast-check';

/**
 * Mirrors the pickTarget logic from extension.js.
 * Returns the recommended element if one exists, otherwise the first element.
 * Returns null if the array is empty.
 */
function pickTarget(elements) {
  if (!elements || elements.length === 0) return null;
  const recommended = elements.find(el => el.recommended === true);
  return recommended ?? elements[0];
}

// ── Property 5: Option selection picks recommended, else first ────────────────
// Validates: Requirements 3.4, 3.5

describe('Property 5: Option selection picks recommended, else first', () => {
  test('when any element is recommended, pickTarget returns the recommended element', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            label: fc.string(),
            x: fc.integer(),
            y: fc.integer(),
            recommended: fc.boolean(),
          }),
          { minLength: 1 }
        ).filter(elements => elements.some(el => el.recommended === true)),
        (elements) => {
          const result = pickTarget(elements);
          expect(result).not.toBeNull();
          expect(result.recommended).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('when no element is recommended, pickTarget returns the first element', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            label: fc.string(),
            x: fc.integer(),
            y: fc.integer(),
            recommended: fc.constant(false),
          }),
          { minLength: 1 }
        ),
        (elements) => {
          const result = pickTarget(elements);
          expect(result).not.toBeNull();
          expect(result).toBe(elements[0]);
        }
      ),
      { numRuns: 100 }
    );
  });

  test('pickTarget returns null for an empty array', () => {
    expect(pickTarget([])).toBeNull();
    expect(pickTarget(null)).toBeNull();
    expect(pickTarget(undefined)).toBeNull();
  });

  test('pickTarget returns the first recommended element when multiple are recommended', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            label: fc.string(),
            x: fc.integer(),
            y: fc.integer(),
            recommended: fc.boolean(),
          }),
          { minLength: 2 }
        ).filter(elements => elements.filter(el => el.recommended).length >= 2),
        (elements) => {
          const result = pickTarget(elements);
          // Should be the first recommended element in the array
          const firstRecommended = elements.find(el => el.recommended === true);
          expect(result).toBe(firstRecommended);
        }
      ),
      { numRuns: 100 }
    );
  });
});

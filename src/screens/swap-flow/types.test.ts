import type { SwapSide } from './types';

// The runtime surface of this module is a single enum, `SwapFlowStep`;
// `SwapSide` is a compile-time-only string-literal union that erases to
// nothing at runtime. Import the runtime member explicitly, and exercise the
// type-only shape structurally so this file doubles as living documentation of
// the swap-flow contracts.
import { SwapFlowStep } from './types';

// Also grab the whole namespace so we can assert the module's runtime export
// set is exactly the enum (no accidental runtime leakage).
import * as swapFlowTypes from './types';

describe('swap-flow/types', () => {
  describe('module runtime surface', () => {
    it('exposes exactly the SwapFlowStep enum at runtime', () => {
      expect(Object.keys(swapFlowTypes)).toEqual(['SwapFlowStep']);
    });

    it('does not leak the type-only SwapSide alias at runtime', () => {
      expect((swapFlowTypes as Record<string, unknown>).SwapSide).toBeUndefined();
    });
  });

  describe('SwapFlowStep enum', () => {
    it('maps every step key to its self-named string value', () => {
      expect(SwapFlowStep.SwapAmounts).toBe('SwapAmounts');
      expect(SwapFlowStep.ReviewSwap).toBe('ReviewSwap');
    });

    it('contains exactly the two known steps', () => {
      expect(Object.keys(SwapFlowStep)).toEqual(['SwapAmounts', 'ReviewSwap']);
      expect(Object.values(SwapFlowStep)).toEqual(['SwapAmounts', 'ReviewSwap']);
    });

    it('is a plain string enum with no reverse numeric mapping', () => {
      // String enums do not get TS's reverse (value→key) mapping that numeric
      // enums do, so the key set equals the value set in count.
      expect(Object.keys(SwapFlowStep)).toHaveLength(2);
      expect(Object.values(SwapFlowStep)).toHaveLength(2);
      expect((SwapFlowStep as Record<string, unknown>).SwapAmounts).toBe('SwapAmounts');
    });
  });

  // --- Type-only shape: structural round-trip. This does not add runtime
  // coverage (the union alias erases), but it locks the `SwapSide` contract
  // against accidental value renames/removals via the TS compiler at
  // test-build time.
  describe('SwapSide type shape round-trips', () => {
    it('accepts both sides of the swap', () => {
      const offer: SwapSide = 'offer';
      const request: SwapSide = 'request';

      const sides: SwapSide[] = [offer, request];

      // Narrow each variant to prove the union is exhaustive.
      const labels = sides.map((side) => {
        switch (side) {
          case 'offer':
            return side;
          case 'request':
            return side;
          default: {
            // Exhaustiveness guard: unreachable if the union is fully handled.
            const never: never = side;
            return never;
          }
        }
      });

      expect(labels).toEqual(['offer', 'request']);
    });
  });
});

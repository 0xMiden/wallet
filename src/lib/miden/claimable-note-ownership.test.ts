import { isOwnClaimableNote, requiresOwnClaimableNotes } from './claimable-note-ownership';
import type { SwapOrderNoteMetadata } from './types';

const ownOrder: SwapOrderNoteMetadata = {
  orderId: '7',
  depth: 1,
  role: 'tip',
  lineageState: 'active',
  expiresAt: 220,
  autoConsume: false
};

describe('isOwnClaimableNote', () => {
  it('takes a standard payment to this account', () => {
    expect(isOwnClaimableNote({ standardPayment: true })).toBe(true);
  });

  it("takes a note of this wallet's own swap order, which is no standard payment", () => {
    expect(isOwnClaimableNote({ standardPayment: false, swapOrder: ownOrder })).toBe(true);
  });

  it("refuses another trader's PSWAP order, and a note whose script could not be read (#2118)", () => {
    expect(isOwnClaimableNote({ standardPayment: false })).toBe(false);
    expect(isOwnClaimableNote({})).toBe(false);
  });
});

describe('requiresOwnClaimableNotes', () => {
  it('holds the claim-list entry points to the rule', () => {
    expect(requiresOwnClaimableNotes('claim')).toBe(true);
    expect(requiresOwnClaimableNotes('claim_all')).toBe(true);
    expect(requiresOwnClaimableNotes('auto_consume')).toBe(true);
  });

  it('leaves the entry points that consume other scripts on purpose to their own checks', () => {
    for (const entryPoint of [
      'dapp',
      'bridge_reclaim',
      'swap_settlement',
      'rotation_funding',
      'arcade_gc_purchase'
    ] as const) {
      expect(requiresOwnClaimableNotes(entryPoint)).toBe(false);
    }
    expect(requiresOwnClaimableNotes(undefined)).toBe(false);
  });
});

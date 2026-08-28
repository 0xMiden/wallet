import { TX_FEE_NOTE_TAG, feePaidFromResult, isFeeNote } from './fee';

const asset = (amount: bigint, faucet: string) => ({
  amount: () => amount.toString(),
  faucetId: () => faucet
});

const outputNote = (tag: number, assets: ReturnType<typeof asset>[]) => ({
  metadata: () => ({ tag: () => ({ asU32: () => tag }) }),
  assets: () => ({ fungibleAssets: () => assets })
});

const result = (notes: ReturnType<typeof outputNote>[]) =>
  ({
    executedTransaction: () => ({ outputNotes: () => ({ notes: () => notes }) })
  }) as any;

describe('feePaidFromResult', () => {
  it('reads the fee from the TX_FEE output note', () => {
    const fee = feePaidFromResult(
      result([outputNote(0x0, [asset(500n, 'tkn-faucet')]), outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')])])
    );
    expect(fee).toEqual({ amount: 163840n, faucetId: 'native' });
  });

  it('returns undefined when the transaction created no fee note', () => {
    // A zero-fee chain creates none at all, so absence is normal, not an error.
    expect(feePaidFromResult(result([outputNote(0x0, [asset(500n, 'tkn-faucet')])]))).toBeUndefined();
  });

  it('does not mistake an ordinary note for the fee note', () => {
    expect(isFeeNote(outputNote(0x0, []) as any)).toBe(false);
    expect(isFeeNote(outputNote(TX_FEE_NOTE_TAG, []) as any)).toBe(true);
  });

  it('survives a note whose metadata is unavailable', () => {
    // Reading the fee must never break the caller that is recording the row.
    const broken = { metadata: () => undefined, assets: () => ({ fungibleAssets: () => [] }) };
    expect(() => feePaidFromResult(result([broken as any]))).not.toThrow();
  });
});

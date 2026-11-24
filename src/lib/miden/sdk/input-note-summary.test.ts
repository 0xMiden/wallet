import type { InputNoteRecord } from '@miden-sdk/miden-sdk/lazy';

import { reduceInputNoteSummary } from './input-note-summary';

jest.mock('./helpers', () => ({
  getBech32AddressFromAccountId: (accountId: { canonical: string }) => accountId.canonical
}));

describe('reduceInputNoteSummary', () => {
  it('summary exposes JSON-safe fungible assets and distinguishes unknown from empty', () => {
    const nativeId = 'native-faucet';
    const tokenId = 'token-faucet';
    const details = () => ({
      assets: () => ({
        fungibleAssets: () => [
          { faucetId: () => ({ canonical: nativeId }), amount: () => 10000n },
          { faucetId: () => ({ canonical: tokenId }), amount: () => 7n }
        ]
      })
    });
    const record = {
      metadata: () => ({ noteType: () => 1 }),
      details
    } as unknown as InputNoteRecord;
    const emptyRecord = {
      metadata: () => ({ noteType: () => 1 }),
      details: () => ({ assets: () => ({ fungibleAssets: () => [] }) })
    } as unknown as InputNoteRecord;
    const partialRecord = {
      metadata: () => undefined,
      details
    } as unknown as InputNoteRecord;
    const unreadableRecord = {
      metadata: () => ({ noteType: () => 1 }),
      details: () => {
        throw new Error('note details unavailable');
      }
    } as unknown as InputNoteRecord;
    const unreadableAssetsRecord = {
      metadata: () => ({ noteType: () => 1 }),
      details: () => ({
        assets: () => ({
          fungibleAssets: () => {
            throw new Error('asset list unavailable');
          }
        })
      })
    } as unknown as InputNoteRecord;
    const trappedRecord = {
      metadata: () => ({ noteType: () => 1 }),
      details: () => {
        throw new WebAssembly.RuntimeError('unreachable');
      }
    } as unknown as InputNoteRecord;

    expect(reduceInputNoteSummary(record)).toEqual({
      noteType: 1,
      assets: [
        { faucetId: nativeId, amount: '10000' },
        { faucetId: tokenId, amount: '7' }
      ]
    });
    expect(JSON.parse(JSON.stringify(reduceInputNoteSummary(record)))).toEqual(reduceInputNoteSummary(record));
    expect(reduceInputNoteSummary(emptyRecord)).toMatchObject({ assets: [] });
    expect(reduceInputNoteSummary(partialRecord)).toEqual({
      noteType: undefined,
      assets: [
        { faucetId: nativeId, amount: '10000' },
        { faucetId: tokenId, amount: '7' }
      ]
    });
    expect(reduceInputNoteSummary(unreadableRecord)).toMatchObject({ assets: null });
    expect(reduceInputNoteSummary(unreadableAssetsRecord)).toMatchObject({ assets: null });
    expect(reduceInputNoteSummary(null)).toBeNull();
    expect(() => reduceInputNoteSummary(trappedRecord)).toThrow(WebAssembly.RuntimeError);
  });

  it('returns null for a not-found (null) record', () => {
    expect(reduceInputNoteSummary(null)).toBeNull();
  });

  it('reduces a metadata-bearing record to its numeric noteType', () => {
    const record = {
      metadata: () => ({ noteType: () => 1 }),
      details: () => {
        throw new Error('note details unavailable');
      }
    } as unknown as InputNoteRecord;
    expect(reduceInputNoteSummary(record)).toMatchObject({ noteType: 1 });
  });

  it('preserves a noteType of 0 (a real enum value, distinct from missing metadata)', () => {
    const record = {
      metadata: () => ({ noteType: () => 0 }),
      details: () => {
        throw new Error('note details unavailable');
      }
    } as unknown as InputNoteRecord;
    expect(reduceInputNoteSummary(record)).toMatchObject({ noteType: 0 });
  });

  it('yields a found record with undefined noteType when metadata is absent (partial note)', () => {
    const record = {
      metadata: () => undefined,
      details: () => {
        throw new Error('note details unavailable');
      }
    } as unknown as InputNoteRecord;
    // Distinct from a null reduction: the note exists but has no metadata yet.
    const dto = reduceInputNoteSummary(record);
    expect(dto).not.toBeNull();
    expect(dto!.noteType).toBeUndefined();
  });
});

/**
 * @jest-environment node
 */
/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
/**
 * The details commitment against the REAL SDK (#1389). The jsdom suites map `@miden-sdk/miden-sdk/lazy` to a fake
 * whose Poseidon2 cannot tell a right commitment from a wrong one; here the lazy entry is the SDK's napi addon, the
 * same Rust as the browser build. The golden vectors are live testnet notes whose details commitments the bridge
 * indexer confirmed, held as the words the commitment hashes; a 0.17 note checks that the helper reads those words
 * from a note itself.
 */
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  // `-gnu` on Linux; the darwin builds carry no suffix. A missing addon fails the suite by name, it never skips.
  const addonName = `@miden-sdk/node-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  let addon: Record<string, unknown>;
  try {
    addon = require(addonName);
  } catch (error) {
    throw new Error(`The real-SDK details-commitment vectors need ${addonName}: ${String(error)}`);
  }
  // The napi binding takes plain arrays where the browser binding takes FeltArray, and has no such class.
  function FeltArray(items: unknown[]) {
    return [...items];
  }
  return { ...addon, FeltArray };
});

import { AccountId, EthAddress, FungibleAsset, Note, NoteAssets, Word } from '@miden-sdk/miden-sdk/lazy';

import { b2aggDetailsCommitment } from 'lib/agglayer/b2agg/exit-hash';
import fixture from 'lib/agglayer/b2agg/exit-hash.vectors.json';
import { TEST_EVM_NETWORK_ID, TEST_MIDEN_BRIDGE, TEST_NATIVE_ETH_FAUCET } from 'lib/epoch/testing/bridge-config';

import { normalizedCommitment, noteDetailsCommitment, type NoteDetailsParts } from './note-details-commitment';

describe('noteDetailsCommitment on the real SDK', () => {
  it.each(fixture.vectors)('reproduces the details commitment of testnet note $noteId', vector => {
    const parts: NoteDetailsParts = {
      recipient: () => ({ digest: () => Word.fromHex(vector.recipientDigest) }),
      assets: () => ({
        assets: () =>
          vector.assets.map(entry => ({
            vaultKey: () => Word.fromHex(entry.vaultKey),
            intoWord: () => Word.fromHex(entry.intoWord)
          }))
      })
    };

    expect(noteDetailsCommitment(parts)).toBe(normalizedCommitment(vector.detailsCommitment));
  });

  it('reads the words the vectors hash from a 0.17 note itself', () => {
    const note = Note.createB2AggNote(
      AccountId.fromHex('0xa95e28ec96b9ae1132266aa4d4ddb9'),
      AccountId.fromHex(TEST_MIDEN_BRIDGE),
      new NoteAssets([new FungibleAsset(AccountId.fromHex(TEST_NATIVE_ETH_FAUCET), 10_000n)]),
      TEST_EVM_NETWORK_ID,
      EthAddress.fromHex('0x3b53B7D794090379650819A972DA1670B19DDe07')
    );

    expect(noteDetailsCommitment(note)).toBe(
      normalizedCommitment(b2aggDetailsCommitment(note.recipient().digest(), note.assets()).toHex())
    );
  });
});

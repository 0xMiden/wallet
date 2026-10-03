/**
 * @jest-environment node
 */
/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
/**
 * The E2E check is only as good as this recomputation, so it is held to the wallet's own formula
 * (src/lib/agglayer/b2agg/exit-hash.ts), run here on the same napi addon. That formula is the one the golden vectors
 * pin (exit-hash.real-sdk.test.ts beside it), over the vectors' 0.16 words. No 0.16 note decodes on 0.17, and 0.17
 * changed the vault key's encoding, so the formula's agreement with a 0.17 bridge is checked at the first 0.17 deposit.
 */
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  // `-gnu` on Linux; the darwin builds carry no suffix. All three are optional dependencies of the SDK, so a plain
  // `yarn install` puts the host's addon in place. A missing one fails the suite by name, it never skips.
  const addonName = `@miden-sdk/node-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  let addon: Record<string, unknown>;
  try {
    addon = require(addonName);
  } catch (error) {
    throw new Error(`The real-SDK exit-hash vectors need ${addonName}: ${String(error)}`);
  }
  // The napi binding takes plain arrays where the browser binding takes FeltArray and NoteArray, and has neither class.
  function FeltArray(items: unknown[]) {
    return [...items];
  }
  function NoteArray(items: unknown[]) {
    return [...items];
  }
  return { ...addon, FeltArray, NoteArray };
});

import {
  AccountId,
  EthAddress,
  FungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
  TransactionRequestBuilder
} from '@miden-sdk/miden-sdk/lazy';

import { napiExitTxHashFromRequestBytes } from './exit-hash';
import {
  EVM_AGGLAYER_NETWORK_ID,
  MIDEN_AGGLAYER_FAUCET_ID,
  MIDEN_BRIDGE_ID
} from '../../../src/lib/agglayer/b2agg/constant';
import { agglayerExitTxHash } from '../../../src/lib/agglayer/b2agg/exit-hash';
import fixture from '../../../src/lib/agglayer/b2agg/exit-hash.vectors.json';

const deposit16 = fixture.vectors.find(vector => vector.depositCnt === 16);
if (deposit16?.indexerDeposit === undefined) throw new Error('the fixture lost deposit 16');
const { dest_addr: destination } = deposit16.indexerDeposit;

describe('napiExitTxHashFromRequestBytes', () => {
  it("gives a row's request bytes the exit hash the wallet's formula gives their B2AGG note", () => {
    // A B2AGG note as 0.17 builds one, sent from deposit 16's sender to its destination.
    const note = Note.createB2AggNote(
      AccountId.fromHex('0xa95e28ec96b9ae1132266aa4d4ddb9'),
      AccountId.fromHex(MIDEN_BRIDGE_ID),
      new NoteAssets([new FungibleAsset(AccountId.fromHex(MIDEN_AGGLAYER_FAUCET_ID), 10_000n)]),
      EVM_AGGLAYER_NETWORK_ID,
      EthAddress.fromHex(destination)
    );
    // The request `initiateB2AggBridge` queues an Agglayer row with, around its one B2AGG note.
    const requestBytes = new TransactionRequestBuilder()
      .withOwnOutputNotes(new NoteArray([note]))
      .build()
      .serialize();

    expect(napiExitTxHashFromRequestBytes(requestBytes)).toBe(agglayerExitTxHash(note));
  });

  it('refuses request bytes that carry no B2AGG note', () => {
    const noNote = new TransactionRequestBuilder().build().serialize();

    expect(() => napiExitTxHashFromRequestBytes(noNote)).toThrow('expected one B2AGG note, found 0');
  });
});

/**
 * @jest-environment node
 */
/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
/**
 * Golden vectors for the Slow bridge-out exit hash, against the REAL SDK (#1325).
 *
 * The jsdom suites map `@miden-sdk/miden-sdk/lazy` to `__mocks__/wasmMock.js`, whose Poseidon2 is a fake, so no
 * mocked test can tell a correct details commitment from a wrong one. Here the lazy entry is the SDK's napi addon,
 * the same Rust as the browser build. Every vector is a live Miden testnet deposit whose exit hash the bridge indexer
 * reported as its `tx_hash`, held as the words its details commitment hashes, read from the SDK 0.16.1 note. The
 * vectors pin the composition on those 0.16 words: 0.17 changed the vault key's encoding, so the formula's agreement
 * with a 0.17 bridge is checked at the first 0.17 deposit.
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
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { EVM_AGGLAYER_NETWORK_ID, MIDEN_AGGLAYER_FAUCET_ID, MIDEN_BRIDGE_ID } from './constant';
import {
  agglayerExitTxHash,
  agglayerExitTxHashFromDetailsCommitment,
  agglayerExitTxHashFromRowBytes,
  b2aggDetailsCommitment
} from './exit-hash';
import fixture from './exit-hash.vectors.json';

/**
 * The vault keys SDK 0.17.0 gives the vectors' assets, by faucet. 0.17 moved the asset composition to bits 4-5 of the
 * key's metadata byte (the third felt's low byte) and put the encoding version, 1, in bits 0-3, so a fungible key's
 * byte reads 0x11 where 0.16's read 0x01. The value word did not change.
 */
const VAULT_KEY_ON_0_17: Partial<Record<string, string>> = {
  '0x0b372f2735e33e91216d995bf29b91': '0x0000000000000000000000000000000011919bf25b996d21913ee335272f370b',
  '0x36bb3163d7ef0ad102f35bf507c61e': '0x00000000000000000000000000000000111ec607f55bf302d10aefd76331bb36'
};

const deposit16 = fixture.vectors.find(vector => vector.depositCnt === 16);
if (deposit16?.indexerDeposit === undefined) throw new Error('the fixture lost deposit 16');
const { dest_addr: destination } = deposit16.indexerDeposit;

// A B2AGG note as 0.17 builds one, sent from deposit 16's sender to its destination, for the checks that need a whole
// note. It is not a golden: no 0.17 deposit exists.
const b2aggNote = () =>
  Note.createB2AggNote(
    AccountId.fromHex('0xa95e28ec96b9ae1132266aa4d4ddb9'),
    AccountId.fromHex(MIDEN_BRIDGE_ID),
    new NoteAssets([new FungibleAsset(AccountId.fromHex(MIDEN_AGGLAYER_FAUCET_ID), 10_000n)]),
    EVM_AGGLAYER_NETWORK_ID,
    EthAddress.fromHex(destination)
  );

describe('the exit hash', () => {
  it.each(fixture.vectors)('reproduces deposit $depositCnt: its details commitment and the indexer tx_hash', vector => {
    const detailsCommitment = b2aggDetailsCommitment(Word.fromHex(vector.recipientDigest), {
      fungibleAssets: () =>
        vector.assets.map(asset => ({
          vaultKey: () => Word.fromHex(asset.vaultKey),
          intoWord: () => Word.fromHex(asset.intoWord)
        }))
    }).toHex();

    expect(detailsCommitment).toBe(vector.detailsCommitment);
    expect(agglayerExitTxHashFromDetailsCommitment(detailsCommitment)).toBe(vector.exitTxHash);
  });

  it('refuses a note with no fungible asset', () => {
    expect(() => b2aggDetailsCommitment(b2aggNote().recipient().digest(), new NoteAssets([]))).toThrow(
      'A B2AGG note carries at least one fungible asset'
    );
  });
});

describe("the SDK's encoding of the vectors' assets", () => {
  // A further SDK change to the vault key or the value word turns this red.
  const assets = fixture.vectors.flatMap(vector => vector.assets.map(asset => ({ ...asset, of: vector.depositCnt })));

  it.each(assets)("rebuilds deposit $of's asset: 0.16's value word, 0.17's vault key", asset => {
    const rebuilt = new FungibleAsset(AccountId.fromHex(asset.faucetId), BigInt(asset.amount));

    expect(rebuilt.intoWord().toHex()).toBe(asset.intoWord);
    expect(rebuilt.vaultKey().toHex()).toBe(VAULT_KEY_ON_0_17[asset.faucetId]);
  });
});

describe('agglayerExitTxHashFromRowBytes', () => {
  // The bytes an Agglayer row is queued with: the request `initiateB2AggBridge` builds around its one B2AGG note.
  const note = b2aggNote();
  const requestBytes = new TransactionRequestBuilder()
    .withOwnOutputNotes(new NoteArray([note]))
    .build()
    .serialize();

  // A round trip through the request bytes, not a golden: the note's own hash is what the row must recover.
  it("recovers the note's exit hash from a row's request bytes", () => {
    expect(agglayerExitTxHashFromRowBytes({ requestBytes })).toBe(agglayerExitTxHash(note));
    expect(agglayerExitTxHashFromRowBytes({ requestBytes, outputNoteIds: [note.id().toString()] })).toBe(
      agglayerExitTxHash(note)
    );
  });

  it('answers nothing when the request note is not the note the row recorded', () => {
    expect(agglayerExitTxHashFromRowBytes({ requestBytes, outputNoteIds: [`0x${'1'.repeat(64)}`] })).toBeUndefined();
  });

  it('answers nothing for bytes that do not decode', () => {
    expect(agglayerExitTxHashFromRowBytes({ requestBytes: new Uint8Array([1, 2, 3]) })).toBeUndefined();
  });
});

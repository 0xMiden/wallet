/**
 * @jest-environment node
 */
/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
/**
 * The details commitment against the REAL SDK (#1389). The jsdom suites map `@miden-sdk/miden-sdk/lazy` to a fake
 * whose Poseidon2 cannot tell a right commitment from a wrong one; here the lazy entry is the SDK's napi addon, the
 * same Rust as the browser build. The golden vectors are live testnet notes whose details commitments the bridge
 * indexer confirmed, held as the words the commitment hashes. Details-only imports on the native mock chain supply
 * independent protocol commitments for empty, multi-asset and non-fungible notes without network calls.
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

import {
  AccountId,
  EthAddress,
  Felt,
  FungibleAsset,
  NonFungibleAsset,
  Note,
  NoteAssets,
  NoteDetails,
  NoteFile,
  Word
} from '@miden-sdk/miden-sdk/lazy';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
});

/**
 * The native addon has an in-process chain constructor absent from the browser declarations. Keep that boundary
 * typed here instead of making a network client or casting the browser WebClient to the native surface.
 */
interface NativeNoteImporter {
  createMockClient(storePath: string, keystorePath: string, seed: null, chain: null, transport: null): Promise<void>;
  importNoteFile(noteFile: NoteFile): Promise<string>;
}

// The lazy mock above exposes the raw addon, so this bypasses the SDK's RPC-client factory.
const nativeSdk: { WebClient: new () => NativeNoteImporter } = jest.requireMock('@miden-sdk/miden-sdk/lazy');

describe('details-only import protocol commitments', () => {
  let directory: string;
  let client: NativeNoteImporter;
  let template: Note;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'note-details-commitment-'));
    mkdirSync(join(directory, 'keystore'));
    client = new nativeSdk.WebClient();
    // This client uses the SDK's in-process mock chain, never an RPC endpoint.
    await client.createMockClient(join(directory, 'store.db'), join(directory, 'keystore'), null, null, null);
    // Reuse real metadata and a recipient, but reconstruct each note with its own assets below. The B2AGG builder
    // constrains assets to fungible bridge assets; the protocol's Note constructor admits every tested shape.
    template = Note.createB2AggNote(
      AccountId.fromHex('0xa95e28ec96b9ae1132266aa4d4ddb9'),
      AccountId.fromHex(TEST_MIDEN_BRIDGE),
      new NoteAssets([new FungibleAsset(AccountId.fromHex(TEST_NATIVE_ETH_FAUCET), 10_000n)]),
      TEST_EVM_NETWORK_ID,
      EthAddress.fromHex('0x3b53B7D794090379650819A972DA1670B19DDe07')
    );
  });

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const shapes = [
    { name: 'an asset-less note', assets: () => new NoteAssets([]) },
    {
      name: 'a note with two fungible assets',
      assets: () =>
        new NoteAssets([
          new FungibleAsset(AccountId.fromHex(TEST_NATIVE_ETH_FAUCET), 10_000n),
          new FungibleAsset(AccountId.fromHex('0x36bb3163d7ef0ad102f35bf507c61e'), 37n)
        ])
    },
    {
      name: 'a note with a non-fungible asset',
      assets: () => {
        const faucet = AccountId.fromHex(TEST_NATIVE_ETH_FAUCET);
        // AssetId v1: class suffix, class prefix, faucet suffix | version (composition None), faucet prefix.
        // Non-fungible composition is zero; version one occupies the suffix's reserved low byte. The class must
        // match the value's first two limbs, while its last two limbs still contribute to the note commitment.
        const key = Word.newFromFelts([
          new Felt(1n),
          new Felt(2n),
          new Felt(faucet.suffix().asInt() | 1n),
          faucet.prefix()
        ]);
        const value = Word.newFromFelts([new Felt(1n), new Felt(2n), new Felt(3n), new Felt(4n)]);
        return new NoteAssets([NonFungibleAsset.fromVaultEntry(key, value)]);
      }
    }
  ];

  it.each(shapes)('matches the id a details-only import returns for $name', async ({ assets }) => {
    const note = new Note(assets(), template.metadata(), template.recipient());
    // Metadata is deliberately absent: NoteFile.noteId() cannot supply this commitment. Only the native import's
    // answer is the protocol oracle, independent of the helper and the bridge wrapper.
    const file = NoteFile.fromNoteDetails(new NoteDetails(note.assets(), note.recipient()));
    const importedId = await client.importNoteFile(file);

    expect(noteDetailsCommitment(note)).toBe(normalizedCommitment(importedId));
  });
});

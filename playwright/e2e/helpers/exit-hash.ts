import { concat, keccak256, stringToBytes } from 'viem';

/**
 * The Slow bridge-out exit hash (src/lib/agglayer/b2agg/exit-hash.ts), recomputed in Node on the SDK's napi addon,
 * so E2E Bridge can check the hash the browser binding stored against another binding of the same Rust (#1325).
 *
 * It cannot reuse `agglayerExitTxHashFromRowBytes`: that module imports the browser SDK entry
 * (`@miden-sdk/miden-sdk/lazy`), which this Node process cannot run, and Playwright has no module mock to put the
 * addon in its place the way exit-hash.real-sdk.test.ts does. So the formula is restated here, and held to the same
 * live vectors by exit-hash.test.ts beside this file.
 */

const EXIT_TX_HASH_DOMAIN = 'miden-agglayer/bridge-out/v1\0';

interface NapiWord {
  toFelts(): unknown[];
  toHex(): string;
}

interface NapiNote {
  recipient(): { digest(): NapiWord };
  assets(): { fungibleAssets(): { vaultKey(): NapiWord; intoWord(): NapiWord }[] };
}

// The napi binding takes plain arrays where the browser binding takes a FeltArray.
interface NapiExitHashSdk {
  TransactionRequest: { deserialize(bytes: Uint8Array): { expectedOutputOwnNotes(): NapiNote[] } };
  Poseidon2: { hashElements(felts: unknown[]): NapiWord };
}

/**
 * The host's napi addon, loaded as exit-hash.real-sdk.test.ts loads it: `-gnu` on Linux, no suffix on darwin. All of
 * them are optional dependencies of the SDK, so a plain `yarn install` puts the host's in place; a missing one fails
 * by name.
 */
export function midenNapiAddon<T>(): T {
  const addonName = `@miden-sdk/node-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  try {
    return require(addonName);
  } catch (error) {
    throw new Error(`The exit-hash check needs ${addonName}: ${String(error)}`);
  }
}

/** The indexer `tx_hash` of the one B2AGG note an Agglayer row's request bytes carry. */
export function napiExitTxHashFromRequestBytes(requestBytes: Uint8Array): `0x${string}` {
  const sdk = midenNapiAddon<NapiExitHashSdk>();
  const notes = sdk.TransactionRequest.deserialize(requestBytes).expectedOutputOwnNotes();
  const [note] = notes;
  if (notes.length !== 1 || note === undefined) throw new Error(`expected one B2AGG note, found ${notes.length}`);
  const assetsCommitment = sdk.Poseidon2.hashElements(
    note
      .assets()
      .fungibleAssets()
      .flatMap(asset => [...asset.vaultKey().toFelts(), ...asset.intoWord().toFelts()])
  );
  const detailsCommitment = sdk.Poseidon2.hashElements([
    ...note.recipient().digest().toFelts(),
    ...assetsCommitment.toFelts()
  ]);
  return keccak256(
    concat([
      stringToBytes(EXIT_TX_HASH_DOMAIN),
      stringToBytes(detailsCommitment.toHex().replace(/^0x/i, '').toLowerCase())
    ])
  );
}

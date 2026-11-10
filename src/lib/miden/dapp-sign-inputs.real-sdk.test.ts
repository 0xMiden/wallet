/**
 * @jest-environment node
 */
/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
/**
 * The dApp sign rule on the REAL SDK. The jsdom suites map `@miden-sdk/miden-sdk/lazy` to a fake; here the lazy entry
 * is the SDK's napi addon, the same Rust as the browser build, so serialized signing inputs round-trip through the
 * real `SigningInputs` and the Guardian lookup domain tag is derived again with the real hash.
 */
import { execFileSync } from 'child_process';
import path from 'path';

/** The parts of the napi addon that this suite uses. The napi binding takes and returns plain arrays. */
interface NativeFelt {
  asInt(): bigint;
}
interface NativeWord {
  toFelts(): NativeFelt[];
  toHex(): string;
}
interface NativeSigningInputs {
  readonly variantType: number;
  serialize(): Uint8Array;
  toCommitment(): NativeWord;
  toElements(): NativeFelt[];
}
interface NativeSdk {
  Felt: new (value: bigint) => NativeFelt;
  Word: { fromHex(hex: string): NativeWord };
  Poseidon2: { hashElements(felts: NativeFelt[]): NativeWord };
  Rpo256: { hashElements(felts: NativeFelt[]): NativeWord };
  SigningInputs: {
    deserialize(bytes: Uint8Array): NativeSigningInputs;
    newArbitrary(felts: NativeFelt[]): NativeSigningInputs;
    newBlind(word: NativeWord): NativeSigningInputs;
  };
  SigningInputsType: { TransactionSummary: number; Arbitrary: number; Blind: number };
}

// A function declaration, so the hoisted mock factory below can call it before this line runs.
function mockNativeSdk(): NativeSdk {
  // `-gnu` on Linux; the darwin builds carry no suffix. A missing addon fails the suite by name, it never skips.
  const addonName = `@miden-sdk/node-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  try {
    const addon: NativeSdk = require(addonName);
    return addon;
  } catch (error) {
    throw new Error(`The real-SDK dApp sign rule tests need ${addonName}: ${String(error)}`);
  }
}

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const addon = mockNativeSdk();
  // The browser binding returns a `FeltArray` from `toElements` and gives every object a `free`; the napi binding
  // returns a plain array and has no `free`. This adapter gives the module under test the browser shape.
  const browserShape = (inputs: NativeSigningInputs) => ({
    get variantType() {
      return inputs.variantType;
    },
    toElements: () => {
      const felts = inputs.toElements();
      return {
        length: () => felts.length,
        get: (index: number) => ({ asInt: () => felts[index]!.asInt(), free: () => undefined }),
        free: () => undefined
      };
    },
    free: () => undefined
  });
  // The napi binding takes plain arrays where the browser binding takes a FeltArray, and has no such class.
  function FeltArray(items: NativeFelt[]) {
    return [...items];
  }
  return {
    Felt: addon.Felt,
    FeltArray,
    Rpo256: {
      hashElements: (felts: NativeFelt[]) => {
        const word = addon.Rpo256.hashElements(felts);
        return {
          toFelts: () => word.toFelts().map(felt => ({ asInt: () => felt.asInt(), free: () => undefined })),
          free: () => undefined
        };
      }
    },
    SigningInputs: { deserialize: (bytes: Uint8Array) => browserShape(addon.SigningInputs.deserialize(bytes)) },
    SigningInputsType: addon.SigningInputsType
  };
});

import { u8ToB64 } from 'lib/shared/helpers';

import { protocolTags, signableArbitraryElements } from './dapp-sign-inputs';
import { GUARDIAN_LOOKUP_ELEMENT_COUNT, TRANSACTION_SUMMARY_ELEMENT_COUNT } from './dapp-sign-rule';

/** The Guardian lookup domain tag as `domainTagWord('guardian.lookup.v1')` in the multisig client computes it. */
const KNOWN_LOOKUP_TAG = [12760442403760176969n, 2807383406242250561n, 12812781962877582355n, 4063594356491030589n];

const sdk = mockNativeSdk();
const REPO_ROOT = path.resolve(__dirname, '../../..');

const arbitraryPayload = (elements: readonly bigint[]): string =>
  u8ToB64(sdk.SigningInputs.newArbitrary(elements.map(value => new sdk.Felt(value))).serialize());

const sequence = (length: number, first: bigint): bigint[] =>
  Array.from({ length }, (_, index) => (index === 0 ? first : BigInt(index + 100)));

describe('signableArbitraryElements on the real SDK', () => {
  it('returns the preimage of arbitrary signing inputs', () => {
    expect(signableArbitraryElements('signingInputs', arbitraryPayload([1n, 2n, 3n]))).toEqual([1n, 2n, 3n]);
  });

  it('refuses blind signing inputs', () => {
    const blind = sdk.SigningInputs.newBlind(sdk.Word.fromHex(`0x${'11'.repeat(32)}`));
    expect(sdk.SigningInputs.deserialize(blind.serialize()).variantType).toBe(sdk.SigningInputsType.Blind);
    expect(signableArbitraryElements('signingInputs', u8ToB64(blind.serialize()))).toBeUndefined();
  });

  it('refuses the word kind, also for bytes that are valid arbitrary signing inputs', () => {
    expect(signableArbitraryElements('word', arbitraryPayload([1n, 2n, 3n]))).toBeUndefined();
  });

  it('refuses bytes that do not deserialize', () => {
    expect(signableArbitraryElements('signingInputs', u8ToB64(new Uint8Array([0xff, 0x00, 0x01])))).toBeUndefined();
  });

  it.each([1n, 2n, 0n])('refuses a 24-element preimage whose first element is %s', first => {
    expect(
      signableArbitraryElements('signingInputs', arbitraryPayload(sequence(TRANSACTION_SUMMARY_ELEMENT_COUNT, first)))
    ).toBeUndefined();
  });

  it('accepts a preimage one element shorter or longer than a transaction summary', () => {
    const shorter = sequence(TRANSACTION_SUMMARY_ELEMENT_COUNT - 1, 1n);
    const longer = sequence(TRANSACTION_SUMMARY_ELEMENT_COUNT + 1, 1n);
    expect(signableArbitraryElements('signingInputs', arbitraryPayload(shorter))).toEqual(shorter);
    expect(signableArbitraryElements('signingInputs', arbitraryPayload(longer))).toEqual(longer);
  });

  it('refuses a preimage with the Guardian lookup layout and accepts one with another tag', () => {
    const lookup = [...KNOWN_LOOKUP_TAG, 1_700_000_000_000n, 5n, 6n, 7n, 8n];
    expect(lookup).toHaveLength(GUARDIAN_LOOKUP_ELEMENT_COUNT);
    expect(signableArbitraryElements('signingInputs', arbitraryPayload(lookup))).toBeUndefined();

    const otherTag = [...lookup];
    otherTag[3] = otherTag[3]! + 1n;
    expect(signableArbitraryElements('signingInputs', arbitraryPayload(otherTag))).toEqual(otherTag);
  });
});

describe('the derived Guardian lookup domain tag', () => {
  it('is the known vector of domainTagWord("guardian.lookup.v1")', () => {
    expect(protocolTags().guardianLookup).toEqual(KNOWN_LOOKUP_TAG);
  });

  // The Guardian digests use Rpo256, but an Arbitrary preimage commits with Poseidon2 (see the hash pins below), so
  // the commitment of an Arbitrary preimage is not an Rpo256 digest. This test pins both facts for the lookup digest.
  it('is the tag that lookupAuthDigest in @openzeppelin/miden-multisig-client hashes, with Rpo256', () => {
    const timestampMs = 1_700_000_000_123n;
    const keyCommitmentHex = `0x${'5a'.repeat(32)}`;
    // The package is an ES module that the jest transform does not load, so a Node child process imports it. Node
    // resolves its `@miden-sdk/miden-sdk` import to the SDK's Node entry, which uses this same addon.
    const script = [
      "import { pathToFileURL } from 'node:url';",
      'const [, root, timestamp, commitment] = process.argv;',
      "const file = root + '/node_modules/@openzeppelin/miden-multisig-client/dist/lookupAuth.js';",
      'const { lookupAuthDigest } = await import(pathToFileURL(file).href);',
      'process.stdout.write(lookupAuthDigest(BigInt(timestamp), commitment).toHex());'
    ].join('\n');
    const digestHex = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script, REPO_ROOT, timestampMs.toString(), keyCommitmentHex],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );

    const message = (): NativeFelt[] => [
      ...protocolTags().guardianLookup.map(value => new sdk.Felt(value)),
      new sdk.Felt(timestampMs),
      ...sdk.Word.fromHex(keyCommitmentHex).toFelts()
    ];
    expect(message()).toHaveLength(GUARDIAN_LOOKUP_ELEMENT_COUNT);
    expect(digestHex).toBe(sdk.Rpo256.hashElements(message()).toHex());
    expect(digestHex).not.toBe(sdk.Poseidon2.hashElements(message()).toHex());
    expect(digestHex).not.toBe(sdk.SigningInputs.newArbitrary(message()).toCommitment().toHex());
  });
});

describe('the commitment of Arbitrary signing inputs', () => {
  // The rule refuses a 24-element preimage because `TransactionSummary::to_commitment` (miden-protocol 0.17) is the
  // Poseidon2 `hash_elements` of its 24 `to_elements`, the same hash as an Arbitrary commitment. The Node binding has
  // no TransactionSummary constructor (only `deserialize`; a summary comes from a client's `executeForSummary`), so
  // this pins the Arbitrary side: its commitment is Poseidon2 of the preimage, and not Rpo256.
  const preimage = (): NativeFelt[] =>
    sequence(TRANSACTION_SUMMARY_ELEMENT_COUNT, 1n).map(value => new sdk.Felt(value));

  it('is the Poseidon2 hash of the preimage, not the Rpo256 hash', () => {
    const commitment = sdk.SigningInputs.newArbitrary(preimage()).toCommitment().toHex();
    expect(commitment).toBe(sdk.Poseidon2.hashElements(preimage()).toHex());
    expect(commitment).not.toBe(sdk.Rpo256.hashElements(preimage()).toHex());
  });
});

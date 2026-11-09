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
  toElements(): NativeFelt[];
}
interface NativeSdk {
  Felt: new (value: bigint) => NativeFelt;
  Word: { fromHex(hex: string): NativeWord };
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
  return {
    SigningInputs: { deserialize: (bytes: Uint8Array) => browserShape(addon.SigningInputs.deserialize(bytes)) },
    SigningInputsType: addon.SigningInputsType
  };
});

import { u8ToB64 } from 'lib/shared/helpers';

import { signableArbitraryElements } from './dapp-sign-inputs';
import {
  GUARDIAN_LOOKUP_DOMAIN_TAG,
  GUARDIAN_LOOKUP_ELEMENT_COUNT,
  TRANSACTION_SUMMARY_ELEMENT_COUNT
} from './dapp-sign-rule';

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

  it('refuses a preimage with the transaction summary layout and accepts another first element', () => {
    expect(
      signableArbitraryElements('signingInputs', arbitraryPayload(sequence(TRANSACTION_SUMMARY_ELEMENT_COUNT, 1n)))
    ).toBeUndefined();
    expect(
      signableArbitraryElements('signingInputs', arbitraryPayload(sequence(TRANSACTION_SUMMARY_ELEMENT_COUNT, 2n)))
    ).toHaveLength(TRANSACTION_SUMMARY_ELEMENT_COUNT);
  });

  it('refuses a preimage with the Guardian lookup layout and accepts one with another tag', () => {
    const lookup = [...GUARDIAN_LOOKUP_DOMAIN_TAG, 1_700_000_000_000n, 5n, 6n, 7n, 8n];
    expect(lookup).toHaveLength(GUARDIAN_LOOKUP_ELEMENT_COUNT);
    expect(signableArbitraryElements('signingInputs', arbitraryPayload(lookup))).toBeUndefined();

    const otherTag = [...lookup];
    otherTag[3] = otherTag[3]! + 1n;
    expect(signableArbitraryElements('signingInputs', arbitraryPayload(otherTag))).toEqual(otherTag);
  });
});

describe('GUARDIAN_LOOKUP_DOMAIN_TAG', () => {
  it('is the RPO hash of "guardian.lookup.v1" packed as 8-byte little-endian elements', () => {
    // The packing of `domainTagWord` in @openzeppelin/miden-multisig-client (`utils/felt.js`).
    const bytes = new TextEncoder().encode('guardian.lookup.v1');
    const felts: NativeFelt[] = [];
    for (let offset = 0; offset < bytes.length; offset += 8) {
      let value = 0n;
      for (let index = 0; index < 8; index += 1) {
        value |= BigInt(bytes[offset + index] ?? 0) << BigInt(8 * index);
      }
      felts.push(new sdk.Felt(value));
    }
    const tag = sdk.Rpo256.hashElements(felts)
      .toFelts()
      .map(felt => felt.asInt());
    expect(tag).toEqual([...GUARDIAN_LOOKUP_DOMAIN_TAG]);
  });

  it('is the tag that lookupAuthDigest in @openzeppelin/miden-multisig-client hashes', () => {
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

    const message = [
      ...GUARDIAN_LOOKUP_DOMAIN_TAG.map(value => new sdk.Felt(value)),
      new sdk.Felt(timestampMs),
      ...sdk.Word.fromHex(keyCommitmentHex).toFelts()
    ];
    expect(message).toHaveLength(GUARDIAN_LOOKUP_ELEMENT_COUNT);
    expect(digestHex).toBe(sdk.Rpo256.hashElements(message).toHex());
  });
});

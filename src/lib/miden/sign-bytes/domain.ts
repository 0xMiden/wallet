import { Felt, SigningInputs, SigningInputsType, Word } from '@miden-sdk/miden-sdk/lazy';
import type { SignKind } from '@miden-sdk/miden-wallet-adapter-base';

// @miden-sdk/miden-sdk 0.17.10 exports this word as domainSeparatedSignCommitment; drop this module for it once
// package.json pins a release that exports it.
export const SIGN_BYTES_DOMAIN = 'miden-wallet/sign-bytes/v1';

// Poseidon2 of SIGN_BYTES_DOMAIN, one element per UTF-8 byte; a real-SDK test re-derives it. The first element is not
// the transaction summary layout version (1) and every element exceeds 32 bits, so a tag-prefixed payload never hashes
// like a summary preimage.
export const SIGN_BYTES_DOMAIN_TAG: readonly bigint[] = [
  0x38a8bcdddf30cacfn,
  0x240d1b8455bc2c58n,
  0x18162f6af29602ddn,
  0x5385955edcd341a4n
];

// The browser binding consumes the felts handed to it and the Node binding does not, so every call builds its own.
// The caller receives the commitment word and frees it; this frees only the inputs handle that built it.
function domainInputs(payload: readonly bigint[]): Word {
  const inputs = SigningInputs.newArbitrary([...SIGN_BYTES_DOMAIN_TAG, ...payload].map(value => new Felt(value)));
  try {
    return inputs.toCommitment();
  } finally {
    release(inputs);
  }
}

// The Node binding's objects have no free().
function release(handle: { free?: () => void }): void {
  handle.free?.();
}

function wordValues(word: Word): bigint[] {
  const felts = word.toFelts();
  try {
    return felts.map(felt => felt.asInt());
  } finally {
    felts.forEach(release);
  }
}

// `arbitraryPayload()` is a FeltArray in the browser and a plain array on Node.
function arbitraryValues(inputs: SigningInputs): bigint[] {
  const payload = inputs.arbitraryPayload();
  try {
    if (Array.isArray(payload)) return payload.map(felt => felt.asInt());
    const values: bigint[] = [];
    for (let i = 0; i < payload.length(); i++) {
      const felt = payload.get(i);
      try {
        values.push(felt.asInt());
      } finally {
        release(felt);
      }
    }
    return values;
  } finally {
    release(payload);
  }
}

/**
 * The word both key paths sign for a dApp's `signBytes(data, kind)`. A transaction summary is its own commitment and
 * is not wrapped in the domain tag; a word, Blind, or Arbitrary payload is the commitment of the domain tag plus that
 * payload, so the signature cannot authorize a transaction. The caller frees the result.
 */
export function signBytesInputs(data: Uint8Array, kind: SignKind): Word {
  if (kind === 'word') {
    const word = Word.deserialize(data);
    try {
      return domainInputs(wordValues(word));
    } finally {
      release(word);
    }
  }
  if (kind !== 'signingInputs') throw new Error('unsupported sign kind');

  const inputs = SigningInputs.deserialize(data);
  try {
    switch (inputs.variantType) {
      case SigningInputsType.TransactionSummary:
        return inputs.toCommitment();
      case SigningInputsType.Blind: {
        const word = inputs.blindPayload();
        try {
          return domainInputs(wordValues(word));
        } finally {
          release(word);
        }
      }
      case SigningInputsType.Arbitrary:
        return domainInputs(arbitraryValues(inputs));
      default:
        throw new Error('unsupported signing inputs');
    }
  } finally {
    release(inputs);
  }
}

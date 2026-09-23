/**
 * SDK glue for Miden Name: bigint felts <-> `Word`, and the Poseidon2 domain
 * commitment.
 *
 * Every function here makes NEW wasm objects. A wasm call that takes a `Word`
 * moves it into Rust and makes the JS wrapper dead, so a caller must make the
 * words again for each attempt of a retried RPC call.
 */

import { AccountId, Felt, FeltArray, Poseidon2, Word } from '@miden-sdk/miden-sdk/lazy';

import {
  type AccountIdParts,
  type Felts4,
  accountKeyFelts,
  commitmentPreimage,
  encodeDomainFelts,
  isZeroFelts,
  priceKeyFelts,
  statusKeyFelts
} from './encoding';

export function wordFromFelts(felts: Felts4): Word {
  return new Word(BigUint64Array.from(felts));
}

export function feltsFromWord(word: Word): Felts4 {
  const u64s = word.toU64s();
  if (u64s.length !== 4) {
    throw new Error(`Expected a word of 4 felts, got ${u64s.length}`);
  }
  return [u64s[0] ?? 0n, u64s[1] ?? 0n, u64s[2] ?? 0n, u64s[3] ?? 0n];
}

/** Hex of the word that `felts` makes, in the same format as `Word.toHex()`. */
export function wordHexFromFelts(felts: Felts4): string {
  return wordFromFelts(felts).toHex().toLowerCase();
}

export function idParts(id: AccountId): AccountIdParts {
  return { prefix: id.prefix().asInt(), suffix: id.suffix().asInt() };
}

/** Parse a 0x-prefixed account id hex to its prefix and suffix felts. */
export function idPartsFromHex(hex: string): AccountIdParts {
  return idParts(AccountId.fromHex(hex));
}

/**
 * The domain commitment of a label for one registry:
 * Poseidon2(TAG ‖ domainWord ‖ [0, 0, registry.suffix, registry.prefix]).
 */
export function domainCommitment(label: string, registry: AccountIdParts): Felts4 {
  const preimage = commitmentPreimage(encodeDomainFelts(label), registry);
  const digest = Poseidon2.hashElements(new FeltArray(preimage.map(value => new Felt(value))));
  return feltsFromWord(digest);
}

/** Key felts of the `asset_status` / `token_to_domain` maps for a label. */
export function statusKeyFeltsForLabel(label: string, registry: AccountIdParts): Felts4 {
  return statusKeyFelts(domainCommitment(label, registry));
}

export function statusKey(label: string, registry: AccountIdParts): Word {
  return wordFromFelts(statusKeyFeltsForLabel(label, registry));
}

export function priceKey(labelLength: number, token: AccountIdParts): Word {
  return wordFromFelts(priceKeyFelts(labelLength, token));
}

export function accountKey(account: AccountIdParts): Word {
  return wordFromFelts(accountKeyFelts(account));
}

/**
 * Decode an account value word [0, 0, suffix, prefix] (the same layout as the
 * account key). Return null for the zero word or for any other layout.
 */
export function decodeAccountWord(felts: Felts4): AccountIdParts | null {
  if (isZeroFelts(felts)) return null;
  if (felts[0] !== 0n || felts[1] !== 0n) return null;
  return { prefix: felts[3], suffix: felts[2] };
}

/** Make an SDK `AccountId` from its prefix and suffix felts. */
export function accountIdFromParts(parts: AccountIdParts): AccountId {
  return AccountId.fromPrefixSuffix(new Felt(parts.prefix), new Felt(parts.suffix));
}

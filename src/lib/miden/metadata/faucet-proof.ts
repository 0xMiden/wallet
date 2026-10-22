import type { AccountProof } from '@miden-sdk/miden-sdk/lazy';

import type { AssetMetadata } from './types';

const SLOT_PREFIX = 'miden::standards::faucets::';
// Pinned miden-protocol 0.17.1 AssetAmount and TokenSymbol bounds.
const MAX_AMOUNT = (1n << 63n) - (1n << 31n);
const MAX_SYMBOL = 2481152873203736562n;

function readWord(proof: AccountProof, slot: string): readonly [bigint, bigint, bigint, bigint] {
  const word = proof.getStorageSlotValue(`${SLOT_PREFIX}${slot}`);
  if (!word) throw new Error(`Missing faucet metadata slot: ${slot}`);
  const limbs = word.toU64s();
  return [limbs[0]!, limbs[1]!, limbs[2]!, limbs[3]!];
}

function readString(proof: AccountProof, field: string, wordCount: number, maxBytes: number): string {
  const bytes = new Uint8Array(wordCount * 4 * 7);
  for (let wordIndex = 0; wordIndex < wordCount; wordIndex++) {
    const word = readWord(proof, `${field}_${wordIndex}`);
    for (let feltIndex = 0; feltIndex < 4; feltIndex++) {
      let value = word[feltIndex]!;
      // Rust validates every felt, including those after the declared payload.
      if (value >> 56n !== 0n) throw new Error(`Invalid faucet ${field} padding`);
      for (let byteIndex = 0; byteIndex < 7; byteIndex++) {
        bytes[(wordIndex * 4 + feltIndex) * 7 + byteIndex] = Number(value & 255n);
        value >>= 8n;
      }
    }
  }
  const length = bytes[0]!;
  if (length > maxBytes) throw new Error(`Invalid faucet ${field} length`);
  // Rust preserves BOMs and embedded zeros, and ignores unused low payload bytes.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(1, length + 1));
}

function readSymbol(value: bigint): string {
  if (value < 1n || value > MAX_SYMBOL) throw new Error('Invalid faucet symbol range');
  const length = Number(value % 26n);
  if (length < 1 || length > 12) throw new Error('Invalid faucet symbol length');
  let remaining = value / 26n;
  let symbol = '';
  for (let index = 0; index < length; index++) {
    symbol = String.fromCharCode(65 + Number(remaining % 26n)) + symbol;
    remaining /= 26n;
  }
  if (remaining !== 0n) throw new Error('Invalid faucet symbol remainder');
  return symbol;
}

/** Reads the complete standard storage layout using miden-standards 0.17.1 decoding rules. */
export function readFaucetProofMetadata(proof: AccountProof): AssetMetadata {
  const [supply, maxSupply, decimals, encodedSymbol] = readWord(proof, 'fungible::token_config');
  if (supply > MAX_AMOUNT || maxSupply > MAX_AMOUNT || supply > maxSupply) {
    throw new Error('Invalid faucet supply');
  }
  if (decimals > 12n) throw new Error('Invalid faucet decimals');
  const symbol = readSymbol(encodedSymbol);
  const name = readString(proof, 'token_name', 2, 32);
  const description = readString(proof, 'token_description', 7, 195);
  readString(proof, 'logo_uri', 7, 195);
  readString(proof, 'external_link', 7, 195);
  if (readWord(proof, 'mutability_config').some(flag => flag !== 0n && flag !== 1n)) {
    throw new Error('Invalid faucet mutability flag');
  }
  return {
    symbol,
    name: name || symbol,
    decimals: Number(decimals),
    scaleIsUnknown: false,
    ...(description ? { description } : {})
  };
}

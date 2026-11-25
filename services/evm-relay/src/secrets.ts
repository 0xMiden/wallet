// Read the two secrets: the relayer key and the RPC URL of each chain. No function returns or logs a secret value,
// except rpcUrlOf, whose value only the chain reader uses.
import { privateKeyToAddress } from 'viem/accounts';

import type { Hex } from './config';
import type { Env } from './types';

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** The last derivation. It saves one curve multiplication per request. */
let derived: { key: string; address: Hex | null } | null = null;

function deriveAddress(key: string): Hex | null {
  try {
    const address = privateKeyToAddress(`0x${key.slice(2)}`);
    return `0x${address.slice(2).toLowerCase()}`;
  } catch {
    // The key is 32 bytes of hex but not a valid secp256k1 scalar.
    return null;
  }
}

/** The relayer address, lower case. Null when RELAYER_PRIVATE_KEY is missing or is not `0x` and 64 hex characters. */
export function relayerAddress(env: Env): Hex | null {
  const key = env.RELAYER_PRIVATE_KEY;
  if (typeof key !== 'string' || !PRIVATE_KEY.test(key)) return null;
  if (derived?.key !== key) derived = { key, address: deriveAddress(key) };
  return derived.address;
}

/** The JSON-RPC URL of a chain from the secret `RPC_URL_<chainId>`. Null when it is missing or not an HTTP(S) URL. */
export function rpcUrlOf(env: Env, chainId: number): string | null {
  const value: unknown = Reflect.get(env, `RPC_URL_${chainId}`);
  if (typeof value !== 'string') return null;
  try {
    const { protocol } = new URL(value);
    switch (protocol) {
      case 'https:':
      case 'http:':
        return value;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

import { randomBytes } from 'node:crypto';

import { verifyMessage, type Address, type Hex } from 'viem';

/** A challenge stays valid for this number of seconds. */
export const CHALLENGE_TTL_SECONDS = 300;

export interface ChallengeMessageInput {
  fiatAmount: string;
  address: Address;
  nonce: string;
  /** Unix time in seconds. */
  expiresAt: number;
}

/**
 * Build the text that the wallet signs.
 * The wallet has a byte-identical twin in `src/lib/onramp/transak-message.ts`.
 * If you change this text, change the twin at the same time.
 */
export function buildChallengeMessage({ fiatAmount, address, nonce, expiresAt }: ChallengeMessageInput): string {
  const expires = new Date(expiresAt * 1000).toISOString();
  return `Buy ${fiatAmount} USD of USDC on Ethereum to ${address} via Transak. Nonce ${nonce}, expires ${expires}.`;
}

export interface ChallengeEntry {
  /** Checksummed address. */
  address: Address;
  /** The amount string exactly as the client sent it. */
  fiatAmount: string;
  /** Unix time in seconds. */
  expiresAt: number;
}

export interface IssuedChallenge {
  nonce: string;
  expiresAt: number;
  message: string;
}

/** In-memory store of open challenges. Each nonce is single use. */
export class ChallengeStore {
  private readonly entries = new Map<string, ChallengeEntry>();

  /** `now` returns the time in milliseconds. */
  constructor(private readonly now: () => number) {}

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  issue(address: Address, fiatAmount: string): IssuedChallenge {
    this.prune();
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = this.nowSeconds() + CHALLENGE_TTL_SECONDS;
    this.entries.set(nonce, { address, fiatAmount, expiresAt });
    return { nonce, expiresAt, message: buildChallengeMessage({ fiatAmount, address, nonce, expiresAt }) };
  }

  /** Remove the entry first, then check expiry. A second call for the same nonce gets null. */
  take(nonce: string): ChallengeEntry | null {
    const entry = this.entries.get(nonce);
    this.entries.delete(nonce);
    if (entry === undefined || entry.expiresAt <= this.nowSeconds()) {
      return null;
    }
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const nowSeconds = this.nowSeconds();
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt <= nowSeconds) {
        this.entries.delete(nonce);
      }
    }
  }
}

/** Return true only when `signature` is a signature of the challenge text by `entry.address`. */
export async function verifyChallenge(entry: ChallengeEntry, nonce: string, signature: Hex): Promise<boolean> {
  const message = buildChallengeMessage({ ...entry, nonce });
  try {
    return await verifyMessage({ address: entry.address, message, signature });
  } catch {
    // A signature that does not parse is a failed check.
    return false;
  }
}

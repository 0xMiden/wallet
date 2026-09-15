/**
 * Mints the chain's NATIVE asset from a public Miden faucet.
 *
 * The harness's other funding route reads genesis wallets out of the local stack's
 * `data/accounts`. That directory exists only where we control genesis, so on a public
 * fee-charging chain (devnet) there was no way to give a fresh account the native asset
 * it needs before it can transact at all — its vault is empty and `pay_fee` withdraws
 * from that vault inside `auth_tx`.
 *
 * A public faucet closes that gap: on devnet the faucet's own account IS the chain's
 * native fee-asset faucet (its bech32 id decodes to the `fee_parameters.native_asset_id`
 * the block header reports), so a grant from it is spendable on fees. It hands back a
 * PUBLIC note addressed to the account, which the account then consumes — the same
 * shape as the genesis-funder path, and the consumption doubles as the deploy, because
 * note credit lands before `pay_fee` takes its cut.
 *
 * The wire protocol is mirrored from `src/lib/miden-chain/faucet-api.ts`, which the
 * wallet itself uses in production; that module is not imported here because it pulls
 * the WASM SDK in through `effective-endpoints`. Getting the proof-of-work wrong cannot
 * pass silently — the faucet rejects a bad nonce — so the two can only diverge loudly.
 */

import { createHash } from 'crypto';

/** Public faucet API per network. Absent = no public funding source for that network. */
const FAUCET_API_BY_NETWORK: Record<string, string | undefined> = {
  devnet: 'https://faucet-api.devnet.miden.io',
  testnet: 'https://faucet-api.testnet.miden.io',
  localhost: undefined
};

/** Grant size, in base units. The devnet faucet's own `base_amount`. */
export const PUBLIC_FAUCET_GRANT = 100_000_000n;

const FETCH_TIMEOUT_MS = 15_000;
const POW_SOLVE_DEADLINE_MS = 30_000;
/** Hashes tried per synchronous slice of a solve, before it yields to the event loop. */
const POW_HASHES_PER_SLICE = 20_000;

export function publicFaucetApiUrl(network: string): string | undefined {
  return FAUCET_API_BY_NETWORK[network];
}

async function faucetFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * A nonce solves the challenge when the first 8 bytes of
 * `SHA-256(challenge ‖ nonce_as_be_u64)`, read big-endian, are below `target`.
 *
 * Hashes synchronously, in slices that yield to the event loop between them. Awaiting
 * WebCrypto once per hash managed about 127k hashes a second locally, against 1.7M for
 * node's hash, so a target the faucet had raised (2^45, about 524k expected hashes) could
 * outlast the deadline on a busy macOS runner, and the faucet expires a challenge after 30 s.
 */
export async function solvePow(
  challengeHex: string,
  target: bigint,
  deadlineMs: number = POW_SOLVE_DEADLINE_MS
): Promise<number> {
  const challengeBytes = hexToBytes(challengeHex);
  const buffer = Buffer.alloc(challengeBytes.length + 8);
  buffer.set(challengeBytes);
  const deadline = Date.now() + deadlineMs;

  for (;;) {
    for (let i = 0; i < POW_HASHES_PER_SLICE; i++) {
      const nonce = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      buffer.writeBigUInt64BE(BigInt(nonce), challengeBytes.length);
      if (createHash('sha256').update(buffer).digest().readBigUInt64BE(0) < target) {
        return nonce;
      }
    }
    // Yield before the deadline check, so timers and sockets in this process get a turn between slices however
    // slow the machine is. A `target` of 0 is unsatisfiable by any nonce; bound the solve rather than spin.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (Date.now() >= deadline) {
      throw new Error(
        `Public faucet PoW unsolved within ${deadlineMs}ms (target=${target}); ` +
          'the challenge is malformed or the difficulty was raised.'
      );
    }
  }
}

/** Grant attempts when the faucet answers 5xx; each starts from a fresh challenge. */
const GRANT_ATTEMPTS = 3;
const GRANT_RETRY_DELAY_MS = 5_000;

/** The faucet failed on its own side (5xx), so the same grant can succeed on a later attempt. */
class FaucetServerError extends Error {}

async function failedResponse(label: string, response: Response): Promise<Error> {
  const message = `${label} (${response.status}): ${await response.text()}`;
  return response.status >= 500 ? new FaucetServerError(message) : new Error(message);
}

async function requestGrant(
  baseUrl: string,
  accountId: string,
  amount: bigint
): Promise<{ txId: string; noteId: string }> {
  const powResponse = await faucetFetch(
    `${baseUrl}/pow?${new URLSearchParams({ account_id: accountId, amount: amount.toString() })}`
  );
  if (!powResponse.ok) {
    throw await failedResponse('Public faucet PoW request failed', powResponse);
  }
  const { challenge, target } = (await powResponse.json()) as { challenge: string; target: number };
  const nonce = await solvePow(challenge, BigInt(target));

  const params = new URLSearchParams({
    account_id: accountId,
    is_private_note: 'false',
    asset_amount: amount.toString(),
    challenge,
    nonce: nonce.toString()
  });
  const response = await faucetFetch(`${baseUrl}/get_tokens?${params}`);
  if (!response.ok) {
    throw await failedResponse('Public faucet mint failed', response);
  }
  const json = (await response.json()) as { tx_id: string; note_id: string };
  return { txId: json.tx_id, noteId: json.note_id };
}

/**
 * Requests `amount` base units of the native asset for `accountId` (bech32).
 * Resolves once the faucet has SUBMITTED the note; the caller still has to wait for it
 * to commit and then consume it.
 *
 * A 5xx is the faucet's own failure (testnet answered `500 Internal error` and `502 Bad Gateway`
 * during incidents), so the grant is retried from a new challenge, which also avoids replaying one
 * that may have expired. A 4xx answers this request and fails at once.
 */
export async function mintFromPublicFaucet(
  baseUrl: string,
  accountId: string,
  amount: bigint = PUBLIC_FAUCET_GRANT,
  retryDelayMs: number = GRANT_RETRY_DELAY_MS
): Promise<{ txId: string; noteId: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestGrant(baseUrl, accountId, amount);
    } catch (error) {
      if (!(error instanceof FaucetServerError) || attempt >= GRANT_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

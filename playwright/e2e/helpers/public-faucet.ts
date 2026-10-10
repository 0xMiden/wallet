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

import type { Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { SerializedInputNoteDetail } from '../../../src/lib/shared/types';

/** Public faucet API per network. Absent = no public funding source for that network. */
const FAUCET_API_BY_NETWORK: Record<string, string | undefined> = {
  devnet: 'https://faucet-api.devnet.miden.io',
  testnet: 'https://faucet-api.testnet.miden.io',
  localhost: undefined
};

const FETCH_TIMEOUT_MS = 15_000;
const POW_SOLVE_DEADLINE_MS = 30_000;
/** Hashes tried per synchronous slice of a solve, before it yields to the event loop. */
const POW_HASHES_PER_SLICE = 20_000;

export function publicFaucetApiUrl(network: string): string | undefined {
  return FAUCET_API_BY_NETWORK[network];
}

/**
 * How every public-faucet helper rejects: the message begins "Public faucet" and the original failure is the cause.
 * A timeout, undici's "fetch failed" or a malformed answer does not name the faucet on its own, and the dApp journeys
 * tell a faucet outage from a wallet failure by that name (`isInfrastructureFailure`, dapp-cells.ts).
 */
export class PublicFaucetError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PublicFaucetError';
  }
}

/** `error` as a PublicFaucetError, keeping a message that already names the faucet. */
export function publicFaucetFailure(error: unknown, what: string): PublicFaucetError {
  if (error instanceof PublicFaucetError) return error;
  if (error instanceof Error && error.message.startsWith('Public faucet')) {
    return new PublicFaucetError(error.message, { cause: error });
  }
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new PublicFaucetError(`Public faucet ${what} failed: ${text}`, { cause: error });
}

/**
 * Fetches `url` and runs `read` on the response inside one bound, as the app's faucetFetch does: the timer runs
 * through the body read and aborts with a TimeoutError naming the bound, and the request is aborted once `read`
 * settles, which ends any body it left unread.
 */
async function faucetFetch<T>(url: string, read: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Request timed out after ${FETCH_TIMEOUT_MS} ms`, 'TimeoutError')),
    FETCH_TIMEOUT_MS
  );
  try {
    return await read(await fetch(url, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
    controller.abort();
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
/**
 * Total time a grant may spend waiting out 429s. The faucet rate-limits a SHARED cooldown, not the
 * target account: on the first run of the devnet suites on next, four parallel jobs each had their
 * first grant for a brand-new account refused with "Account is rate limited for 25 more seconds".
 */
const RATE_LIMIT_BUDGET_MS = 180_000;
/** Wait assumed when a 429 does not say how long. */
const RATE_LIMIT_FALLBACK_MS = 30_000;

/** The faucet failed on its own side (5xx), so the same grant can succeed on a later attempt. */
class FaucetServerError extends Error {}

/** The faucet refused for now (429) and said, or implied, when to come back. */
class FaucetRateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number
  ) {
    super(message);
  }
}

async function failedResponse(label: string, response: Response): Promise<Error> {
  // The status decides whether a retry can help; a body that fails or stalls only loses the explanation.
  const message = `${label} (${response.status}): ${await response.text().catch(() => '')}`;
  if (response.status === 429) {
    // "Account is rate limited for 25 more seconds." A second over, so the retry lands after it.
    const seconds = message.match(/(\d+)\s+more\s+seconds?/i)?.[1];
    return new FaucetRateLimitedError(message, seconds ? (Number(seconds) + 1) * 1000 : RATE_LIMIT_FALLBACK_MS);
  }
  return response.status >= 500 ? new FaucetServerError(message) : new Error(message);
}

async function requestGrant(
  baseUrl: string,
  accountId: string,
  amount: bigint
): Promise<{ txId?: string; noteId: string }> {
  const { challenge, target } = await faucetFetch(
    `${baseUrl}/pow?${new URLSearchParams({ account_id: accountId, amount: amount.toString() })}`,
    async response => {
      if (!response.ok) {
        throw await failedResponse('Public faucet PoW request failed', response);
      }
      const json: { challenge: string; target: number } = await response.json();
      return json;
    }
  );
  const nonce = await solvePow(challenge, BigInt(target));

  const params = new URLSearchParams({
    account_id: accountId,
    is_private_note: 'false',
    asset_amount: amount.toString(),
    challenge,
    nonce: nonce.toString()
  });
  return faucetFetch(`${baseUrl}/get_tokens?${params}`, async response => {
    if (!response.ok) {
      throw await failedResponse('Public faucet mint failed', response);
    }
    const json: unknown = await response.json();
    const noteId = json && typeof json === 'object' ? Reflect.get(json, 'note_id') : undefined;
    if (typeof noteId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(noteId)) {
      throw new Error('Public faucet returned an invalid note ID');
    }
    const txId = Reflect.get(json as object, 'tx_id');
    return { txId: typeof txId === 'string' ? txId : undefined, noteId };
  });
}

async function advertisedGrantAmount(baseUrl: string): Promise<bigint> {
  return faucetFetch(`${baseUrl}/get_metadata`, async response => {
    if (!response.ok) throw await failedResponse('Public faucet metadata request failed', response);
    const metadata: unknown = await response.json();
    const baseAmount = metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'base_amount') : undefined;
    if (typeof baseAmount !== 'number' || !Number.isSafeInteger(baseAmount) || baseAmount <= 0) {
      throw new Error('Faucet metadata base_amount must be a positive safe integer');
    }
    return BigInt(baseAmount);
  });
}

/**
 * Requests `amount` base units of the native asset for `accountId` (bech32).
 * When omitted, resolves the faucet's advertised base grant once and retains it across retries.
 * Resolves once the faucet has SUBMITTED the note; the caller still has to wait for it
 * to commit and then consume it.
 *
 * A 5xx is the faucet's own failure (testnet answered `500 Internal error` and `502 Bad Gateway`
 * during incidents), so the grant is retried from a new challenge, which also avoids replaying one
 * that may have expired. A 429 is waited out for as long as the faucet asks, within
 * `RATE_LIMIT_BUDGET_MS`, and does not count against the 5xx attempts. Any other 4xx answers this
 * request and fails at once. Every rejection is a `PublicFaucetError`.
 */
export async function mintFromPublicFaucet(
  baseUrl: string,
  accountId: string,
  amount?: bigint,
  retryDelayMs: number = GRANT_RETRY_DELAY_MS,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))
): Promise<{ txId?: string; noteId: string }> {
  let resolvedAmount = amount;
  let serverFailures = 0;
  let rateLimitedMs = 0;
  for (;;) {
    try {
      resolvedAmount ??= await advertisedGrantAmount(baseUrl);
      return await requestGrant(baseUrl, accountId, resolvedAmount);
    } catch (error) {
      if (error instanceof FaucetRateLimitedError && rateLimitedMs + error.retryAfterMs <= RATE_LIMIT_BUDGET_MS) {
        rateLimitedMs += error.retryAfterMs;
        await sleep(error.retryAfterMs);
        continue;
      }
      if (!(error instanceof FaucetServerError) || ++serverFailures >= GRANT_ATTEMPTS) {
        throw publicFaucetFailure(error, 'grant');
      }
      await sleep(retryDelayMs * serverFailures);
    }
  }
}

export async function fundFreshGuardianThroughUi(page: Page, network: string, outputDir: string) {
  const { vaultBalanceByFaucetId, walletDiscoveredNativeFaucetId } = await import('./balance-truth');
  const { readTransactionRows, TxStatus } = await import('./history');
  if (!publicFaucetApiUrl(network)) throw new Error(`No public faucet for ${network}`);
  if (process.env.CI && (process.env.E2E_RETRY_EXISTING_FAUCET || process.env.E2E_WALLET_A_PROFILE)) {
    throw new Error('CI public funding must use a fresh profile without replay');
  }
  await page.setViewportSize({ width: 1280, height: 960 });
  fs.mkdirSync(outputDir, { recursive: true });
  const screenshot = async (name: string) => {
    const filename = path.join(outputDir, `${name}.png`);
    await page.screenshot({ path: filename, scale: 'css' });
    if (process.platform === 'darwin') execFileSync('sips', ['-Z', '1800', filename], { stdio: 'ignore' });
  };
  const evidence = async () => {
    const transactions = await readTransactionRows(page);
    const nativeFaucetId = await walletDiscoveredNativeFaucetId(page);
    const balance = nativeFaucetId ? await vaultBalanceByFaucetId(page, nativeFaucetId) : 0n;
    const consume = transactions.filter(row => row.type === 'consume');
    const ids = [...new Set(consume.flatMap(row => row.noteIds ?? (row.noteId ? [row.noteId] : [])))];
    const notes: SerializedInputNoteDetail[] = ids.length
      ? await page.evaluate(async noteIds => {
          const intercom = (window as any).__TEST_INTERCOM__;
          if (!intercom) throw new Error('Missing real wallet intercom');
          const result = await intercom.request({ type: 'GET_INPUT_NOTE_DETAILS_REQUEST', noteIds });
          if (result.type !== 'GET_INPUT_NOTE_DETAILS_RESPONSE') throw new Error('Unexpected input note response');
          return result.notes;
        }, ids)
      : [];
    const snapshot = { network, nativeFaucetId, nativeVaultBaseUnits: balance.toString(), notes, transactions };
    fs.writeFileSync(path.join(outputDir, 'public-faucet-evidence.json'), JSON.stringify(snapshot, null, 2));
    return snapshot;
  };
  if ((await readTransactionRows(page)).some(row => row.type === 'consume')) {
    throw new Error('Public faucet verification requires a fresh wallet without previous consumes');
  }
  const pinPrompt = page.getByRole('button', { name: 'Got it', exact: true });
  if (await pinPrompt.isVisible()) await pinPrompt.click();
  const fund = page.getByRole('button', { name: /Fund your wallet/i });
  await fund.waitFor({ state: 'visible', timeout: 60_000 });
  await fund.click();
  try {
    // Real tab taps exercise responsiveness without reloading the pending faucet request.
    await page.getByRole('button', { name: /^Activity(?:,|$)/ }).click({ timeout: 10_000 });
    await page.waitForURL(/#\/history/, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Home', exact: true }).click({ timeout: 10_000 });
    await page.waitForURL(/#\/$/, { timeout: 10_000 });
    await screenshot('public-faucet-navigation-responsive');
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const snapshot = await evidence();
      const consume = snapshot.transactions.filter(row => row.type === 'consume');
      const failed = consume.find(row => row.status === TxStatus.Failed);
      if (failed)
        throw new Error(`Public faucet consume failed: ${failed.rawError ?? failed.error ?? JSON.stringify(failed)}`);
      const completed = consume.filter(row => row.status === TxStatus.Completed);
      if (completed.length > 1) throw new Error('Fresh faucet wallet unexpectedly completed multiple consumes');
      const transaction = completed[0];
      const noteIds = transaction?.noteIds ?? (transaction?.noteId ? [transaction.noteId] : []);
      // SDK states 4/5 await confirmation; 6/7 carry the chain-confirmed nullifier height.
      const received = snapshot.notes.filter(note => noteIds.includes(note.noteId) && ['6', '7'].includes(note.state));
      const balance = BigInt(snapshot.nativeVaultBaseUnits);
      if (transaction && received.length === noteIds.length && noteIds.length && balance > 0n) {
        const granted = received
          .flatMap(note => note.assets)
          .filter(asset => asset.faucetId === snapshot.nativeFaucetId)
          .reduce((total, asset) => total + BigInt(asset.amount), 0n);
        const fee = BigInt(transaction.feeAmount ?? '0');
        if (
          !snapshot.nativeFaucetId ||
          (fee > 0n && transaction.feeFaucetId !== snapshot.nativeFaucetId) ||
          balance !== granted - fee
        ) {
          throw new Error(
            `Native vault does not equal the consumed public grant minus its fee: ${JSON.stringify(snapshot)}`
          );
        }
        await screenshot('public-faucet-consumed');
        return snapshot;
      }
      await page.waitForTimeout(2_000);
    }
    throw new Error(`Public faucet did not consume into a positive vault: ${JSON.stringify(await evidence())}`);
  } finally {
    await evidence().catch(() => {});
    if (!page.isClosed()) await screenshot('public-faucet-final-state').catch(() => {});
  }
}

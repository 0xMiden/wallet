import { GuardianHttpClient } from '@openzeppelin/guardian-client';

import {
  clearGuardianNoteRecoveryProgress,
  reportGuardianNoteRecoveryProgress
} from 'lib/guardian-note-recovery-progress';
import { getSignerDetailsFromAccount, resolveGuardianEndpoint } from 'lib/miden/guardian/account';
import { registerGuardianOrigin } from 'lib/miden/guardian/native-http';
import { WalletSigner } from 'lib/miden/guardian/signer';
import { canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getAllUncompletedTransactions } from 'lib/miden/transaction/get';
import { b64ToU8 } from 'lib/shared/helpers';
import { WalletAccount } from 'lib/shared/types';

import { getAccountsWriteQueue } from './accounts-write-queue';
import { midenClientProxy } from './miden-client-proxy';
import { accountsUpdated, store } from './store';
import { doSync } from './sync-manager';
import type { Vault } from './vault';

// NOTE: transaction-history recovery from Guardian's retained deltas is NOT
// implemented here. It cannot be built against today's Guardian API: the
// server only lists PENDING proposals on GET /delta/proposal, `getDelta`
// needs the exact proposer-chosen `Date.now()` nonces (unknowable after seed
// recovery), and `getDeltaSince` merges the history into one metadata-less
// blob — so completed history is unreachable until a Guardian release exposes
// canonical delta history (OpenZeppelin/guardian#357).

export interface GuardianPendingNoteRecoveryResult {
  proposalNotes: number;
  publicNotes: number;
  sourceFailures: number;
  /**
   * Set when the run stopped early to get out of the way — the wallet locked
   * under it, or a transaction appeared. Not a failure: the caller releases the
   * account's reservation so it is retried in this same backend lifetime.
   */
  deferred: boolean;
}

/**
 * The live vault, or null when the wallet is locked.
 *
 * The recovery runs detached for minutes, so it must never hold a `Vault`
 * across those awaits: an auto-lock nulls the store's vault, and `withUnlocked`
 * only asserts the store is INITED (see `store.ts`), so nothing downstream
 * would notice. A captured vault would keep cold-signing Guardian requests
 * after the user locked, and `accountsUpdated` merges into state that `locked`
 * deliberately rebuilt empty ("Security stuff! ... Reset all properties!"),
 * repopulating `accounts`/`currentAccount` into a locked wallet's front state.
 * Resolving it at each point of use is the same defence the transaction
 * processor's `withUnlockedVault` provides for issue #313.
 */
function liveVault(): Vault | null {
  return store.getState().vault ?? null;
}

function isWalletLocked(): boolean {
  return liveVault() === null;
}

/**
 * Whether the run must stop and give the client back, checked between every
 * chunk. Kickoff-time gating is not enough: the run lasts minutes, and the
 * user can lock the wallet or start a transaction at any point inside it. A
 * transaction's short-deadline reads queued behind a recovery op get
 * deadline-killed — the "hot-key rotation always fails on the first try" bug
 * this feature's gating exists to avoid.
 *
 * Returns the reason to stop, or null to keep going.
 */
async function shouldYield(): Promise<'wallet locked' | 'transaction in flight' | null> {
  if (isWalletLocked()) return 'wallet locked';
  try {
    if (!(await isSafeToRunNow())) return 'transaction in flight';
  } catch (error) {
    // Advisory check: a rejected Dexie query is no reason to abandon a run
    // that is otherwise making progress.
    console.warn('[GuardianRecovery] Could not check for live transactions mid-run; continuing:', error);
  }
  return null;
}

/**
 * Upper bound on notes accepted from a Guardian's pending proposals. The
 * response is remote and only as trustworthy as the operator, and every entry
 * costs a base64 decode, a WASM deserialize, an RPC round trip and a store
 * write — so it is capped rather than iterated to whatever length arrives.
 */
const MAX_PROPOSAL_NOTES = 500;

/**
 * Proposal notes imported per offscreen op. The public backfill is chunked for
 * exactly this reason and the proposal import must be too: on mobile and
 * desktop `USE_OFFSCREEN_CLIENT` is off, so a single call runs inline and holds
 * the one WASM mutex — with no op deadline — for as long as it takes.
 */
const PROPOSAL_IMPORT_BATCH_SIZE = 25;

/**
 * Longest base64 note accepted from a Guardian. `MAX_PROPOSAL_NOTES` bounds the
 * COUNT; without a length bound too, a handful of entries can still be
 * gigabytes of string, and `b64ToU8` materializes each one as a second copy in
 * a service worker with no memory headroom. A serialized consume note is a few
 * KB, so this is orders of magnitude of slack.
 */
const MAX_PROPOSAL_NOTE_B64_LENGTH = 1_000_000;

interface GuardianClientContext {
  guardian: GuardianHttpClient;
  /** Hex account id (`0x…`) — Guardian request signing (`AuthDigest`) rejects the composite bech32 publicKey. */
  guardianAccountId: string;
}

interface GuardianPendingNotePayload {
  proposalNoteBytes: Uint8Array[];
  proposalFetchFailed: boolean;
}

function withHexPrefix(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}

async function createGuardianClientContext(account: WalletAccount): Promise<GuardianClientContext> {
  if (!account.coldPublicKey) {
    throw new Error(`Recovered Guardian account ${account.publicKey} is missing its cold public key`);
  }
  const commitment = await withWasmClientLock(async () => {
    const sdkAccount = await midenClientProxy.getAccount(account.publicKey);
    if (!sdkAccount) throw new Error(`Recovered Guardian account ${account.publicKey} is unavailable locally`);
    const details = await getSignerDetailsFromAccount(sdkAccount, true);
    return details.commitment;
  });

  const guardianEndpoint = await resolveGuardianEndpoint(account);
  registerGuardianOrigin(guardianEndpoint);
  const guardian = new GuardianHttpClient(guardianEndpoint);
  guardian.setSigner(
    // Resolved per signature, never captured: a lock landing mid-run must stop
    // the cold key from signing anything further.
    new WalletSigner(withHexPrefix(account.coldPublicKey), withHexPrefix(commitment), (publicKey, wordHex) => {
      const vault = liveVault();
      if (!vault) throw new Error('Wallet is locked: refusing to sign a Guardian recovery request');
      return vault.signWord(publicKey, wordHex);
    })
  );
  return {
    guardian,
    guardianAccountId: canonicalWalletAccountId(account.publicKey)
  };
}

async function fetchProposalNotePayload(
  account: WalletAccount,
  context: GuardianClientContext
): Promise<GuardianPendingNotePayload> {
  try {
    const proposals = await context.guardian.getDeltaProposals(context.guardianAccountId);
    const proposalNoteBytes: Uint8Array[] = [];
    let undecodable = 0;
    let truncated = false;
    for (const proposal of proposals) {
      const metadata = proposal.deltaPayload.metadata;
      if (metadata?.proposalType !== 'consume_notes' || metadata.consumeNotesMetadataVersion !== 2) continue;
      for (const encodedNote of metadata.consumeNotesNotes ?? []) {
        if (proposalNoteBytes.length >= MAX_PROPOSAL_NOTES) {
          truncated = true;
          break;
        }
        if (typeof encodedNote !== 'string' || encodedNote.length > MAX_PROPOSAL_NOTE_B64_LENGTH) {
          undecodable++;
          console.warn(`[GuardianRecovery] Skipping oversized/non-string proposal note for ${account.publicKey}`);
          continue;
        }
        // Decode per note: the payload is remote, and `b64ToU8` throws on
        // malformed base64. One bad entry must not discard the notes already
        // collected from earlier proposals.
        try {
          proposalNoteBytes.push(b64ToU8(encodedNote));
        } catch (error) {
          undecodable++;
          console.warn(`[GuardianRecovery] Skipping undecodable proposal note for ${account.publicKey}:`, error);
        }
      }
      if (truncated) break;
    }
    if (truncated) {
      console.warn(
        `[GuardianRecovery] Guardian offered more than ${MAX_PROPOSAL_NOTES} proposal notes for ` +
          `${account.publicKey}; importing the first ${MAX_PROPOSAL_NOTES} and keeping the recovery pending`
      );
    }
    console.log(
      `[GuardianRecovery] Pending proposals for ${account.publicKey}: ${proposals.length} proposals, ` +
        `${proposalNoteBytes.length} embedded consume notes, ${undecodable} undecodable`
    );
    return { proposalNoteBytes, proposalFetchFailed: undecodable > 0 || truncated };
  } catch (error) {
    console.warn(`[GuardianRecovery] Pending proposal lookup failed for ${account.publicKey}:`, error);
    return { proposalNoteBytes: [], proposalFetchFailed: true };
  }
}

/**
 * Account creation time (unix seconds) from the Guardian's `getState`
 * metadata. 0 on any failure or on a value that cannot be a creation time —
 * the scan-range resolver treats 0 as "unknown" and falls back to scanning
 * from genesis.
 *
 * The value only ever narrows the scan, so a wrong one silently costs
 * recovered notes: a timestamp in the future makes the resolver start at the
 * chain tip, the run then finds nothing and reports success, and the one-shot
 * flag clears. Since it comes from a remote operator (and from that host's
 * clock), anything at or beyond "now" is treated as unusable rather than
 * trusted.
 */
async function fetchAccountCreatedAtSeconds(account: WalletAccount, context: GuardianClientContext): Promise<number> {
  try {
    const state = await context.guardian.getState(context.guardianAccountId);
    const parsed = Date.parse(state.createdAt);
    if (Number.isNaN(parsed)) return 0;
    const createdAtSeconds = Math.floor(parsed / 1000);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (createdAtSeconds <= 0 || createdAtSeconds > nowSeconds) {
      console.warn(
        `[GuardianRecovery] Ignoring implausible createdAt "${state.createdAt}" for ${account.publicKey}; ` +
          'scanning from genesis instead'
      );
      return 0;
    }
    return createdAtSeconds;
  } catch (error) {
    console.warn(`[GuardianRecovery] Account createdAt lookup failed for ${account.publicKey}:`, error);
    return 0;
  }
}

/**
 * Blocks per public-backfill chunk. Bounds how long any single offscreen call
 * holds the WASM mutex (queued reads deadline-kill the realm behind a
 * long-held mutex) and sets the granularity of the progress card.
 */
const PUBLIC_BACKFILL_CHUNK_BLOCKS = 200_000;

export async function recoverPendingNotes(account: WalletAccount): Promise<GuardianPendingNoteRecoveryResult> {
  console.log(`[GuardianRecovery] Recovering pending notes for ${account.publicKey}...`);
  const result: GuardianPendingNoteRecoveryResult = {
    proposalNotes: 0,
    publicNotes: 0,
    sourceFailures: 0,
    deferred: false
  };

  try {
    // Source 1: drain the private-note transport backlog.
    await reportGuardianNoteRecoveryProgress({ accountId: account.publicKey, step: 'transport' });
    try {
      await midenClientProxy.drainPrivateNoteTransport();
    } catch (error) {
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Private-note transport drain failed for ${account.publicKey}:`, error);
    }

    const yieldedBeforeProposals = await shouldYield();
    if (yieldedBeforeProposals) {
      result.deferred = true;
      console.warn(`[GuardianRecovery] Yielding (${yieldedBeforeProposals}) before proposals for ${account.publicKey}`);
      return result;
    }

    // Source 2: notes embedded in pending consume proposals.
    await reportGuardianNoteRecoveryProgress({ accountId: account.publicKey, step: 'proposals' });
    let context: GuardianClientContext | undefined;
    try {
      context = await createGuardianClientContext(account);
    } catch (error) {
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Guardian client setup failed for ${account.publicKey}:`, error);
    }
    let createdAtSeconds = 0;
    if (context) {
      const payload = await fetchProposalNotePayload(account, context);
      if (payload.proposalFetchFailed) result.sourceFailures++;
      // Batched so no single op holds the WASM mutex for the whole payload.
      for (let start = 0; start < payload.proposalNoteBytes.length; start += PROPOSAL_IMPORT_BATCH_SIZE) {
        const batch = payload.proposalNoteBytes.slice(start, start + PROPOSAL_IMPORT_BATCH_SIZE);
        const yielded = await shouldYield();
        if (yielded) {
          result.deferred = true;
          console.warn(`[GuardianRecovery] Yielding (${yielded}) mid-proposal-import for ${account.publicKey}`);
          return result;
        }
        try {
          const imported = await midenClientProxy.importRecoveryNoteBytes(batch);
          result.proposalNotes += imported.imported;
          result.sourceFailures += imported.failures;
        } catch (error) {
          result.sourceFailures++;
          console.warn(`[GuardianRecovery] Proposal note import failed for ${account.publicKey}:`, error);
        }
      }
      createdAtSeconds = await fetchAccountCreatedAtSeconds(account, context);
    }

    // Source 3: public notes by account tag, scanned from the account's
    // creation block (not genesis) in bounded chunks with live progress.
    try {
      const { startBlock, latestBlock } = await midenClientProxy.resolveRecoveryScanRange(createdAtSeconds);
      console.log(`[GuardianRecovery] Public backfill for ${account.publicKey}: blocks ${startBlock}-${latestBlock}`);
      await reportGuardianNoteRecoveryProgress({
        accountId: account.publicKey,
        step: 'public',
        startBlock,
        syncedToBlock: startBlock,
        latestBlock
      });
      let scannedToBlock = startBlock;
      // A work list rather than a fixed stride, because a chunk can come back
      // `saturated` — too wide for the node, or holding more tag matches than
      // one op should import. Halves are pushed to the FRONT, so ranges are
      // still completed in ascending order and `scannedToBlock` stays a true
      // watermark. Each retry is its own offscreen op, which is the point: the
      // narrowing happens between ops, not inside one holding the WASM mutex.
      const pending: Array<[number, number]> = [];
      for (let blockFrom = startBlock; blockFrom <= latestBlock; blockFrom += PUBLIC_BACKFILL_CHUNK_BLOCKS) {
        pending.push([blockFrom, Math.min(latestBlock, blockFrom + PUBLIC_BACKFILL_CHUNK_BLOCKS - 1)]);
      }
      while (pending.length > 0) {
        const [blockFrom, blockTo] = pending.shift()!;
        const yielded = await shouldYield();
        if (yielded) {
          result.deferred = true;
          console.warn(`[GuardianRecovery] Yielding (${yielded}) mid-backfill for ${account.publicKey}`);
          return result;
        }
        try {
          const chunk = await midenClientProxy.recoverPublicNotesRange(account.publicKey, blockFrom, blockTo);
          result.publicNotes += chunk.imported;
          result.sourceFailures += chunk.failures;
          if (chunk.saturated && blockTo > blockFrom) {
            const midpoint = blockFrom + Math.floor((blockTo - blockFrom) / 2);
            pending.unshift([blockFrom, midpoint], [midpoint + 1, blockTo]);
          } else if (chunk.saturated) {
            // Unsplittable and still saturated. The flag comes over the realm
            // boundary as JSON, so this is also the guard that keeps a bogus
            // `saturated` from looping forever on a one-block range.
            result.sourceFailures++;
            console.warn(`[GuardianRecovery] Block ${blockFrom} stayed saturated for ${account.publicKey}; skipping`);
          } else {
            // Only a chunk that actually completed advances the reported
            // progress, so the card never claims a range it skipped.
            scannedToBlock = blockTo;
          }
        } catch (error) {
          result.sourceFailures++;
          console.warn(
            `[GuardianRecovery] Public backfill chunk ${blockFrom}-${blockTo} failed for ${account.publicKey}:`,
            error
          );
        }
        await reportGuardianNoteRecoveryProgress({
          accountId: account.publicKey,
          step: 'public',
          startBlock,
          syncedToBlock: scannedToBlock,
          latestBlock
        });
      }
    } catch (error) {
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Public account-tag recovery failed for ${account.publicKey}:`, error);
    }

    const yieldedBeforeSync = await shouldYield();
    if (yieldedBeforeSync) {
      result.deferred = true;
      console.warn(
        `[GuardianRecovery] Yielding (${yieldedBeforeSync}) before the closing sync for ${account.publicKey}`
      );
      return result;
    }
    await doSync(true);
    console.log(
      `[GuardianRecovery] Pending notes for ${account.publicKey}: ` +
        `proposal notes imported=${result.proposalNotes}, ` +
        `public notes imported=${result.publicNotes}, ` +
        `source failures=${result.sourceFailures}`
    );
    return result;
  } finally {
    await clearGuardianNoteRecoveryProgress(account.publicKey);
  }
}

/**
 * Accounts whose pending-note recovery has started in this process. A pass
 * that FAILED a source keeps its entry, so an account gets at most one such
 * attempt per backend lifetime: the flag stays set for the next backend start
 * to retry, without GuardianRecoveryProvider's 5s poll re-running the full
 * drain/backfill in a loop against a persistently failing source.
 *
 * Entries are released again only where the run never really got its turn — a
 * refused start, a rejected eligibility query, or a wallet lock — since those
 * are transient and should be retried within this same backend lifetime.
 */
const startedRecoveries = new Set<string>();

/**
 * Recoveries run one at a time. They are long, they monopolize the single
 * WASM/offscreen client, and they narrate their progress through one shared
 * storage record — so two concurrent runs would both contend for that client
 * and interleave their progress writes, blanking each other's card. Seed
 * recovery flags EVERY adopted account, so more than one eligible account is
 * the normal case, not an edge case.
 */
let recoveryQueue: Promise<void> = Promise.resolve();

/**
 * Start the detached pending-note recovery for a seed-recovered account, but
 * only once it cannot collide with a live transaction: the mandatory hot-key
 * rotation must have landed and no transaction may be queued or generating —
 * on ANY account, since every account shares the single WASM/offscreen
 * client. The recovery holds that client for long stretches; a concurrent
 * transaction's short-deadline reads queue behind it and get deadline-killed
 * — the "hot-key rotation always fails on the first try" bug. The trigger
 * lives in the frontend (GuardianRecoveryProvider), which retries until this
 * returns true.
 *
 * Returns true when the recovery was started (it then runs detached), false
 * when the account is ineligible or busy right now.
 */
export async function maybeStartGuardianRecovery(account: WalletAccount): Promise<boolean> {
  if (!account.guardianNoteRecoveryPending) return false;
  if (account.requiresHotKeyRotation) return false;
  if (startedRecoveries.has(account.publicKey)) return false;

  // Reserve the slot BEFORE awaiting: concurrent requests for the same
  // account (popup + full page both mount the provider) would otherwise both
  // pass the check above while the first one's Dexie query is in flight.
  startedRecoveries.add(account.publicKey);
  try {
    if (!(await isSafeToRunNow())) {
      startedRecoveries.delete(account.publicKey);
      return false;
    }
  } catch (error) {
    // Release the reservation: a rejected Dexie query is transient, and
    // holding the slot would make the account unstartable for the rest of
    // this backend's lifetime while its pending flag stays set.
    startedRecoveries.delete(account.publicKey);
    throw error;
  }

  // Queued rather than launched: `recoveryQueue` serializes runs across
  // accounts. The `catch` is belt-and-braces — `runDetachedRecovery` swallows
  // its own errors, but a rejection here would short-circuit every later
  // `.then` and strand accounts that are already marked started.
  recoveryQueue = recoveryQueue.then(() => runDetachedRecovery(account)).catch(() => {});
  return true;
}

/**
 * No transaction queued or generating on ANY account — they all share the one
 * WASM/offscreen client, and a transaction's short-deadline reads queued
 * behind the recovery get deadline-killed.
 */
async function isSafeToRunNow(): Promise<boolean> {
  const uncompleted = await getAllUncompletedTransactions();
  return uncompleted.length === 0;
}

/**
 * The detached recovery itself. Never throws. The pending flag is only
 * cleared after a pass in which every source succeeded, so a failed or
 * interrupted run leaves it set and a later backend start retries — every
 * source is idempotent (imports and syncs, no destructive step).
 */
async function runDetachedRecovery(account: WalletAccount): Promise<void> {
  // Re-check at the head of the queue, not just at kickoff: this entry may
  // have waited out another account's whole recovery, and the user can have
  // locked the wallet or started a transaction in the meantime.
  const yieldedAtTurn = await shouldYield();
  if (yieldedAtTurn) {
    startedRecoveries.delete(account.publicKey);
    console.log(`[GuardianRecovery] Deferring recovery for ${account.publicKey} at its turn: ${yieldedAtTurn}`);
    return;
  }

  console.log(`[GuardianRecovery] Starting detached pending-note recovery for ${account.publicKey}`);
  try {
    const result = await recoverPendingNotes(account);
    if (result.deferred) {
      // Giving way is not a failing source: release the reservation so the
      // provider's poll restarts this account once the wallet is free again,
      // instead of waiting for the next backend start.
      startedRecoveries.delete(account.publicKey);
      console.warn(`[GuardianRecovery] Recovery for ${account.publicKey} deferred; will be re-offered`);
      return;
    }
    if (result.sourceFailures > 0) {
      console.warn(
        `[GuardianRecovery] Keeping recovery pending for ${account.publicKey}: ` +
          `${result.sourceFailures} source(s) failed; will retry on the next session`
      );
      return;
    }
    await clearPendingFlag(account);
  } catch (error) {
    console.warn(`[GuardianRecovery] Detached pending-note recovery failed for ${account.publicKey}:`, error);
  }
}

/**
 * The terminal write. Joins the accounts-list write queue: this is a
 * read-modify-write of the whole accounts array landing at a moment the user
 * cannot predict, and an unqueued account create racing it drops one of the
 * two writes.
 *
 * Never throws, and releases the account's reservation on every path that
 * leaves the flag set — the pass itself succeeded, so the only thing standing
 * between the user and a finished recovery is this write, and holding the
 * reservation would make the account unstartable for the rest of this
 * backend's lifetime with nothing left to clear it.
 */
async function clearPendingFlag(account: WalletAccount): Promise<void> {
  try {
    await getAccountsWriteQueue().add(async () => {
      const vault = liveVault();
      if (!vault) {
        startedRecoveries.delete(account.publicKey);
        console.warn(`[GuardianRecovery] Wallet locked before clearing the flag for ${account.publicKey}; will retry`);
        return;
      }
      const updated = await vault.setGuardianNoteRecoveryPending(account.publicKey, false);
      // A lock between the write and the broadcast would merge accounts back
      // into the state `locked` just reset; the flag is already persisted, so
      // dropping the broadcast is the safe half to lose.
      if (isWalletLocked()) return;
      accountsUpdated(updated);
    });
  } catch (error) {
    startedRecoveries.delete(account.publicKey);
    console.warn(`[GuardianRecovery] Failed to clear the recovery flag for ${account.publicKey}; will retry:`, error);
  }
}

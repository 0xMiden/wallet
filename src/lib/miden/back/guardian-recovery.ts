import { GuardianHttpClient } from '@openzeppelin/guardian-client';

import {
  clearGuardianNoteRecoveryProgress,
  fetchGuardianNoteRecoveryProgress,
  type GuardianNoteRecoveryProgress,
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
import { OperationAbortedError } from './offscreen-codec';
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
/**
 * True for the rejection the SW raises when it tears down the offscreen realm.
 *
 * This is expected traffic, not a broken source. On the extension the offscreen
 * client is on (`vite.background.config.ts`), read deadlines are armed at
 * DISPATCH, and recovery chunks are not critical ops — so an AutoSync read
 * queued behind a chunk trips its own 15s deadline while still waiting, and
 * `onDeadline` kills the realm, taking the chunk with it. Counting that as a
 * source failure would keep the account's reservation and strand the recovery
 * for the rest of the session; treated as a deferral it resumes from the
 * checkpoint on the next offer instead.
 */
function isAbortedOp(error: unknown): boolean {
  return error instanceof OperationAbortedError;
}

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
 *
 * Going over the cap is a failed source, so the pending flag stays set and the
 * account is retried on the next backend start rather than finishing over the
 * notes that did not fit. There is no cursor: the retry re-reads the pending
 * list from the top, and what makes that converge is the list SHRINKING as the
 * notes already imported get consumed and their proposals stop being pending.
 * An account holding more than this many notes that stay pending indefinitely
 * would need a cursor to finish, which is not built — it stays flagged, which
 * is the safe direction.
 */
const MAX_PROPOSAL_NOTES = 500;

/**
 * Proposals inspected at all. `MAX_PROPOSAL_NOTES` bounds what is kept, which
 * does not bound the work: a response listing a million proposals of the wrong
 * type is rejected entry by entry, and that iteration is itself the cost.
 */
const MAX_PROPOSALS_EXAMINED = 1_000;

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
    let unsupportedVersion = 0;
    let malformed = 0;
    let truncated = false;
    // The proposal list, and every note list inside it, is remote input: bound
    // what is even LOOKED AT, not just what is kept. Otherwise an operator can
    // spend the service worker's CPU on a response of a million entries that
    // are all rejected.
    if (proposals.length > MAX_PROPOSALS_EXAMINED) truncated = true;
    for (const proposal of proposals.slice(0, MAX_PROPOSALS_EXAMINED)) {
      // Reached through optional chaining, not a bare dereference: one null
      // entry or one missing `deltaPayload` in a remote list would otherwise
      // throw past this loop and discard every note collected from the
      // proposals before it — the opposite of the per-note isolation below.
      const metadata = proposal?.deltaPayload?.metadata;
      if (metadata === undefined || metadata === null) {
        malformed++;
        continue;
      }
      if (metadata.proposalType !== 'consume_notes') continue;
      if (metadata.consumeNotesMetadataVersion !== 2) {
        // A consume proposal in a shape this build cannot read may still be
        // carrying notes. Skipping it silently would let the pass finish clean
        // and clear the one-shot flag over them, so it counts as a failed
        // source and the recovery is retried by a build that understands it.
        unsupportedVersion++;
        continue;
      }
      const encodedNotes = metadata.consumeNotesNotes ?? [];
      if (encodedNotes.length > MAX_PROPOSAL_NOTES) truncated = true;
      for (const encodedNote of encodedNotes.slice(0, MAX_PROPOSAL_NOTES)) {
        if (proposalNoteBytes.length >= MAX_PROPOSAL_NOTES) {
          truncated = true;
          break;
        }
        if (typeof encodedNote !== 'string' || encodedNote.length > MAX_PROPOSAL_NOTE_B64_LENGTH) {
          undecodable++;
          continue;
        }
        // Decode per note: the payload is remote, and `b64ToU8` throws on
        // malformed base64. One bad entry must not discard the notes already
        // collected from earlier proposals.
        try {
          proposalNoteBytes.push(b64ToU8(encodedNote));
        } catch {
          undecodable++;
        }
      }
      if (truncated) break;
    }
    if (truncated) {
      console.warn(
        `[GuardianRecovery] Guardian offered more proposal notes than the ${MAX_PROPOSAL_NOTES} cap for ` +
          `${account.publicKey}; importing what fits and keeping the recovery pending`
      );
    }
    // Counted rather than logged per entry: a hostile payload would otherwise
    // choose how many lines it writes to the console.
    console.log(
      `[GuardianRecovery] Pending proposals for ${account.publicKey}: ${proposals.length} proposals, ` +
        `${proposalNoteBytes.length} embedded consume notes, ${undecodable} undecodable, ` +
        `${unsupportedVersion} of an unsupported version, ${malformed} malformed`
    );
    return {
      proposalNoteBytes,
      proposalFetchFailed: undecodable > 0 || truncated || unsupportedVersion > 0 || malformed > 0
    };
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

/**
 * A resumable pass reuses the progress record as its checkpoint.
 *
 * Deferring for a transaction is not rare — it is the norm. The recovery's job
 * is to make consumable notes visible, auto-consume is on by default
 * (`DEFAULT_AUTO_CONSUME`), and the SW enqueues a consume for every newly
 * visible native-asset note, so importing notes MANUFACTURES the transactions
 * that make `shouldYield` fire. Without a checkpoint each deferral would throw
 * the whole pass away and the next one would re-pay the transport drain, the
 * Guardian client setup, the proposal imports and the scan-range resolution
 * before reaching the block it had already got to — a wallet that never
 * finishes recovering.
 *
 * Only a pass with NO source failures may be checkpointed: the record carries a
 * block watermark, not a failure count, so resuming past a failed source would
 * let a later clean pass clear the one-shot pending flag over notes that were
 * never imported.
 */
function resumePointFor(account: WalletAccount, progress: GuardianNoteRecoveryProgress | null): number | null {
  if (!progress || progress.accountId !== account.publicKey) return null;
  if (progress.step !== 'public' || progress.syncedToBlock === undefined) return null;
  // `sourcesClean` is what makes the watermark trustworthy, and it must be
  // present: the `finally` below only discards a failed pass's record on a
  // GRACEFUL exit, and the service worker being evicted mid-run is a case the
  // rest of this feature explicitly plans for. Without this check, a pass whose
  // transport drain failed — or whose earlier backfill chunk failed while a
  // later one advanced the watermark past it — is resumed, completes cleanly,
  // and clears the one-shot flag over notes nothing ever imported.
  //
  // Staleness is deliberately NOT considered. An old record is exactly the case
  // worth resuming: it means the run died rather than finished.
  if (progress.sourcesClean !== true) return null;
  return progress.syncedToBlock;
}

export async function recoverPendingNotes(account: WalletAccount): Promise<GuardianPendingNoteRecoveryResult> {
  const result: GuardianPendingNoteRecoveryResult = {
    proposalNotes: 0,
    publicNotes: 0,
    sourceFailures: 0,
    deferred: false
  };

  // Highest watermark this pass has persisted, so the deferral log can say
  // whether there is anything to resume from. Null until the public step runs.
  let checkpointedBlock: number | null = null;

  let resumeFromBlock: number | null = null;
  try {
    resumeFromBlock = resumePointFor(account, await fetchGuardianNoteRecoveryProgress(account.publicKey));
  } catch (error) {
    console.warn(`[GuardianRecovery] Could not read the checkpoint for ${account.publicKey}; starting over:`, error);
  }
  console.log(
    `[GuardianRecovery] Recovering pending notes for ${account.publicKey}` +
      (resumeFromBlock === null ? '...' : ` (resuming the public backfill at block ${resumeFromBlock})`)
  );

  try {
    let context: GuardianClientContext | undefined;
    let createdAtSeconds = 0;

    // Source 1: drain the private-note transport backlog.
    //
    // Re-run on a RESUMED pass as well, unlike source 2. This is the wallet's
    // only caller of the SDK's `fetchPrivate`, so a private note that lands in
    // the transport while the pass is deferred is fetched by nothing else —
    // and once a later pass finishes cleanly the one-shot flag clears and no
    // pass ever runs again. It is a single short op and `mode: 'all'` re-reads
    // the whole backlog, so repeating it costs almost nothing.
    //
    // The progress write is skipped when resuming: it would downgrade this
    // account's entry from `public` back to `transport` and lose the very
    // watermark being resumed from.
    if (resumeFromBlock === null) {
      await reportGuardianNoteRecoveryProgress({ accountId: account.publicKey, step: 'transport' });
    }
    try {
      await midenClientProxy.drainPrivateNoteTransport();
    } catch (error) {
      if (isAbortedOp(error)) {
        result.deferred = true;
        console.warn(`[GuardianRecovery] Transport drain aborted with the offscreen realm for ${account.publicKey}`);
        return result;
      }
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Private-note transport drain failed for ${account.publicKey}:`, error);
    }

    const yieldedBeforeProposals = await shouldYield();
    if (yieldedBeforeProposals) {
      result.deferred = true;
      console.warn(`[GuardianRecovery] Yielding (${yieldedBeforeProposals}) before proposals for ${account.publicKey}`);
      return result;
    }

    // Source 2 is skipped on a resumed pass, because re-importing the same
    // proposal notes is the expensive half to repeat. What makes that safe is
    // `sourcesClean` on the record: reaching the `public` step does NOT by
    // itself mean this source succeeded (a failure here only increments a
    // counter and falls through), so the resume point is gated on the writing
    // pass having been failure-free — see `resumePointFor`.
    if (resumeFromBlock === null) {
      // Source 2: notes embedded in pending consume proposals.
      await reportGuardianNoteRecoveryProgress({ accountId: account.publicKey, step: 'proposals' });
      try {
        context = await createGuardianClientContext(account);
      } catch (error) {
        // The setup reads the account through the offscreen realm, so it can be
        // aborted by a deadline kill like every other dispatch here — expected
        // traffic, not a broken source. Counting it as a failure would strand
        // the account for the rest of the backend's lifetime AND skip the
        // public backfill, which needs this context for the creation block.
        if (isAbortedOp(error)) {
          result.deferred = true;
          console.warn(
            `[GuardianRecovery] Guardian client setup aborted with the offscreen realm for ${account.publicKey}`
          );
          return result;
        }
        result.sourceFailures++;
        console.warn(`[GuardianRecovery] Guardian client setup failed for ${account.publicKey}:`, error);
      }
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
            if (isAbortedOp(error)) {
              result.deferred = true;
              console.warn(
                `[GuardianRecovery] Proposal import aborted with the offscreen realm for ${account.publicKey}`
              );
              return result;
            }
            result.sourceFailures++;
            console.warn(`[GuardianRecovery] Proposal note import failed for ${account.publicKey}:`, error);
          }
          // Re-stamped per batch, not per phase: the record ages out after
          // GUARDIAN_NOTE_RECOVERY_PROGRESS_STALE_MS, and the whole proposal
          // phase can outlast that — the card would vanish mid-run and the
          // user would think it had finished.
          await reportGuardianNoteRecoveryProgress({ accountId: account.publicKey, step: 'proposals' });
        }
        createdAtSeconds = await fetchAccountCreatedAtSeconds(account, context);
      }
    }

    // Source 3: public notes by account tag, scanned from the account's
    // creation block (not genesis) in bounded chunks with live progress.
    //
    // Skipped when the Guardian was unreachable on a fresh pass: `createdAt`
    // would be unknown, which means scanning genesis→tip, and the same failure
    // keeps the pending flag set — so every backend start would re-walk the
    // whole chain, forever, for an account whose cold key or local record is
    // permanently absent. A resumed pass has its range from the checkpoint and
    // does not need the Guardian at all.
    if (resumeFromBlock === null && !context) {
      console.warn(
        `[GuardianRecovery] Skipping the public backfill for ${account.publicKey}: ` +
          'no Guardian client, so the creation block is unknown and the scan would start at genesis'
      );
      return result;
    }

    try {
      // On a resumed pass only the chain tip is needed, and passing 0 makes the
      // resolver return it after ONE header read instead of binary-searching
      // for a creation block the checkpoint already supersedes.
      const range = await midenClientProxy.resolveRecoveryScanRange(resumeFromBlock === null ? createdAtSeconds : 0);
      const latestBlock = range.latestBlock;
      const startBlock = resumeFromBlock === null ? range.startBlock : Math.min(resumeFromBlock, latestBlock);
      console.log(`[GuardianRecovery] Public backfill for ${account.publicKey}: blocks ${startBlock}-${latestBlock}`);
      await reportGuardianNoteRecoveryProgress({
        accountId: account.publicKey,
        step: 'public',
        startBlock,
        syncedToBlock: startBlock,
        latestBlock,
        sourcesClean: result.sourceFailures === 0
      });
      checkpointedBlock = result.sourceFailures === 0 ? startBlock : null;
      let scannedToBlock = startBlock;
      // A work list rather than a fixed stride, because a chunk can come back
      // `saturated` — too wide for the node, or holding more tag matches than
      // one op should import. Halves are pushed to the FRONT, so ranges are
      // still completed in ascending order and `scannedToBlock` stays a true
      // watermark. Each retry is its own offscreen op, which is the point: the
      // narrowing happens between ops, not inside one holding the WASM mutex.
      const pending: Array<[number, number, number]> = [];
      for (let blockFrom = startBlock; blockFrom <= latestBlock; blockFrom += PUBLIC_BACKFILL_CHUNK_BLOCKS) {
        pending.push([blockFrom, Math.min(latestBlock, blockFrom + PUBLIC_BACKFILL_CHUNK_BLOCKS - 1), 0]);
      }
      while (pending.length > 0) {
        const [blockFrom, blockTo, noteOffset] = pending.shift()!;
        const yielded = await shouldYield();
        if (yielded) {
          result.deferred = true;
          console.warn(`[GuardianRecovery] Yielding (${yielded}) mid-backfill for ${account.publicKey}`);
          return result;
        }
        try {
          const chunk = await midenClientProxy.recoverPublicNotesRange(
            account.publicKey,
            blockFrom,
            blockTo,
            noteOffset
          );
          result.publicNotes += chunk.imported;
          result.sourceFailures += chunk.failures;
          if (chunk.saturated && blockTo > blockFrom) {
            const midpoint = blockFrom + Math.floor((blockTo - blockFrom) / 2);
            pending.unshift([blockFrom, midpoint, 0], [midpoint + 1, blockTo, 0]);
          } else if (chunk.saturated) {
            // Unsplittable and still saturated. The flag comes over the realm
            // boundary as JSON, so this is also the guard that keeps a bogus
            // `saturated` from looping forever on a one-block range.
            result.sourceFailures++;
            console.warn(`[GuardianRecovery] Block ${blockFrom} stayed saturated for ${account.publicKey}; skipping`);
          } else if (chunk.nextNoteOffset !== undefined && chunk.nextNoteOffset > noteOffset) {
            // The range fits but its notes do not: same range, next page. The
            // strict advance is what makes this terminate — the offset crosses
            // the realm boundary as JSON, and one that failed to move would
            // re-run this page forever.
            pending.unshift([blockFrom, blockTo, chunk.nextNoteOffset]);
          } else {
            if (chunk.nextNoteOffset !== undefined) {
              result.sourceFailures++;
              console.warn(
                `[GuardianRecovery] Blocks ${blockFrom}-${blockTo} asked to resume at note ` +
                  `${chunk.nextNoteOffset}, which does not advance past ${noteOffset}; skipping the rest`
              );
            }
            // Only a range that actually completed advances the reported
            // progress, so the card never claims one it skipped or half-did.
            scannedToBlock = blockTo;
          }
        } catch (error) {
          if (isAbortedOp(error)) {
            result.deferred = true;
            console.warn(
              `[GuardianRecovery] Backfill chunk ${blockFrom}-${blockTo} aborted with the offscreen realm; ` +
                `will resume ${account.publicKey} from block ${scannedToBlock}`
            );
            return result;
          }
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
          latestBlock,
          // Re-stamped per chunk: a failure anywhere in this pass makes the
          // watermark unusable as a resume point, including for a pass that
          // never reaches its `finally` because the realm was evicted.
          sourcesClean: result.sourceFailures === 0
        });
        checkpointedBlock = result.sourceFailures === 0 ? scannedToBlock : null;
      }
    } catch (error) {
      if (isAbortedOp(error)) {
        result.deferred = true;
        console.warn(`[GuardianRecovery] Public backfill aborted with the offscreen realm for ${account.publicKey}`);
        return result;
      }
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
    // Keep the record ONLY as a checkpoint for a clean deferral — that is what
    // lets the next pass resume at the block this one reached instead of
    // redoing every source. Any other exit clears it: a finished pass has
    // nothing left to narrate, and a pass that failed a source must start over
    // (the record carries a watermark, not a failure count, so resuming past a
    // failed source could clear the pending flag over notes never imported).
    if (result.deferred && result.sourceFailures === 0) {
      // Only the public step writes a resumable watermark, so a deferral before
      // it has nothing to resume from — saying otherwise sends whoever reads
      // this looking for a checkpoint that was never written.
      console.log(
        checkpointedBlock === null
          ? `[GuardianRecovery] Deferring ${account.publicKey} before the backfill; the next pass starts over`
          : `[GuardianRecovery] Keeping the checkpoint for ${account.publicKey} to resume from block ${checkpointedBlock}`
      );
    } else {
      await clearGuardianNoteRecoveryProgress(account.publicKey);
    }
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

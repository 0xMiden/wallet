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
  /** Set when the run stopped early because the wallet locked under it. */
  abortedByLock: boolean;
}

/**
 * The recovery runs detached for minutes and keeps using the `Vault` it
 * captured at kickoff. An auto-lock in the meantime nulls the store's vault,
 * and `withUnlocked` only asserts the store is INITED (see `store.ts`), so
 * nothing downstream would notice. Continuing past a lock would sign Guardian
 * requests with a post-lock vault and — worse — `accountsUpdated` merges into
 * state that `locked` deliberately rebuilt empty ("Security stuff! ... Reset
 * all properties!"), repopulating `accounts`/`currentAccount` into the front
 * state of a locked wallet. Same hazard class as issue #313, which is why the
 * transaction processor uses `withUnlockedVault`.
 */
function isWalletLocked(): boolean {
  return !store.getState().vault;
}

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

async function createGuardianClientContext(account: WalletAccount, vault: Vault): Promise<GuardianClientContext> {
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
    new WalletSigner(withHexPrefix(account.coldPublicKey), withHexPrefix(commitment), (publicKey, wordHex) =>
      vault.signWord(publicKey, wordHex)
    )
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
    for (const proposal of proposals) {
      const metadata = proposal.deltaPayload.metadata;
      if (metadata?.proposalType !== 'consume_notes' || metadata.consumeNotesMetadataVersion !== 2) continue;
      for (const encodedNote of metadata.consumeNotesNotes ?? []) {
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
    }
    console.log(
      `[GuardianRecovery] Pending proposals for ${account.publicKey}: ${proposals.length} proposals, ` +
        `${proposalNoteBytes.length} embedded consume notes, ${undecodable} undecodable`
    );
    return { proposalNoteBytes, proposalFetchFailed: undecodable > 0 };
  } catch (error) {
    console.warn(`[GuardianRecovery] Pending proposal lookup failed for ${account.publicKey}:`, error);
    return { proposalNoteBytes: [], proposalFetchFailed: true };
  }
}

/**
 * Account creation time (unix seconds) from the Guardian's `getState`
 * metadata. 0 on any failure — the scan-range resolver treats 0 as
 * "unknown" and falls back to scanning from genesis.
 */
async function fetchAccountCreatedAtSeconds(account: WalletAccount, context: GuardianClientContext): Promise<number> {
  try {
    const state = await context.guardian.getState(context.guardianAccountId);
    const parsed = Date.parse(state.createdAt);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
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

export async function recoverPendingNotes(
  account: WalletAccount,
  vault: Vault
): Promise<GuardianPendingNoteRecoveryResult> {
  console.log(`[GuardianRecovery] Recovering pending notes for ${account.publicKey}...`);
  const result: GuardianPendingNoteRecoveryResult = {
    proposalNotes: 0,
    publicNotes: 0,
    sourceFailures: 0,
    abortedByLock: false
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

    // Source 2 signs Guardian requests with the captured vault, so stop here
    // rather than reach for a vault the user has locked.
    if (isWalletLocked()) {
      result.abortedByLock = true;
      console.warn(`[GuardianRecovery] Wallet locked during recovery for ${account.publicKey}; stopping early`);
      return result;
    }

    // Source 2: notes embedded in pending consume proposals.
    await reportGuardianNoteRecoveryProgress({ accountId: account.publicKey, step: 'proposals' });
    let context: GuardianClientContext | undefined;
    try {
      context = await createGuardianClientContext(account, vault);
    } catch (error) {
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Guardian client setup failed for ${account.publicKey}:`, error);
    }
    let createdAtSeconds = 0;
    if (context) {
      const payload = await fetchProposalNotePayload(account, context);
      if (payload.proposalFetchFailed) result.sourceFailures++;
      if (payload.proposalNoteBytes.length > 0) {
        try {
          const imported = await midenClientProxy.importRecoveryNoteBytes(payload.proposalNoteBytes);
          result.proposalNotes = imported.imported;
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
      for (let blockFrom = startBlock; blockFrom <= latestBlock; blockFrom += PUBLIC_BACKFILL_CHUNK_BLOCKS) {
        const blockTo = Math.min(latestBlock, blockFrom + PUBLIC_BACKFILL_CHUNK_BLOCKS - 1);
        if (isWalletLocked()) {
          result.abortedByLock = true;
          console.warn(`[GuardianRecovery] Wallet locked mid-backfill for ${account.publicKey}; stopping early`);
          return result;
        }
        try {
          const chunk = await midenClientProxy.recoverPublicNotesRange(account.publicKey, blockFrom, blockTo);
          result.publicNotes += chunk.imported;
          result.sourceFailures += chunk.failures;
          // Only a chunk that actually completed advances the reported
          // progress, so the card never claims a range it skipped.
          scannedToBlock = blockTo;
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

    if (isWalletLocked()) {
      result.abortedByLock = true;
      console.warn(`[GuardianRecovery] Wallet locked before the closing sync for ${account.publicKey}`);
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
export async function maybeStartGuardianRecovery(account: WalletAccount, vault: Vault): Promise<boolean> {
  if (!account.guardianNoteRecoveryPending) return false;
  if (account.requiresHotKeyRotation) return false;
  if (startedRecoveries.has(account.publicKey)) return false;

  // Reserve the slot BEFORE awaiting: concurrent requests for the same
  // account (popup + full page both mount the provider) would otherwise both
  // pass the check above while the first one's Dexie query is in flight.
  startedRecoveries.add(account.publicKey);
  try {
    const uncompleted = await getAllUncompletedTransactions();
    if (uncompleted.length > 0) {
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
  // accounts. Never rejects — `runDetachedRecovery` swallows its own errors.
  recoveryQueue = recoveryQueue.then(() => runDetachedRecovery(account, vault));
  return true;
}

/**
 * The detached recovery itself. Never throws. The pending flag is only
 * cleared after a pass in which every source succeeded, so a failed or
 * interrupted run leaves it set and a later backend start retries — every
 * source is idempotent (imports and syncs, no destructive step).
 */
async function runDetachedRecovery(account: WalletAccount, vault: Vault): Promise<void> {
  console.log(`[GuardianRecovery] Starting detached pending-note recovery for ${account.publicKey}`);
  try {
    const result = await recoverPendingNotes(account, vault);
    if (result.abortedByLock) {
      // A lock is not a failing source: release the reservation so the
      // provider's poll restarts this account once the user unlocks, instead
      // of waiting for the next backend start.
      startedRecoveries.delete(account.publicKey);
      console.warn(`[GuardianRecovery] Recovery for ${account.publicKey} deferred until the wallet is unlocked`);
      return;
    }
    if (result.sourceFailures > 0) {
      console.warn(
        `[GuardianRecovery] Keeping recovery pending for ${account.publicKey}: ` +
          `${result.sourceFailures} source(s) failed; will retry on the next session`
      );
      return;
    }
    if (isWalletLocked()) {
      startedRecoveries.delete(account.publicKey);
      console.warn(`[GuardianRecovery] Wallet locked before clearing the flag for ${account.publicKey}; will retry`);
      return;
    }
    const updated = await vault.setGuardianNoteRecoveryPending(account.publicKey, false);
    accountsUpdated(updated);
  } catch (error) {
    console.warn(`[GuardianRecovery] Detached pending-note recovery failed for ${account.publicKey}:`, error);
  }
}

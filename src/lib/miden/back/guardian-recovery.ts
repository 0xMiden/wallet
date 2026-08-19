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
import { accountsUpdated } from './store';
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
    for (const proposal of proposals) {
      const metadata = proposal.deltaPayload.metadata;
      if (metadata?.proposalType !== 'consume_notes' || metadata.consumeNotesMetadataVersion !== 2) continue;
      for (const encodedNote of metadata.consumeNotesNotes ?? []) proposalNoteBytes.push(b64ToU8(encodedNote));
    }
    console.log(
      `[GuardianRecovery] Pending proposals for ${account.publicKey}: ${proposals.length} proposals, ` +
        `${proposalNoteBytes.length} embedded consume notes`
    );
    return { proposalNoteBytes, proposalFetchFailed: false };
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
  const result: GuardianPendingNoteRecoveryResult = { proposalNotes: 0, publicNotes: 0, sourceFailures: 0 };

  try {
    // Source 1: drain the private-note transport backlog.
    await reportGuardianNoteRecoveryProgress({ accountId: account.publicKey, step: 'transport' });
    try {
      await midenClientProxy.drainPrivateNoteTransport();
    } catch (error) {
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Private-note transport drain failed for ${account.publicKey}:`, error);
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
      for (let blockFrom = startBlock; blockFrom <= latestBlock; blockFrom += PUBLIC_BACKFILL_CHUNK_BLOCKS) {
        const blockTo = Math.min(latestBlock, blockFrom + PUBLIC_BACKFILL_CHUNK_BLOCKS - 1);
        try {
          result.publicNotes += await midenClientProxy.recoverPublicNotesRange(account.publicKey, blockFrom, blockTo);
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
          syncedToBlock: blockTo,
          latestBlock
        });
      }
    } catch (error) {
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Public account-tag recovery failed for ${account.publicKey}:`, error);
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
    await clearGuardianNoteRecoveryProgress();
  }
}

/**
 * Accounts whose pending-note recovery has started in this process. Entries
 * are never removed once a run begins (only a refused start is rolled back),
 * so an account gets at most one recovery attempt per backend lifetime: a
 * failed pass keeps `guardianNoteRecoveryPending` set for the next backend
 * start to retry, without GuardianRecoveryProvider's 5s poll re-running the
 * full drain/backfill in a loop against a persistently failing source.
 */
const startedRecoveries = new Set<string>();

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
  const uncompleted = await getAllUncompletedTransactions();
  if (uncompleted.length > 0) {
    startedRecoveries.delete(account.publicKey);
    return false;
  }

  runDetachedRecovery(account, vault);
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
    if (result.sourceFailures > 0) {
      console.warn(
        `[GuardianRecovery] Keeping recovery pending for ${account.publicKey}: ` +
          `${result.sourceFailures} source(s) failed; will retry on the next session`
      );
      return;
    }
    const updated = await vault.setGuardianNoteRecoveryPending(account.publicKey, false);
    accountsUpdated(updated);
  } catch (error) {
    console.warn(`[GuardianRecovery] Detached pending-note recovery failed for ${account.publicKey}:`, error);
  }
}

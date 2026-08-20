import { Account, MidenClient, NoteType, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import {
  AccountInspector,
  Multisig,
  MultisigClient,
  GuardianHttpClient,
  buildUpdateSignersTransactionRequest,
  executeForSummary,
  type ProposalMetadata,
  type TransactionProposal,
  type Proposal
} from '@openzeppelin/miden-multisig-client';

import { getEffectiveDefaultGuardianEndpoint, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import * as secureHotKey from 'lib/secure-hot-key';
import type { GeneratedHotKey } from 'lib/secure-hot-key';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import type { WalletAccount } from 'lib/shared/types';

import { getSignerDetailsFromAccount, insertGuardianAccountMonotonically, resolveGuardianEndpoint } from './account';
import { registerGuardianOrigin } from './native-http';
import { guardianRegisterBackoffMs } from './serialize';
import { WalletSigner, type SignWordFunction } from './signer';
import { midenClientProxy } from '../back/miden-client-proxy';
import { accountIdStringToSdk } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

/**
 * Structural GuardianHttpError auth-rejection check (401 /
 * `authentication_failed` / `signer_not_authorized`). Duck-typed rather than
 * `instanceof GuardianHttpError` so it survives test mocks of the multisig
 * client and any duplicate-package instance of the error class (same
 * convention as the 409 check in `./serialize.ts`).
 */
export const isGuardianAuthRejection = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const status = 'status' in err ? err.status : undefined;
  const code = 'code' in err ? err.code : undefined;
  return status === 401 || code === 'authentication_failed' || code === 'signer_not_authorized';
};

const MAX_SYNC_RETRIES = 30;
const SYNC_RETRY_DELAY_MS = 1000;
// The guardian typically re-canonicalizes an accepted delta within ~2-10 ticks,
// so wait a bounded window (~30s = 30 × SYNC_RETRY_DELAY_MS) before the
// last-resort re-register.
// NOTE: this now equals MAX_SYNC_RETRIES, so the last-resort re-register fires
// at the same point as the full nonce-retry ceiling — the earlier "self-heal
// sooner than the ceiling" property is gone. If that property is still wanted,
// set this strictly below MAX_SYNC_RETRIES (guardian-owner call).
const MAX_GUARDIAN_CANONICALIZE_RETRIES = 30;
const MAX_GUARDIAN_REGISTER_RETRIES = 8;
// The per-attempt backoff (capped exponential, and Retry-After-aware on 429s)
// lives in `guardianRegisterBackoffMs` (./serialize, #619).

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * MultisigService wraps the MultisigClient and Multisig classes from
 * @openzeppelin/miden-multisig-client to provide a simplified interface
 * for Guardian account operations.
 */
export class MultisigService {
  multisig: Multisig;
  client: MultisigClient;
  guardianEndpoint: string;
  syncRetryCount: number = 0;
  // Dedupe overlapping `sync()` calls. The guardian sync fires every ~3s without
  // awaiting prior ticks, and the cached service instance is shared, so two ticks
  // could otherwise drive `syncState()` concurrently and clobber `syncRetryCount`.
  private syncInFlight: Promise<void> | null = null;

  constructor(multisig: Multisig, client: MultisigClient, guardianEndpoint: string) {
    this.multisig = multisig;
    this.client = client;
    this.guardianEndpoint = guardianEndpoint;
  }

  /**
   * Initialize a MultisigService for an existing Guardian account.
   *
   * `guardianEndpoint` is resolved per-account by the caller (see
   * `resolveGuardianEndpoint`) so accounts on different operators don't collide.
   */
  static async init(
    account: Account,
    publicKey: string,
    signerCommitment: string,
    signWordFn: SignWordFunction,
    guardianEndpoint: string
  ): Promise<MultisigService> {
    try {
      const signer = new WalletSigner(publicKey, signerCommitment, signWordFn);

      // Reuse the shared singleton client instead of spinning up a fresh
      // WebClient (each new WebClient spawns a ~6MB web-client-methods-worker
      // that is never terminated). Reusing the singleton also lets the multisig
      // lib's rawClientCache WeakMap (keyed by this client instance) hit across
      // every init, so at most ONE shared raw worker is created total.
      const webClient = (await getMidenClient()).client;

      registerGuardianOrigin(guardianEndpoint);
      const client = new MultisigClient(webClient, {
        guardianEndpoint,
        midenRpcEndpoint: getEffectiveRpcUrl()
      });
      // `load` drives the shared WASM web-client, so it must be serialized with
      // every other client operation via the global mutex.
      const multisig = await withWasmClientLock(() => client.load(account.id().toString(), signer));

      return new MultisigService(multisig, client, guardianEndpoint);
    } catch (error) {
      console.log('Error initializing MultisigService:', error);
      throw error;
    }
  }

  /**
   * Build a transient cold-bound MultisigService for ops that must be cold-signed
   * (switch_guardian co-sign and replace_hot_key). The cold commitment is read
   * from on-chain storage via getSignerDetailsFromAccount(_, true) — order
   * convention `[hot, cold]` is preserved across rotations because
   * createReplaceHotKeyProposal uses an in-place swap target list.
   *
   * Caller is expected to drop the returned service immediately after use so
   * cold key material doesn't outlive the operation.
   */
  static async buildColdMultisigService(
    account: Account,
    walletAccount: WalletAccount,
    signWordFn: SignWordFunction
  ): Promise<MultisigService> {
    if (!walletAccount.coldPublicKey) {
      throw new Error(`Guardian account ${walletAccount.publicKey} is missing coldPublicKey — re-create the wallet`);
    }
    const { commitment } = await getSignerDetailsFromAccount(account, true);
    const guardianEndpoint = await resolveGuardianEndpoint(walletAccount);
    return MultisigService.init(
      account,
      `0x${walletAccount.coldPublicKey}`,
      `0x${commitment}`,
      signWordFn,
      guardianEndpoint
    );
  }

  static async importAccountFromGuardian(
    publicKey: string,
    signerCommitment: string,
    signWordFn: SignWordFunction,
    accountId: string,
    webClient: MidenClient
  ) {
    // No production callers today. If a future feature wires this into a
    // non-default guardian import, thread the per-account `guardianEndpoint` in
    // (as `MultisigService.init` does) rather than reintroducing a global-key
    // read: the frozen global GUARDIAN_URL_STORAGE_KEY is intentionally not
    // consulted here (#408 stage 3), so this binds to the network default.
    const guardianEndpoint = getEffectiveDefaultGuardianEndpoint();
    const guardian = new GuardianHttpClient(guardianEndpoint);
    const signer = new WalletSigner(publicKey, signerCommitment, signWordFn);
    guardian.setSigner(signer);
    try {
      const { stateJson } = await guardian.getState(accountId);
      const account = Account.deserialize(b64ToU8(stateJson.data));

      // The guardian is an untrusted remote: never overwrite local state with an
      // account whose ID doesn't match the one we requested, or a malicious /
      // misconfigured guardian could clobber a different local account.
      const returnedId = account.id().toString();
      if (returnedId !== accountId) {
        throw new Error(`Guardian returned account ${returnedId} but ${accountId} was requested`);
      }

      await insertGuardianAccountMonotonically(webClient, account);
    } catch (error) {
      console.error('Error fetching account state from Guardian:', error);
      throw error;
    }
  }

  /**
   * Get the account ID for this multisig.
   */
  get accountId(): string {
    return this.multisig.accountId;
  }

  /**
   * Create a send (P2ID) transaction proposal. Always private — the multisig
   * client's send proposal has no reclaim-height option, so this is only used
   * for a plain (non-recallable) Guardian send. Anything that needs a recall
   * window or a public, allocator-readable note (recallable send, Epoch bridge,
   * earn deposit) is built as a P2IDE send request and routed through
   * `createCustomProposal`.
   */
  async createSendProposal(recipientId: string, faucetId: string, amount: bigint): Promise<Proposal> {
    return withWasmClientLock(() =>
      this.multisig.createP2idProposal(
        accountIdStringToSdk(recipientId).toString(),
        accountIdStringToSdk(faucetId).toString(),
        amount,
        undefined,
        { noteType: NoteType.Private }
      )
    );
  }

  /**
   * Create a consume notes transaction proposal.
   */
  async createConsumeNotesProposal(noteIds: string[]): Promise<Proposal> {
    return withWasmClientLock(() => this.multisig.createConsumeNotesProposal(noteIds));
  }

  /** Current on-chain threshold for `procedure`, or undefined if none is set. */
  getProcedureThreshold(procedure: string): number | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.multisig as any).procedureThresholds?.get(procedure);
  }

  /**
   * The account's loaded on-chain auth structure: overall threshold, signer
   * commitments, and per-procedure thresholds. Used by the E2E harness to
   * assert the 3-key shape (e.g. that `update_guardian` is hardened to 2 and
   * the signer set is `[hot, cold]`) — properties the balance-only checks miss.
   */
  getAuthInfo(): { threshold: number; signerCommitments: string[]; procedureThresholds: Record<string, number> } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = this.multisig as any;
    const procedureThresholds: Record<string, number> = {};
    if (m.procedureThresholds instanceof Map) {
      for (const [proc, threshold] of m.procedureThresholds.entries()) {
        procedureThresholds[String(proc)] = threshold as number;
      }
    }
    return {
      threshold: typeof m.threshold === 'number' ? m.threshold : NaN,
      signerCommitments: Array.isArray(m.signerCommitments) ? m.signerCommitments.map(String) : [],
      procedureThresholds
    };
  }

  /** Create a proposal that sets `procedure`'s signature threshold to `threshold`. */
  async createUpdateProcedureThresholdProposal(procedure: string, threshold: number): Promise<Proposal> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return withWasmClientLock(() =>
      (this.multisig as any).createUpdateProcedureThresholdProposal(procedure, threshold)
    );
  }

  async signAndExecuteProposal(id: string): Promise<void> {
    // `signProposal` is signing + guardian HTTP (no shared-client access); only
    // `executeProposal` touches the WASM client and needs the mutex.
    await this.multisig.signProposal(id);
    await withWasmClientLock(() => this.multisig.executeProposal(id));
  }

  /**
   * Create a custom transaction proposal from a serialized transaction request.
   * This is used for 'execute' type transactions.
   *
   * `proposalType` is a free-form label that @openzeppelin/miden-multisig-client
   * validates as lowercase snake_case (`[a-z0-9_]`) and rejects if it collides
   * with a built-in type — so the default must be snake_case, not `'custom transaction'`.
   */
  async createCustomProposal(requestBytes: Uint8Array, proposalType: string = 'custom_transaction'): Promise<Proposal> {
    return await withWasmClientLock(() => this.multisig.createCustomProposal(requestBytes, proposalType));
  }

  /**
   * Sign a proposal with this service's bound signer. Used by switch_guardian's
   * cold co-sign path where cold contributes a signature without driving the
   * follow-up createTransactionProposalRequest call (hot does that).
   * Sigs accumulate on the Guardian server keyed by proposal id.
   */
  async signProposal(id: string): Promise<void> {
    await this.multisig.signProposal(id);
  }

  /**
   * Tell the Guardian that a canonicalization candidate will not be submitted.
   *
   * This records an abandonment intent rather than immediately discarding the
   * candidate. The Guardian first checks that the transaction did not land, so
   * this is safe to call after ambiguous prover/RPC/submit failures.
   */
  async abandonCandidate(nonce: number): Promise<void> {
    await this.multisig.abandonCandidate(nonce);
  }

  async signAndCreateTransactionRequest(id: string, requestBytes?: Uint8Array): Promise<TransactionRequest> {
    const proposal = await this.multisig.signProposal(id);
    if (proposal.metadata.proposalType === 'custom') {
      if (!requestBytes) {
        throw new Error('Request Bytes are required for custom execution');
      }
      const advice = await this.multisig.prepareCustomExecution(id, requestBytes);
      const request = TransactionRequest.deserialize(requestBytes);
      return request.extendAdviceMap(advice);
    }
    return withWasmClientLock(() => this.multisig.createTransactionProposalRequest(id));
  }

  /**
   * Import the GUARDIAN's stored state into the local client — once, no retries,
   * and NO re-register fallback.
   *
   * `sync()` is the wrong tool when the caller is still deciding whether to push:
   * its last-resort stage re-registers local state at a lagging guardian. This is
   * the read half on its own, for a caller that needs the guardian's own view
   * before it can tell a stale allowlist from a device that has been rotated out.
   * `multisig.syncState()` only overwrites local when the guardian is genuinely
   * AHEAD, so this cannot pull a good local account backwards.
   */
  async adoptGuardianStateOnce(): Promise<void> {
    await withWasmClientLock(() => this.multisig.syncState());
  }

  sync(): Promise<void> {
    // Coalesce overlapping ticks onto a single in-flight run so the retry
    // counter and `syncState` aren't driven concurrently. Not `async`: return
    // the cached promise itself so concurrent callers share one identity.
    if (this.syncInFlight) {
      return this.syncInFlight;
    }
    this.syncInFlight = this.runSync().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async runSync(): Promise<void> {
    // Iterative retry (not recursion): the WASM mutex is non-reentrant, so a
    // recursive `await this.sync()` while holding it would deadlock. We lock
    // around each `syncState` attempt and release during the back-off wait so
    // other client operations can proceed between retries.
    this.syncRetryCount = 0;
    // Consecutive "guardian still canonicalizing" failures this run (Stage 1 below).
    let canonicalizeRetryCount = 0;
    // The last-resort re-register (Stage 2 below) runs at most once per run so a
    // genuinely stuck guardian doesn't loop re-registering every tick.
    let realignAttempted = false;
    for (;;) {
      try {
        await withWasmClientLock(() => this.multisig.syncState());
        this.syncRetryCount = 0; // Reset retry count on successful sync
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isNonceTooLow = message.includes('nonce') && message.includes('too low');
        if (isNonceTooLow) {
          if (this.syncRetryCount >= MAX_SYNC_RETRIES) {
            throw new Error('Max sync retries reached: local state is ahead of on-chain state');
          }
          this.syncRetryCount++;
          console.warn(
            'Nonce is too low, local state is ahead of on-chain state, retrying sync...',
            this.syncRetryCount
          );
          await delay(SYNC_RETRY_DELAY_MS);
          continue;
        }

        // Auth rejections (401 / authentication_failed / signer_not_authorized)
        // are NOT self-healed here: never push local state to a guardian that
        // just refused our signer — if our binding is the stale side, the
        // caller-level cache eviction (guardian-sync) rebuilds it; if the
        // guardian is the stale side, that's an operator/registration problem
        // to surface, not overwrite. Rethrow like any other error.

        // `multisig.syncState` refuses to overwrite local state while the guardian
        // is still canonicalizing a delta it just accepted: its stored blob lags the
        // on-chain account, so the incoming guardian commitment doesn't match on-chain
        // ("Refusing to overwrite local state ..."). This is usually transient — the
        // guardian catches up within ~2-10 ticks — so handle it in two stages, all
        // silently in the background (this runs only under the AutoSync / post-tx
        // bookkeeping paths, never a UI flow).
        const isGuardianCanonicalizing =
          message.includes('Refusing to overwrite local state') ||
          (message.includes('commitment') && message.includes('match'));
        if (isGuardianCanonicalizing) {
          // Stage 1: WAIT it out with a bounded back-off (its own, shorter ceiling
          // so a real divergence doesn't stall for the full nonce-retry window).
          if (canonicalizeRetryCount < MAX_GUARDIAN_CANONICALIZE_RETRIES) {
            canonicalizeRetryCount++;
            console.warn(
              'Guardian still canonicalizing (its state lags on-chain), retrying sync...',
              canonicalizeRetryCount
            );
            await delay(SYNC_RETRY_DELAY_MS);
            continue;
          }

          // Stage 2 (last resort): the guardian never caught up within the
          // canonicalization window, so treat it as a genuine guardian-blob divergence
          // and re-register our current on-chain state ONCE, then retry the sync. For a
          // same-guardian rotation this realigns the guardian; after a switch the cached
          // service is normally already replaced (via getOrCreateMultisigService's
          // endpoint drift-check) before we get here, so this rarely fires for switches.
          // Best-effort: if the re-register itself fails, fall through to the original
          // error and let the next background tick reconcile.
          if (!realignAttempted) {
            realignAttempted = true;
            try {
              console.warn(
                'Guardian still lagging after canonicalization window; re-registering current state as a last resort'
              );
              await this.reRegisterCurrentStateOnGuardian();
              continue;
            } catch (realignError) {
              console.warn('Last-resort guardian re-registration failed (non-fatal):', realignError);
            }
          }
          throw error;
        }

        throw error; // Rethrow other errors (caller logs per-account)
      }
    }
  }

  async getConsumableNotes() {
    return withWasmClientLock(() => this.multisig.getConsumableNotes());
  }

  /**
   * Build a switch-guardian proposal pointing at `newGuardianEndpoint`.
   * Caller is responsible for signing/submitting the proposal AND for
   * calling `finalizeGuardianSwitch` + persisting the endpoint only
   * after the on-chain switch commits.
   */
  async createSwitchGuardianProposal(
    newGuardianEndpoint: string
  ): Promise<{ proposal: Proposal; newEndpoint: string }> {
    try {
      registerGuardianOrigin(newGuardianEndpoint);
      const newGuardian = new GuardianHttpClient(newGuardianEndpoint);
      // Fetch the new guardian's ECDSA commitment to match the account's scheme.
      const { commitment } = await newGuardian.getPubkey('ecdsa');
      // `createSwitchGuardianProposal` already creates and returns the proposal;
      // calling `createProposal` again would duplicate it (nonce collision).
      const proposal = await withWasmClientLock(() =>
        this.multisig.createSwitchGuardianProposal(newGuardianEndpoint, commitment)
      );
      return { proposal, newEndpoint: newGuardianEndpoint };
    } catch (error) {
      console.error('Error creating switch-guardian proposal:', error);
      throw error;
    }
  }

  /**
   * Build a proposal that replaces this account's hot signer in-place. Mints a
   * fresh hot key via the secureHotKey facade and constructs an `update_signers`
   * proposal whose target list is `[newHotCommit, coldCommit]` (preserving the
   * `[hot, cold]` ordering convention so getSignerDetailsFromAccount keeps
   * working post-rotation).
   *
   * Bypasses the SDK's createAddSignerProposal/createRemoveSignerProposal
   * convenience wrappers (those compute different target lists). At execution
   * time, multisig.ts's buildTransactionRequestFromMetadata treats all three
   * `update_signers` variants identically and uses metadata.targetSignerCommitments
   * directly — so labeling this as 'add_signer' is cosmetic.
   *
   * Sign + submit this proposal with a cold-bound MultisigService — replacing
   * the hot key cannot itself require the hot key (recovery-friendly). Default
   * threshold for update_signers is 1, so cold alone satisfies it.
   *
   * Caller is responsible for persisting `newHot.ciphertext` BEFORE submitting
   * the resulting tx (see initiateReplaceHotKeyTransaction).
   */
  async createReplaceHotKeyProposal(account: Account): Promise<{ proposal: Proposal; newHot: GeneratedHotKey }> {
    const newHot = await secureHotKey.generateHotKey();
    const { commitment: coldCommitRaw } = await getSignerDetailsFromAccount(account, true);
    const ensure0x = (h: string): string => (h.startsWith('0x') ? h : `0x${h}`);
    const targetSignerCommitments = [ensure0x(newHot.commitmentHex), ensure0x(coldCommitRaw)];
    const targetThreshold = this.multisig.threshold;

    // Keep getMidenClient() and both WASM ops inside a single lock scope — the
    // WASM client is single-threaded, so resolving the client outside the lock
    // (or splitting the build/execute into two lock windows) leaves a gap where
    // another holder can run and trigger "recursive use ... unsafe aliasing".
    const { summaryBase64, saltHex } = await withWasmClientLock(async () => {
      const webClient = (await getMidenClient()).client;
      const { request, salt } = await buildUpdateSignersTransactionRequest(
        webClient,
        targetThreshold,
        targetSignerCommitments,
        { signatureScheme: 'ecdsa', midenRpcEndpoint: getEffectiveRpcUrl() }
      );
      const summary = await executeForSummary(webClient, this.accountId, request, getEffectiveRpcUrl());
      return { summaryBase64: u8ToB64(summary.serialize()), saltHex: salt.toHex() };
    });
    const metadata: ProposalMetadata = {
      proposalType: 'add_signer',
      targetThreshold,
      targetSignerCommitments,
      saltHex,
      requiredSignatures: this.multisig.getEffectiveThreshold('add_signer'),
      description: 'Replace device (hot) signer'
    };

    const proposal = await this.multisig.createProposal(Date.now(), summaryBase64, metadata);
    console.log('Created replace-hot-key proposal:', proposal.id);
    return { proposal, newHot };
  }

  /**
   * Post-submit finalization for a switch-guardian proposal. Mirrors the
   * block that upstream's `multisig.executeProposal` runs when it detects
   * a `switch_guardian` metadata type. Must be called AFTER the on-chain
   * switch lands — `client.load(...)` against the new guardian will fail
   * until `registerOnGuardian` succeeds.
   *
   * By the time this runs the on-chain guardian has already been switched, so
   * the old guardian no longer has authority over the account. Registration on
   * the new guardian is therefore retried with back-off: a transient blip must
   * not be the difference between a usable account and one stranded between
   * guardians.
   */
  async finalizeGuardianSwitch(newGuardianEndpoint: string): Promise<void> {
    try {
      console.log('Finalizing guardian switch to new endpoint:', newGuardianEndpoint);
      const updatedStateBase64 = await withWasmClientLock(async () => {
        await midenClientProxy.syncState();
        const account = await midenClientProxy.getAccount(this.accountId);
        if (!account) {
          throw new Error(`Updated account ${this.accountId} is missing from local client`);
        }
        return u8ToB64(account.serialize());
      });

      registerGuardianOrigin(newGuardianEndpoint);
      const nextGuardian = new GuardianHttpClient(newGuardianEndpoint);
      const { commitment } = await nextGuardian.getPubkey('ecdsa');

      this.multisig.setGuardianClient(nextGuardian);
      this.multisig.guardianPublicKey = commitment;
      this.guardianEndpoint = newGuardianEndpoint;
      await this.registerOnGuardianWithRetry(updatedStateBase64);
    } catch (error) {
      console.error('Error finalizing guardian switch:', error);
      throw error;
    }
  }

  private async registerOnGuardianWithRetry(stateBase64: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_GUARDIAN_REGISTER_RETRIES; attempt++) {
      try {
        await this.multisig.registerOnGuardian(stateBase64);
        return;
      } catch (error) {
        lastError = error;
        console.warn(`registerOnGuardian failed (attempt ${attempt}/${MAX_GUARDIAN_REGISTER_RETRIES})`, error);
        if (attempt < MAX_GUARDIAN_REGISTER_RETRIES) {
          // #619 — on a 429 this honours the guardian's own Retry-After instead
          // of the blind exponential backoff (which just earns another 429).
          await delay(guardianRegisterBackoffMs(error, attempt));
        }
      }
    }
    throw new Error('Failed to register account on the new guardian after switching', { cause: lastError });
  }

  /**
   * Push this account's CURRENT on-chain state to its (unchanged) guardian, so the
   * guardian's stored blob tracks structural rotations.
   *
   * Upstream `multisig.executeProposal` only re-registers the post-execution state
   * on the guardian for `switch_guardian` proposals; for `update_signers`
   * (replace-hot-key) and `update_procedure_threshold` it submits the tx on-chain
   * but never updates the guardian. Without this push, the guardian's `getState`
   * keeps serving the pre-rotation blob, so the next `multisig.syncState` sees
   * guardian-commitment != on-chain-commitment and throws on
   * `ensureSafeToOverwriteLocalState` every ~3s tick — permanently, until a full
   * reinstall re-registers the account. Mirrors `finalizeGuardianSwitch`'s
   * registration step but keeps the same guardian endpoint. Idempotent: if the
   * guardian already has this state, re-registering is a no-op.
   *
   * Called explicitly by those completion handlers, and as the Stage-2 last resort
   * in `runSync` once a lagging guardian fails to canonicalize within the retry
   * window (NOT on the first sign of lag — see `runSync`).
   */
  async reRegisterCurrentStateOnGuardian(): Promise<void> {
    const { updatedStateBase64, freshSignerCommitments } = await withWasmClientLock(async () => {
      await midenClientProxy.syncState();
      const account = await midenClientProxy.getAccount(this.accountId);
      if (!account) {
        throw new Error(`Account ${this.accountId} is missing from local client`);
      }
      // #619 gap (3): derive the guardian allowlist (`auth.cosigner_commitments`,
      // written by registerOnGuardian from `multisig.signerCommitments`) from the
      // SAME freshly-synced on-chain account as the state blob — NOT the cached
      // `multisig.signerCommitments`, which `client.load` set from the guardian's
      // stored blob and can still be the PRE-rotation [old-hot, cold]. Deriving
      // it here via `AccountInspector.fromAccount` is byte-identical to that
      // load-time derivation (same by-key reader), so there is no allowlist-format
      // drift; it just uses the fresh source. Without this, a re-register after a
      // hot-key rotation could re-push the old hot key and re-arm the permanent
      // 401 this method exists to prevent.
      const freshSignerCommitments = AccountInspector.fromAccount(account).signerCommitments;
      return { updatedStateBase64: u8ToB64(account.serialize()), freshSignerCommitments };
    });
    // Guard against a truncated read: AccountInspector.fromAccount swallows
    // per-slot storage-read failures (skips the slot, no throw), so a partial
    // read could yield an empty set. NEVER overwrite a good cached allowlist with
    // an empty one and push that to the guardian — that would re-arm the very
    // 401 this method prevents. On an empty derive, keep the cached set (the
    // guardian-sync 401 self-heal covers any residual staleness).
    if (freshSignerCommitments.length > 0) {
      this.multisig.signerCommitments = freshSignerCommitments;
    }
    await this.registerOnGuardianWithRetry(updatedStateBase64);
  }
}

// Re-export types that may be needed by consumers
export type { TransactionProposal, ProposalMetadata };

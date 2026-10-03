import { Account, MidenClient, NoteArray, NoteType, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import {
  AccountInspector,
  Multisig,
  MultisigClient,
  GuardianHttpClient,
  buildUpdateSignersTransactionRequest,
  chainAnchorToBase64,
  executeForSummary,
  type ProposalMetadata,
  type TransactionProposal,
  type Proposal
} from '@openzeppelin/miden-multisig-client';

import { getEffectiveDefaultGuardianEndpoint, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import type { WalletAccount } from 'lib/shared/types';

import {
  assertGuardianKeyCommitment,
  getSignerDetailsFromAccount,
  insertGuardianAccountMonotonically,
  resolveGuardianEndpoint
} from './account';
import {
  GuardianProbeTimeoutError,
  isGuardianAccountAlreadyRegistered,
  OUTGOING_GUARDIAN_DEADLINE_MS,
  withTimeout
} from './discover';
import { registerGuardianOrigin, withGuardianProbe } from './native-http';
import { GUARDIAN_RETRY_MAX_ATTEMPTS, guardianRegisterBackoffMs, NEW_GUARDIAN_PUBKEY_TIMEOUT_MS } from './serialize';
import { WalletSigner, type SignWordFunction } from './signer';
import { midenClientProxy } from '../back/miden-client-proxy';
import { freeChainAnchor } from '../sdk/chain-anchor';
import { accountRefToSdk, feeAwareRequestBuilder, randomFeeSalt } from '../sdk/helpers';
import {
  assertWasmHoldCurrent,
  getCurrentWasmLockHold,
  getMidenClient,
  withWasmClientLock,
  type WasmClientLockOptions,
  type WasmLockHold
} from '../sdk/miden-client';
import { isGuardianCanonicalizationError } from '../sdk/sdk-error-code';
import {
  WASM_LOCK_SYNC_WATCHDOG_MS,
  WasmClientPoisonedError,
  isWasmClientPoisonedError
} from '../sdk/wasm-client-poison';
import { monotonicNowMs } from '../sync-backoff';
import { syncUnderBoundedLock } from '../sync-lock';

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

/**
 * `reRegisterCurrentStateOnGuardian` refused to push (#1233): this device's copy of the account is
 * not the on-chain state, or either side could not be read. `/configure` overwrites the guardian's
 * state unconditionally, so pushing a copy that is behind the chain moves the guardian backwards
 * and discards its in-flight update. Nothing was written.
 */
export class GuardianReRegisterRefusedError extends Error {
  constructor(accountId: string, cause: unknown) {
    super(`Not re-registering account ${accountId} on its guardian: its local state is not the on-chain state`, {
      cause
    });
    this.name = 'GuardianReRegisterRefusedError';
  }
}

export const isGuardianReRegisterRefusal = (error: unknown): boolean => error instanceof GuardianReRegisterRefusedError;

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
// Stage 2's re-register, for every runSync caller: the idle loop reaches it on a timer, runSync's own sync hold
// already takes this ceiling for all of them, and the stage is best-effort, falling through to the original error.
const GUARDIAN_SYNC_REALIGN_LOCK_OPTIONS = { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-sync-realign' };

/**
 * Per-attempt ceiling on the two POST-COMMIT round-trips to the NEW guardian in
 * {@link MultisigService.finalizeGuardianSwitch} — its `GET /pubkey` and each
 * `registerOnGuardian` attempt.
 *
 * `GuardianHttpClient` passes no `AbortSignal` (the reason
 * `withOutgoingGuardianDeadline` exists for the arms that talk to the OUTGOING
 * operator), so an operator that accepts the connection and then goes silent
 * produces no error until the fetch boundary cuts the request off at
 * GUARDIAN_REQUEST_TIMEOUT_MS, and these two calls sit PAST the on-chain commit:
 * every attempt spent in silence keeps `completeSwitchGuardianTransaction` from
 * its terminal status write, parking a committed rotation at
 * `GeneratingTransaction`, which the routed UI observes, and leaving
 * `registerFailed`, the very flag whose self-heal exists to finish this
 * registration later, unrecorded. The direct path bounds its counterparts more
 * tightly for exactly this reason (F-144 bounded only the endpoint persist beside
 * it).
 *
 * Matched to the direct path's `DIRECT_REGISTER_TIMEOUT_MS` and to the shared
 * `NEW_GUARDIAN_PUBKEY_TIMEOUT_MS` (./serialize), which bounds the pre-sign
 * pubkey check on both switch paths, this file's `createSwitchGuardianProposal`
 * included: generous, because expiring early costs an attempt out of the
 * budget, and its job is only to convert silence into a failure the loop can
 * consume.
 */
export const POST_COMMIT_GUARDIAN_TIMEOUT_MS = 30_000;
// The per-attempt backoff (capped exponential, and Retry-After-aware on 429s)
// lives in `guardianRegisterBackoffMs` (./serialize, #619).

/**
 * Ceiling on the settlement read before a proposal (#312). Short, because it is
 * a hint: no answer only means the proposal goes ahead and meets the Guardian's
 * own 409 if the previous delta is still settling.
 */
export const PRIOR_CANDIDATE_CHECK_TIMEOUT_MS = 10_000;

/** The Guardian's own hold on a candidate that never settles (600 s): past it the Guardian has released it (#1317). */
export const GUARDIAN_CANDIDATE_HOLD_MS = 600_000;

/** Where the delta a previous write left stands: still a `candidate`, `settled`, or `unknown`. */
export type PriorCandidateState = 'candidate' | 'settled' | 'unknown';

/** The Guardian holds no delta at that nonce. Duck-typed like the other Guardian error checks. */
const isGuardianDeltaNotFound = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 'delta_not_found';

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
  private switchProposalId?: string;

  constructor(
    multisig: Multisig,
    client: MultisigClient,
    guardianEndpoint: string,
    private readonly requestSigner?: WalletSigner
  ) {
    this.multisig = multisig;
    this.client = client;
    this.guardianEndpoint = guardianEndpoint;
  }

  /**
   * Initialize a MultisigService for an existing Guardian account.
   *
   * `guardianEndpoint` is resolved per-account by the caller (see
   * `resolveGuardianEndpoint`) so accounts on different operators don't collide.
   *
   * `lockOptions` bounds and labels the hold below, and the CADENCE callers have to
   * pass it. This hold - not the account read that precedes it - is the one that
   * parks on the #777 path: it contains the client BUILD, which after any eviction
   * finds an empty singleton slot and sends a fresh genesis fetch to the node that
   * just refused to answer, and then `load()`, a guardian round trip. Left on the
   * default backstop it was five minutes of frozen wallet per lap, and an unlabelled
   * eviction record could not say which flow parked. `getOrCreateMultisigService`'s
   * `boundAtSyncCeiling` bounded only its own read and handed the longer await here
   * unbounded, so the parameter did not buy what its docstring claimed.
   *
   * `onHeld` receives how long that hold lasted, from acquisition, even when the
   * load throws.
   */
  static async init(
    account: Account,
    publicKey: string,
    signerCommitment: string,
    signWordFn: SignWordFunction,
    guardianEndpoint: string,
    lockOptions?: WasmClientLockOptions,
    onHeld?: (ms: number) => void
  ): Promise<MultisigService> {
    try {
      const signer = new WalletSigner(publicKey, signerCommitment, signWordFn);

      // `load` drives the shared WASM web-client, so it must be serialized with
      // every other client operation via the global mutex — and the client is
      // RESOLVED inside the same hold: resolving it outside left a window where
      // a recovery replaced the singleton between the resolve and the lock, so
      // this caller drove a client that no longer existed (issue #775; the same
      // shape vault already fixed).
      //
      // Reuse the shared singleton client instead of spinning up a fresh
      // WebClient (each new WebClient spawns a ~6MB web-client-methods-worker
      // that is never terminated). Reusing the singleton also lets the multisig
      // lib's rawClientCache WeakMap (keyed by this client instance) hit across
      // every init, so at most ONE shared raw worker is created total.
      const loadUnderHold = async (hold: WasmLockHold) => {
        const webClient = (await getMidenClient()).client;
        // The build above is an await, and on the #777 path it is the long one: this
        // initializer is reachable from the unattended guardian sync loop, whose whole
        // problem is a client that parks on a node that never answers. If the hold was
        // evicted while it ran, the mutex is already somebody else's and `load()` below —
        // a WASM call on that borrowed client — is the double borrow the lock exists to
        // prevent. Strictly pre-write, so failing here costs a retry and nothing else.
        if (getCurrentWasmLockHold() !== hold) {
          throw new WasmClientPoisonedError(
            'watchdog',
            new Error('guardian service init abandoned after the client build')
          );
        }
        registerGuardianOrigin(guardianEndpoint);
        const multisigClient = new MultisigClient(webClient, {
          guardianEndpoint,
          midenRpcEndpoint: getEffectiveRpcUrl()
        });
        return { multisig: await multisigClient.load(account.id().toString(), signer), client: multisigClient };
      };
      const { multisig, client } = await withWasmClientLock(async hold => {
        const heldFrom = monotonicNowMs();
        try {
          return await loadUnderHold(hold);
        } finally {
          onHeld?.(monotonicNowMs() - heldFrom);
        }
      }, lockOptions);

      return new MultisigService(multisig, client, guardianEndpoint, signer);
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
   *
   * `lockOptions` bounds and labels BOTH holds this takes - the commitment read
   * here and `init`'s below - and the cadence caller (the guardian sync's cold
   * re-register self-heal) passes it for the reason spelled out on `init`.
   */
  static async buildColdMultisigService(
    account: Account,
    walletAccount: WalletAccount,
    signWordFn: SignWordFunction,
    lockOptions?: WasmClientLockOptions
  ): Promise<MultisigService> {
    if (!walletAccount.coldPublicKey) {
      throw new Error(`Guardian account ${walletAccount.publicKey} is missing coldPublicKey — re-create the wallet`);
    }
    // UNDER A HOLD. `getSignerDetailsFromAccount` walks the account's storage
    // maps, so it is a WASM call and not a field read - and every one of this
    // method's five callers hands in an `account` read under a hold that has
    // already RELEASED, which left this call free to run concurrently with
    // another flow's client operation: the `recursive use of an object ...
    // unsafe aliasing` panic the global mutex exists to prevent. Sequential with
    // `init`'s own hold below, never nested, so the non-reentrant mutex is safe.
    //
    // What this does NOT recover is the handle's provenance: `account` is a
    // borrow of whichever client the caller's earlier hold resolved, so an
    // eviction in the gap leaves these bytes coming from a replaced client. The
    // strictly-correct shape is the one the guardian-sync snapshots use - ONE
    // hold spanning the account read and every read derived from it - but that
    // requires the commitment to be read at all five call sites and threaded in.
    // Serializing here is the part that removes the crash.
    //
    // Left as-is deliberately, on the strength of WHICH field is read: the COLD
    // commitment is a permanent allowlist member, unchanged by any rotation, so a
    // handle from a replaced client yields the same bytes a fresh read would - the
    // guardian-sync caller names its argument `staleAccount` for exactly this
    // reason. What a replaced client can do is DISPOSE the handle, and that
    // surfaces as the SDK's own `isDisposed` throw, i.e. a failed attempt and a
    // retry, not a wrong commitment written to the guardian. Should this method
    // ever read a field that a rotation moves, that reasoning expires and the
    // threading is required.
    const commitment = await withWasmClientLock(
      async () => (await getSignerDetailsFromAccount(account, true)).commitment,
      lockOptions
    );
    const guardianEndpoint = resolveGuardianEndpoint(walletAccount);
    return MultisigService.init(
      account,
      `0x${walletAccount.coldPublicKey}`,
      `0x${commitment}`,
      signWordFn,
      guardianEndpoint,
      lockOptions
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
    // (as `MultisigService.init` does); until then this binds to the network
    // default.
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
   * Create a send (P2ID) transaction proposal. The multisig client's send
   * proposal has no reclaim-height option, so this is only used for a plain
   * (non-recallable) Guardian send. Anything that needs a recall window or a
   * public, allocator-readable note (recallable send, Epoch bridge, earn
   * deposit) is built as a P2IDE send request and routed through
   * `createCustomProposal`.
   *
   * `noteType` is a required argument rather than a hardcoded Private: the
   * caller resolves it from the row the user actually approved. Defaulting it
   * here is what made a Public guardian send emit a private note the recipient
   * was never sent.
   *
   * Ids go through `accountRefToSdk`, not the bech32-only parser: faucet ids in
   * particular reach the wallet in both hex and bech32 form, and the sibling
   * recallable-send path already accepts both — a hex id that the recallable
   * path sends fine would throw here.
   */
  async createSendProposal(
    recipientId: string,
    faucetId: string,
    amount: bigint,
    noteType: NoteType
  ): Promise<Proposal> {
    return withWasmClientLock(() =>
      this.multisig.createP2idProposal(
        accountRefToSdk(recipientId).toString(),
        accountRefToSdk(faucetId).toString(),
        amount,
        { noteType }
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
   * `createCustomProposal` for a request the wallet built itself, re-bound to the current sync
   * height first. Returns the bytes the proposal was made from; the caller persists them, since
   * custom execution has to rebuild from exactly those.
   *
   * A guarded request's auth args bind the sync height at BUILD, and the proposal's anchor is
   * the sync height at CAPTURE. The kernel authenticates the bound block only when the two
   * agree, so persisted bytes proposed after any sync (a 409 retry, a restart, a slow round
   * trip) failed with "transaction summary binds block N, which the transaction does not
   * authenticate". Rebuilding in the same lock hold as the capture closes that gap.
   *
   * Only for requests whose whole content is their own output notes (the wallet's sends,
   * swaps and collateral notes): nothing else survives the rebuild, and a dApp's request is
   * not ours to rebuild. The notes are carried over as they are, so a PSWAP keeps its order id.
   */
  async createRebasedCustomProposal(
    requestBytes: Uint8Array,
    proposalType: string
  ): Promise<{ proposal: Proposal; requestBytes: Uint8Array }> {
    return await withWasmClientLock(async hold => {
      const client = (await getMidenClient()).client;
      assertWasmHoldCurrent(hold, 'rebased custom proposal: after the client build');
      const notes = TransactionRequest.deserialize(requestBytes).expectedOutputOwnNotes();
      const builder = await feeAwareRequestBuilder(client, this.accountId, randomFeeSalt());
      assertWasmHoldCurrent(hold, 'rebased custom proposal: after the fee-aware builder');
      const rebased = builder.withOwnOutputNotes(new NoteArray(notes)).build().serialize();
      const proposal = await this.multisig.createCustomProposal(rebased, proposalType);
      return { proposal, requestBytes: rebased };
    });
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
   * this is safe to call after ambiguous prover/RPC/submit failures. Never call it
   * after a resolved submit (#1233): a transaction still in the mempool passes that
   * check, and a finalized abandon releases the account onto stale state. The one
   * exception is a submit the node then discarded: that transaction is no longer in
   * the mempool and never lands, and the Guardian still refuses the abandon if it did.
   */
  async abandonCandidate(nonce: number): Promise<void> {
    await this.multisig.abandonCandidate(nonce);
  }

  /**
   * Hand the guardian this service still talks to the executed switch-guardian delta, as upstream
   * `executeProposal` does after its submit (#1233). Without it that operator keeps the pre-switch
   * state and never releases the account; with it, it canonicalizes the switch once the block lands,
   * releases the account, and keeps serving reads of the post-switch state. Only after the switch's
   * submit resolved, and before `finalizeGuardianSwitch` repoints this service.
   */
  async pushSwitchDelta(proposalId: string): Promise<void> {
    const guardian = this.client.guardianClient;
    const delta = await guardian.getDeltaProposal(this.accountId, proposalId);
    await guardian.pushDelta({ ...delta, deltaPayload: delta.deltaPayload.txSummary });
  }

  /**
   * `pushSwitchDelta` on the one outgoing-guardian budget, outside any lock, and never rejecting:
   * `'pushed'` when it landed in time, `'silent'` when the guardian sat on it for the whole budget (what
   * predicts a parked hold next), and `'refused'` for any other rejection, an unreachable answer
   * included, since that one came back inside the budget (#1233).
   */
  async pushSwitchDeltaBounded(proposalId: string): Promise<'pushed' | 'silent' | 'refused'> {
    try {
      await withTimeout(
        this.pushSwitchDelta(proposalId),
        OUTGOING_GUARDIAN_DEADLINE_MS,
        'pushing the executed switch delta to the outgoing guardian'
      );
      return 'pushed';
    } catch (error) {
      const outcome = error instanceof GuardianProbeTimeoutError ? 'silent' : 'refused';
      console.warn(`[Guardian] the outgoing guardian did not take the executed switch delta (${outcome}):`, error);
      return outcome;
    }
  }

  /**
   * Read this guardian's state for the account over HTTP only, never under the WASM lock (#1233): a
   * caller asks before an adopt, whose hold a silent guardian would park until the fetch boundary cuts
   * each request off a minute in.
   */
  async probeGuardianState(): Promise<void> {
    await this.client.guardianClient.getState(this.accountId);
  }

  /**
   * Where the delta at `nonce` stands on this service's Guardian, for the
   * settlement gate before a proposal (#312): `'candidate'` while the Guardian
   * still holds it as a candidate, `'settled'` once it canonicalized, discarded
   * or retained it or holds no such delta, and `'unknown'` for any other answer,
   * a failed read or no answer within PRIOR_CANDIDATE_CHECK_TIMEOUT_MS. HTTP
   * only, never under the WASM lock, and never rejects.
   */
  async priorCandidateState(nonce: number): Promise<PriorCandidateState> {
    try {
      const delta = await withTimeout(
        this.client.guardianClient.getDelta(this.accountId, nonce),
        PRIOR_CANDIDATE_CHECK_TIMEOUT_MS,
        `reading guardian candidate ${nonce}`
      );
      switch (delta.status.status) {
        case 'candidate':
          return 'candidate';
        case 'canonical':
        case 'discarded':
        case 'retained':
          return 'settled';
        default:
          return 'unknown';
      }
    } catch (error) {
      if (isGuardianDeltaNotFound(error)) return 'settled';
      console.warn(`[Guardian] could not read candidate ${nonce}; the proposal goes ahead`, error);
      return 'unknown';
    }
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
    const request = await withWasmClientLock(() => this.multisig.createTransactionProposalRequest(id));
    if (proposal.metadata.proposalType === 'switch_guardian') this.switchProposalId = id;
    return request;
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
   * AHEAD, so this cannot pull a good local account backwards. `onHeld` receives
   * how long the hold lasted, from acquisition, even when the read throws.
   */
  async adoptGuardianStateOnce(onHeld?: (ms: number) => void): Promise<void> {
    await withWasmClientLock(
      async () => {
        const heldFrom = monotonicNowMs();
        try {
          await this.multisig.syncState();
        } finally {
          onHeld?.(monotonicNowMs() - heldFrom);
        }
      },
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-adopt' }
    );
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
        // Bounded like every other pure-sync hold (#777): it is reached from the
        // idle loop, and the fetch boundary lets each guardian request in it run up
        // to GUARDIAN_REQUEST_TIMEOUT_MS, so one unresponsive guardian holds the
        // whole app's WASM access for that minute once per retry in this loop; the
        // ceiling bounds the hold as a whole.
        await withWasmClientLock(() => this.multisig.syncState(), {
          watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
          label: 'guardian-sync'
        });
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

        // `multisig.syncState` refuses to overwrite local state ("Refusing to overwrite
        // local state ...") when the guardian's state has local's nonce with another
        // commitment, or is ahead of local (or local has none) but does not match the
        // chain: typically a guardian still canonicalizing the latest delta, whose stored
        // blob lags the on-chain account. A guardian merely behind local is kept quietly
        // and never reaches here. The lag is usually transient - the guardian catches up
        // within ~2-10 ticks - so handle it in two stages, all silently in the background
        // (this runs only under the AutoSync / post-tx bookkeeping paths, never a UI flow).
        // The refusal alone (#1233): a broader "commitment ... match" test also caught the
        // re-register guard's own mismatch and the SDK's import mismatch, neither a lag.
        const isGuardianCanonicalizing = isGuardianCanonicalizationError(error);
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
          // The push happens only when local IS the on-chain state (#1233); otherwise it is
          // refused and this falls through the same way.
          if (!realignAttempted) {
            realignAttempted = true;
            try {
              console.warn(
                'Guardian still lagging after canonicalization window; re-registering current state as a last resort'
              );
              await this.reRegisterCurrentStateOnGuardian(undefined, GUARDIAN_SYNC_REALIGN_LOCK_OPTIONS);
              continue;
            } catch (realignError) {
              // AN EVICTION IS NOT "non-fatal", AND IT IS NOT ABOUT THE GUARDIAN.
              // `reRegisterCurrentStateOnGuardian` takes a hold whose first act is a
              // `syncState()` round trip and re-checks ownership twice, so poison is
              // one of the shapes this catch actually receives. Swallowed here, what
              // reached the caller was `error` - the canonicalization failure - so
              // `syncGuardianAccounts`' poison arm read false, the pass did NOT break,
              // and it went on to take fresh holds for the remaining accounts while
              // the abandoned call was still inside WASM. Worse than the double
              // borrow: the fall-through then books `noteNonEvictionSyncFailure`,
              // which ZEROES this account's eviction count, so the lap that parked us
              // withdrew the fuse's evidence for the park. Stage 2 is reached after
              // ~30s of ordinary post-rotation operator lag, on a ~3s cadence.
              //
              // Identical to the defect the adopt arm carries a rethrow for; this is
              // the same rule one function over.
              if (isWasmClientPoisonedError(realignError)) throw realignError;
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
      // Not yet known to be a Guardian: on mobile its origin routes through native HTTP only while it is checked.
      const commitment = await withGuardianProbe(newGuardianEndpoint, async () => {
        const newGuardian = new GuardianHttpClient(newGuardianEndpoint);
        // Fetch the new guardian's ECDSA commitment to match the account's scheme.
        // Validated before use: the SDK interpolates this wire value into
        // transaction-script SOURCE, and `normalizeHexWord` checks neither charset
        // nor length. Same boundary the direct-switch path applies.
        // Every probed check carries its own deadline: a caller's deadline abandons it without cancelling it.
        const answer = await withTimeout(
          newGuardian.getPubkey('ecdsa'),
          NEW_GUARDIAN_PUBKEY_TIMEOUT_MS,
          `New guardian ${newGuardianEndpoint} pubkey fetch`
        );
        return assertGuardianKeyCommitment(answer.commitment, newGuardianEndpoint);
      });
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
   * Build a proposal that replaces this account's hot signer in-place. Constructs an
   * `update_signers` proposal whose target list is `[newHotCommit, coldCommit]`
   * (preserving the `[hot, cold]` ordering convention so getSignerDetailsFromAccount
   * keeps working post-rotation) from the commitment it is given.
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
   * The caller mints the key and owns its persistence (see
   * `generateGuardianTransaction`), so a retried call proposes the same key.
   * Each call first runs `syncBeforeRotationBuild`, so a retry after a
   * pending-delta 409 builds on the settled state.
   */
  async createReplaceHotKeyProposal(account: Account, newHotCommitmentHex: string): Promise<Proposal> {
    await this.syncBeforeRotationBuild();
    const { commitment: coldCommitRaw } = await getSignerDetailsFromAccount(account, true);
    const ensure0x = (h: string): string => (h.startsWith('0x') ? h : `0x${h}`);
    const targetSignerCommitments = [ensure0x(newHotCommitmentHex), ensure0x(coldCommitRaw)];
    // After the sync on purpose: the adopt refreshes the loaded config from the adopted account.
    const targetThreshold = this.multisig.threshold;

    const { summaryBase64, saltHex, chainAnchor } = await withWasmClientLock(
      async hold => {
        const webClient = (await getMidenClient()).client;
        // An eviction ABANDONS this callback rather than cancelling it, so every
        // WASM call after a parking await needs the ownership re-check - the build,
        // the request construction, and the summary execution can each park on the
        // network, and past an eviction the mutex (and the client) belong to a
        // successor. All three transitions are pre-sign/pre-submit: stopping costs
        // the user a retry and nothing else.
        assertWasmHoldCurrent(hold, 'replace-hot-key: after the client build');
        const { request, salt } = await buildUpdateSignersTransactionRequest(
          webClient,
          targetThreshold,
          targetSignerCommitments,
          // This site drives the low-level builder directly (it needs the request AND
          // salt back to build the proposal by hand), so it names the account the
          // multisig auth args are committed for. That account id is what selects the
          // fee-aware builder: without it the request carries no fee conversion info
          // and `fee::pay_fee` aborts with ERR_FEE_CONVERSION_INFO_MISSING. The bound
          // block defaults to the sync height, the block the summary anchor below
          // names and a rebuild pins.
          {
            accountId: this.accountId,
            signatureScheme: 'ecdsa'
          }
        );
        assertWasmHoldCurrent(hold, 'replace-hot-key: after the update-signers request build');
        // The anchor names the block the auth args bind. Re-execution at a later
        // tip reproduces the summary when the request declares that bound block.
        const { summary, anchor } = await executeForSummary(webClient, this.accountId, request);
        // The live anchor's only job is to be serialized onto the proposal; once
        // the wire form exists, release the WASM object (it holds a partial
        // blockchain) instead of leaving it to the finalizer - the same
        // serialize-then-free every multisig-client proposal creator does (#784).
        try {
          // Inside the try on purpose: summary/salt/anchor are borrows of the
          // client's RefCell, so touching them past an eviction IS the double
          // borrow - but the anchor release must still run on this throw
          // (freeChainAnchor swallows a disposed-object failure).
          assertWasmHoldCurrent(hold, 'replace-hot-key: after the summary execution');
          return {
            summaryBase64: u8ToB64(summary.serialize()),
            saltHex: salt.toHex(),
            chainAnchor: chainAnchorToBase64(anchor)
          };
        } finally {
          freeChainAnchor(anchor);
        }
      },
      { label: 'replace-hot-key-build' }
    );
    const metadata: ProposalMetadata = {
      proposalType: 'add_signer',
      targetThreshold,
      targetSignerCommitments,
      saltHex,
      chainAnchor,
      requiredSignatures: this.multisig.getEffectiveThreshold('add_signer'),
      description: 'Replace device (hot) signer'
    };

    const proposal = await this.multisig.createProposal(Date.now(), summaryBase64, metadata);
    console.log('Created replace-hot-key proposal:', proposal.id);
    return proposal;
  }

  /**
   * Bring the local copy of this private account up to date before a rotation is
   * built on it: the chain for a current reference block, then the guardian for the
   * account state, which only the guardian holds. After a seed recovery the local
   * copy is whatever was adopted at recovery, and the old device's last transaction
   * may have settled since; a summary built on the older state is refused by the
   * node (#904).
   *
   * The adopt keeps local state quietly when the guardian is behind local. It throws
   * the SDK's "Refusing to overwrite local state" when the guardian's state has local's
   * nonce but another commitment, or does not match the chain. Those two are answers,
   * not failures, and must not escape: letting one out would fail a rotation that can
   * still build on local state.
   */
  private async syncBeforeRotationBuild(): Promise<void> {
    await syncUnderBoundedLock('replace-hot-key-sync');
    await this.adoptGuardianStateOnce().catch((error: unknown) => {
      if (!isGuardianCanonicalizationError(error)) throw error;
      console.warn(
        '[Guardian] replace-hot-key: guardian state refused (same nonce, other commitment; or not on chain); ' +
          'building on local state',
        error
      );
    });
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
    // Beside the registration, never ahead of it: the old operator is often why the switch was made. Awaited before
    // returning all the same: a cold signer's authority ends with the pipeline that awaits this.
    const recorded = this.recordCommittedGuardianSwitch();
    try {
      console.log('Finalizing guardian switch to new endpoint:', newGuardianEndpoint);
      const updatedStateBase64 = await withWasmClientLock(async hold => {
        await midenClientProxy.syncState();
        // The sync is the canonical parking await (a node that never answers),
        // and an eviction during it hands the mutex to a successor without
        // stopping this callback — the account read below would then be an
        // unmutexed call into a client somebody else is inside. Pre-registration,
        // so failing here just re-runs the (retried) finalize.
        assertWasmHoldCurrent(hold, 'finalize-switch: after the state sync');
        const account = await midenClientProxy.getAccount(this.accountId);
        if (!account) {
          throw new Error(`Updated account ${this.accountId} is missing from local client`);
        }
        // serialize() reads through the Account's borrow of the client's
        // RefCell, so the read await needs its own re-check.
        assertWasmHoldCurrent(hold, 'finalize-switch: after the account read');
        return u8ToB64(account.serialize());
      });

      registerGuardianOrigin(newGuardianEndpoint);
      const nextGuardian = new GuardianHttpClient(newGuardianEndpoint);
      const pubkeyResponse = await withTimeout(
        nextGuardian.getPubkey('ecdsa'),
        POST_COMMIT_GUARDIAN_TIMEOUT_MS,
        `New guardian ${newGuardianEndpoint} pubkey fetch`
      );
      // The last `/pubkey` consumer that took the field on trust. The guardian
      // client returns it off an unchecked `response.json()` cast, so its type is
      // whatever the endpoint served, and this assigned it straight into the
      // multisig config. Throwing is safe here even though the rotation has
      // committed: the caller books `registerFailed` and the self-heal retries,
      // which is strictly better than a config holding a non-commitment.
      const commitment = assertGuardianKeyCommitment(pubkeyResponse?.commitment, newGuardianEndpoint);

      this.multisig.setGuardianClient(nextGuardian);
      this.multisig.guardianPublicKey = commitment;
      this.guardianEndpoint = newGuardianEndpoint;
      await this.registerOnGuardianWithRetry(updatedStateBase64);
    } catch (error) {
      console.error('Error finalizing guardian switch:', error);
      throw error;
    } finally {
      await recorded;
    }
  }

  // Everything is taken before the first await: finalize moves guardianEndpoint on, and the id is cleared so the
  // history is pushed at most once, whatever the push's outcome.
  private async recordCommittedGuardianSwitch(): Promise<void> {
    if (!this.switchProposalId || !this.requestSigner) return;
    const proposalId = this.switchProposalId;
    this.switchProposalId = undefined;
    try {
      const guardian = new GuardianHttpClient(this.guardianEndpoint);
      guardian.setSigner(this.requestSigner);
      // Switch requests do not push a delta before submission. Record the
      // committed switch on the old operator before changing endpoints.
      await withTimeout(
        (async () => {
          const delta = await guardian.getDeltaProposal(this.accountId, proposalId);
          await guardian.pushDelta({ ...delta, deltaPayload: delta.deltaPayload.txSummary });
        })(),
        POST_COMMIT_GUARDIAN_TIMEOUT_MS,
        'Recording the committed Guardian switch'
      );
    } catch (error) {
      // The switch has committed. A history failure must not stop registration.
      console.warn('[Guardian] Failed to retain committed switch history on the old operator:', error);
    }
  }

  private async registerOnGuardianWithRetry(stateBase64: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= GUARDIAN_RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        await withTimeout(
          this.multisig.registerOnGuardian(stateBase64),
          POST_COMMIT_GUARDIAN_TIMEOUT_MS,
          'New guardian registration'
        );
        return;
      } catch (error) {
        // The operator already holds the account: the goal state, so it must not
        // be retried into a failure. Newly reachable now that an attempt can
        // TIME OUT — a `/configure` the server applied and answered too late
        // leaves the account registered, and the next attempt says so. Reporting
        // `registerFailed` for that arms a self-heal against a state that needs
        // no healing. (Not proof the held state is the state THIS rotation
        // intended; that comparison belongs elsewhere, as on the direct path.)
        if (isGuardianAccountAlreadyRegistered(error)) {
          console.warn('New guardian already holds this account; registration is a no-op.');
          return;
        }
        lastError = error;
        console.warn(`registerOnGuardian failed (attempt ${attempt}/${GUARDIAN_RETRY_MAX_ATTEMPTS})`, error);
        if (attempt < GUARDIAN_RETRY_MAX_ATTEMPTS) {
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
   *
   * Pushes only when the local account is the on-chain state; otherwise it refuses
   * with `GuardianReRegisterRefusedError` and writes nothing (#1233).
   *
   * `onBeforeRegister` fires immediately before the first `/configure` goes out, and
   * exists so a caller that keeps an attempt budget can tell the two halves of this
   * method apart. Everything above that point is a local WASM hold containing a
   * `syncState()` - a network round trip, and the likeliest await in the whole method
   * to park - so a caller that flipped its "attempted" flag before calling this
   * charged the operator for a request that was never issued. That is the same
   * which-side-of-the-POST distinction `attemptColdReRegisterSelfHeal` already makes
   * for its own eviction bookkeeping; it just could not see this far in. It receives
   * the signer set this push registers, derived from the account
   * `verifyStateCommitment` matched against the chain in the same hold: the chain's
   * signer set.
   *
   * `lockOptions` bounds and labels the hold below, and the CADENCE caller has to pass
   * it for the same reason `init` documents: the hold contains a `syncState()`, so on
   * the #777 path it parks on a node that never answers. Reached from `runSync`'s
   * stage-2 last resort, which the ~3 s guardian sync drives - left on the default
   * five-minute backstop that was a frozen wallet per lap, and unlabelled the eviction
   * record could not say which of the loop's holds it was.
   */
  async reRegisterCurrentStateOnGuardian(
    onBeforeRegister?: (signerCommitments: readonly string[]) => void,
    lockOptions?: WasmClientLockOptions
  ): Promise<void> {
    const { updatedStateBase64, freshSignerCommitments } = await withWasmClientLock(async hold => {
      await midenClientProxy.syncState();
      // Reachable from the BACKGROUND runSync stage-2 last resort — exactly the
      // unattended loop whose failure mode is a sync parked on a dead node, i.e.
      // the population the watchdog eviction exists for. An abandoned callback
      // must not carry on into the reads below (each a borrow of a client a
      // successor now owns); everything here is pre-registration, so stopping is
      // strictly cheaper.
      assertWasmHoldCurrent(hold, 're-register: after the state sync');
      // Push only the on-chain state (#1233). `/configure` overwrites the guardian unconditionally,
      // and runSync's Stage 2 reaches here when the guardian is AHEAD of a stale local copy (another
      // device's newer state it is still canonicalizing): pushing local would move the guardian
      // backwards and discard its in-flight update. So compare local with a fresh chain read first,
      // and refuse, writing nothing, when they differ or either side cannot be read.
      try {
        await this.multisig.verifyStateCommitment();
      } catch (error) {
        throw new GuardianReRegisterRefusedError(this.accountId, error);
      }
      // The chain read parked, and the account read below is a borrow of the client this hold owns.
      assertWasmHoldCurrent(hold, 're-register: after the chain commitment check');
      const account = await midenClientProxy.getAccount(this.accountId);
      if (!account) {
        throw new Error(`Account ${this.accountId} is missing from local client`);
      }
      // The inspector walks account storage and serialize() reads through the
      // same RefCell — both are borrows, so the read await gets its own re-check.
      assertWasmHoldCurrent(hold, 're-register: after the account read');
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
      // Bounded and labelled BY THE CALLER, because both callers are on the ~3s
      // guardian cadence: `runSync`'s stage-2 last resort and the cold
      // re-register self-heal. This was the one hold left in the file on the
      // 5-minute default backstop, which on a 3s loop is a hundred dead laps -
      // and, unlabelled, its eviction record could not say which of the two
      // flows had parked. The sibling holds here already make this argument for
      // themselves (`guardian-adopt`, `guardian-sync`).
    }, lockOptions);
    // Guard against a truncated read: AccountInspector.fromAccount swallows
    // per-slot storage-read failures (skips the slot, no throw), so a partial
    // read could yield an empty set. NEVER overwrite a good cached allowlist with
    // an empty one and push that to the guardian — that would re-arm the very
    // 401 this method prevents. On an empty derive, keep the cached set (the
    // guardian-sync 401 self-heal covers any residual staleness).
    if (freshSignerCommitments.length > 0) {
      this.multisig.signerCommitments = freshSignerCommitments;
    }
    // The POST is now unavoidable from the caller's point of view: past this line a
    // `/configure` may land even if the retry loop then throws or is torn down.
    onBeforeRegister?.(freshSignerCommitments);
    await this.registerOnGuardianWithRetry(updatedStateBase64);
  }
}

// Re-export types that may be needed by consumers
export type { TransactionProposal, ProposalMetadata };

/**
 * The relay submitter: the one place where the relay meets a bridge flow. A flow gives the calls that it must send.
 * The submitter puts them in one Calibur batch, has the backend sign it with the relay key (the `signRelay` action),
 * relays it, and follows the job until it is final. It knows no bridge.
 *
 * The submitter never signs a second batch while the first one can still execute: before each POST it gives the job
 * to the caller (`onJob`), and after a POST whose outcome is not known it reads the job instead of signing again.
 */
import { zeroAddress, zeroHash, type Address, type Hash, type Hex } from 'viem';

import type { RelayChainConfig } from 'lib/remote-config/schema';
import type { RelaySignedAuthorization, RelaySignRequest, RelaySignResult } from 'lib/shared/types';

import { batchDigest, batchNonceOf, buildFeeCall, type BatchCall, type BatchEnvelope } from './batch';
import {
  fetchRelayAccount,
  fetchRelayJob,
  relayCallBody,
  submitRelay,
  type RelayAccountQuery,
  type RelayJobQuery
} from './client';
import {
  RelayApiError,
  RelayExpiredError,
  RelayMismatchError,
  RelayNotSubmittedError,
  RelayRefusedError,
  RelayRevertedError,
  RelayStillPendingError,
  RelayUnknownOutcomeError,
  openRelayJobError,
  relayErrorAction,
  relaySubmitFailure
} from './errors';
import {
  assertFeeWithinCap,
  assertRelayAccountMatches,
  assertRelayJobMatches,
  deductFeeRecipient,
  relayerFeeOf,
  relayFeeToken,
  type RelayReviewedFee
} from './guards';
import { reportOpenRelayJob } from './open-jobs';
import { lowerAddress, lowerHash } from './parse';
import type { RelayAccount, RelayJob, RelayJobRef, RelayResult, RelaySubmission } from './types';

export type { RelayJobRef, RelayResult } from './types';

/** The most calls in one batch, the fee call included. The relay contract has the same limit. */
export const MAX_RELAY_BATCH_CALLS = 8;
/** The time from the signature to the batch deadline. The relay takes 60 seconds to 24 hours. */
export const RELAY_DEADLINE_SECONDS = 30 * 60;
/** The time between two reads of an open job. */
export const RELAY_POLL_MS = 5_000;
/** The longest wait for a job to become final. */
export const RELAY_WAIT_MS = 10 * 60_000;
/** The most times one submit signs again after `stale_request` or a `simulation_failed` with a new sequence. */
export const MAX_STALE_RETRIES = 2;
/**
 * The time after a batch deadline after which a job that the relay does not know can no longer execute: the relay
 * refuses a deadline less than 60 seconds ahead, and Calibur refuses a batch after its deadline.
 */
export const RELAY_RESUME_GRACE_SECONDS = 120;
/**
 * The relay deletes a final job this long after it became final. A read after that can find no job that executed: a
 * caller that knows the earliest time of the POST does not trust `not-submitted` from then plus this time.
 */
export const RELAY_FINAL_JOB_RETENTION_SECONDS = 24 * 60 * 60;

const EVEN_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const UINT256_LIMIT = 1n << 256n;

export interface RelaySubmitOptions {
  /**
   * Runs before EACH signature request: the first one and each one after a retry. It checks that the user's review
   * (account, route, quote) still holds. A throw ends the submit; nothing new is signed.
   */
  beforeSign?: () => Promise<void>;
  /**
   * Runs after the batch is signed and BEFORE the POST, with the job that the POST will create. The caller stores it
   * durably. A throw ends the submit; nothing is posted.
   */
  onJob?: (job: RelayJobRef) => Promise<void>;
  /** `deduct` mode only: the fee that the user reviewed (`reviewRelayFee`). */
  fee?: RelayReviewedFee;
}

export interface RelaySubmitterOptions {
  /** The relay entry of the chain in the remote config (`getRelayChain`). */
  chain: RelayChainConfig;
  /** The account's `relayEvmAddress`. */
  address: Address;
  /** Signs through the backend: `request => signRelay(accountPublicKey, request)`. */
  sign: (request: RelaySignRequest) => Promise<RelaySignResult>;
  /** Tests replace the service calls, the clock (ms) and the wait. */
  fetchAccount?: (query: RelayAccountQuery) => Promise<RelayAccount>;
  postRelay?: (submission: RelaySubmission) => Promise<RelayJob>;
  fetchJob?: (query: RelayJobQuery) => Promise<RelayJob>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One read of a job that an earlier submit recorded through `onJob`:
 * - `succeeded`, `reverted`, `expired`, `pending`: the relay knows the job. `hash` is the job's last transaction hash
 *   (the mined hash of a final job, the relayer's cancel transaction of an `expired` job).
 * - `unknown`: the outcome is still not known. The relay does not know the job and the deadline plus
 *   `RELAY_RESUME_GRACE_SECONDS` is not past, or the read failed (`cause`). Read again later.
 * - `not-submitted`: the relay does not know the job and the deadline plus `RELAY_RESUME_GRACE_SECONDS` is past. The
 *   batch can no longer execute.
 */
export type RelayJobCheck =
  | { state: 'succeeded'; hash: Hash }
  | { state: 'reverted'; hash: Hex }
  | { state: 'expired'; hash: Hex }
  | { state: 'pending'; hash: Hex }
  | { state: 'unknown'; cause: unknown }
  | { state: 'not-submitted' };

export interface RelaySubmitter {
  readonly chainId: number;
  readonly address: Address;
  /** Relays the calls as ONE batch. Resolves when the job is final and succeeded. */
  submit(calls: BatchCall[], options?: RelaySubmitOptions): Promise<RelayResult>;
  /** Follows a job that an earlier submit recorded through `onJob`. */
  resume(job: RelayJobRef): Promise<RelayResult>;
  /** Reads a job that an earlier submit recorded through `onJob` once, with no wait. It signs nothing. */
  check(job: RelayJobRef): Promise<RelayJobCheck>;
}

/** A POST that the relay refused: the job was not stored. It never leaves this module. */
class RefusedPost extends Error {
  readonly refusal: RelayApiError;

  constructor(refusal: RelayApiError) {
    super(refusal.message);
    this.name = 'RefusedPost';
    this.refusal = refusal;
  }
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sleepFor(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function retryAfterMs(error: unknown): number {
  return error instanceof RelayApiError && error.retryAfter !== undefined ? error.retryAfter * 1000 : 0;
}

function isNotFound(error: unknown): boolean {
  return error instanceof RelayApiError && error.code === 'not_found';
}

/** A relay submitter for one relay address on one chain. See the module comment. */
export function createRelaySubmitter(options: RelaySubmitterOptions): RelaySubmitter {
  const { chain, sign } = options;
  const chainId = chain.chainId;
  const relayAddress = lowerAddress(options.address);
  if (relayAddress === null) throw new TypeError('relay submitter: the relay address is not valid');
  const address: Address = relayAddress;
  const fetchAccount = options.fetchAccount ?? (query => fetchRelayAccount(query));
  const postRelay = options.postRelay ?? (submission => submitRelay(submission));
  const fetchJob = options.fetchJob ?? (query => fetchRelayJob(query));
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? sleepFor;

  /** One call as the vault takes it: a target that is not the zero address and not the relay address itself. */
  function checkedCall(call: BatchCall): BatchCall {
    const to = lowerAddress(call.to);
    if (to === null || to === zeroAddress || to === address) {
      throw new TypeError('relay submitter: the call target is not valid');
    }
    if (call.value < 0n || call.value >= UINT256_LIMIT) throw new TypeError('relay submitter: the value is not valid');
    if (!EVEN_HEX.test(call.data)) throw new TypeError('relay submitter: the data is not hex bytes');
    return { to, value: call.value, data: `0x${call.data.slice(2).toLowerCase()}` };
  }

  /** The job reference that a caller gives to `resume`, checked. A bad reference is a defect of the caller. */
  function checkedRef(job: RelayJobRef): RelayJobRef {
    const id = lowerHash(job.id);
    if (job.chainId !== chainId) throw new TypeError('relay submitter: the job is for another chain');
    if (id === null) throw new TypeError('relay submitter: the job id is not valid');
    if (!Number.isSafeInteger(job.deadline) || job.deadline < 0) {
      throw new TypeError('relay submitter: the job deadline is not valid');
    }
    return { chainId, id, deadline: job.deadline };
  }

  /**
   * The calls with the fee call last in `deduct` mode. The fee call pays the reviewed fee to the configured fee
   * recipient. Throws `RelayRefusedError` when the review and the relayer's terms do not agree.
   */
  function batchWithFee(calls: BatchCall[], account: RelayAccount, fee: RelayReviewedFee | undefined): BatchCall[] {
    switch (account.mode) {
      case 'sponsor':
        if (fee !== undefined) throw new RelayRefusedError('unexpected-fee');
        return calls;
      case 'deduct': {
        if (fee === undefined) throw new RelayRefusedError('no-reviewed-fee');
        const recipient = deductFeeRecipient(account, chain);
        if (relayerFeeOf(account, fee.token).fee > fee.amount) throw new RelayRefusedError('fee-changed');
        assertFeeWithinCap(chain, fee.token, fee.amount);
        return [...calls, buildFeeCall({ token: fee.token, recipient, amount: fee.amount })];
      }
    }
  }

  function assertTargetsAllowed(calls: BatchCall[], allowedTargets: Address[] | null): void {
    if (allowedTargets === null) return;
    if (!calls.every(call => allowedTargets.some(target => sameHex(target, call.to)))) {
      throw new RelayRefusedError('target-not-allowed');
    }
  }

  async function signAuthorization(nonce: number): Promise<RelaySignedAuthorization> {
    const signed = await sign({ op: 'authorization', chainId, nonce });
    if (
      signed.op !== 'authorization' ||
      !sameHex(signed.authorization.address, chain.calibur.address) ||
      signed.authorization.chainId !== chainId ||
      signed.authorization.nonce !== nonce
    ) {
      throw new RelayMismatchError('relay: the backend signed another authorization');
    }
    return signed.authorization;
  }

  /** `GET /v1/relay/{id}`, and the check that the answer is the asked job. */
  async function readJob(ref: RelayJobRef): Promise<RelayJob> {
    const job = await fetchJob({ id: ref.id, chainId });
    assertRelayJobMatches(job, ref.id);
    return job;
  }

  /**
   * Reads the job until it is final. Resolves with the final hash of a succeeded job. Throws `RelayRevertedError`,
   * `RelayExpiredError`, `RelayStillPendingError` after the wait limit, and `RelayUnknownOutcomeError` when the relay
   * no longer knows the job.
   */
  async function followJob(ref: RelayJobRef, first: RelayJob): Promise<RelayResult> {
    const started = now();
    let current = first;
    let delay = RELAY_POLL_MS;
    for (;;) {
      switch (current.state) {
        case 'succeeded':
          return { id: ref.id, hash: current.txHash };
        case 'reverted':
          throw new RelayRevertedError(ref.id, current.txHash);
        case 'expired':
          throw new RelayExpiredError(ref.id, current.txHash);
        case 'pending':
          break;
      }
      if (now() - started >= RELAY_WAIT_MS) throw new RelayStillPendingError(ref, current.txHash);
      await sleep(delay);
      try {
        current = await readJob(ref);
        delay = RELAY_POLL_MS;
      } catch (error) {
        // The job is stored: a passing failure of a read does not end the wait.
        if (isNotFound(error)) throw new RelayUnknownOutcomeError(ref, error);
        if (relayErrorAction(error) !== 'wait') throw error;
        delay = Math.max(RELAY_POLL_MS, retryAfterMs(error));
      }
    }
  }

  /**
   * Waits until the open job of `busy` is final or gone. Then the address takes a new batch. When the job is still
   * pending after the wait limit, it throws the `busy` error: no batch of this submit was stored.
   */
  async function waitForOpenJob(id: Hex, busy: RelayApiError): Promise<void> {
    try {
      await followJob({ chainId, id, deadline: 0 }, { id, state: 'pending', txHash: zeroHash });
    } catch (error) {
      if (error instanceof RelayStillPendingError) throw busy;
      if (
        error instanceof RelayRevertedError ||
        error instanceof RelayExpiredError ||
        error instanceof RelayUnknownOutcomeError
      ) {
        return;
      }
      throw error;
    }
  }

  /** After a POST that did not prove a refusal: read the job. Found: follow it. Else the outcome is not known. */
  async function followUnknown(ref: RelayJobRef, cause: unknown): Promise<RelayResult> {
    let job: RelayJob;
    try {
      job = await readJob(ref);
    } catch {
      throw new RelayUnknownOutcomeError(ref, cause);
    }
    return followJob(ref, job);
  }

  /**
   * One attempt with an account that was just read: the guards, `beforeSign`, the signatures, `onJob`, the POST and
   * the wait. A POST that the relay refused throws `RefusedPost`.
   */
  async function attempt(
    calls: BatchCall[],
    account: RelayAccount,
    submitOptions: RelaySubmitOptions
  ): Promise<RelayResult> {
    assertRelayAccountMatches(account, chain, address);
    const batch = batchWithFee(calls, account, submitOptions.fee);
    if (batch.length > MAX_RELAY_BATCH_CALLS) throw new RelayRefusedError('too-many-calls');
    assertTargetsAllowed(calls, account.allowedTargets);
    if (submitOptions.beforeSign !== undefined) await submitOptions.beforeSign();
    const authorization = account.needsAuthorization ? await signAuthorization(account.authorizationNonce) : undefined;
    const deadline = Math.floor(now() / 1000) + RELAY_DEADLINE_SECONDS;
    const envelope: BatchEnvelope = {
      chainId,
      evmAddress: address,
      executor: chain.executor,
      batchNonce: batchNonceOf(account.sequence),
      salt: account.salt,
      deadline: BigInt(deadline)
    };
    const digest = batchDigest(chain.calibur, envelope, batch);
    const signed = await sign({
      op: 'batch',
      chainId,
      calls: batch.map(relayCallBody),
      batchNonce: envelope.batchNonce.toString(),
      salt: envelope.salt,
      deadline
    });
    if (signed.op !== 'batch' || !sameHex(signed.digest, digest)) {
      throw new RelayMismatchError('relay: the backend signed another batch');
    }
    const ref: RelayJobRef = { chainId, id: digest, deadline };
    if (submitOptions.onJob !== undefined) await submitOptions.onJob(ref);
    const submission: RelaySubmission = {
      chainId,
      evmAddress: address,
      calls: batch,
      batchNonce: envelope.batchNonce,
      salt: envelope.salt,
      deadline: envelope.deadline,
      signature: signed.signature
    };
    if (authorization !== undefined) submission.authorization = authorization;
    let job: RelayJob;
    try {
      job = await postRelay(submission);
      assertRelayJobMatches(job, digest);
    } catch (error) {
      // Only a refusal proves that the relay did not store the job. Else read it; never sign again.
      if (relaySubmitFailure(error) === 'unknown') return followUnknown(ref, error);
      if (error instanceof RelayApiError) throw new RefusedPost(error);
      throw error;
    }
    return followJob(ref, job);
  }

  /** A fresh account read for the `simulation_failed` check, or null when the read fails. */
  async function readAccountOrNull(): Promise<RelayAccount | null> {
    try {
      return await fetchAccount({ chainId, address });
    } catch {
      return null;
    }
  }

  /**
   * One relay with its bounded retries. Each retry reads the account, runs the guards and `beforeSign`, and signs a
   * new batch: after `stale_request`, after `simulation_failed` when the sequence changed, and once after `busy` when
   * the open job is final.
   */
  async function relay(calls: BatchCall[], submitOptions: RelaySubmitOptions): Promise<RelayResult> {
    let resignRetries = 0;
    let busyWaited = false;
    let account = await fetchAccount({ chainId, address });
    for (;;) {
      try {
        return await attempt(calls, account, submitOptions);
      } catch (error) {
        if (!(error instanceof RefusedPost)) throw error;
        const refusal = error.refusal;
        switch (refusal.code) {
          case 'stale_request':
            if (resignRetries >= MAX_STALE_RETRIES) throw refusal;
            resignRetries += 1;
            account = await fetchAccount({ chainId, address });
            break;
          case 'simulation_failed': {
            if (resignRetries >= MAX_STALE_RETRIES) throw refusal;
            // A new sequence means that another batch of the address landed: the batch can pass when signed again.
            const fresh = await readAccountOrNull();
            if (fresh === null || fresh.sequence === account.sequence) throw refusal;
            resignRetries += 1;
            account = fresh;
            break;
          }
          case 'busy':
            if (busyWaited || refusal.id === undefined) throw refusal;
            busyWaited = true;
            await waitForOpenJob(refusal.id, refusal);
            account = await fetchAccount({ chainId, address });
            break;
          default:
            throw refusal;
        }
      }
    }
  }

  // One relay at a time per submitter: two batches of one address would read the same sequence.
  let queue: Promise<unknown> = Promise.resolve();
  function submit(calls: BatchCall[], submitOptions: RelaySubmitOptions = {}): Promise<RelayResult> {
    const run = async (): Promise<RelayResult> => {
      if (calls.length === 0) throw new TypeError('relay submitter: a batch needs a call');
      const checked = calls.map(checkedCall);
      const fee = submitOptions.fee;
      const reviewed = fee === undefined ? undefined : { token: relayFeeToken(fee.token), amount: fee.amount };
      return relay(checked, { ...submitOptions, fee: reviewed });
    };
    const result = queue.then(run, run).catch((error: unknown) => {
      // A flow that cannot read the typed error (a library that drops the cause) reads the open job from a watch.
      const open = openRelayJobError(error);
      if (open !== undefined) reportOpenRelayJob(address, open.job);
      throw error;
    });
    queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Reads the job by id once. Found: its state and hash. Not found: `unknown` until `RELAY_RESUME_GRACE_SECONDS`
   * after the deadline, then `not-submitted`. Any other failed read, an answer for another job included: `unknown`.
   */
  async function check(job: RelayJobRef): Promise<RelayJobCheck> {
    const ref = checkedRef(job);
    let current: RelayJob;
    try {
      current = await readJob(ref);
    } catch (error) {
      if (isNotFound(error) && now() / 1000 > ref.deadline + RELAY_RESUME_GRACE_SECONDS) {
        return { state: 'not-submitted' };
      }
      return { state: 'unknown', cause: error };
    }
    return { state: current.state, hash: current.txHash };
  }

  /**
   * Reads the job by id (`check`). Found: follows it to a final state. Not found: `RelayUnknownOutcomeError` until
   * `RELAY_RESUME_GRACE_SECONDS` after the deadline, then `RelayNotSubmittedError`. Any other failed read:
   * `RelayUnknownOutcomeError`.
   */
  async function resume(job: RelayJobRef): Promise<RelayResult> {
    const ref = checkedRef(job);
    const checked = await check(ref);
    switch (checked.state) {
      case 'unknown':
        throw new RelayUnknownOutcomeError(ref, checked.cause);
      case 'not-submitted':
        throw new RelayNotSubmittedError(ref);
      default:
        return followJob(ref, { id: ref.id, state: checked.state, txHash: checked.hash });
    }
  }

  return { chainId, address, submit, resume, check };
}

/**
 * The relay deposit engine: one step ("tick") of a deposit-address bridge-in for one account, chain and token. The
 * caller decides when to tick. A tick first finishes a signed submission that the service may have accepted, then
 * follows an open relay job, and else reads the relay address and, when a deposit is relayable, signs and sends it.
 *
 * The service is untrusted: the guards in `guards.ts` check its answers, and the wallet computes the batch digest
 * itself. The relay job becomes a `bridged-receive` row with the shape of a WalletConnect Agglayer deposit row, so
 * the existing Agglayer tracking (`lib/miden/activity/bridge-receive.ts`, then the claim on Miden) takes over.
 * Every dependency is injected, so the engine has no I/O of its own.
 */
import { formatUnits, type Address, type Hex } from 'viem';

import type { IBridgedReceivePhase, IBridgedReceiveRelay } from 'lib/miden/db/types';
import type { RelayChainConfig } from 'lib/remote-config/schema';
import type { RelaySignRequest, RelaySignResult } from 'lib/shared/types';
import type { BridgeReceiveFailureSource } from 'lib/telemetry/bridge-receive-failure';
import { EvmTransactionRevertedError } from 'lib/walletconnect/receipt';

import { batchDigest, batchNonceOf, buildRelayCalls, type RelayFee } from './batch';
import { relaySubmissionBody } from './client';
import type { RelayDepositRoute } from './deposit-route';
import type { RelayRowRef } from './deposit-rows';
import {
  readPendingSubmission,
  relayPendingKey,
  type RelayPendingSubmission,
  type RelayRowDraft
} from './deposit-store';
import { RelayApiError, RelayMismatchError, RelayUnavailableError, relayErrorAction } from './errors';
import { acceptedFee, assertRelayAccountMatches, assertRelayJobMatches, relayableAmount } from './guards';
import type { RelayAccount, RelayAuthorization, RelayJob, RelaySubmission } from './types';

/** The service keeps a job for 24 hours. After that, a row whose job it does not know follows its hash alone. */
export const RELAY_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
/** The deadline of a signed batch, from the time it is signed. */
export const RELAY_DEADLINE_SECONDS = 60 * 60;

/** What the user chose when they opened the deposit address. `token` is the zero address for the native coin. */
export interface RelayDepositTarget {
  provider: 'agglayer';
  chainId: number;
  token: string;
}

/**
 * The result of a tick. JSON-safe: amounts are decimal strings in source base units, `retryAfter` is in seconds.
 * - `off`: the relay is off or does not serve the chain. `no-relay-address`: the account has no relay key.
 *   `no-route`: the chain has no Agglayer receive route for the token. `unsupported`: the relay does not list the
 *   token or does not serve the deposit kind on the chain. `busy`: a tick for another token of the chain is running.
 * - `no-deposit`, `below-minimum`, `fee-refused`: nothing is relayable.
 * - `sending`: a signed deposit waits for the service to accept it.
 * - `relay-pending`: the service submitted the deposit and waits for it to be mined. `bridging`: it is mined, and the
 *   Agglayer tracking of the row follows it.
 * - `waiting`: the service asks for a wait. `failed`: the tick stopped; `code` says why.
 */
export type RelayDepositStatus =
  | { kind: 'off' }
  | { kind: 'no-relay-address' }
  | { kind: 'no-route' }
  | { kind: 'unsupported'; reason: 'token' | 'kind' }
  | { kind: 'busy' }
  | { kind: 'no-deposit' }
  | { kind: 'below-minimum'; balance: string; minimum: string }
  | { kind: 'fee-refused'; balance: string; fee: string }
  | { kind: 'sending'; retryAfter?: number }
  | { kind: 'relay-pending'; rowId: string }
  | { kind: 'bridging'; rowId: string }
  | { kind: 'waiting'; code: string; retryAfter?: number }
  | { kind: 'failed'; code: string; rowId?: string };

/** The fields a tick writes on a row; `updateBridgedReceivePhase` takes them. */
export interface RelayRowWrite {
  relay: IBridgedReceiveRelay;
  evmTxHash?: string;
  error?: string;
  errorId?: 'raw_bridge_deposit_failed';
  failure?: BridgeReceiveFailureSource;
}

export interface RelayDepositDeps {
  /** Hydrates this realm's bridge config from storage. */
  initConfig(): Promise<void>;
  relayChain(chainId: number): RelayChainConfig | null;
  route(chainId: number, token: Address): RelayDepositRoute | null;
  /** The stored account of `accountPublicKey`, or null when there is none. */
  account(accountPublicKey: string): Promise<{ publicKey: string; relayEvmAddress?: string } | null>;
  /** The Miden account id as `0x` and 30 hex characters. */
  midenAccountHex(publicKey: string): Promise<string>;
  fetchAccount(chainId: number, address: Address): Promise<RelayAccount>;
  submit(request: RelaySubmission): Promise<RelayJob>;
  fetchJob(id: Hex): Promise<RelayJob>;
  sign(accountPublicKey: string, request: RelaySignRequest): Promise<RelaySignResult>;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: RelayPendingSubmission): Promise<void>;
    remove(key: string): Promise<void>;
  };
  rows: {
    open(accountId: string, chainId: number): Promise<RelayRowRef[]>;
    create(draft: RelayRowDraft, relay: IBridgedReceiveRelay): Promise<string>;
    write(id: string, phase: IBridgedReceivePhase, fields: RelayRowWrite): Promise<void>;
  };
  chainName(chainId: number): string;
  nowMs(): number;
}

/** The backend refused to sign. */
class RelaySignFailedError extends Error {
  constructor(cause: unknown) {
    super('relay: the backend refused to sign', { cause });
    this.name = 'RelaySignFailedError';
  }
}

interface Tick {
  deps: RelayDepositDeps;
  chain: RelayChainConfig;
  chainId: number;
  token: Address;
  route: RelayDepositRoute;
  /** The stored public key of the account. */
  accountId: string;
  relayAddress: Address;
  pendingKey: string;
}

function evmAddress(value: string): Address | null {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? `0x${value.slice(2).toLowerCase()}` : null;
}

function jobId(value: string): Hex | null {
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? `0x${value.slice(2).toLowerCase()}` : null;
}

function codeOf(error: unknown): string {
  if (error instanceof RelayApiError) return error.code;
  if (error instanceof RelayUnavailableError) return error.reason;
  if (error instanceof RelayMismatchError) return 'mismatch';
  if (error instanceof RelaySignFailedError) return 'sign-refused';
  return 'unexpected';
}

function retryOf(error: unknown): { retryAfter?: number } {
  return error instanceof RelayApiError && error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {};
}

/** Step 9: what a failure means for the next tick. */
function statusOfError(error: unknown): RelayDepositStatus {
  if (codeOf(error) === 'unexpected') console.warn('[relay-deposit] tick failed', error);
  switch (relayErrorAction(error)) {
    case 'wait':
      return { kind: 'waiting', code: codeOf(error), ...retryOf(error) };
    case 'sign-again':
      return { kind: 'waiting', code: codeOf(error) };
    default:
      return { kind: 'failed', code: codeOf(error) };
  }
}

function nowSeconds(t: Tick): number {
  return Math.floor(t.deps.nowMs() / 1000);
}

/** The submission of a stored body. `relaySubmissionBody` of the result is the stored body again. */
function submissionOf(record: RelayPendingSubmission): RelaySubmission {
  const { body, feeRecipient } = record;
  const feeAmount = BigInt(body.params.fee);
  let fee: RelayFee | null = null;
  if (feeAmount !== 0n) {
    if (feeRecipient === null) throw new Error('relay: the stored submission has a fee and no fee recipient');
    fee = { recipient: feeRecipient, amount: feeAmount };
  }
  return {
    chainId: body.chainId,
    kind: body.kind,
    evmAddress: body.evmAddress,
    params: { ...body.params, amount: BigInt(body.params.amount), fee },
    batchNonce: BigInt(body.batchNonce),
    salt: body.salt,
    deadline: BigInt(body.deadline),
    signature: body.signature,
    ...(body.authorization ? { authorization: body.authorization } : {})
  };
}

/** A failed send of a stored submission. The record stays unless the service refused the request itself. */
async function sendFailure(t: Tick, error: unknown): Promise<RelayDepositStatus> {
  if (relayErrorAction(error) === 'wait') return { kind: 'sending', ...retryOf(error) };
  // A mismatch or a local failure can follow an accepted job: the record stays, so a later tick repairs the row.
  if (error instanceof RelayApiError) await t.deps.storage.remove(t.pendingKey);
  return statusOfError(error);
}

/** Step 4: the state of a job, written on its row. `known` is a job the caller already read. */
async function followJob(t: Tick, row: RelayRowRef, known?: RelayJob): Promise<RelayDepositStatus> {
  let job = known;
  if (!job) {
    const id = jobId(row.relay.jobId);
    if (!id) return { kind: 'failed', code: 'bad-row', rowId: row.id };
    try {
      job = await t.deps.fetchJob(id);
    } catch (error) {
      if (!(error instanceof RelayApiError) || error.code !== 'not_found') throw error;
      // The service keeps a job for 24 hours. A younger job it does not know can be a passing fault, so the tick asks
      // again; an older one is gone, and the Agglayer tracking follows the row by its recorded hash alone.
      if (t.deps.nowMs() - row.initiatedAt * 1000 < RELAY_JOB_RETENTION_MS) {
        return { kind: 'relay-pending', rowId: row.id };
      }
      await t.deps.rows.write(row.id, row.phase, { relay: { ...row.relay, state: 'expired' } });
      return { kind: 'bridging', rowId: row.id };
    }
    assertRelayJobMatches(job, id);
  }
  const relay: IBridgedReceiveRelay = { ...row.relay, txHash: job.txHash };
  switch (job.state) {
    case 'pending':
      // The relayer can replace its transaction; the row follows the newest hash.
      if (job.txHash !== row.evmTxHash) await t.deps.rows.write(row.id, row.phase, { relay, evmTxHash: job.txHash });
      return { kind: 'relay-pending', rowId: row.id };
    case 'succeeded':
      // The phase a WalletConnect Agglayer row takes once its source receipt succeeds.
      await t.deps.rows.write(row.id, 'delivering', {
        relay: { ...relay, state: 'succeeded' },
        evmTxHash: job.txHash
      });
      return { kind: 'bridging', rowId: row.id };
    default: {
      const revert = new EvmTransactionRevertedError(t.deps.chainName(t.chainId));
      await t.deps.rows.write(row.id, 'failed', {
        relay: { ...relay, state: 'reverted' },
        evmTxHash: job.txHash,
        error: revert.message,
        errorId: 'raw_bridge_deposit_failed',
        failure: { step: 'deposit_receipt', cause: revert }
      });
      return { kind: 'failed', code: 'reverted', rowId: row.id };
    }
  }
}

/** Step 8: the row of an accepted job, written once per job id, then the record goes. */
async function acceptJob(t: Tick, record: RelayPendingSubmission, job: RelayJob): Promise<RelayDepositStatus> {
  assertRelayJobMatches(job, record.digest);
  const relay: IBridgedReceiveRelay = {
    jobId: record.digest,
    chainId: record.body.chainId,
    kind: 'agglayer-deposit',
    token: record.row.token,
    state: 'pending',
    txHash: job.txHash
  };
  const rowId = await t.deps.rows.create(record.row, relay);
  await t.deps.storage.remove(t.pendingKey);
  const row = (await t.deps.rows.open(t.accountId, t.chainId)).find(open => open.id === rowId);
  // A row that the tracking has already moved past `delivering` needs nothing more from the job.
  if (!row) return { kind: 'bridging', rowId };
  return row.relay.state === 'pending' ? followJob(t, row, job) : { kind: 'bridging', rowId };
}

/**
 * A stored submission that cannot be sent again (its deadline passed, or the service asks to sign again). The job id
 * is the digest, so a job the service accepted is still found and gets its row. Null when the service knows no job:
 * the record goes, and the tick reads the address again.
 */
async function retirePending(t: Tick, record: RelayPendingSubmission): Promise<RelayDepositStatus | null> {
  try {
    return await acceptJob(t, record, await t.deps.fetchJob(record.digest));
  } catch (error) {
    if (!(error instanceof RelayApiError) || error.code !== 'not_found') throw error;
  }
  await t.deps.storage.remove(t.pendingKey);
  return null;
}

/** Step 3: a stored submission comes first. Null when there is none left, so the tick goes on. */
async function resumePending(t: Tick): Promise<RelayDepositStatus | null> {
  const stored = await t.deps.storage.get(t.pendingKey);
  if (stored === undefined || stored === null) return null;
  const record = readPendingSubmission(stored);
  if (!record) {
    console.warn('[relay-deposit] dropping a pending submission that does not read back');
    await t.deps.storage.remove(t.pendingKey);
    return null;
  }
  try {
    if (record.body.deadline > nowSeconds(t)) {
      try {
        // The service answers the same request with the same job.
        return await acceptJob(t, record, await t.deps.submit(submissionOf(record)));
      } catch (error) {
        if (relayErrorAction(error) !== 'sign-again') return await sendFailure(t, error);
      }
    }
    return await retirePending(t, record);
  } catch (error) {
    return sendFailure(t, error);
  }
}

function feeOf(account: RelayAccount, fee: bigint): RelayFee | null {
  return account.mode === 'deduct' && account.feeRecipient !== null
    ? { recipient: account.feeRecipient, amount: fee }
    : null;
}

async function signed(t: Tick, request: RelaySignRequest): Promise<RelaySignResult> {
  try {
    return await t.deps.sign(t.accountId, request);
  } catch (error) {
    throw new RelaySignFailedError(error);
  }
}

/** Steps 6 to 8: sign the full relayable balance, store the submission, then send it. */
async function signAndSend(
  t: Tick,
  account: RelayAccount,
  sequence: bigint,
  amount: bigint,
  feeAmount: bigint
): Promise<RelayDepositStatus> {
  const { chainId, token, route } = t;
  const fee = feeOf(account, feeAmount);
  const batchNonce = batchNonceOf('agglayer-deposit', sequence);
  const deadline = nowSeconds(t) + RELAY_DEADLINE_SECONDS;
  const midenAccountHex = await t.deps.midenAccountHex(t.accountId);

  let authorization: RelayAuthorization | undefined;
  if (account.needsAuthorization) {
    const result = await signed(t, { op: 'authorization', chainId, nonce: account.authorizationNonce });
    if (
      result.op !== 'authorization' ||
      result.authorization.address.toLowerCase() !== t.chain.calibur.address.toLowerCase() ||
      result.authorization.chainId !== chainId ||
      result.authorization.nonce !== account.authorizationNonce
    )
      return { kind: 'failed', code: 'authorization-mismatch' };
    authorization = result.authorization;
  }
  const result = await signed(t, {
    op: 'batch',
    chainId,
    kind: 'agglayer-deposit',
    params: {
      token,
      amount: amount.toString(),
      fee: fee && { recipient: fee.recipient, amount: fee.amount.toString() }
    },
    batchNonce: batchNonce.toString(),
    salt: account.salt,
    deadline
  });
  const envelope = {
    chainId,
    evmAddress: t.relayAddress,
    executor: t.chain.executor,
    batchNonce,
    salt: account.salt,
    deadline: BigInt(deadline)
  };
  const params = { token, amount, midenAccountHex, fee };
  const digest = batchDigest(t.chain.calibur, envelope, buildRelayCalls('agglayer-deposit', route.deposit, params));
  if (result.op !== 'batch' || result.digest.toLowerCase() !== digest)
    return { kind: 'failed', code: 'digest-mismatch' };

  const submission: RelaySubmission = {
    chainId,
    kind: 'agglayer-deposit',
    evmAddress: t.relayAddress,
    params,
    batchNonce,
    salt: account.salt,
    deadline: BigInt(deadline),
    signature: result.signature,
    ...(authorization ? { authorization } : {})
  };
  const scale = 10n ** BigInt(Math.max(0, route.sourceDecimals - route.outputDecimals));
  const row: RelayRowDraft = {
    accountId: t.accountId,
    sourceAddress: t.relayAddress,
    chainId,
    token,
    amount: amount.toString(),
    sourceAmount: formatUnits(amount, route.sourceDecimals),
    sourceSymbol: route.sourceSymbol,
    outputAmount: formatUnits(amount / scale, route.outputDecimals),
    outputSymbol: route.outputSymbol,
    agglayerRoute: route.agglayerRoute,
    ...(route.agglayerDelivery ? { agglayerDelivery: route.agglayerDelivery } : {})
  };
  const record: RelayPendingSubmission = {
    body: relaySubmissionBody(submission),
    feeRecipient: fee?.recipient ?? null,
    digest,
    row
  };
  // Stored before the network call: a crash after the service accepted it is repaired by step 3.
  await t.deps.storage.set(t.pendingKey, record);
  let job: RelayJob;
  try {
    job = await t.deps.submit(submission);
  } catch (error) {
    if (relayErrorAction(error) !== 'sign-again') return sendFailure(t, error);
    return (await retirePending(t, record)) ?? { kind: 'waiting', code: codeOf(error) };
  }
  return acceptJob(t, record, job);
}

/** Step 5: read the relay address and decide what is relayable. */
async function readAndSend(t: Tick, open: RelayRowRef[]): Promise<RelayDepositStatus> {
  const account = await t.deps.fetchAccount(t.chainId, t.relayAddress);
  assertRelayAccountMatches(account, t.chain, t.relayAddress);
  const entry = account.balances.find(balance => balance.token.toLowerCase() === t.token);
  if (!entry) return { kind: 'unsupported', reason: 'token' };
  const kind = account.kinds['agglayer-deposit'];
  if (!kind) return { kind: 'unsupported', reason: 'kind' };
  if (entry.balance === 0n) {
    const bridging = open.find(row => row.relay.token === t.token);
    return bridging ? { kind: 'bridging', rowId: bridging.id } : { kind: 'no-deposit' };
  }
  const fee = acceptedFee(account, t.chain, t.token);
  if (fee === null) return { kind: 'fee-refused', balance: entry.balance.toString(), fee: entry.fee.toString() };
  const amount = relayableAmount(entry, fee);
  if (amount === null) {
    return { kind: 'below-minimum', balance: entry.balance.toString(), minimum: entry.minAmount.toString() };
  }
  return signAndSend(t, account, kind.sequence, amount, fee);
}

async function runTick(
  deps: RelayDepositDeps,
  accountPublicKey: string,
  chainId: number,
  token: Address
): Promise<RelayDepositStatus> {
  try {
    // Step 1. A tick can run before this realm hydrated its config; this never waits for the network.
    await deps.initConfig();
    const chain = deps.relayChain(chainId);
    if (!chain) return { kind: 'off' };
    const account = await deps.account(accountPublicKey);
    const relayAddress = account?.relayEvmAddress === undefined ? null : evmAddress(account.relayEvmAddress);
    if (!account || !relayAddress) return { kind: 'no-relay-address' };
    const route = deps.route(chainId, token);
    if (!route) return { kind: 'no-route' };
    const pendingKey = relayPendingKey(account.publicKey, chainId);
    const t: Tick = { deps, chain, chainId, token, route, accountId: account.publicKey, relayAddress, pendingKey };

    const resumed = await resumePending(t);
    if (resumed) return resumed;
    const open = await deps.rows.open(t.accountId, chainId);
    const pending = open.find(row => row.relay.state === 'pending');
    if (pending) return await followJob(t, pending);
    return await readAndSend(t, open);
  } catch (error) {
    return statusOfError(error);
  }
}

/**
 * The tick of one realm. Step 2: one tick at a time per account and chain. A second call for the same token gets the
 * running tick's result; a call for another token of the chain gets `busy`.
 */
export function createRelayDepositEngine(deps: RelayDepositDeps) {
  const running = new Map<string, { token: Address; tick: Promise<RelayDepositStatus> }>();
  return function relayDepositTick(accountPublicKey: string, target: RelayDepositTarget): Promise<RelayDepositStatus> {
    const token = evmAddress(target.token);
    if (target.provider !== 'agglayer' || !token) return Promise.resolve({ kind: 'no-route' });
    const key = `${accountPublicKey}:${target.chainId}`;
    const current = running.get(key);
    if (current) return current.token === token ? current.tick : Promise.resolve({ kind: 'busy' });
    const tick = runTick(deps, accountPublicKey, target.chainId, token).finally(() => running.delete(key));
    running.set(key, { token, tick });
    return tick;
  };
}

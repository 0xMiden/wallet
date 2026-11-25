import { parseSignature, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { IBridgedReceivePhase, IBridgedReceiveRelay } from 'lib/miden/db/types';
import { planRelaySignature } from 'lib/miden/relay-key/sign-rules';
import type { RelayChainConfig } from 'lib/remote-config/schema';
import type { RelaySignRequest, RelaySignResult } from 'lib/shared/types';

import { batchDigest, buildRelayCalls } from './batch';
import {
  SEPOLIA_AGGLAYER_CONFIG,
  SEPOLIA_CALIBUR_PIN,
  TEST_ERC20,
  TEST_EXECUTOR,
  TEST_FEE_RECIPIENT,
  TEST_MIDEN_ACCOUNT_HEX
} from './batch/testing';
import { relaySubmissionBody } from './client';
import {
  createRelayDepositEngine,
  RELAY_DEADLINE_SECONDS,
  type RelayDepositDeps,
  type RelayDepositStatus,
  type RelayDepositTarget,
  type RelayRowWrite
} from './deposit';
import type { RelayDepositRoute } from './deposit-route';
import type { RelayRowRef } from './deposit-rows';
import { readPendingSubmission, relayPendingKey, type RelayRowDraft } from './deposit-store';
import { RelayApiError, RelayUnavailableError } from './errors';
import type { RelayAccount, RelayJob, RelaySubmission } from './types';

const CHAIN_ID = 11155111;
const START_MS = 1_800_000_000_000;
const ACCOUNT = 'mtst1account';
// Hardhat key #0 stands in for the relay key.
const relayKey = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const RELAY_ADDRESS: Address = `0x${relayKey.address.slice(2).toLowerCase()}`;
const CALIBUR: Address = `0x${SEPOLIA_CALIBUR_PIN.address.slice(2).toLowerCase()}`;
const SALT: Hex = `0x${'0'.repeat(24)}${CALIBUR.slice(2)}`;
const TX1: Hex = `0x${'71'.repeat(32)}`;
const TX2: Hex = `0x${'72'.repeat(32)}`;

const CHAIN: RelayChainConfig = {
  key: 'sepolia',
  chainId: CHAIN_ID,
  executor: TEST_EXECUTOR,
  calibur: { ...SEPOLIA_CALIBUR_PIN, address: CALIBUR },
  maxFee: { [TEST_ERC20]: '1000' }
};

const ROUTE: RelayDepositRoute = {
  agglayerRoute: {
    chainId: CHAIN_ID,
    contractAddress: SEPOLIA_AGGLAYER_CONFIG.bridgeAddress,
    midenBridgeId: 'mtst1bridge',
    indexerUrl: 'https://indexer.example',
    rollupId: SEPOLIA_AGGLAYER_CONFIG.midenNetworkId,
    evmNetworkId: 0
  },
  agglayerDelivery: { originToken: TEST_ERC20, faucetId: '0xfaucet', scale: 0 },
  sourceSymbol: 'USDC',
  sourceDecimals: 6,
  outputSymbol: 'USDC',
  outputDecimals: 6,
  deposit: SEPOLIA_AGGLAYER_CONFIG
};

function relayAccount(overrides: Partial<RelayAccount> = {}): RelayAccount {
  return {
    chainId: CHAIN_ID,
    address: RELAY_ADDRESS,
    mode: 'sponsor',
    executor: TEST_EXECUTOR,
    feeRecipient: null,
    needsAuthorization: false,
    authorizationNonce: 4,
    salt: SALT,
    kinds: { 'agglayer-deposit': { sequence: 2n } },
    balances: [{ token: TEST_ERC20, balance: 2_500_000n, minAmount: 100_000n, fee: 0n }],
    ...overrides
  };
}

const DEDUCT: Partial<RelayAccount> = {
  mode: 'deduct',
  feeRecipient: TEST_FEE_RECIPIENT,
  balances: [{ token: TEST_ERC20, balance: 2_500_000n, minAmount: 100_000n, fee: 1000n }]
};

/** The digest the service computes again from a submission's parameters. */
function serviceDigest(request: RelaySubmission): Hex {
  const envelope = {
    chainId: request.chainId,
    evmAddress: request.evmAddress,
    executor: CHAIN.executor,
    batchNonce: request.batchNonce,
    salt: request.salt,
    deadline: request.deadline
  };
  return batchDigest(
    CHAIN.calibur,
    envelope,
    buildRelayCalls('agglayer-deposit', SEPOLIA_AGGLAYER_CONFIG, request.params)
  );
}

interface FakeRow extends RelayRowRef {
  draft: RelayRowDraft;
  error?: string;
  errorId?: string;
}

function harness() {
  const clock = { now: START_MS };
  const storage = new Map<string, unknown>();
  const rows = new Map<string, FakeRow>();
  const jobs = new Map<string, RelayJob>();
  /** Bodies the service received, in order. */
  const bodies: string[] = [];
  const service = { account: relayAccount(), jobTxHash: TX1, bodies };

  const sign = jest.fn(async (_pk: string, request: RelaySignRequest): Promise<RelaySignResult> => {
    const plan = planRelaySignature(request, {
      midenAccountHex: TEST_MIDEN_ACCOUNT_HEX,
      relayAddress: RELAY_ADDRESS,
      chain: CHAIN,
      agglayer: SEPOLIA_AGGLAYER_CONFIG,
      nowSeconds: Math.floor(clock.now / 1000)
    });
    const signature = await relayKey.sign({ hash: plan.digest });
    switch (plan.op) {
      case 'authorization': {
        const { r, s, yParity } = parseSignature(signature);
        return { op: 'authorization', authorization: { ...plan.authorization, r, s, yParity: yParity === 1 ? 1 : 0 } };
      }
      default:
        return { op: 'batch', digest: plan.digest, signature };
    }
  });
  const submit = jest.fn(async (request: RelaySubmission): Promise<RelayJob> => {
    service.bodies.push(JSON.stringify(relaySubmissionBody(request)));
    const id = serviceDigest(request);
    const job = jobs.get(id) ?? { id, state: 'pending', txHash: service.jobTxHash };
    jobs.set(id, job);
    return job;
  });
  const fetchJob = jest.fn(async (id: Hex): Promise<RelayJob> => {
    const job = jobs.get(id);
    if (!job) throw new RelayApiError('not_found', 404, 'The relay does not exist');
    return job;
  });
  const fetchAccount = jest.fn(async (_chainId: number, _address: Address) => service.account);
  let rowCount = 0;

  const deps: RelayDepositDeps = {
    initConfig: async () => undefined,
    relayChain: chainId => (chainId === CHAIN_ID ? CHAIN : null),
    route: (chainId, token) => (chainId === CHAIN_ID && token === TEST_ERC20 ? ROUTE : null),
    account: async publicKey => (publicKey === ACCOUNT ? { publicKey, relayEvmAddress: relayKey.address } : null),
    midenAccountHex: async () => TEST_MIDEN_ACCOUNT_HEX,
    fetchAccount,
    submit,
    fetchJob,
    sign,
    storage: {
      get: async key => storage.get(key),
      // Storage keeps JSON, so a value goes in and out as JSON.
      set: async (key, value) => {
        storage.set(key, JSON.parse(JSON.stringify(value)));
      },
      remove: async key => {
        storage.delete(key);
      }
    },
    rows: {
      open: async (_accountId, chainId) =>
        [...rows.values()]
          .filter(row => row.relay.chainId === chainId && (row.phase === 'submitting' || row.phase === 'delivering'))
          .map(({ id, phase, initiatedAt, evmTxHash, relay }) => ({ id, phase, initiatedAt, evmTxHash, relay })),
      create: async (draft: RelayRowDraft, relay: IBridgedReceiveRelay) => {
        const existing = [...rows.values()].find(row => row.relay.jobId === relay.jobId);
        if (existing) return existing.id;
        rowCount += 1;
        const id = `row-${rowCount}`;
        const initiatedAt = Math.floor(clock.now / 1000);
        rows.set(id, { id, phase: 'submitting', initiatedAt, evmTxHash: relay.txHash, relay, draft });
        return id;
      },
      write: async (id: string, phase: IBridgedReceivePhase, fields: RelayRowWrite) => {
        const row = rows.get(id);
        if (!row) return;
        rows.set(id, {
          ...row,
          phase,
          relay: fields.relay,
          ...(fields.evmTxHash ? { evmTxHash: fields.evmTxHash } : {}),
          ...(fields.error ? { error: fields.error, errorId: fields.errorId } : {})
        });
      }
    },
    chainName: () => 'Sepolia',
    nowMs: () => clock.now
  };
  const tick = createRelayDepositEngine(deps);
  const run = (token: string = TEST_ERC20) => tick(ACCOUNT, { provider: 'agglayer', chainId: CHAIN_ID, token });
  const pendingKey = relayPendingKey(ACCOUNT, CHAIN_ID);
  const pending = () => readPendingSubmission(storage.get(pendingKey));
  const onlyRow = () => {
    expect(rows.size).toBe(1);
    const [row] = [...rows.values()];
    if (!row) throw new Error('no row');
    return row;
  };
  return { clock, storage, rows, jobs, service, deps, sign, submit, fetchJob, fetchAccount, run, pending, onlyRow };
}

function lastSubmission(submit: jest.Mock<Promise<RelayJob>, [RelaySubmission]>): RelaySubmission {
  const call = submit.mock.calls.at(-1);
  if (!call) throw new Error('nothing was submitted');
  return call[0];
}

describe('relay deposit engine', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('preconditions', () => {
    it('is off while the relay does not serve the chain', async () => {
      const h = harness();
      h.deps.relayChain = () => null;
      const tick = createRelayDepositEngine(h.deps);
      expect(await tick(ACCOUNT, { provider: 'agglayer', chainId: CHAIN_ID, token: TEST_ERC20 })).toEqual({
        kind: 'off'
      });
      expect(h.fetchAccount).not.toHaveBeenCalled();
    });

    it('needs an account with a relay address', async () => {
      const h = harness();
      h.deps.account = async publicKey => ({ publicKey });
      const tick = createRelayDepositEngine(h.deps);
      expect(await tick(ACCOUNT, { provider: 'agglayer', chainId: CHAIN_ID, token: TEST_ERC20 })).toEqual({
        kind: 'no-relay-address'
      });
      expect(await tick('mtst1other', { provider: 'agglayer', chainId: CHAIN_ID, token: TEST_ERC20 })).toEqual({
        kind: 'no-relay-address'
      });
    });

    it('needs an Agglayer receive route for the token', async () => {
      const h = harness();
      expect(await h.run(zeroAddress)).toEqual({ kind: 'no-route' });
      expect(await h.run('not an address')).toEqual({ kind: 'no-route' });
      expect(h.fetchAccount).not.toHaveBeenCalled();
    });

    it('reports a token the relay does not list and a kind it does not serve', async () => {
      const h = harness();
      h.service.account = relayAccount({ balances: [] });
      expect(await h.run()).toEqual({ kind: 'unsupported', reason: 'token' });
      h.service.account = relayAccount({ kinds: {} });
      expect(await h.run()).toEqual({ kind: 'unsupported', reason: 'kind' });
      expect(h.sign).not.toHaveBeenCalled();
    });

    it('reports no deposit and a deposit below the minimum', async () => {
      const h = harness();
      h.service.account = relayAccount({
        balances: [{ token: TEST_ERC20, balance: 0n, minAmount: 100_000n, fee: 0n }]
      });
      expect(await h.run()).toEqual({ kind: 'no-deposit' });
      h.service.account = relayAccount({
        balances: [{ token: TEST_ERC20, balance: 99_999n, minAmount: 100_000n, fee: 0n }]
      });
      expect(await h.run()).toEqual({ kind: 'below-minimum', balance: '99999', minimum: '100000' });
      expect(h.sign).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('relays the full balance in sponsor mode and writes one row for the job', async () => {
      const h = harness();
      const status = await h.run();

      const row = h.onlyRow();
      expect(status).toEqual({ kind: 'relay-pending', rowId: row.id });
      expect(h.sign).toHaveBeenCalledTimes(1);
      const submission = lastSubmission(h.submit);
      expect(submission.params).toEqual({
        token: TEST_ERC20,
        amount: 2_500_000n,
        midenAccountHex: TEST_MIDEN_ACCOUNT_HEX,
        fee: null
      });
      expect(submission.authorization).toBeUndefined();
      expect(submission.deadline).toBe(BigInt(START_MS / 1000 + RELAY_DEADLINE_SECONDS));
      expect(row.phase).toBe('submitting');
      expect(row.evmTxHash).toBe(TX1);
      expect(row.relay).toEqual({
        jobId: serviceDigest(submission),
        chainId: CHAIN_ID,
        kind: 'agglayer-deposit',
        token: TEST_ERC20,
        state: 'pending',
        txHash: TX1
      });
      expect(row.draft).toEqual({
        accountId: ACCOUNT,
        sourceAddress: RELAY_ADDRESS,
        chainId: CHAIN_ID,
        token: TEST_ERC20,
        amount: '2500000',
        sourceAmount: '2.5',
        sourceSymbol: 'USDC',
        outputAmount: '2.5',
        outputSymbol: 'USDC',
        agglayerRoute: ROUTE.agglayerRoute,
        agglayerDelivery: ROUTE.agglayerDelivery
      });
      expect(h.pending()).toBeNull();
    });

    it('signs an authorization first while the address does not delegate', async () => {
      const h = harness();
      h.service.account = relayAccount({ needsAuthorization: true });
      await h.run();

      expect(h.sign.mock.calls.map(([, request]) => request.op)).toEqual(['authorization', 'batch']);
      expect(h.sign.mock.calls[0]?.[1]).toEqual({ op: 'authorization', chainId: CHAIN_ID, nonce: 4 });
      expect(lastSubmission(h.submit).authorization).toEqual(
        expect.objectContaining({ address: CALIBUR, chainId: CHAIN_ID, nonce: 4 })
      );
      h.onlyRow();
    });

    it('pays the fee in deduct mode and bridges the rest', async () => {
      const h = harness();
      h.service.account = relayAccount({ ...DEDUCT, needsAuthorization: true });
      await h.run();

      const submission = lastSubmission(h.submit);
      expect(submission.params.amount).toBe(2_499_000n);
      expect(submission.params.fee).toEqual({ recipient: TEST_FEE_RECIPIENT, amount: 1000n });
      expect(submission.authorization).toBeDefined();
      expect(h.onlyRow().draft.amount).toBe('2499000');
    });

    it('stops when the signed digest is not the one the wallet computes', async () => {
      const h = harness();
      h.sign.mockImplementationOnce(async () => ({ op: 'batch', digest: `0x${'99'.repeat(32)}`, signature: '0x01' }));
      expect(await h.run()).toEqual({ kind: 'failed', code: 'digest-mismatch' });
      expect(h.submit).not.toHaveBeenCalled();
      expect(h.pending()).toBeNull();
    });

    it('reports a refused signature', async () => {
      const h = harness();
      h.sign.mockRejectedValueOnce(new Error('Relay signature refused: deadline'));
      expect(await h.run()).toEqual({ kind: 'failed', code: 'sign-refused' });
      expect(h.submit).not.toHaveBeenCalled();
    });
  });

  describe('guards', () => {
    it('refuses an account whose executor is not the configured one', async () => {
      const h = harness();
      h.service.account = relayAccount({ executor: TEST_FEE_RECIPIENT });
      expect(await h.run()).toEqual({ kind: 'failed', code: 'mismatch' });
      expect(h.sign).not.toHaveBeenCalled();
    });

    it('refuses a fee above the configured cap', async () => {
      const h = harness();
      h.service.account = relayAccount({
        ...DEDUCT,
        balances: [{ token: TEST_ERC20, balance: 2_500_000n, minAmount: 100_000n, fee: 1001n }]
      });
      expect(await h.run()).toEqual({ kind: 'fee-refused', balance: '2500000', fee: '1001' });
      expect(h.sign).not.toHaveBeenCalled();
    });

    it('refuses a job whose id is not the digest of the batch and keeps the submission', async () => {
      const h = harness();
      h.submit.mockResolvedValueOnce({ id: `0x${'99'.repeat(32)}`, state: 'pending', txHash: TX1 });
      expect(await h.run()).toEqual({ kind: 'failed', code: 'mismatch' });
      expect(h.rows.size).toBe(0);
      expect(h.pending()).not.toBeNull();
    });
  });

  describe('jobs', () => {
    it('follows the newest hash of a pending job', async () => {
      const h = harness();
      const first = await h.run();
      const [job] = [...h.jobs.values()];
      if (!job) throw new Error('no job');
      h.jobs.set(job.id, { ...job, txHash: TX2 });

      expect(await h.run()).toEqual(first);
      expect(h.onlyRow().evmTxHash).toBe(TX2);
      expect(h.fetchAccount).toHaveBeenCalledTimes(1);
    });

    it('moves a succeeded job to the phase the Agglayer tracking expects', async () => {
      const h = harness();
      await h.run();
      const [job] = [...h.jobs.values()];
      if (!job) throw new Error('no job');
      h.jobs.set(job.id, { ...job, state: 'succeeded', txHash: TX2 });

      const row = h.onlyRow();
      expect(await h.run()).toEqual({ kind: 'bridging', rowId: row.id });
      expect(h.onlyRow()).toEqual(
        expect.objectContaining({
          phase: 'delivering',
          evmTxHash: TX2,
          relay: { ...row.relay, state: 'succeeded', txHash: TX2 }
        })
      );

      // The address is empty now: the tick reports the row in flight and signs nothing.
      h.service.account = relayAccount({
        balances: [{ token: TEST_ERC20, balance: 0n, minAmount: 100_000n, fee: 0n }]
      });
      expect(await h.run()).toEqual({ kind: 'bridging', rowId: row.id });
      expect(h.sign).toHaveBeenCalledTimes(1);
    });

    it('fails the row of a reverted job with the existing revert message', async () => {
      const h = harness();
      await h.run();
      const [job] = [...h.jobs.values()];
      if (!job) throw new Error('no job');
      h.jobs.set(job.id, { ...job, state: 'reverted', txHash: TX2 });

      const row = h.onlyRow();
      expect(await h.run()).toEqual({ kind: 'failed', code: 'reverted', rowId: row.id });
      expect(h.onlyRow()).toEqual(
        expect.objectContaining({
          phase: 'failed',
          evmTxHash: TX2,
          error: 'The Sepolia transaction reverted',
          errorId: 'raw_bridge_deposit_failed'
        })
      );
      expect(h.onlyRow().relay.state).toBe('reverted');
    });

    it('asks again for a young job the service does not know, and leaves an old one to its hash', async () => {
      const h = harness();
      await h.run();
      h.jobs.clear();
      const row = h.onlyRow();

      expect(await h.run()).toEqual({ kind: 'relay-pending', rowId: row.id });
      expect(h.onlyRow().relay.state).toBe('pending');

      h.clock.now += 25 * 60 * 60 * 1000;
      expect(await h.run()).toEqual({ kind: 'bridging', rowId: row.id });
      expect(h.onlyRow()).toEqual(expect.objectContaining({ phase: 'submitting', evmTxHash: TX1 }));
      expect(h.onlyRow().relay.state).toBe('expired');
      // The row is no longer followed as a job: the next tick reads the address again.
      await h.run();
      expect(h.fetchAccount).toHaveBeenCalledTimes(2);
    });
  });

  describe('a stored submission after a crash', () => {
    it('resends the same body when the crash came before the send', async () => {
      const h = harness();
      h.submit.mockRejectedValueOnce(new Error('the realm stopped'));
      expect(await h.run()).toEqual({ kind: 'failed', code: 'unexpected' });
      expect(h.pending()).not.toBeNull();
      const body = JSON.stringify(h.pending()?.body);

      expect(await h.run()).toEqual({ kind: 'relay-pending', rowId: h.onlyRow().id });
      expect(h.service.bodies).toEqual([body]);
      expect(h.sign).toHaveBeenCalledTimes(1);
      expect(h.pending()).toBeNull();
    });

    it('writes the row once when the crash came after the send', async () => {
      const h = harness();
      h.submit.mockImplementationOnce(async request => {
        h.service.bodies.push(JSON.stringify(relaySubmissionBody(request)));
        const id = serviceDigest(request);
        h.jobs.set(id, { id, state: 'pending', txHash: TX1 });
        throw new Error('the realm stopped');
      });
      await h.run();
      expect(h.rows.size).toBe(0);

      expect(await h.run()).toEqual({ kind: 'relay-pending', rowId: h.onlyRow().id });
      expect(h.service.bodies).toHaveLength(2);
      expect(new Set(h.service.bodies).size).toBe(1);
      expect(h.jobs.size).toBe(1);
      expect(h.pending()).toBeNull();
    });

    it('keeps one row when the crash came after the row and before the record went', async () => {
      const h = harness();
      const remove = h.deps.storage.remove;
      h.deps.storage.remove = async () => {
        throw new Error('the realm stopped');
      };
      expect(await h.run()).toEqual({ kind: 'failed', code: 'unexpected' });
      expect(h.rows.size).toBe(1);
      expect(h.pending()).not.toBeNull();

      h.deps.storage.remove = remove;
      expect(await h.run()).toEqual({ kind: 'relay-pending', rowId: h.onlyRow().id });
      expect(h.pending()).toBeNull();
      expect(h.sign).toHaveBeenCalledTimes(1);
    });

    it('finds an accepted job after the deadline, and signs again when the service knows none', async () => {
      const accepted = harness();
      accepted.submit.mockImplementationOnce(async request => {
        const id = serviceDigest(request);
        accepted.jobs.set(id, { id, state: 'succeeded', txHash: TX2 });
        throw new RelayUnavailableError('timeout', 'relay /v1/relay: the request failed (timeout)');
      });
      expect(await accepted.run()).toEqual({ kind: 'sending' });
      accepted.clock.now += (RELAY_DEADLINE_SECONDS + 1) * 1000;
      const row = await accepted.run();
      expect(row).toEqual({ kind: 'bridging', rowId: accepted.onlyRow().id });
      expect(accepted.onlyRow()).toEqual(expect.objectContaining({ phase: 'delivering', evmTxHash: TX2 }));
      expect(accepted.submit).toHaveBeenCalledTimes(1);

      const lost = harness();
      lost.submit.mockRejectedValueOnce(new RelayUnavailableError('network', 'relay: network'));
      await lost.run();
      lost.clock.now += (RELAY_DEADLINE_SECONDS + 1) * 1000;
      expect(await lost.run()).toEqual({ kind: 'relay-pending', rowId: lost.onlyRow().id });
      expect(lost.sign).toHaveBeenCalledTimes(2);
      expect(lastSubmission(lost.submit).deadline).toBe(BigInt(lost.clock.now / 1000 + RELAY_DEADLINE_SECONDS));
    });
  });

  describe('errors', () => {
    it('waits and keeps the submission on a wait error, then sends the same body', async () => {
      const h = harness();
      h.submit.mockRejectedValueOnce(new RelayApiError('rate_limited', 429, 'slow down', 60));
      expect(await h.run()).toEqual({ kind: 'sending', retryAfter: 60 });
      const body = JSON.stringify(h.pending()?.body);

      expect(await h.run()).toEqual({ kind: 'relay-pending', rowId: h.onlyRow().id });
      expect(h.service.bodies).toEqual([body]);
    });

    it('waits on an account read that the service cannot answer', async () => {
      const h = harness();
      h.fetchAccount.mockRejectedValueOnce(new RelayUnavailableError('network', 'relay: network'));
      expect(await h.run()).toEqual({ kind: 'waiting', code: 'network' });
      h.fetchAccount.mockRejectedValueOnce(new RelayApiError('rpc_unavailable', 502, 'rpc', 5));
      expect(await h.run()).toEqual({ kind: 'waiting', code: 'rpc_unavailable', retryAfter: 5 });
    });

    it('drops the submission on sign-again, and the next tick signs again', async () => {
      const h = harness();
      h.submit.mockRejectedValueOnce(new RelayApiError('stale_request', 409, 'stale'));
      expect(await h.run()).toEqual({ kind: 'waiting', code: 'stale_request' });
      expect(h.pending()).toBeNull();
      expect(h.fetchJob).toHaveBeenCalledTimes(1);

      expect(await h.run()).toEqual({ kind: 'relay-pending', rowId: h.onlyRow().id });
      expect(h.sign).toHaveBeenCalledTimes(2);
    });

    it('drops the submission and stops on a refusal', async () => {
      const h = harness();
      h.submit.mockRejectedValueOnce(new RelayApiError('bad_signature', 400, 'bad'));
      expect(await h.run()).toEqual({ kind: 'failed', code: 'bad_signature' });
      expect(h.pending()).toBeNull();
      expect(h.rows.size).toBe(0);
    });
  });

  it('runs one tick at a time per account and chain', async () => {
    const h = harness();
    let release: (account: RelayAccount) => void = () => undefined;
    h.fetchAccount.mockImplementationOnce(
      () =>
        new Promise<RelayAccount>(resolve => {
          release = resolve;
        })
    );
    const tick = createRelayDepositEngine(h.deps);
    const target: RelayDepositTarget = { provider: 'agglayer', chainId: CHAIN_ID, token: TEST_ERC20 };
    const first = tick(ACCOUNT, target);
    const second = tick(ACCOUNT, target);
    expect(second).toBe(first);
    expect(await tick(ACCOUNT, { ...target, token: TEST_FEE_RECIPIENT })).toEqual({ kind: 'busy' });

    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    release(relayAccount());
    const status: RelayDepositStatus = await first;
    expect(status).toEqual({ kind: 'relay-pending', rowId: h.onlyRow().id });
    expect(h.submit).toHaveBeenCalledTimes(1);
    // The guard ends with the tick.
    const third = tick(ACCOUNT, target);
    expect(third).not.toBe(first);
    await third;
  });
});

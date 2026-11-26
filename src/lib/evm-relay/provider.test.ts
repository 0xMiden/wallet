/**
 * @jest-environment node
 */
import { encodeFunctionData, erc20Abi, type Address, type EIP1193Provider, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, mainnet } from 'viem/chains';

import { planRelaySignature } from 'lib/miden/relay-key/sign-rules';
import type { RelaySignRequest, RelaySignResult } from 'lib/shared/types';

import { batchDigest, batchNonceOf, buildFeeCall, recoverBatchSigner, type BatchCall } from './batch';
import type { RelayAccountQuery, RelayJobQuery } from './client';
import {
  RelayApiError,
  RelayMismatchError,
  RelayProviderRpcError,
  RelayRefusedError,
  RelayRevertedError,
  RelayStillPendingError,
  RelayUnavailableError
} from './errors';
import {
  MAX_RELAY_BATCH_CALLS,
  RELAY_DEADLINE_SECONDS,
  RELAY_POLL_MS,
  RELAY_WAIT_MS,
  createRelayProvider,
  createRelayWalletClient,
  type RelayProvider,
  type RelayProviderOptions
} from './provider';
import { CHAIN, EXECUTOR, FEE_RECIPIENT, NATIVE, SALT, USDC, upperHex } from './testing';
import type { RelayAccount, RelayJob, RelaySubmission } from './types';

// Any key works: the relay key is the key of the relay address, so the signatures recover to RELAY.
const relayKey = privateKeyToAccount('0x1772fe91fd5a0e606a5fed77763cffebdf7d0a44f86be481c60319286db10e6f');
const RELAY: Address = `0x${relayKey.address.slice(2).toLowerCase()}`;
const TARGET: Address = '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582';
const OTHER_JOB: Hex = `0x${'0b'.repeat(32)}`;
const START_MS = 1_800_000_000_000;
const hashOf = (byte: string): Hash => `0x${byte.repeat(32)}`;

function relayAccount(overrides: Partial<RelayAccount> = {}): RelayAccount {
  return {
    chainId: CHAIN.chainId,
    address: RELAY,
    mode: 'sponsor',
    executor: EXECUTOR,
    feeRecipient: null,
    needsAuthorization: false,
    authorizationNonce: 0,
    salt: SALT,
    sequence: 3n,
    fees: [],
    allowedTargets: null,
    balances: [],
    ...overrides
  };
}

function deductAccount(fee: bigint, overrides: Partial<RelayAccount> = {}): RelayAccount {
  return relayAccount({ mode: 'deduct', feeRecipient: FEE_RECIPIENT, fees: [{ token: USDC, fee }], ...overrides });
}

/** The digest of a submission, as the relay computes the job id. */
function digestOf(submission: RelaySubmission): Hex {
  const { chainId, evmAddress, batchNonce, salt, deadline, calls } = submission;
  return batchDigest(CHAIN.calibur, { chainId, evmAddress, executor: EXECUTOR, batchNonce, salt, deadline }, calls);
}

type Answer<T> = T | Error | ((input: RelaySubmission) => T);

interface Harness {
  provider: RelayProvider;
  options: RelayProviderOptions;
  accounts: RelayAccount[];
  submits: Answer<'pending' | 'succeeded' | 'reverted' | RelayJob>[];
  jobs: (RelayJob | Error | 'pending' | 'succeeded' | 'reverted')[];
  submissions: RelaySubmission[];
  signRequests: RelaySignRequest[];
  accountQueries: RelayAccountQuery[];
  jobQueries: RelayJobQuery[];
  sleeps: number[];
  readRpc: jest.Mock<Promise<unknown>, [string, unknown]>;
  clock: { ms: number };
}

/**
 * A provider over stub services. The stub relay answers each submission with a job whose id is its digest; the stub
 * backend signs under the real vault rule (`planRelaySignature`) with the relay key.
 */
function harness(extra: Partial<RelayProviderOptions> = {}): Harness {
  const clock = { ms: START_MS };
  const state: Omit<Harness, 'provider' | 'options'> = {
    accounts: [relayAccount()],
    submits: ['succeeded'],
    jobs: [],
    submissions: [],
    signRequests: [],
    accountQueries: [],
    jobQueries: [],
    sleeps: [],
    readRpc: jest.fn(async (_method: string, _params: unknown): Promise<unknown> => '0x1'),
    clock
  };
  const jobFor = (answer: 'pending' | 'succeeded' | 'reverted' | RelayJob, id: Hex, hash: Hash): RelayJob =>
    typeof answer === 'string' ? { id, state: answer, txHash: hash } : answer;
  const options: RelayProviderOptions = {
    chain: CHAIN,
    address: RELAY,
    rpcUrl: 'https://rpc.example',
    sign: async (request: RelaySignRequest): Promise<RelaySignResult> => {
      state.signRequests.push(request);
      const plan = planRelaySignature(request, {
        relayAddress: RELAY,
        chain: CHAIN,
        nowSeconds: Math.floor(clock.ms / 1000)
      });
      const signature = await relayKey.sign({ hash: plan.digest });
      switch (plan.op) {
        case 'authorization': {
          const r: Hex = `0x${signature.slice(2, 66)}`;
          const s: Hex = `0x${signature.slice(66, 130)}`;
          return { op: 'authorization', authorization: { ...plan.authorization, r, s, yParity: 0 } };
        }
        case 'batch':
          return { op: 'batch', digest: plan.digest, signature };
      }
    },
    fetchAccount: async query => {
      state.accountQueries.push(query);
      const next = state.accounts.length > 1 ? state.accounts.shift() : state.accounts[0];
      if (next === undefined) throw new Error('no account');
      return next;
    },
    submit: async submission => {
      state.submissions.push(submission);
      const answer = state.submits.length > 1 ? state.submits.shift() : state.submits[0];
      if (answer === undefined) throw new Error('no submit answer');
      if (answer instanceof Error) throw answer;
      const resolved = typeof answer === 'function' ? answer(submission) : answer;
      return jobFor(resolved, digestOf(submission), hashOf('a1'));
    },
    fetchJob: async query => {
      state.jobQueries.push(query);
      const answer = state.jobs.length > 1 ? state.jobs.shift() : state.jobs[0];
      if (answer === undefined) throw new Error('no job answer');
      if (answer instanceof Error) throw answer;
      return jobFor(answer, query.id, hashOf('f1'));
    },
    readRpc: state.readRpc,
    now: () => clock.ms,
    sleep: async ms => {
      state.sleeps.push(ms);
      clock.ms += ms;
    },
    ...extra
  };
  // The stubs read `state`, so a test changes their answers through the returned object.
  return Object.assign(state, { options, provider: createRelayProvider(options) });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error
  );
}

function sendTransaction(provider: RelayProvider, tx: Record<string, unknown>): Promise<Hash> {
  return provider.request<Hash>({ method: 'eth_sendTransaction', params: [{ from: RELAY, ...tx }] });
}

const CALL: BatchCall = { to: TARGET, value: 0n, data: '0xcafe0001' };

function submitted(h: Harness, index = 0): RelaySubmission {
  const submission = h.submissions[index];
  if (submission === undefined) throw new Error(`no submission ${index}`);
  return submission;
}

describe('createRelayProvider', () => {
  it('refuses a relay address or a fee token that is not an address', () => {
    expect(() => createRelayProvider({ ...harness().options, address: '0x12' })).toThrow(TypeError);
    expect(() => createRelayProvider({ ...harness().options, feeToken: '0x12' })).toThrow('the fee token');
  });

  it('fits the EIP-1193 provider type of viem and of the bridge flows', () => {
    const { provider } = harness();
    const eip1193: Pick<EIP1193Provider, 'request'> = provider;
    expect(typeof eip1193.request).toBe('function');
    expect(provider.chainId).toBe(CHAIN.chainId);
    expect(provider.address).toBe(RELAY);
  });

  it('keeps the relay address in lower case', () => {
    const { provider } = harness({ address: upperHex(RELAY) });
    expect(provider.address).toBe(RELAY);
  });
});

describe('request: account and chain methods', () => {
  it.each(['eth_accounts', 'eth_requestAccounts'])('answers %s with the relay address', async method => {
    expect(await harness().provider.request({ method })).toEqual([RELAY]);
  });

  it('answers eth_chainId with the hex chain id', async () => {
    expect(await harness().provider.request({ method: 'eth_chainId' })).toBe('0x2105');
  });

  it('accepts a switch to its own chain', async () => {
    const { provider } = harness();
    expect(await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] })).toBe(
      null
    );
  });

  it('refuses a switch to another chain with 4200', async () => {
    const error = await failure(
      harness().provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })
    );
    expect(error).toBeInstanceOf(RelayProviderRpcError);
    expect(error).toMatchObject({ code: 4200 });
  });

  it.each([undefined, [], ['0x2105'], [{ chainId: 'base' }]])('refuses the switch parameters %p', async params => {
    const error = await failure(harness().provider.request({ method: 'wallet_switchEthereumChain', params }));
    expect(error).toMatchObject({ code: -32602 });
  });

  it.each([
    'personal_sign',
    'eth_sign',
    'eth_signTypedData',
    'eth_signTypedData_v4',
    'eth_signTransaction',
    'eth_sendRawTransaction',
    'wallet_sendCalls',
    'wallet_getCapabilities',
    'wallet_sendTransaction',
    'eth_newFilter'
  ])('refuses %s with 4200 and signs nothing', async method => {
    const h = harness();
    const error = await failure(h.provider.request({ method, params: [] }));
    expect(error).toBeInstanceOf(RelayProviderRpcError);
    expect(error).toMatchObject({ code: 4200 });
    expect(h.signRequests).toHaveLength(0);
  });
});

describe('request: read methods', () => {
  it.each(['eth_call', 'eth_getBalance', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_estimateGas'])(
    'sends %s on to the chain RPC',
    async method => {
      const h = harness();
      const params = [{ to: TARGET }, 'latest'];
      expect(await h.provider.request({ method, params })).toBe('0x1');
      expect(h.readRpc).toHaveBeenCalledWith(method, params);
    }
  );

  it('sends empty parameters when the caller gives none', async () => {
    const h = harness();
    await h.provider.request({ method: 'eth_blockNumber' });
    expect(h.readRpc).toHaveBeenCalledWith('eth_blockNumber', []);
  });

  it('passes on the error of a read as it is', async () => {
    const h = harness();
    const revert = new RelayProviderRpcError(3, 'execution reverted', '0x08c379a0');
    h.readRpc.mockRejectedValueOnce(revert);
    expect(await failure(h.provider.request({ method: 'eth_call', params: [] }))).toBe(revert);
  });
});

describe('eth_sendTransaction', () => {
  it('relays one call in sponsor mode and gives the final hash', async () => {
    const h = harness();
    h.submits = ['pending'];
    h.jobs = ['pending', 'succeeded'];

    const hash = await sendTransaction(h.provider, { to: TARGET, value: '0x10', data: '0xcafe0001', gas: '0x5208' });

    expect(hash).toBe(hashOf('f1'));
    expect(h.sleeps).toEqual([RELAY_POLL_MS, RELAY_POLL_MS]);
    expect(h.submissions).toHaveLength(1);
    const submission = submitted(h);
    expect(submission.calls).toEqual([{ to: TARGET, value: 16n, data: '0xcafe0001' }]);
    expect(submission).toMatchObject({
      chainId: CHAIN.chainId,
      evmAddress: RELAY,
      batchNonce: batchNonceOf(3n),
      salt: SALT,
      deadline: BigInt(START_MS / 1000 + RELAY_DEADLINE_SECONDS)
    });
    expect(submission.authorization).toBeUndefined();
    expect(h.accountQueries).toEqual([{ chainId: CHAIN.chainId, address: RELAY }]);
    expect(h.jobQueries).toEqual([
      { id: digestOf(submission), chainId: CHAIN.chainId },
      { id: digestOf(submission), chainId: CHAIN.chainId }
    ]);
    const envelope = { ...submission, executor: EXECUTOR };
    expect(await recoverBatchSigner(CHAIN.calibur, envelope, submission.calls, submission.signature)).toBe(
      relayKey.address
    );
  });

  it('gives the hash at once when the relay answers succeeded', async () => {
    const h = harness();
    expect(await sendTransaction(h.provider, { to: TARGET })).toBe(hashOf('a1'));
    expect(h.sleeps).toEqual([]);
    expect(submitted(h).calls).toEqual([{ to: TARGET, value: 0n, data: '0x' }]);
  });

  it.each([
    ['input', { input: '0xCAFE0001' }],
    ['data and input that agree', { data: '0xcafe0001', input: '0xCAFE0001' }],
    ['a sender in upper case', { from: upperHex(RELAY), data: '0xcafe0001' }],
    ['a hex chain id', { chainId: '0x2105', data: '0xcafe0001' }],
    ['a number chain id', { chainId: 8453, data: '0xcafe0001' }],
    ['a target in upper case', { to: upperHex(TARGET), data: '0xcafe0001' }],
    [
      'gas fields, which it ignores',
      { data: '0xcafe0001', gas: '0x1', gasPrice: '0x1', maxFeePerGas: '0x2', nonce: '0x7', accessList: [] }
    ]
  ])('reads %s', async (_name, tx) => {
    const h = harness();
    await sendTransaction(h.provider, { to: TARGET, ...tx });
    expect(submitted(h).calls).toEqual([CALL]);
  });

  it.each([
    ['no parameters', undefined],
    ['a parameter that is not an object', ['0x01']],
    ['an empty list', []]
  ])('refuses %s with -32602', async (_name, params) => {
    const h = harness();
    const error = await failure(h.provider.request({ method: 'eth_sendTransaction', params }));
    expect(error).toMatchObject({ code: -32602 });
    expect(h.accountQueries).toHaveLength(0);
  });

  it.each([
    ['a missing sender', { from: undefined }],
    ['another sender', { from: TARGET }]
  ])('refuses %s with 4100', async (_name, tx) => {
    const h = harness();
    const error = await failure(sendTransaction(h.provider, { to: TARGET, ...tx }));
    expect(error).toMatchObject({ code: 4100 });
    expect(h.signRequests).toHaveLength(0);
  });

  it.each([
    ['another chain', { chainId: '0x1' }],
    ['a chain id that is not a quantity', { chainId: 'base' }],
    ['a contract creation', { to: undefined }],
    ['a target that is not an address', { to: '0x1234' }],
    ['the zero target', { to: NATIVE }],
    ['the relay address as the target', { to: RELAY }],
    ['data and input that differ', { data: '0x01', input: '0x02' }],
    ['data that is not hex bytes', { data: '0x123' }],
    ['data that is not a string', { data: 5 }],
    ['a value that is not a quantity', { value: 16 }],
    ['a decimal value', { value: '16' }],
    ['a value of 2^256', { value: `0x1${'0'.repeat(64)}` }],
    ['an authorization list', { authorizationList: [] }],
    ['blobs', { blobs: ['0x01'] }],
    ['blob hashes', { blobVersionedHashes: [hashOf('01')] }],
    ['a blob fee', { maxFeePerBlobGas: '0x1' }]
  ])('refuses %s with -32602 and signs nothing', async (_name, tx) => {
    const h = harness();
    const error = await failure(sendTransaction(h.provider, { to: TARGET, ...tx }));
    expect(error).toBeInstanceOf(RelayProviderRpcError);
    expect(error).toMatchObject({ code: -32602 });
    expect(h.signRequests).toHaveLength(0);
    expect(h.submissions).toHaveLength(0);
  });
});

describe('sendCalls', () => {
  const APPROVE: BatchCall = {
    to: USDC,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TARGET, 5n] })
  };

  it('relays approve and the bridge call in one batch', async () => {
    const h = harness();
    expect(await h.provider.sendCalls([APPROVE, CALL])).toBe(hashOf('a1'));
    expect(h.submissions).toHaveLength(1);
    expect(submitted(h).calls).toEqual([APPROVE, CALL]);
  });

  it('normalizes the case of targets and calldata', async () => {
    const h = harness();
    await h.provider.sendCalls([{ to: upperHex(TARGET), value: 0n, data: upperHex(CALL.data) }]);
    expect(submitted(h).calls).toEqual([CALL]);
  });

  it.each<[string, BatchCall[]]>([
    ['no calls', []],
    ['the zero target', [{ ...CALL, to: NATIVE }]],
    ['the relay address as the target', [{ ...CALL, to: upperHex(RELAY) }]],
    ['a target that is not an address', [{ ...CALL, to: '0x12' }]],
    ['a negative value', [{ ...CALL, value: -1n }]],
    ['a value of 2^256', [{ ...CALL, value: 1n << 256n }]],
    ['calldata of half a byte', [{ ...CALL, data: '0x123' }]]
  ])('refuses %s with -32602', async (_name, calls) => {
    const h = harness();
    expect(await failure(h.provider.sendCalls(calls))).toMatchObject({ code: -32602 });
    expect(h.accountQueries).toHaveLength(0);
  });

  it('takes 8 calls in sponsor mode', async () => {
    const h = harness();
    await h.provider.sendCalls(Array.from({ length: MAX_RELAY_BATCH_CALLS }, () => CALL));
    expect(submitted(h).calls).toHaveLength(MAX_RELAY_BATCH_CALLS);
  });

  it('runs one relay at a time, and a failed relay does not stop the next', async () => {
    const h = harness();
    h.submits = [new RelayApiError('simulation_failed', 409, 'reverts'), 'succeeded'];
    const first = failure(h.provider.sendCalls([CALL]));
    const second = h.provider.sendCalls([APPROVE]);
    expect(await first).toMatchObject({ code: 'simulation_failed' });
    expect(await second).toBe(hashOf('a1'));
    expect(h.submissions.map(submission => submission.calls)).toEqual([[CALL], [APPROVE]]);
  });
});

describe('deduct mode', () => {
  it('adds the fee call last, to the relay fee recipient', async () => {
    const h = harness({ feeToken: upperHex(USDC) });
    h.accounts = [deductAccount(1000n)];
    await h.provider.sendCalls([CALL]);
    expect(submitted(h).calls).toEqual([CALL, buildFeeCall({ token: USDC, recipient: FEE_RECIPIENT, amount: 1000n })]);
  });

  it('pays a native fee with a plain transfer', async () => {
    const h = harness({ feeToken: NATIVE, chain: { ...CHAIN, maxFee: { [NATIVE]: '100' } } });
    h.accounts = [deductAccount(0n, { fees: [{ token: NATIVE, fee: 100n }] })];
    await h.provider.sendCalls([CALL]);
    expect(submitted(h).calls[1]).toEqual({ to: FEE_RECIPIENT, value: 100n, data: '0x' });
  });

  it('refuses 8 calls, since the fee call needs a place', async () => {
    const h = harness({ feeToken: USDC });
    h.accounts = [deductAccount(1000n)];
    const error = await failure(h.provider.sendCalls(Array.from({ length: MAX_RELAY_BATCH_CALLS }, () => CALL)));
    expect(error).toBeInstanceOf(RelayRefusedError);
    expect(error).toMatchObject({ reason: 'too-many-calls' });
    expect(h.signRequests).toHaveLength(0);
  });

  it.each<[string, Partial<RelayProviderOptions>, RelayAccount, string]>([
    ['no fee token', {}, deductAccount(1000n), 'no-fee-token'],
    ['a fee token with no relay fee', { feeToken: NATIVE }, deductAccount(1000n), 'no-fee'],
    ['a fee above the config cap', { feeToken: USDC }, deductAccount(50_001n), 'fee-not-accepted'],
    ['a fee of 0', { feeToken: USDC }, deductAccount(0n), 'fee-not-accepted'],
    [
      'a fee token without a config cap',
      { feeToken: NATIVE },
      deductAccount(0n, { fees: [{ token: NATIVE, fee: 1n }] }),
      'fee-not-accepted'
    ]
  ])('refuses %s and signs nothing', async (_name, extra, account, reason) => {
    const h = harness(extra);
    h.accounts = [account];
    const error = await failure(h.provider.sendCalls([CALL]));
    expect(error).toBeInstanceOf(RelayRefusedError);
    expect(error).toMatchObject({ reason });
    expect(h.signRequests).toHaveLength(0);
  });
});

describe('allowed targets', () => {
  it('relays calls to allowed targets, the fee call excepted', async () => {
    const h = harness({ feeToken: USDC });
    h.accounts = [deductAccount(1000n, { allowedTargets: [TARGET] })];
    await h.provider.sendCalls([CALL]);
    expect(submitted(h).calls).toHaveLength(2);
  });

  it('refuses a call to a target that the relayer does not allow', async () => {
    const h = harness();
    h.accounts = [relayAccount({ allowedTargets: [USDC] })];
    const error = await failure(h.provider.sendCalls([CALL]));
    expect(error).toMatchObject({ name: 'RelayRefusedError', reason: 'target-not-allowed' });
    expect(h.signRequests).toHaveLength(0);
  });
});

describe('the answers it does not trust', () => {
  it('refuses an account with another executor and signs nothing', async () => {
    const h = harness();
    h.accounts = [relayAccount({ executor: FEE_RECIPIENT })];
    expect(await failure(h.provider.sendCalls([CALL]))).toBeInstanceOf(RelayMismatchError);
    expect(h.signRequests).toHaveLength(0);
  });

  it('refuses a job whose id is not the digest', async () => {
    const h = harness();
    h.submits = [{ id: OTHER_JOB, state: 'succeeded', txHash: hashOf('a1') }];
    expect(await failure(h.provider.sendCalls([CALL]))).toBeInstanceOf(RelayMismatchError);
  });

  it('refuses a read of another job while it waits', async () => {
    const h = harness();
    h.submits = ['pending'];
    h.jobs = [{ id: OTHER_JOB, state: 'succeeded', txHash: hashOf('f1') }];
    expect(await failure(h.provider.sendCalls([CALL]))).toBeInstanceOf(RelayMismatchError);
  });

  it('refuses a batch signature over another digest', async () => {
    const h = harness();
    const provider = createRelayProvider({
      ...h.options,
      sign: async (): Promise<RelaySignResult> => ({ op: 'batch', digest: OTHER_JOB, signature: hashOf('0c') })
    });
    expect(await failure(provider.sendCalls([CALL]))).toMatchObject({
      name: 'RelayMismatchError',
      message: 'relay: the backend signed another batch'
    });
    expect(h.submissions).toHaveLength(0);
  });

  it('refuses an authorization answer to a batch request', async () => {
    const h = harness();
    const provider = createRelayProvider({
      ...h.options,
      sign: async (): Promise<RelaySignResult> => ({
        op: 'authorization',
        authorization: { address: CHAIN.calibur.address, chainId: 8453, nonce: 0, r: SALT, s: SALT, yParity: 0 }
      })
    });
    expect(await failure(provider.sendCalls([CALL]))).toBeInstanceOf(RelayMismatchError);
  });
});

describe('EIP-7702 authorization', () => {
  it('signs the authorization first when the address does not delegate yet, and sends it', async () => {
    const h = harness();
    h.accounts = [relayAccount({ needsAuthorization: true, authorizationNonce: 4 })];
    await h.provider.sendCalls([CALL]);
    expect(h.signRequests.map(request => request.op)).toEqual(['authorization', 'batch']);
    expect(h.signRequests[0]).toEqual({ op: 'authorization', chainId: CHAIN.chainId, nonce: 4 });
    expect(submitted(h).authorization).toMatchObject({ address: CHAIN.calibur.address, chainId: 8453, nonce: 4 });
  });

  it.each<[string, RelaySignResult]>([
    ['a batch', { op: 'batch', digest: OTHER_JOB, signature: hashOf('0c') }],
    [
      'another delegate',
      { op: 'authorization', authorization: { address: TARGET, chainId: 8453, nonce: 4, r: SALT, s: SALT, yParity: 0 } }
    ],
    [
      'another chain',
      {
        op: 'authorization',
        authorization: { address: CHAIN.calibur.address, chainId: 1, nonce: 4, r: SALT, s: SALT, yParity: 0 }
      }
    ],
    [
      'another nonce',
      {
        op: 'authorization',
        authorization: { address: CHAIN.calibur.address, chainId: 8453, nonce: 5, r: SALT, s: SALT, yParity: 0 }
      }
    ]
  ])('refuses %s as the signed authorization', async (_name, answer) => {
    const h = harness();
    h.accounts = [relayAccount({ needsAuthorization: true, authorizationNonce: 4 })];
    const provider = createRelayProvider({ ...h.options, sign: async () => answer });
    expect(await failure(provider.sendCalls([CALL]))).toMatchObject({
      name: 'RelayMismatchError',
      message: 'relay: the backend signed another authorization'
    });
    expect(h.submissions).toHaveLength(0);
  });
});

describe('the wait for a final state', () => {
  it('rejects a reverted job with its id and hash', async () => {
    const h = harness();
    h.submits = ['pending'];
    h.jobs = ['reverted'];
    const error = await failure(h.provider.sendCalls([CALL]));
    expect(error).toBeInstanceOf(RelayRevertedError);
    expect(error).toMatchObject({ id: digestOf(submitted(h)), txHash: hashOf('f1') });
  });

  it('rejects a job that the relay answers reverted at once', async () => {
    const h = harness();
    h.submits = ['reverted'];
    expect(await failure(h.provider.sendCalls([CALL]))).toMatchObject({
      name: 'RelayRevertedError',
      txHash: hashOf('a1')
    });
  });

  it('stops after 10 minutes with the id and the last hash', async () => {
    const h = harness();
    h.submits = ['pending'];
    h.jobs = ['pending'];
    const error = await failure(h.provider.sendCalls([CALL]));
    expect(error).toBeInstanceOf(RelayStillPendingError);
    expect(error).toMatchObject({ id: digestOf(submitted(h)), txHash: hashOf('f1') });
    expect(h.jobQueries).toHaveLength(RELAY_WAIT_MS / RELAY_POLL_MS);
    expect(h.clock.ms - START_MS).toBe(RELAY_WAIT_MS);
  });

  it('keeps the wait through passing read failures and honours a retryAfter', async () => {
    const h = harness();
    h.submits = ['pending'];
    h.jobs = [
      new RelayUnavailableError('network', 'down'),
      new RelayApiError('rate_limited', 429, 'slow', 20),
      new RelayApiError('service_unavailable', 503, 'later', 1),
      'succeeded'
    ];
    expect(await h.provider.sendCalls([CALL])).toBe(hashOf('f1'));
    expect(h.sleeps).toEqual([RELAY_POLL_MS, RELAY_POLL_MS, 20_000, RELAY_POLL_MS]);
  });

  it('ends the wait on a read failure that is not passing', async () => {
    const h = harness();
    h.submits = ['pending'];
    h.jobs = [new RelayApiError('not_found', 404, 'gone')];
    expect(await failure(h.provider.sendCalls([CALL]))).toMatchObject({ code: 'not_found' });
  });
});

describe('retries', () => {
  it('reads and signs again after stale_request, at most 2 times', async () => {
    const h = harness();
    h.accounts = [relayAccount({ sequence: 3n }), relayAccount({ sequence: 4n }), relayAccount({ sequence: 5n })];
    const stale = new RelayApiError('stale_request', 409, 'stale');
    h.submits = [stale, stale, 'succeeded'];
    expect(await h.provider.sendCalls([CALL])).toBe(hashOf('a1'));
    expect(h.accountQueries).toHaveLength(3);
    expect(h.submissions.map(submission => submission.batchNonce)).toEqual([
      batchNonceOf(3n),
      batchNonceOf(4n),
      batchNonceOf(5n)
    ]);
  });

  it('gives up after the third stale_request', async () => {
    const h = harness();
    h.submits = [new RelayApiError('stale_request', 409, 'stale')];
    expect(await failure(h.provider.sendCalls([CALL]))).toMatchObject({ code: 'stale_request' });
    expect(h.submissions).toHaveLength(3);
  });

  it('waits for the open job of busy, then starts again once', async () => {
    const h = harness();
    h.submits = [new RelayApiError('busy', 409, 'busy', undefined, OTHER_JOB), 'succeeded'];
    h.jobs = ['pending', 'succeeded'];
    expect(await h.provider.sendCalls([CALL])).toBe(hashOf('a1'));
    expect(h.jobQueries).toEqual([
      { id: OTHER_JOB, chainId: CHAIN.chainId },
      { id: OTHER_JOB, chainId: CHAIN.chainId }
    ]);
    expect(h.submissions).toHaveLength(2);
    expect(h.accountQueries).toHaveLength(2);
  });

  it.each<[string, RelayJob | Error]>([
    ['reverted', { id: OTHER_JOB, state: 'reverted', txHash: hashOf('f1') }],
    ['gone', new RelayApiError('not_found', 404, 'gone')]
  ])('starts again when the open job is %s', async (_name, answer) => {
    const h = harness();
    h.submits = [new RelayApiError('busy', 409, 'busy', undefined, OTHER_JOB), 'succeeded'];
    h.jobs = [answer];
    expect(await h.provider.sendCalls([CALL])).toBe(hashOf('a1'));
    expect(h.submissions).toHaveLength(2);
  });

  it('passes on a failure of the wait for the open job', async () => {
    const h = harness();
    h.submits = [new RelayApiError('busy', 409, 'busy', undefined, OTHER_JOB)];
    h.jobs = [new RelayApiError('bad_signature', 400, 'no')];
    expect(await failure(h.provider.sendCalls([CALL]))).toMatchObject({ code: 'bad_signature' });
    expect(h.submissions).toHaveLength(1);
  });

  it('gives up on a second busy', async () => {
    const h = harness();
    h.submits = [new RelayApiError('busy', 409, 'busy', undefined, OTHER_JOB)];
    h.jobs = ['succeeded'];
    expect(await failure(h.provider.sendCalls([CALL]))).toMatchObject({ code: 'busy' });
    expect(h.submissions).toHaveLength(2);
  });

  it('gives up on a busy without the id of the open job', async () => {
    const h = harness();
    h.submits = [new RelayApiError('busy', 409, 'busy')];
    expect(await failure(h.provider.sendCalls([CALL]))).toMatchObject({ code: 'busy' });
    expect(h.submissions).toHaveLength(1);
    expect(h.jobQueries).toHaveLength(0);
  });

  it.each([
    new RelayApiError('simulation_failed', 409, 'reverts'),
    new RelayApiError('fee_too_low', 400, 'low'),
    new RelayApiError('target_not_allowed', 400, 'no'),
    new RelayUnavailableError('timeout', 'slow'),
    new Error('plain')
  ])('passes on %p without a retry', async error => {
    const h = harness();
    h.submits = [error];
    expect(await failure(h.provider.sendCalls([CALL]))).toBe(error);
    expect(h.submissions).toHaveLength(1);
  });
});

describe('createRelayWalletClient', () => {
  /** The provider with a record of each method that viem sends through the transport. */
  function recorded(provider: RelayProvider): { provider: RelayProvider; methods: string[] } {
    const methods: string[] = [];
    return {
      methods,
      provider: {
        ...provider,
        request: args => {
          methods.push(args.method);
          return provider.request(args);
        }
      }
    };
  }

  it('refuses a chain that is not the chain of the provider', () => {
    expect(() => createRelayWalletClient(harness().provider, mainnet)).toThrow(TypeError);
  });

  it('turns sendTransaction into exactly one relay with the same call', async () => {
    const h = harness();
    const spy = recorded(h.provider);
    const client = createRelayWalletClient(spy.provider, base);
    const hash = await client.sendTransaction({
      account: RELAY,
      chain: base,
      to: TARGET,
      value: 7n,
      data: '0xcafe0001'
    });
    expect(hash).toBe(hashOf('a1'));
    expect(h.submissions).toHaveLength(1);
    expect(submitted(h).calls).toEqual([{ to: TARGET, value: 7n, data: '0xcafe0001' }]);
    expect(spy.methods).toEqual(['eth_chainId', 'eth_sendTransaction']);
  });

  it('turns writeContract into exactly one relay with the encoded call', async () => {
    const h = harness();
    const spy = recorded(h.provider);
    const client = createRelayWalletClient(spy.provider, base);
    await client.writeContract({
      account: RELAY,
      chain: base,
      address: USDC,
      abi: erc20Abi,
      functionName: 'approve',
      args: [TARGET, 5n]
    });
    expect(h.submissions).toHaveLength(1);
    expect(submitted(h).calls).toEqual([
      { to: USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TARGET, 5n] }) }
    ]);
    expect(spy.methods).toEqual(['eth_chainId', 'eth_sendTransaction']);
  });

  it('sends a refusal back through viem with its cause', async () => {
    const h = harness();
    h.accounts = [relayAccount({ allowedTargets: [USDC] })];
    const client = createRelayWalletClient(h.provider, base);
    const error = await failure(client.sendTransaction({ account: RELAY, chain: base, to: TARGET }));
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('target-not-allowed');
    expect(h.signRequests).toHaveLength(0);
  });
});

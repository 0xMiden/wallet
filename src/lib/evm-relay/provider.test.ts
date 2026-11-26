/**
 * @jest-environment node
 */
import { encodeFunctionData, erc20Abi, type Address, type EIP1193Provider, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, mainnet } from 'viem/chains';

import { planRelaySignature } from 'lib/miden/relay-key/sign-rules';
import type { RelaySignRequest, RelaySignResult } from 'lib/shared/types';

import { batchDigest, buildFeeCall, type BatchCall } from './batch';
import {
  RelayApiError,
  RelayProviderRpcError,
  RelayRefusedError,
  RelayUnavailableError,
  RelayUnknownOutcomeError
} from './errors';
import {
  createRelayProvider,
  createRelayWalletClient,
  type RelayProvider,
  type RelayProviderOptions
} from './provider';
import type { RelayJobRef } from './submit';
import { CHAIN, EXECUTOR, FEE_RECIPIENT, NATIVE, SALT, USDC, upperHex } from './testing';
import type { RelayAccount, RelayJob, RelayJobState, RelaySubmission } from './types';

// Any key works: the relay key is the key of the relay address, so the signatures recover to RELAY.
const relayKey = privateKeyToAccount('0x1772fe91fd5a0e606a5fed77763cffebdf7d0a44f86be481c60319286db10e6f');
const RELAY: Address = `0x${relayKey.address.slice(2).toLowerCase()}`;
const TARGET: Address = '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582';
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

function digestOf(submission: RelaySubmission): Hex {
  const { chainId, evmAddress, batchNonce, salt, deadline, calls } = submission;
  return batchDigest(CHAIN.calibur, { chainId, evmAddress, executor: EXECUTOR, batchNonce, salt, deadline }, calls);
}

type JobAnswer = RelayJobState | RelayJob | Error;

interface Harness {
  provider: RelayProvider;
  options: RelayProviderOptions;
  accounts: RelayAccount[];
  posts: JobAnswer[];
  jobs: JobAnswer[];
  submissions: RelaySubmission[];
  signRequests: RelaySignRequest[];
  accountQueries: number;
  readRpc: jest.Mock<Promise<unknown>, [string, unknown]>;
}

function next<T>(answers: T[]): T {
  const answer = answers.length > 1 ? answers.shift() : answers[0];
  if (answer === undefined) throw new Error('no answer');
  return answer;
}

function jobOf(answer: JobAnswer, id: Hex, hash: Hash): RelayJob {
  if (answer instanceof Error) throw answer;
  return typeof answer === 'string' ? { id, state: answer, txHash: hash } : answer;
}

/** A provider over stub services. The stub backend signs under the real vault rule with the relay key. */
function harness(extra: Partial<RelayProviderOptions> = {}): Harness {
  const clock = { ms: START_MS };
  const state: Omit<Harness, 'provider' | 'options'> = {
    accounts: [relayAccount()],
    posts: ['succeeded'],
    jobs: [],
    submissions: [],
    signRequests: [],
    accountQueries: 0,
    readRpc: jest.fn(async (_method: string, _params: unknown): Promise<unknown> => '0x1')
  };
  const options: RelayProviderOptions = {
    chain: CHAIN,
    address: RELAY,
    rpcUrl: 'https://rpc.example',
    sign: async (request: RelaySignRequest): Promise<RelaySignResult> => {
      state.signRequests.push(request);
      const plan = planRelaySignature(request, { relayAddress: RELAY, chain: CHAIN, nowSeconds: clock.ms / 1000 });
      const signature = await relayKey.sign({ hash: plan.digest });
      switch (plan.op) {
        case 'authorization':
          return {
            op: 'authorization',
            authorization: { ...plan.authorization, r: SALT, s: SALT, yParity: 0 }
          };
        case 'batch':
          return { op: 'batch', digest: plan.digest, signature };
      }
    },
    fetchAccount: async () => {
      state.accountQueries += 1;
      return next(state.accounts);
    },
    postRelay: async submission => {
      state.submissions.push(submission);
      return jobOf(next(state.posts), digestOf(submission), hashOf('a1'));
    },
    fetchJob: async query => jobOf(next(state.jobs), query.id, hashOf('f1')),
    readRpc: state.readRpc,
    now: () => clock.ms,
    sleep: async ms => {
      clock.ms += ms;
    },
    ...extra
  };
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

/** The first error of the `cause` chain that is an instance of `type`, or undefined. */
function causeOf<T extends Error>(error: unknown, type: new (...args: never[]) => T): T | undefined {
  let current = error;
  while (current instanceof Error) {
    if (current instanceof type) return current;
    current = current.cause;
  }
  return undefined;
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
  it('refuses a relay address that is not an address', () => {
    expect(() => createRelayProvider({ ...harness().options, address: '0x12' })).toThrow(TypeError);
  });

  it('fits the EIP-1193 provider type of viem and of the bridge flows', () => {
    const { provider } = harness({ address: upperHex(RELAY) });
    const eip1193: Pick<EIP1193Provider, 'request'> = provider;
    expect(typeof eip1193.request).toBe('function');
    expect(provider.chainId).toBe(CHAIN.chainId);
    expect(provider.address).toBe(RELAY);
    expect(provider.submitter.address).toBe(RELAY);
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
  it('relays one call through the submitter and gives the final hash', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = ['succeeded'];
    const hash = await sendTransaction(h.provider, { to: TARGET, value: '0x10', data: '0xcafe0001', gas: '0x5208' });
    expect(hash).toBe(hashOf('f1'));
    expect(h.submissions).toHaveLength(1);
    expect(submitted(h).calls).toEqual([{ to: TARGET, value: 16n, data: '0xcafe0001' }]);
  });

  it('relays a transaction without data or value', async () => {
    const h = harness();
    expect(await sendTransaction(h.provider, { to: TARGET })).toBe(hashOf('a1'));
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
    expect(h.accountQueries).toBe(0);
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

  it.each<[string, BatchCall[]]>([
    ['no calls', []],
    ['the zero target', [{ ...CALL, to: NATIVE }]],
    ['the relay address as the target', [{ ...CALL, to: upperHex(RELAY) }]],
    ['a value of 2^256', [{ ...CALL, value: 1n << 256n }]]
  ])('refuses %s with -32602', async (_name, calls) => {
    const h = harness();
    expect(await failure(h.provider.sendCalls(calls))).toMatchObject({ code: -32602 });
    expect(h.accountQueries).toBe(0);
  });

  it('passes on a relay error as it is', async () => {
    const h = harness();
    const low = new RelayApiError('fee_too_low', 400, 'low');
    h.posts = [low];
    expect(await failure(h.provider.sendCalls([CALL]))).toBe(low);
  });
});

describe('the submit options', () => {
  it('passes beforeSign, onJob and the reviewed fee to each submit', async () => {
    const events: string[] = [];
    const refs: RelayJobRef[] = [];
    const h = harness({
      beforeSign: async () => {
        events.push('beforeSign');
      },
      onJob: async job => {
        refs.push(job);
        events.push('onJob');
      },
      fee: { token: USDC, amount: 1000n }
    });
    h.accounts = [relayAccount({ mode: 'deduct', feeRecipient: FEE_RECIPIENT, fees: [{ token: USDC, fee: 1000n }] })];
    await sendTransaction(h.provider, { to: TARGET, data: '0xcafe0001' });
    await h.provider.sendCalls([CALL]);
    expect(events).toEqual(['beforeSign', 'onJob', 'beforeSign', 'onJob']);
    expect(refs.map(ref => ref.id)).toEqual(h.submissions.map(digestOf));
    expect(submitted(h).calls).toEqual([CALL, buildFeeCall({ token: USDC, recipient: FEE_RECIPIENT, amount: 1000n })]);
  });

  it('gives the job to onJob before an answer is lost, and the submitter resumes it', async () => {
    const refs: RelayJobRef[] = [];
    const h = harness({
      onJob: async job => {
        refs.push(job);
      }
    });
    h.posts = [new RelayUnavailableError('timeout', 'slow')];
    h.jobs = [new RelayApiError('not_found', 404, 'no')];
    expect(await failure(h.provider.sendCalls([CALL]))).toBeInstanceOf(RelayUnknownOutcomeError);
    const [job] = refs;
    if (job === undefined) throw new Error('no job recorded');
    h.jobs = ['succeeded'];
    expect(await h.provider.submitter.resume(job)).toEqual({ id: job.id, hash: hashOf('f1') });
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

  it('turns sendTransaction into exactly one relay POST with the same call', async () => {
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

  it('turns writeContract into exactly one relay POST with the encoded call', async () => {
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

  it('keeps a refusal reachable through the cause chain of the viem error', async () => {
    const h = harness();
    h.accounts = [relayAccount({ allowedTargets: [USDC] })];
    const client = createRelayWalletClient(h.provider, base);
    const error = await failure(client.sendTransaction({ account: RELAY, chain: base, to: TARGET }));
    expect(causeOf(error, RelayRefusedError)).toMatchObject({ reason: 'target-not-allowed' });
    expect(h.signRequests).toHaveLength(0);
  });

  it('keeps an unknown outcome and its job reachable through the cause chain', async () => {
    const h = harness();
    h.posts = [new RelayUnavailableError('network', 'down')];
    h.jobs = [new RelayApiError('not_found', 404, 'no')];
    const client = createRelayWalletClient(h.provider, base);
    const error = await failure(client.sendTransaction({ account: RELAY, chain: base, to: TARGET }));
    expect(causeOf(error, RelayUnknownOutcomeError)?.job.id).toBe(digestOf(submitted(h)));
  });
});

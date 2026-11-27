/**
 * @jest-environment node
 */
import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { planRelaySignature } from 'lib/miden/relay-key/sign-rules';
import type { RelaySignRequest, RelaySignResult } from 'lib/shared/types';

import { batchDigest, batchNonceOf, buildFeeCall, recoverBatchSigner, type BatchCall } from './batch';
import type { RelayAccountQuery, RelayJobQuery } from './client';
import {
  RelayApiError,
  RelayExpiredError,
  RelayFeeTooLowError,
  RelayMismatchError,
  RelayNotSubmittedError,
  RelayRefusedError,
  RelayRevertedError,
  RelayStillPendingError,
  RelayUnavailableError,
  RelayUnknownOutcomeError,
  relayErrorAction
} from './errors';
import type { RelayReviewedFee } from './guards';
import { watchOpenRelayJobs } from './open-jobs';
import {
  MAX_RELAY_BATCH_CALLS,
  RELAY_DEADLINE_SECONDS,
  RELAY_POLL_MS,
  RELAY_RESUME_GRACE_SECONDS,
  RELAY_WAIT_MS,
  createRelaySubmitter,
  type RelayJobRef,
  type RelaySubmitOptions,
  type RelaySubmitter,
  type RelaySubmitterOptions
} from './submit';
import { CHAIN, EXECUTOR, FEE_RECIPIENT, NATIVE, SALT, USDC, upperHex } from './testing';
import type { RelayAccount, RelayJob, RelayJobState, RelaySubmission } from './types';

// Any key works: the relay key is the key of the relay address, so the signatures recover to RELAY.
const relayKey = privateKeyToAccount('0x1772fe91fd5a0e606a5fed77763cffebdf7d0a44f86be481c60319286db10e6f');
const RELAY: Address = `0x${relayKey.address.slice(2).toLowerCase()}`;
const TARGET: Address = '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582';
const OTHER_JOB: Hex = `0x${'0b'.repeat(32)}`;
const START_MS = 1_800_000_000_000;
const START_SECONDS = START_MS / 1000;
const DEADLINE = START_SECONDS + RELAY_DEADLINE_SECONDS;
const hashOf = (byte: string): Hash => `0x${byte.repeat(32)}`;
const USDC_FEE: RelayReviewedFee = { token: USDC, amount: 1000n };

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
    feeTokens: [],
    allowedTargets: null,
    balances: [],
    ...overrides
  };
}

/** A `deduct` account that takes a fee in the native coin and in USDC. */
function deductAccount(overrides: Partial<RelayAccount> = {}): RelayAccount {
  return relayAccount({ mode: 'deduct', feeRecipient: FEE_RECIPIENT, feeTokens: [NATIVE, USDC], ...overrides });
}

/** The digest of a submission, as the relay computes the job id. */
function digestOf(submission: RelaySubmission): Hex {
  const { chainId, evmAddress, batchNonce, salt, deadline, calls } = submission;
  return batchDigest(CHAIN.calibur, { chainId, evmAddress, executor: EXECUTOR, batchNonce, salt, deadline }, calls);
}

type JobAnswer = RelayJobState | RelayJob | Error;

interface Harness {
  submitter: RelaySubmitter;
  options: RelaySubmitterOptions;
  accounts: (RelayAccount | Error)[];
  posts: JobAnswer[];
  jobs: JobAnswer[];
  submissions: RelaySubmission[];
  signRequests: RelaySignRequest[];
  accountQueries: RelayAccountQuery[];
  jobQueries: RelayJobQuery[];
  sleeps: number[];
  /** Every service call, signature and hook in order. */
  events: string[];
  clock: { ms: number };
}

/** The next answer of a list: each answer once, the last one for every later call. */
function next<T>(answers: T[]): T {
  const answer = answers.length > 1 ? answers.shift() : answers[0];
  if (answer === undefined) throw new Error('no answer');
  return answer;
}

function jobOf(answer: JobAnswer, id: Hex, hash: Hash): RelayJob {
  if (answer instanceof Error) throw answer;
  return typeof answer === 'string' ? { id, state: answer, txHash: hash } : answer;
}

/**
 * A submitter over stub services. The stub relay answers each submission with a job whose id is its digest; the stub
 * backend signs under the real vault rule (`planRelaySignature`) with the relay key.
 */
function harness(extra: Partial<RelaySubmitterOptions> = {}): Harness {
  const clock = { ms: START_MS };
  const state: Omit<Harness, 'submitter' | 'options'> = {
    accounts: [relayAccount()],
    posts: ['succeeded'],
    jobs: [],
    submissions: [],
    signRequests: [],
    accountQueries: [],
    jobQueries: [],
    sleeps: [],
    events: [],
    clock
  };
  const options: RelaySubmitterOptions = {
    chain: CHAIN,
    address: RELAY,
    sign: async (request: RelaySignRequest): Promise<RelaySignResult> => {
      state.signRequests.push(request);
      state.events.push(`sign:${request.op}`);
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
      state.events.push('account');
      const answer = next(state.accounts);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    postRelay: async submission => {
      state.submissions.push(submission);
      state.events.push('post');
      return jobOf(next(state.posts), digestOf(submission), hashOf('a1'));
    },
    fetchJob: async query => {
      state.jobQueries.push(query);
      state.events.push(`job:${query.id === OTHER_JOB ? 'other' : 'own'}`);
      return jobOf(next(state.jobs), query.id, hashOf('f1'));
    },
    now: () => clock.ms,
    sleep: async ms => {
      state.sleeps.push(ms);
      clock.ms += ms;
    },
    ...extra
  };
  // The stubs read `state`, so a test changes their answers through the returned object.
  return Object.assign(state, { options, submitter: createRelaySubmitter(options) });
}

/** Submit options whose hooks write to the event log; `onJob` also keeps each job. */
function hooks(h: Harness, extra: RelaySubmitOptions = {}): RelaySubmitOptions & { refs: RelayJobRef[] } {
  const refs: RelayJobRef[] = [];
  return {
    refs,
    beforeSign: async () => {
      h.events.push('beforeSign');
    },
    onJob: async job => {
      refs.push(job);
      h.events.push('onJob');
    },
    ...extra
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error
  );
}

const CALL: BatchCall = { to: TARGET, value: 0n, data: '0xcafe0001' };
const APPROVE: BatchCall = {
  to: USDC,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TARGET, 5n] })
};

function submitted(h: Harness, index = 0): RelaySubmission {
  const submission = h.submissions[index];
  if (submission === undefined) throw new Error(`no submission ${index}`);
  return submission;
}

function refOf(h: Harness, index = 0): RelayJobRef {
  return { chainId: CHAIN.chainId, id: digestOf(submitted(h, index)), deadline: Number(submitted(h, index).deadline) };
}

describe('createRelaySubmitter', () => {
  it('refuses a relay address that is not an address', () => {
    expect(() => createRelaySubmitter({ ...harness().options, address: '0x12' })).toThrow(TypeError);
  });

  it('keeps the chain and the relay address in lower case', () => {
    const { submitter } = harness({ address: upperHex(RELAY) });
    expect(submitter.address).toBe(RELAY);
    expect(submitter.chainId).toBe(CHAIN.chainId);
  });
});

describe('submit', () => {
  it('relays the calls in sponsor mode and gives the id and the final hash', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = ['pending', 'succeeded'];

    const result = await h.submitter.submit([APPROVE, CALL]);

    const submission = submitted(h);
    expect(result).toEqual({ id: digestOf(submission), hash: hashOf('f1') });
    expect(h.sleeps).toEqual([RELAY_POLL_MS, RELAY_POLL_MS]);
    expect(submission.calls).toEqual([APPROVE, CALL]);
    expect(submission).toMatchObject({
      chainId: CHAIN.chainId,
      evmAddress: RELAY,
      batchNonce: batchNonceOf(3n),
      salt: SALT,
      deadline: BigInt(DEADLINE)
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
    expect(await h.submitter.submit([CALL])).toEqual({ id: digestOf(submitted(h)), hash: hashOf('a1') });
    expect(h.sleeps).toEqual([]);
  });

  it('reads, checks, signs, records the job and only then posts', async () => {
    const h = harness();
    h.accounts = [relayAccount({ needsAuthorization: true, authorizationNonce: 4 })];
    const options = hooks(h);
    await h.submitter.submit([CALL], options);
    expect(h.events).toEqual(['account', 'beforeSign', 'sign:authorization', 'sign:batch', 'onJob', 'post']);
    expect(options.refs).toEqual([refOf(h)]);
    expect(options.refs[0]?.deadline).toBe(DEADLINE);
  });

  it('signs nothing when beforeSign throws', async () => {
    const h = harness();
    const stop = new Error('the quote expired');
    const error = await failure(h.submitter.submit([CALL], hooks(h, { beforeSign: () => Promise.reject(stop) })));
    expect(error).toBe(stop);
    expect(h.signRequests).toHaveLength(0);
    expect(h.submissions).toHaveLength(0);
  });

  it('posts nothing when onJob throws', async () => {
    const h = harness();
    const stop = new Error('the store is full');
    const error = await failure(h.submitter.submit([CALL], hooks(h, { onJob: () => Promise.reject(stop) })));
    expect(error).toBe(stop);
    expect(h.signRequests.map(request => request.op)).toEqual(['batch']);
    expect(h.submissions).toHaveLength(0);
  });

  it('normalizes the case of targets and calldata', async () => {
    const h = harness();
    await h.submitter.submit([{ to: upperHex(TARGET), value: 0n, data: upperHex(CALL.data) }]);
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
  ])('refuses %s with a TypeError and reads nothing', async (_name, calls) => {
    const h = harness();
    expect(await failure(h.submitter.submit(calls))).toBeInstanceOf(TypeError);
    expect(h.accountQueries).toHaveLength(0);
  });

  it('takes 8 calls in sponsor mode', async () => {
    const h = harness();
    await h.submitter.submit(Array.from({ length: MAX_RELAY_BATCH_CALLS }, () => CALL));
    expect(submitted(h).calls).toHaveLength(MAX_RELAY_BATCH_CALLS);
  });

  it('runs one relay at a time, and a failed relay does not stop the next', async () => {
    const h = harness();
    h.posts = [new RelayApiError('fee_too_low', 400, 'low'), 'succeeded'];
    const first = failure(h.submitter.submit([CALL]));
    const second = h.submitter.submit([APPROVE]);
    expect(await first).toMatchObject({ code: 'fee_too_low' });
    expect((await second).hash).toBe(hashOf('a1'));
    expect(h.submissions.map(submission => submission.calls)).toEqual([[CALL], [APPROVE]]);
  });
});

describe('deduct mode', () => {
  it('pays exactly the reviewed fee last, to the configured fee recipient', async () => {
    const h = harness();
    h.accounts = [deductAccount()];
    await h.submitter.submit([CALL], { fee: { token: upperHex(USDC), amount: 1200n } });
    expect(submitted(h).calls).toEqual([CALL, buildFeeCall({ token: USDC, recipient: FEE_RECIPIENT, amount: 1200n })]);
  });

  it('pays a native fee with a plain transfer', async () => {
    const h = harness({ chain: { ...CHAIN, maxFee: { [NATIVE]: '100' } } });
    h.accounts = [deductAccount({ feeTokens: [NATIVE] })];
    await h.submitter.submit([CALL], { fee: { token: NATIVE, amount: 100n } });
    expect(submitted(h).calls[1]).toEqual({ to: FEE_RECIPIENT, value: 100n, data: '0x' });
  });

  it('refuses 8 calls, since the fee call needs a place', async () => {
    const h = harness();
    h.accounts = [deductAccount()];
    const calls = Array.from({ length: MAX_RELAY_BATCH_CALLS }, () => CALL);
    const error = await failure(h.submitter.submit(calls, { fee: USDC_FEE }));
    expect(error).toMatchObject({ name: 'RelayRefusedError', reason: 'too-many-calls' });
    expect(h.signRequests).toHaveLength(0);
  });

  it.each<[string, RelayAccount, RelayReviewedFee | undefined, string]>([
    ['no reviewed fee', deductAccount(), undefined, 'no-reviewed-fee'],
    [
      'a fee token that the relay does not take',
      deductAccount({ feeTokens: [USDC] }),
      { token: NATIVE, amount: 1000n },
      'no-fee'
    ],
    ['a reviewed fee above the config cap', deductAccount(), { token: USDC, amount: 50_001n }, 'fee-not-accepted'],
    ['a reviewed fee of 0', deductAccount(), { token: USDC, amount: 0n }, 'fee-not-accepted'],
    ['a fee token without a config cap', deductAccount(), { token: NATIVE, amount: 1n }, 'fee-not-accepted']
  ])('refuses %s and signs nothing', async (_name, account, fee, reason) => {
    const h = harness();
    h.accounts = [account];
    const error = await failure(h.submitter.submit([CALL], { fee }));
    expect(error).toBeInstanceOf(RelayRefusedError);
    expect(error).toMatchObject({ reason });
    expect(h.signRequests).toHaveLength(0);
  });

  it('refuses a reviewed fee in sponsor mode', async () => {
    const h = harness();
    const error = await failure(h.submitter.submit([CALL], { fee: USDC_FEE }));
    expect(error).toMatchObject({ name: 'RelayRefusedError', reason: 'unexpected-fee' });
    expect(h.signRequests).toHaveLength(0);
  });

  it('refuses a reviewed fee token that is not an address before any read', async () => {
    const h = harness();
    expect(await failure(h.submitter.submit([CALL], { fee: { token: '0x12', amount: 1n } }))).toBeInstanceOf(TypeError);
    expect(h.accountQueries).toHaveLength(0);
  });

  it('refuses an account that names another fee recipient', async () => {
    const h = harness();
    h.accounts = [deductAccount({ feeRecipient: TARGET })];
    expect(await failure(h.submitter.submit([CALL], { fee: USDC_FEE }))).toBeInstanceOf(RelayMismatchError);
    expect(h.signRequests).toHaveLength(0);
  });

  it('refuses deduct mode on a chain without a configured fee recipient', async () => {
    const h = harness({ chain: { ...CHAIN, feeRecipient: undefined } });
    h.accounts = [deductAccount()];
    expect(await failure(h.submitter.submit([CALL], { fee: USDC_FEE }))).toMatchObject({
      name: 'RelayMismatchError',
      message: 'relay: the chain does not take deduct mode'
    });
    expect(h.signRequests).toHaveLength(0);
  });

  it('passes on fee_too_low with the required fee, signs no higher fee and posts nothing more', async () => {
    const h = harness();
    h.accounts = [deductAccount()];
    const low = new RelayFeeTooLowError(400, 'low', 1500n, USDC);
    h.posts = [low];
    const error = await failure(h.submitter.submit([CALL], { fee: USDC_FEE }));
    expect(error).toBe(low);
    expect(error).toMatchObject({ required: 1500n, token: USDC });
    expect(relayErrorAction(error)).toBe('review-again');
    expect(h.signRequests).toHaveLength(1);
    expect(h.submissions).toHaveLength(1);
    expect(h.jobQueries).toHaveLength(0);
    expect(submitted(h).calls[1]).toEqual(buildFeeCall({ token: USDC, recipient: FEE_RECIPIENT, amount: 1000n }));
  });

  describe('signs the same reviewed fee on each retry', () => {
    const FEE_CALL = buildFeeCall({ token: USDC, recipient: FEE_RECIPIENT, amount: 1000n });

    it.each<[string, RelayAccount[], JobAnswer[], JobAnswer[]]>([
      [
        'stale_request',
        [deductAccount({ sequence: 3n }), deductAccount({ sequence: 4n })],
        [new RelayApiError('stale_request', 409, 'stale'), 'succeeded'],
        []
      ],
      [
        'simulation_failed with a new sequence',
        [deductAccount({ sequence: 3n }), deductAccount({ sequence: 4n })],
        [new RelayApiError('simulation_failed', 409, 'reverts'), 'succeeded'],
        []
      ],
      [
        'busy',
        [deductAccount()],
        [new RelayApiError('busy', 409, 'busy', undefined, OTHER_JOB), 'succeeded'],
        ['succeeded']
      ]
    ])('after %s', async (_name, accounts, posts, jobs) => {
      const h = harness();
      h.accounts = accounts;
      h.posts = posts;
      h.jobs = jobs;
      expect((await h.submitter.submit([CALL], { fee: USDC_FEE })).hash).toBe(hashOf('a1'));
      expect(h.submissions).toHaveLength(2);
      expect(h.submissions.map(submission => submission.calls)).toEqual([
        [CALL, FEE_CALL],
        [CALL, FEE_CALL]
      ]);
    });
  });
});

describe('allowed targets', () => {
  it('relays calls to allowed targets, the fee call excepted', async () => {
    const h = harness();
    h.accounts = [deductAccount({ allowedTargets: [TARGET] })];
    await h.submitter.submit([CALL], { fee: USDC_FEE });
    expect(submitted(h).calls).toHaveLength(2);
  });

  it('refuses a call to a target that the relayer does not allow', async () => {
    const h = harness();
    h.accounts = [relayAccount({ allowedTargets: [USDC] })];
    const error = await failure(h.submitter.submit([CALL]));
    expect(error).toMatchObject({ name: 'RelayRefusedError', reason: 'target-not-allowed' });
    expect(h.signRequests).toHaveLength(0);
  });
});

describe('the answers it does not trust', () => {
  it('refuses an account with another executor and signs nothing', async () => {
    const h = harness();
    h.accounts = [relayAccount({ executor: FEE_RECIPIENT })];
    expect(await failure(h.submitter.submit([CALL]))).toBeInstanceOf(RelayMismatchError);
    expect(h.signRequests).toHaveLength(0);
  });

  it('refuses a read of another job while it waits', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = [{ id: OTHER_JOB, state: 'succeeded', txHash: hashOf('f1') }];
    expect(await failure(h.submitter.submit([CALL]))).toBeInstanceOf(RelayMismatchError);
  });

  it('refuses a batch signature over another digest and posts nothing', async () => {
    const h = harness();
    const submitter = createRelaySubmitter({
      ...h.options,
      sign: async (): Promise<RelaySignResult> => ({ op: 'batch', digest: OTHER_JOB, signature: hashOf('0c') })
    });
    expect(await failure(submitter.submit([CALL]))).toMatchObject({
      name: 'RelayMismatchError',
      message: 'relay: the backend signed another batch'
    });
    expect(h.submissions).toHaveLength(0);
  });

  it('refuses an authorization answer to a batch request', async () => {
    const h = harness();
    const submitter = createRelaySubmitter({
      ...h.options,
      sign: async (): Promise<RelaySignResult> => ({
        op: 'authorization',
        authorization: { address: CHAIN.calibur.address, chainId: 8453, nonce: 0, r: SALT, s: SALT, yParity: 0 }
      })
    });
    expect(await failure(submitter.submit([CALL]))).toBeInstanceOf(RelayMismatchError);
  });
});

describe('EIP-7702 authorization', () => {
  it('signs the authorization first when the address does not delegate yet, and sends it', async () => {
    const h = harness();
    h.accounts = [relayAccount({ needsAuthorization: true, authorizationNonce: 4 })];
    await h.submitter.submit([CALL]);
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
    const submitter = createRelaySubmitter({ ...h.options, sign: async () => answer });
    expect(await failure(submitter.submit([CALL]))).toMatchObject({
      name: 'RelayMismatchError',
      message: 'relay: the backend signed another authorization'
    });
    expect(h.submissions).toHaveLength(0);
  });
});

describe('the final states', () => {
  it('rejects a reverted job with its id and hash', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = ['reverted'];
    const error = await failure(h.submitter.submit([CALL]));
    expect(error).toBeInstanceOf(RelayRevertedError);
    expect(error).toMatchObject({ id: digestOf(submitted(h)), txHash: hashOf('f1') });
  });

  it('rejects a job that the relay answers reverted at once', async () => {
    const h = harness();
    h.posts = ['reverted'];
    expect(await failure(h.submitter.submit([CALL]))).toMatchObject({
      name: 'RelayRevertedError',
      txHash: hashOf('a1')
    });
  });

  it('rejects an expired job with its id and the cancel hash', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = ['expired'];
    const error = await failure(h.submitter.submit([CALL]));
    expect(error).toBeInstanceOf(RelayExpiredError);
    expect(error).toMatchObject({ id: digestOf(submitted(h)), txHash: hashOf('f1') });
  });

  it('stops after 10 minutes with the job and the last hash, and signs nothing more', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = ['pending'];
    const error = await failure(h.submitter.submit([CALL]));
    expect(error).toBeInstanceOf(RelayStillPendingError);
    expect(error).toMatchObject({ job: refOf(h), id: digestOf(submitted(h)), txHash: hashOf('f1') });
    expect(h.jobQueries).toHaveLength(RELAY_WAIT_MS / RELAY_POLL_MS);
    expect(h.clock.ms - START_MS).toBe(RELAY_WAIT_MS);
    expect(h.signRequests).toHaveLength(1);
  });

  it('keeps the wait through passing read failures and honours a retryAfter', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = [
      new RelayUnavailableError('network', 'down'),
      new RelayApiError('rate_limited', 429, 'slow', 20),
      new RelayApiError('service_unavailable', 503, 'later', 1),
      'succeeded'
    ];
    expect((await h.submitter.submit([CALL])).hash).toBe(hashOf('f1'));
    expect(h.sleeps).toEqual([RELAY_POLL_MS, RELAY_POLL_MS, 20_000, RELAY_POLL_MS]);
  });

  it('ends the wait on a read failure that is not passing', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = [new RelayApiError('bad_signature', 400, 'no')];
    expect(await failure(h.submitter.submit([CALL]))).toMatchObject({ code: 'bad_signature' });
  });

  it('gives the job back as not known when the relay forgets it during the wait', async () => {
    const h = harness();
    h.posts = ['pending'];
    const gone = new RelayApiError('not_found', 404, 'gone');
    h.jobs = [gone];
    const error = await failure(h.submitter.submit([CALL]));
    expect(error).toBeInstanceOf(RelayUnknownOutcomeError);
    expect(error).toMatchObject({ job: refOf(h), cause: gone });
  });
});

describe('a POST whose outcome is not known', () => {
  const unknown: [string, Error][] = [
    ['a network failure', new RelayUnavailableError('network', 'down')],
    ['a timeout', new RelayUnavailableError('timeout', 'slow')],
    ['an answer that does not parse', new RelayUnavailableError('bad_response', 'garbage')],
    ['internal_error', new RelayApiError('internal_error', 500, 'boom')],
    ['service_unavailable', new RelayApiError('service_unavailable', 503, 'broken')],
    ['rpc_unavailable', new RelayApiError('rpc_unavailable', 502, 'rpc')],
    ['a code this build does not know', new RelayApiError('unknown_error', 400, 'new')],
    ['an error of another kind', new Error('plain')]
  ];

  it.each(unknown)('reads the job after %s and follows it when the relay has it', async (_name, error) => {
    const h = harness();
    h.posts = [error];
    h.jobs = ['pending', 'succeeded'];
    const options = hooks(h);
    const result = await h.submitter.submit([CALL], options);
    expect(result).toEqual({ id: digestOf(submitted(h)), hash: hashOf('f1') });
    expect(h.events).toEqual(['account', 'beforeSign', 'sign:batch', 'onJob', 'post', 'job:own', 'job:own']);
    expect(h.submissions).toHaveLength(1);
  });

  it.each(unknown)('signs nothing more after %s when the relay does not have the job', async (_name, error) => {
    const h = harness();
    h.posts = [error];
    h.jobs = [new RelayApiError('not_found', 404, 'no')];
    const result = await failure(h.submitter.submit([CALL]));
    expect(result).toBeInstanceOf(RelayUnknownOutcomeError);
    expect(result).toMatchObject({ job: refOf(h), id: digestOf(submitted(h)), cause: error });
    expect(h.signRequests).toHaveLength(1);
    expect(h.submissions).toHaveLength(1);
  });

  it('gives the job back as not known when the read fails too', async () => {
    const h = harness();
    h.posts = [new RelayUnavailableError('timeout', 'slow')];
    h.jobs = [new RelayUnavailableError('network', 'down')];
    expect(await failure(h.submitter.submit([CALL]))).toBeInstanceOf(RelayUnknownOutcomeError);
    expect(h.submissions).toHaveLength(1);
  });

  it('reads its own job when the answer names another job', async () => {
    const h = harness();
    h.posts = [{ id: OTHER_JOB, state: 'succeeded', txHash: hashOf('a1') }];
    h.jobs = ['succeeded'];
    expect(await h.submitter.submit([CALL])).toEqual({ id: digestOf(submitted(h)), hash: hashOf('f1') });
    expect(h.jobQueries).toEqual([{ id: digestOf(submitted(h)), chainId: CHAIN.chainId }]);
  });

  it('passes on a missing base URL at once: no request was sent', async () => {
    const h = harness();
    const missing = new RelayUnavailableError('not_configured', 'off');
    h.posts = [missing];
    expect(await failure(h.submitter.submit([CALL]))).toBe(missing);
    expect(h.jobQueries).toHaveLength(0);
  });

  it.each([
    new RelayApiError('invalid_request', 400, 'bad'),
    new RelayApiError('fee_too_low', 400, 'low'),
    new RelayApiError('target_not_allowed', 400, 'no'),
    new RelayApiError('bad_signature', 400, 'no'),
    new RelayApiError('relayer_unfunded', 503, 'empty'),
    new RelayApiError('rate_limited', 429, 'slow', 60)
  ])('passes on the refusal %p without a read or a retry', async error => {
    const h = harness();
    h.posts = [error];
    expect(await failure(h.submitter.submit([CALL]))).toBe(error);
    expect(h.submissions).toHaveLength(1);
    expect(h.jobQueries).toHaveLength(0);
  });
});

describe('retries', () => {
  const stale = new RelayApiError('stale_request', 409, 'stale');
  const reverts = new RelayApiError('simulation_failed', 409, 'reverts');
  const busy = new RelayApiError('busy', 409, 'busy', undefined, OTHER_JOB);

  it('reads, checks the review, signs and records a new job after stale_request, at most 2 times', async () => {
    const h = harness();
    h.accounts = [relayAccount({ sequence: 3n }), relayAccount({ sequence: 4n }), relayAccount({ sequence: 5n })];
    h.posts = [stale, stale, 'succeeded'];
    const options = hooks(h);
    expect((await h.submitter.submit([CALL], options)).hash).toBe(hashOf('a1'));
    const attempt = ['account', 'beforeSign', 'sign:batch', 'onJob', 'post'];
    expect(h.events).toEqual([...attempt, ...attempt, ...attempt]);
    expect(h.submissions.map(submission => submission.batchNonce)).toEqual([
      batchNonceOf(3n),
      batchNonceOf(4n),
      batchNonceOf(5n)
    ]);
    expect(options.refs.map(ref => ref.id)).toEqual([0, 1, 2].map(index => digestOf(submitted(h, index))));
  });

  it('gives up after the third stale_request', async () => {
    const h = harness();
    h.posts = [stale];
    expect(await failure(h.submitter.submit([CALL]))).toBe(stale);
    expect(h.submissions).toHaveLength(3);
  });

  it('signs nothing more when the review no longer holds on a retry', async () => {
    const h = harness();
    h.posts = [stale];
    let reviews = 0;
    const outdated = new Error('the quote changed');
    const beforeSign = async () => {
      reviews += 1;
      if (reviews > 1) throw outdated;
    };
    expect(await failure(h.submitter.submit([CALL], { beforeSign }))).toBe(outdated);
    expect(h.signRequests).toHaveLength(1);
    expect(h.submissions).toHaveLength(1);
  });

  it('signs again after simulation_failed when a fresh read shows a new sequence', async () => {
    const h = harness();
    h.accounts = [relayAccount({ sequence: 3n }), relayAccount({ sequence: 4n })];
    h.posts = [reverts, 'succeeded'];
    expect((await h.submitter.submit([CALL], hooks(h))).hash).toBe(hashOf('a1'));
    const attempt = ['beforeSign', 'sign:batch', 'onJob', 'post'];
    expect(h.events).toEqual(['account', ...attempt, 'account', ...attempt]);
    expect(h.submissions.map(submission => submission.batchNonce)).toEqual([batchNonceOf(3n), batchNonceOf(4n)]);
  });

  it('passes on simulation_failed when the sequence is the same', async () => {
    const h = harness();
    h.posts = [reverts];
    expect(await failure(h.submitter.submit([CALL]))).toBe(reverts);
    expect(h.accountQueries).toHaveLength(2);
    expect(h.submissions).toHaveLength(1);
  });

  it('passes on simulation_failed when the fresh read fails', async () => {
    const h = harness();
    h.accounts = [relayAccount(), new RelayUnavailableError('network', 'down')];
    h.posts = [reverts];
    expect(await failure(h.submitter.submit([CALL]))).toBe(reverts);
    expect(h.submissions).toHaveLength(1);
  });

  it('counts simulation_failed retries with the stale_request retries', async () => {
    const h = harness();
    h.accounts = [relayAccount({ sequence: 3n }), relayAccount({ sequence: 4n }), relayAccount({ sequence: 5n })];
    h.posts = [stale, stale, reverts];
    expect(await failure(h.submitter.submit([CALL]))).toBe(reverts);
    expect(h.submissions).toHaveLength(3);
    expect(h.accountQueries).toHaveLength(3);
  });

  it('waits for the open job of busy, then reads, checks the review and signs again once', async () => {
    const h = harness();
    h.posts = [busy, 'succeeded'];
    h.jobs = ['pending', 'succeeded'];
    const options = hooks(h);
    expect((await h.submitter.submit([CALL], options)).hash).toBe(hashOf('a1'));
    const attempt = ['beforeSign', 'sign:batch', 'onJob', 'post'];
    expect(h.events).toEqual(['account', ...attempt, 'job:other', 'job:other', 'account', ...attempt]);
    expect(h.jobQueries).toEqual([
      { id: OTHER_JOB, chainId: CHAIN.chainId },
      { id: OTHER_JOB, chainId: CHAIN.chainId }
    ]);
    expect(options.refs).toHaveLength(2);
  });

  it.each<[string, JobAnswer]>([
    ['reverted', { id: OTHER_JOB, state: 'reverted', txHash: hashOf('f1') }],
    ['expired', { id: OTHER_JOB, state: 'expired', txHash: hashOf('f1') }],
    ['gone', new RelayApiError('not_found', 404, 'gone')]
  ])('starts again when the open job is %s', async (_name, answer) => {
    const h = harness();
    h.posts = [busy, 'succeeded'];
    h.jobs = [answer];
    expect((await h.submitter.submit([CALL])).hash).toBe(hashOf('a1'));
    expect(h.submissions).toHaveLength(2);
  });

  it('passes on busy when the open job is still pending after the wait limit', async () => {
    const h = harness();
    h.posts = [busy];
    h.jobs = ['pending'];
    expect(await failure(h.submitter.submit([CALL]))).toBe(busy);
    expect(h.submissions).toHaveLength(1);
    expect(h.clock.ms - START_MS).toBe(RELAY_WAIT_MS);
  });

  it('passes on a failure of the wait for the open job', async () => {
    const h = harness();
    h.posts = [busy];
    h.jobs = [new RelayApiError('bad_signature', 400, 'no')];
    expect(await failure(h.submitter.submit([CALL]))).toMatchObject({ code: 'bad_signature' });
    expect(h.submissions).toHaveLength(1);
  });

  it('gives up on a second busy', async () => {
    const h = harness();
    h.posts = [busy];
    h.jobs = ['succeeded'];
    expect(await failure(h.submitter.submit([CALL]))).toBe(busy);
    expect(h.submissions).toHaveLength(2);
  });

  it('gives up on a busy without the id of the open job', async () => {
    const h = harness();
    const anonymous = new RelayApiError('busy', 409, 'busy');
    h.posts = [anonymous];
    expect(await failure(h.submitter.submit([CALL]))).toBe(anonymous);
    expect(h.submissions).toHaveLength(1);
    expect(h.jobQueries).toHaveLength(0);
  });

  it('does not sign again for a stale_request code from a job read', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = [stale];
    expect(await failure(h.submitter.submit([CALL]))).toBe(stale);
    expect(h.signRequests).toHaveLength(1);
  });
});

describe('resume', () => {
  const JOB: RelayJobRef = { chainId: CHAIN.chainId, id: OTHER_JOB, deadline: START_SECONDS - 60 };
  const notFound = new RelayApiError('not_found', 404, 'no');

  it('gives the final hash of a job that succeeded', async () => {
    const h = harness();
    h.jobs = ['succeeded'];
    expect(await h.submitter.resume({ ...JOB, id: upperHex(OTHER_JOB) })).toEqual({
      id: OTHER_JOB,
      hash: hashOf('f1')
    });
    expect(h.jobQueries).toEqual([{ id: OTHER_JOB, chainId: CHAIN.chainId }]);
    expect(h.signRequests).toHaveLength(0);
  });

  it('follows a pending job to its final state', async () => {
    const h = harness();
    h.jobs = ['pending', 'pending', 'succeeded'];
    expect((await h.submitter.resume(JOB)).hash).toBe(hashOf('f1'));
    expect(h.sleeps).toEqual([RELAY_POLL_MS, RELAY_POLL_MS]);
  });

  it.each<[RelayJobState, string]>([
    ['reverted', 'RelayRevertedError'],
    ['expired', 'RelayExpiredError']
  ])('rejects a %s job', async (state, name) => {
    const h = harness();
    h.jobs = [state];
    expect(await failure(h.submitter.resume(JOB))).toMatchObject({ name, id: OTHER_JOB, txHash: hashOf('f1') });
  });

  it('rejects a job that is still pending after the wait limit with the job', async () => {
    const h = harness();
    h.jobs = ['pending'];
    expect(await failure(h.submitter.resume(JOB))).toMatchObject({ name: 'RelayStillPendingError', job: JOB });
  });

  it.each([
    ['before the deadline', START_SECONDS + 600],
    ['in the grace time after the deadline', START_SECONDS - 60],
    ['at the end of the grace time', START_SECONDS - RELAY_RESUME_GRACE_SECONDS]
  ])('keeps an unknown job unknown %s', async (_name, deadline) => {
    const h = harness();
    h.jobs = [notFound];
    const error = await failure(h.submitter.resume({ ...JOB, deadline }));
    expect(error).toBeInstanceOf(RelayUnknownOutcomeError);
    expect(error).toMatchObject({ job: { ...JOB, deadline }, cause: notFound });
  });

  it('reports an unknown job as not submitted after the grace time', async () => {
    const h = harness();
    h.jobs = [notFound];
    const deadline = START_SECONDS - RELAY_RESUME_GRACE_SECONDS - 1;
    const error = await failure(h.submitter.resume({ ...JOB, deadline }));
    expect(error).toBeInstanceOf(RelayNotSubmittedError);
    expect(error).toMatchObject({ job: { ...JOB, deadline }, id: OTHER_JOB });
  });

  it.each<[string, JobAnswer]>([
    ['a failed read', new RelayUnavailableError('network', 'down')],
    ['an answer for another job', { id: hashOf('0c'), state: 'succeeded', txHash: hashOf('f1') }]
  ])('keeps the job unknown after %s, also long after the deadline', async (_name, answer) => {
    const h = harness();
    h.jobs = [answer];
    const error = await failure(h.submitter.resume({ ...JOB, deadline: 0 }));
    expect(error).toBeInstanceOf(RelayUnknownOutcomeError);
  });

  it.each<[string, RelayJobRef]>([
    ['another chain', { ...JOB, chainId: 1 }],
    ['an id that is not a hash', { ...JOB, id: '0x12' }],
    ['a deadline that is not an integer', { ...JOB, deadline: 1.5 }],
    ['a negative deadline', { ...JOB, deadline: -1 }]
  ])('refuses a job with %s and reads nothing', async (_name, job) => {
    const h = harness();
    expect(await failure(h.submitter.resume(job))).toBeInstanceOf(TypeError);
    expect(h.jobQueries).toHaveLength(0);
  });

  it('follows the job that a submit recorded before its answer was lost', async () => {
    const h = harness();
    h.posts = [new RelayUnavailableError('timeout', 'slow')];
    h.jobs = [notFound];
    const options = hooks(h);
    expect(await failure(h.submitter.submit([CALL], options))).toBeInstanceOf(RelayUnknownOutcomeError);
    const [recorded] = options.refs;
    if (recorded === undefined) throw new Error('no job recorded');
    h.jobs = ['succeeded'];
    expect(await h.submitter.resume(recorded)).toEqual({ id: recorded.id, hash: hashOf('f1') });
    expect(recorded).toEqual({ chainId: CHAIN.chainId, id: digestOf(submitted(h)), deadline: DEADLINE });
  });
});

describe('check', () => {
  const JOB: RelayJobRef = { chainId: CHAIN.chainId, id: OTHER_JOB, deadline: START_SECONDS - 60 };
  const notFound = new RelayApiError('not_found', 404, 'no');

  it.each<RelayJobState>(['succeeded', 'reverted', 'expired', 'pending'])(
    'gives a %s job with its hash after one read, with no wait and no signature',
    async state => {
      const h = harness();
      h.jobs = [state];
      expect(await h.submitter.check({ ...JOB, id: upperHex(OTHER_JOB) })).toEqual({ state, hash: hashOf('f1') });
      expect(h.jobQueries).toEqual([{ id: OTHER_JOB, chainId: CHAIN.chainId }]);
      expect(h.sleeps).toHaveLength(0);
      expect(h.signRequests).toHaveLength(0);
    }
  );

  it.each([
    ['before the deadline', START_SECONDS + 600],
    ['at the end of the grace time', START_SECONDS - RELAY_RESUME_GRACE_SECONDS]
  ])('keeps a job that the relay does not know unknown %s', async (_name, deadline) => {
    const h = harness();
    h.jobs = [notFound];
    expect(await h.submitter.check({ ...JOB, deadline })).toEqual({ state: 'unknown', cause: notFound });
  });

  it('reports a job that the relay does not know as not submitted one second after the grace time', async () => {
    const h = harness();
    h.jobs = [notFound];
    const deadline = START_SECONDS - RELAY_RESUME_GRACE_SECONDS - 1;
    expect(await h.submitter.check({ ...JOB, deadline })).toEqual({ state: 'not-submitted' });
  });

  it.each<[string, JobAnswer]>([
    ['a failed read', new RelayUnavailableError('network', 'down')],
    ['an answer for another job id', { id: hashOf('0c'), state: 'succeeded', txHash: hashOf('f1') }]
  ])('keeps the job unknown after %s, also long after the deadline', async (_name, answer) => {
    const h = harness();
    h.jobs = [answer];
    const checked = await h.submitter.check({ ...JOB, deadline: 0 });
    expect(checked.state).toBe('unknown');
  });

  it('gives the guard error of an answer for another job as the cause', async () => {
    const h = harness();
    h.jobs = [{ id: hashOf('0c'), state: 'succeeded', txHash: hashOf('f1') }];
    expect(await h.submitter.check(JOB)).toEqual({ state: 'unknown', cause: expect.any(RelayMismatchError) });
  });

  it.each<[string, RelayJobRef]>([
    ['another chain', { ...JOB, chainId: 1 }],
    ['an id that is not a hash', { ...JOB, id: '0x12' }],
    ['a deadline that is not an integer', { ...JOB, deadline: 1.5 }]
  ])('refuses a job with %s and reads nothing', async (_name, job) => {
    const h = harness();
    expect(await failure(h.submitter.check(job))).toBeInstanceOf(TypeError);
    expect(h.jobQueries).toHaveLength(0);
  });
});

describe('the open jobs of a submit', () => {
  it('reports a job whose outcome is not known to a watch of its chain and address only', async () => {
    const h = harness();
    h.posts = [new RelayUnavailableError('timeout', 'slow')];
    h.jobs = [new RelayApiError('not_found', 404, 'no')];
    const own = watchOpenRelayJobs(CHAIN.chainId, upperHex(RELAY));
    const otherChain = watchOpenRelayJobs(1, RELAY);
    const otherAddress = watchOpenRelayJobs(CHAIN.chainId, TARGET);
    expect(await failure(h.submitter.submit([CALL]))).toBeInstanceOf(RelayUnknownOutcomeError);
    expect(own.jobs()).toEqual([refOf(h)]);
    expect(otherChain.jobs()).toEqual([]);
    expect(otherAddress.jobs()).toEqual([]);
    [own, otherChain, otherAddress].forEach(watch => watch.stop());
  });

  it('reports a job that is still pending after the wait limit', async () => {
    const h = harness();
    h.posts = ['pending'];
    h.jobs = ['pending'];
    const watch = watchOpenRelayJobs(CHAIN.chainId, RELAY);
    expect(await failure(h.submitter.submit([CALL]))).toBeInstanceOf(RelayStillPendingError);
    expect(watch.jobs()).toEqual([refOf(h)]);
    watch.stop();
  });

  it('reports no final job and no refusal, and nothing after the watch stops', async () => {
    const h = harness();
    h.posts = ['reverted'];
    const watch = watchOpenRelayJobs(CHAIN.chainId, RELAY);
    expect(await failure(h.submitter.submit([CALL]))).toBeInstanceOf(RelayRevertedError);
    h.posts = [new RelayApiError('bad_signature', 400, 'no')];
    expect(await failure(h.submitter.submit([CALL]))).toMatchObject({ code: 'bad_signature' });
    expect(watch.jobs()).toEqual([]);
    watch.stop();
    h.posts = [new RelayUnavailableError('timeout', 'slow')];
    h.jobs = [new RelayApiError('not_found', 404, 'no')];
    expect(await failure(h.submitter.submit([CALL]))).toBeInstanceOf(RelayUnknownOutcomeError);
    expect(watch.jobs()).toEqual([]);
  });

  it('refuses a watch of an address that is not valid', () => {
    expect(() => watchOpenRelayJobs(CHAIN.chainId, '0x12')).toThrow(TypeError);
  });
});

/**
 * @jest-environment node
 */
import type { Address, Hex } from 'viem';

import type { RelaySignResult } from 'lib/shared/types';

import { batchDigest, batchNonceOf, type BatchCall } from './batch';
import { fetchRelayAccount, fetchRelayJob, submitRelay } from './client';
import { RELAY_DEADLINE_SECONDS, RELAY_POLL_MS, createRelaySubmitter } from './submit';
import { CHAIN, EXECUTOR, RELAY_ADDRESS, SALT } from './testing';
import type { RelayAccount } from './types';

// The submitter's default dependencies are the relay client, `Date.now` and `setTimeout`.
jest.mock('./client', () => ({
  ...jest.requireActual('./client'),
  fetchRelayAccount: jest.fn(),
  submitRelay: jest.fn(),
  fetchRelayJob: jest.fn()
}));

const NOW_SECONDS = 1_800_000_000;
const TARGET: Address = '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582';
const SIGNATURE: Hex = `0x${'c3'.repeat(65)}`;
const HASH: Hex = `0x${'7e'.repeat(32)}`;
const CALLS: BatchCall[] = [{ to: TARGET, value: 0n, data: '0x' }];

const ACCOUNT: RelayAccount = {
  chainId: CHAIN.chainId,
  address: RELAY_ADDRESS,
  mode: 'sponsor',
  executor: EXECUTOR,
  feeRecipient: null,
  needsAuthorization: false,
  authorizationNonce: 0,
  salt: SALT,
  sequence: 0n,
  fees: [],
  allowedTargets: null,
  balances: []
};

// The batch that the submitter builds at NOW_SECONDS for CALLS.
const DIGEST = batchDigest(
  CHAIN.calibur,
  {
    chainId: CHAIN.chainId,
    evmAddress: RELAY_ADDRESS,
    executor: EXECUTOR,
    batchNonce: batchNonceOf(0n),
    salt: SALT,
    deadline: BigInt(NOW_SECONDS + RELAY_DEADLINE_SECONDS)
  },
  CALLS
);

afterEach(() => {
  jest.useRealTimers();
});

it('uses the relay client and the real clock when the caller injects none', async () => {
  jest.useFakeTimers({ now: NOW_SECONDS * 1000 });
  const submitter = createRelaySubmitter({
    chain: CHAIN,
    address: RELAY_ADDRESS,
    sign: async (): Promise<RelaySignResult> => ({ op: 'batch', digest: DIGEST, signature: SIGNATURE })
  });
  jest.mocked(fetchRelayAccount).mockResolvedValue(ACCOUNT);
  jest.mocked(submitRelay).mockResolvedValue({ id: DIGEST, state: 'pending', txHash: HASH });
  jest.mocked(fetchRelayJob).mockResolvedValue({ id: DIGEST, state: 'succeeded', txHash: HASH });

  const sent = submitter.submit(CALLS);
  await jest.advanceTimersByTimeAsync(RELAY_POLL_MS);
  expect(await sent).toEqual({ id: DIGEST, hash: HASH });
  expect(fetchRelayAccount).toHaveBeenCalledWith({ chainId: CHAIN.chainId, address: RELAY_ADDRESS });
  expect(submitRelay).toHaveBeenCalledWith(expect.objectContaining({ calls: CALLS, signature: SIGNATURE }));
  expect(fetchRelayJob).toHaveBeenCalledWith({ id: DIGEST, chainId: CHAIN.chainId });

  expect(await submitter.resume({ chainId: CHAIN.chainId, id: DIGEST, deadline: NOW_SECONDS })).toEqual({
    id: DIGEST,
    hash: HASH
  });
});

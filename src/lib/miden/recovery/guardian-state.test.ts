import type { Signer } from '@openzeppelin/guardian-client';

import { guardianStateReadSigner } from './guardian-state';
import { RequestAuthPayload } from '../../../../node_modules/@openzeppelin/guardian-client/dist/auth-request';

const delegate: Signer = {
  publicKey: 'public',
  commitment: 'commitment',
  scheme: 'ecdsa',
  signRequest: jest.fn().mockResolvedValue('authenticated'),
  signAccountIdWithTimestamp: jest.fn().mockResolvedValue('legacy'),
  signCommitment: jest.fn().mockResolvedValue('transaction-signature')
};
const payload = RequestAuthPayload.fromRequest({ account_id: 'retained' });

beforeEach(() => jest.clearAllMocks());

it('authorizes one exact GET-state request and denies the client replay retry', async () => {
  const action = async () => {
    const signer = guardianStateReadSigner(delegate, 'retained', async () => {});
    const signature = await signer.signRequest?.('retained', 1, payload);
    await expect(Promise.resolve().then(() => signer.signRequest?.('retained', 2, payload))).rejects.toThrow();
    return signature;
  };
  await expect(action()).resolves.toBe('authenticated');
  expect(delegate.signRequest).toHaveBeenCalledTimes(1);
});

it.each([
  ['different account', 'other', payload],
  ['proposal payload', 'retained', RequestAuthPayload.fromRequest({ account_id: 'retained', transaction: 'payload' })]
])('never signs a %s through recovery authentication', async (_name, accountId, request) => {
  await expect(
    Promise.resolve().then(() =>
      guardianStateReadSigner(delegate, 'retained', async () => {}).signRequest?.(accountId, 1, request)
    )
  ).rejects.toThrow();
  expect(delegate.signRequest).not.toHaveBeenCalled();
});

it('never grants generic commitment or legacy authentication signatures', async () => {
  const invoke = async (kind: 'commitment' | 'legacy') => {
    const signer = guardianStateReadSigner(delegate, 'retained', async () => {});
    return kind === 'commitment' ? signer.signCommitment('tx') : signer.signAccountIdWithTimestamp('retained', 1);
  };
  await expect(invoke('commitment')).rejects.toThrow();
  await expect(invoke('legacy')).rejects.toThrow();
  expect(delegate.signCommitment).not.toHaveBeenCalled();
  expect(delegate.signAccountIdWithTimestamp).not.toHaveBeenCalled();
});

it('refuses a staged authentication after the live vault or binding changes', async () => {
  await expect(
    Promise.resolve().then(() =>
      guardianStateReadSigner(delegate, 'retained', async () => {
        throw new Error('retired');
      }).signRequest?.('retained', 1, payload)
    )
  ).rejects.toThrow();
  expect(delegate.signRequest).not.toHaveBeenCalled();
});

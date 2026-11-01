/** @jest-environment node */

import { WalletMessageType } from 'lib/shared/types';

import { checkpointFinancialChange, verifyFinancialRecovery } from './financial-writer';
import { getStorageHealth } from '../storage-health';

const mockPortRequest = jest.fn().mockResolvedValue({ type: WalletMessageType.FinancialRecoveryResponse });
const mockBackend = jest.fn().mockResolvedValue(undefined);
const mockBackendBridge = jest.fn((accountId: string, entry: unknown, _epoch: number) => mockBackend(accountId, entry));
let mockBackendInstalled = false;
jest.mock('lib/intercom/client', () => ({ createIntercomClient: () => ({ request: mockPortRequest }) }));
jest.mock('../back/store', () => ({
  withUnlocked: (operation: (state: { vault: { checkpointFinancialRecovery: typeof mockBackend } }) => Promise<void>) =>
    operation({ vault: { checkpointFinancialRecovery: mockBackend } })
}));
jest.mock('./financial-backend', () => ({
  getFinancialRecoveryBackend: () => (mockBackendInstalled ? mockBackendBridge : undefined)
}));

const previousTarget = process.env.WALLET_BUILD_TARGET;
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
beforeEach(() => {
  mockPortRequest.mockClear();
  mockBackend.mockClear();
  mockBackendBridge.mockClear();
  mockBackendInstalled = false;
});
afterEach(() => {
  if (previousTarget === undefined) delete process.env.WALLET_BUILD_TARGET;
  else process.env.WALLET_BUILD_TARGET = previousTarget;
  if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
  else Reflect.deleteProperty(globalThis, 'document');
});

it.each([
  ['Chrome service worker', 'extension', false, true],
  ['Firefox background page', 'extension', true, true],
  ['native backend', 'mobile', true, false]
])('uses the live backend Vault in the %s', async (_role, target, hasDocument, installed) => {
  process.env.WALLET_BUILD_TARGET = String(target);
  mockBackendInstalled = Boolean(installed);
  if (hasDocument) Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });
  await verifyFinancialRecovery('account-a');
  expect(mockBackend).toHaveBeenCalledWith('account-a', undefined);
  expect(mockPortRequest).not.toHaveBeenCalled();
  expect(mockBackendBridge.mock.calls).toEqual(installed ? [['account-a', undefined, getStorageHealth().epoch]] : []);
});

it.each(['extension UI', 'offscreen'])('awaits the checkpoint over IPC from the %s page', async () => {
  process.env.WALLET_BUILD_TARGET = 'extension';
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });
  await checkpointFinancialChange({
    kind: 'debit',
    id: 'charge',
    accountId: 'account-a',
    initiatedAt: 1,
    spentUsd: 7n
  });
  expect(mockPortRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      type: WalletMessageType.FinancialRecoveryRequest,
      expectedEpoch: getStorageHealth().epoch,
      accountId: 'account-a',
      entry: expect.any(Object)
    })
  );
  expect(mockBackend).not.toHaveBeenCalled();
});

it('propagates a backend refusal without falling back to IPC', async () => {
  process.env.WALLET_BUILD_TARGET = 'extension';
  mockBackendInstalled = true;
  mockBackend.mockRejectedValueOnce(new Error('Wallet is locked'));
  await expect(verifyFinancialRecovery('account-a')).rejects.toThrow('Wallet is locked');
  expect(mockPortRequest).not.toHaveBeenCalled();
});

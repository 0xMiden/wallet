import { renderHook } from '@testing-library/react';

import { useCctpExecute } from 'app/templates/EvmConnectModal/useCctpExecute';
import { getUsdcxExecutorSource } from 'lib/usdcx/constant';
import { NativeReown } from 'lib/walletconnect/native';

import * as Repo from '../repo';
import { getStorageHealth } from '../storage-health';
import { installProviderReceiptBackend } from './receipt-backend';
import { initiateBridgedReceiveTransaction } from '../transaction/initiate';

let mockNative = false;
const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
const mockWrite = jest.fn(async () => hash);
jest.mock('wagmi', () => ({
  useWriteContract: () => ({ mutateAsync: mockWrite }),
  useSwitchChain: () => ({ switchChainAsync: async () => {} })
}));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));
jest.mock('lib/miden/activity', () => ({
  updateBridgedReceivePhase: (...args: unknown[]) =>
    Reflect.apply(
      jest.requireActual<typeof import('../transaction/complete')>('../transaction/complete').updateBridgedReceivePhase,
      undefined,
      args
    )
}));
jest.mock('lib/walletconnect/fees', () => ({ readNativeFeeFields: async () => ({}) }));
jest.mock('lib/walletconnect/native', () => ({
  isNativeReownAvailable: () => mockNative,
  NativeReown: { sendTransaction: jest.fn(async () => ({ hash })) },
  prepareNativeSessionChain: async () => {},
  unwrapNativeResult: (value: unknown) => value
}));
jest.mock('lib/walletconnect/receipt', () => ({ waitForEvmReceipt: async () => {} }));

it.each([false, true])('Task4C2 finalseams retains manual CCTP proof before native=%s execution', async native => {
  await Repo.db.open();
  mockNative = native;
  mockWrite.mockClear();
  jest.mocked(NativeReown.sendTransaction).mockClear();
  installProviderReceiptBackend(async () => {});
  const source = getUsdcxExecutorSource(84532);
  const id = await initiateBridgedReceiveTransaction({
    accountId: 'account-a',
    amount: 1n,
    faucetId: 'faucet',
    provider: 'usdcx',
    sourceAddress: '0x1111111111111111111111111111111111111111',
    sourceAmount: '1',
    sourceSymbol: 'USDC',
    sourceChainId: source.chain.id,
    usdcxSource: source
  });
  const leg = { sourceDomain: source.domain, message: '0x1234', attestation: '0xabcd' };
  await Repo.transactions.where({ id }).modify(row => {
    row.extraInputs.phase = 'delivering';
    row.extraInputs.cctp = leg;
  });
  let release = () => {};
  let entered = () => {};
  const ack = new Promise<void>(resolve => {
    release = resolve;
  });
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  installProviderReceiptBackend(async () => {
    entered();
    await ack;
  });
  const hook = renderHook(useCctpExecute);
  const operation = hook.result.current(id, source.chain.id, leg).catch((error: unknown) => error);
  try {
    await Promise.race([started, operation]);
    expect(mockWrite.mock.calls.length + jest.mocked(NativeReown.sendTransaction).mock.calls.length).toBe(0);
    release();
    expect(await operation).toBe(hash);
  } finally {
    release();
    await operation;
    hook.unmount();
    installProviderReceiptBackend(undefined);
  }
});

it('Task4C2 owners refuses a fresh manual CCTP execute after an ambiguous wallet response without poisoning health', async () => {
  await Repo.db.open();
  mockNative = false;
  installProviderReceiptBackend(async () => {});
  mockWrite.mockReset().mockRejectedValue(new Error('Wallet response lost'));
  const source = getUsdcxExecutorSource(84532);
  const id = await initiateBridgedReceiveTransaction({
    accountId: 'account-a',
    amount: 1n,
    faucetId: 'faucet',
    provider: 'usdcx',
    sourceAddress: '0x1111111111111111111111111111111111111111',
    sourceAmount: '1',
    sourceSymbol: 'USDC',
    sourceChainId: source.chain.id,
    usdcxSource: source
  });
  const leg = { sourceDomain: source.domain, message: '0x1234', attestation: '0xabcd' };
  await Repo.transactions.where({ id }).modify(row => {
    row.extraInputs.phase = 'delivering';
    row.extraInputs.cctp = leg;
  });
  const hook = renderHook(useCctpExecute);
  try {
    await expect(hook.result.current(id, source.chain.id, leg)).rejects.toThrow('Wallet response lost');
    await expect(hook.result.current(id, source.chain.id, leg)).rejects.toThrow();
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect((await Repo.transactions.get(id))?.extraInputs.cctp?.executeSubmission).toBe('attempted');
    expect(getStorageHealth().status).toBe('healthy');
  } finally {
    hook.unmount();
    installProviderReceiptBackend(undefined);
  }
});

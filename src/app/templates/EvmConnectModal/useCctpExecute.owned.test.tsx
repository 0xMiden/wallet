import { renderHook, waitFor } from '@testing-library/react';
import { createPublicClient, TransactionReceiptNotFoundError, type Hash } from 'viem';

import { bridgeOperationOf, recordBridgeSourceAttempt } from 'lib/bridge/operation';
import { assertCctpSourceMessage, sourceMessageFromReceipt } from 'lib/bridge/providers/xreserve/cctp-message';
import { recordCctpSourceFacts } from 'lib/bridge/providers/xreserve/ownership';
import {
  FORWARD_HASH,
  cctpArcReceipt,
  cctpDepositAttestation,
  cctpSourceMessage,
  cctpSourceReceipt
} from 'lib/bridge/testing/cctp-fixtures';
import { reviewedOwnedCircleTransfer, TEST_CCTP_TRANSMITTER } from 'lib/bridge/testing/circle-fixtures';
import { accounts, now } from 'lib/bridge/testing/fixtures';
import { createBridgeReceiveReconciler } from 'lib/miden/activity/bridge-receive';
import type { IBridgedReceiveExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { getUsdcxExecutorSource } from 'lib/usdcx/constant';
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { encodeExecutorHookData } from 'lib/usdcx/executor';
import { EvmTransactionRevertedError, waitForEvmReceipt } from 'lib/walletconnect/receipt';

import { useCctpExecute } from './useCctpExecute';

jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: jest.fn() }));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) }
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: jest.fn(() => 'https://wallet-rpc.example/private')
}));
jest.mock('lib/remote-config/runtime', () => ({
  initBridgeConfig: async () => undefined,
  getBridgeConfigSnapshot: () => jest.requireActual('lib/bridge/testing/circle-fixtures').circleSnapshot()
}));
const write = jest.fn();
const nativeWrite = jest.fn();
const switchChain = jest.fn();
const prepare = jest.fn();
const fees = jest.fn();
const receiptReader = jest.fn();
const waitReceiptReader = jest.fn();
let native = false;
jest.mock('wagmi', () => ({
  useWriteContract: () => ({ mutateAsync: write }),
  useSwitchChain: () => ({ switchChainAsync: switchChain })
}));
jest.mock('lib/walletconnect/fees', () => ({ readNativeFeeFields: (...args: unknown[]) => fees(...args) }));
jest.mock('lib/walletconnect/native', () => ({
  ...jest.requireActual('lib/walletconnect/native'),
  isNativeReownAvailable: () => native,
  prepareNativeSessionChain: (...args: unknown[]) => prepare(...args),
  NativeReown: { sendTransaction: (...args: unknown[]) => nativeWrite(...args) },
  unwrapNativeResult: (value: unknown) => value
}));
jest.mock('lib/walletconnect/receipt', () => ({
  ...jest.requireActual('lib/walletconnect/receipt'),
  waitForEvmReceipt: jest.fn()
}));
const fetchMock = jest.fn();
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const sourceHash: Hash = `0x${'c'.repeat(64)}`;
const retryHash: Hash = `0x${'d'.repeat(64)}`;
const unavailableReceipts = [
  { label: 'another transaction reverted', receipt: { transactionHash: retryHash, status: 'reverted' } },
  { label: 'missing reverted hash', receipt: { status: 'reverted' } },
  { label: 'malformed reverted hash', receipt: { transactionHash: 123, status: 'reverted' } },
  { label: 'malformed receipt status', receipt: { transactionHash: FORWARD_HASH, status: 'unknown' } }
];
beforeAll(() => Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock }));
afterAll(() => {
  if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
  else Reflect.deleteProperty(globalThis, 'fetch');
});
beforeEach(async () => {
  jest.resetAllMocks();
  native = false;
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
  jest
    .mocked(createPublicClient)
    .mockReturnValue(
      Object.assign(
        jest
          .requireActual('viem')
          .createPublicClient({ transport: jest.requireActual('viem').http('https://rpc.example') }),
        { getTransactionReceipt: receiptReader, waitForTransactionReceipt: waitReceiptReader }
      )
    );
  write.mockResolvedValue(FORWARD_HASH);
  nativeWrite.mockResolvedValue({ hash: FORWARD_HASH });
  switchChain.mockResolvedValue(undefined);
  prepare.mockResolvedValue(undefined);
  fees.mockResolvedValue({});
  await Repo.transactions.clear();
});
afterEach(() => jest.restoreAllMocks());
async function funded() {
  const review = reviewedOwnedCircleTransfer();
  const source = getUsdcxExecutorSource(11155111);
  let finish: () => void = () => undefined;
  const finished = new Promise<void>(resolve => {
    finish = resolve;
  });
  const owner = createBridgeReceiveReconciler({ getLocks: () => undefined });
  const id = await owner.startSubmission(
    () =>
      initiateBridgedReceiveTransaction({
        accountId: accounts.midenAccount,
        amount: 1000001n,
        faucetId: review.route.recovery.nativeAsset!.faucetId,
        provider: 'usdcx',
        sourceAddress: accounts.evmAddress,
        sourceChainId: 11155111,
        sourceAmount: '1.000002',
        sourceSymbol: 'USDC',
        usdcxSource: source,
        operation: { operationId: 'owned-execute', review }
      }),
    async (rowId, claimed) => {
      if (!claimed) throw new Error('Missing real CAS winner');
      await recordBridgeSourceAttempt(claimed.operationId, claimed.revision, { hash: sourceHash });
      const raw = sourceMessageFromReceipt(
        cctpSourceReceipt(sourceHash, cctpSourceMessage(source)),
        sourceHash,
        TEST_CCTP_TRANSMITTER
      );
      assertCctpSourceMessage(
        raw,
        source,
        1000001n,
        encodeExecutorHookData(
          source.target,
          usdcxRemoteRecipientFor(accounts.midenAccount),
          `0x${accounts.evmAddress.slice(2)}`
        )
      );
      await recordCctpSourceFacts(
        { rowId, operation: claimed, checks: { readCurrent: async () => review, now: () => now } },
        { sourceMessage: raw, messageTransmitter: TEST_CCTP_TRANSMITTER }
      );
      await updateBridgedReceivePhase(rowId, 'delivering', { cctp: { sourceDomain: source.domain, forwarded: true } });
      finish();
    }
  );
  await finished;
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      messages: [
        {
          status: 'complete',
          message: cctpSourceMessage(source, { executed: 1000 }),
          attestation: '0xabcd',
          forwardState: 'FAILED'
        }
      ]
    })
  });
  await owner.reconcile();
  const row = await Repo.transactions.get(id);
  const inputs: IBridgedReceiveExtraInputs | undefined = row?.extraInputs;
  const leg = inputs?.cctp;
  if (!leg?.message || !leg.attestation)
    throw new Error('Real reconciler did not produce an executable owned candidate');
  return { id, leg, owner };
}

it.each([false, true])(
  'executes the real owned candidate and records destination facts (native=%s)',
  async useNative => {
    const { id, leg } = await funded();
    native = useNative;
    const root = renderHook(useCctpExecute);
    try {
      expect(await root.result.current(id, 11155111, leg)).toBe(FORWARD_HASH);
      const row = await Repo.transactions.get(id);
      expect(row?.extraInputs.cctp?.executeTxHash).toBe(FORWARD_HASH);
      expect(bridgeOperationOf(row!)?.sourceAttempt?.hash).toBe(sourceHash);
      expect(useNative ? nativeWrite : write).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
    }
  }
);
it.each([false, true])('preserves a real persisted untagged legacy execute path (native=%s)', async useNative => {
  const { id, leg } = await funded();
  await Repo.transactions.where({ id }).modify(row => {
    Reflect.deleteProperty(row.extraInputs, 'bridgeOperation');
  });
  native = useNative;
  jest
    .mocked(waitForEvmReceipt)
    .mockImplementation(
      jest.requireActual<typeof import('lib/walletconnect/receipt')>('lib/walletconnect/receipt').waitForEvmReceipt
    );
  waitReceiptReader.mockResolvedValue({ transactionHash: FORWARD_HASH, status: 'success' });
  const root = renderHook(useCctpExecute);
  try {
    expect(await root.result.current(id, 11155111, leg)).toBe(FORWARD_HASH);
    expect((await Repo.transactions.get(id))?.extraInputs.cctp?.executeTxHash).toBe(FORWARD_HASH);
    expect(useNative ? nativeWrite : write).toHaveBeenCalledTimes(1);
  } finally {
    root.unmount();
  }
});
it.each([false, true])('preserves actual untagged replacement receipt compatibility (native=%s)', async useNative => {
  const { id, leg } = await funded();
  await Repo.transactions.where({ id }).modify(row => {
    Reflect.deleteProperty(row.extraInputs, 'bridgeOperation');
  });
  native = useNative;
  jest
    .mocked(waitForEvmReceipt)
    .mockImplementation(
      jest.requireActual<typeof import('lib/walletconnect/receipt')>('lib/walletconnect/receipt').waitForEvmReceipt
    );
  waitReceiptReader.mockResolvedValue({ transactionHash: retryHash, status: 'success' });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const root = renderHook(useCctpExecute);
  try {
    expect(await root.result.current(id, 11155111, leg)).toBe(FORWARD_HASH);
    expect(waitReceiptReader).toHaveBeenCalledWith({ hash: FORWARD_HASH, confirmations: 1 });
    expect(warn).not.toHaveBeenCalled();
    expect((await Repo.transactions.get(id))?.extraInputs.cctp?.executeTxHash).toBe(FORWARD_HASH);
    expect(useNative ? nativeWrite : write).toHaveBeenCalledTimes(1);
  } finally {
    root.unmount();
  }
});

it.each(['missing row', 'legacy restored', 'legacy recovered'])(
  'refuses %s rather than treating absent ownership as legacy consent',
  async change => {
    const { id, leg } = await funded();
    if (change === 'missing row') await Repo.transactions.delete(id);
    else
      await Repo.transactions.where({ id }).modify(row => {
        Reflect.deleteProperty(row.extraInputs, 'bridgeOperation');
        if (change === 'legacy restored') row.restoredFromBackup = true;
        else row.recovered = true;
      });
    const root = renderHook(useCctpExecute);
    try {
      const outcome: unknown = await root.result.current(id, 11155111, leg).catch(error => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(write).not.toHaveBeenCalled();
      expect(nativeWrite).not.toHaveBeenCalled();
    } finally {
      root.unmount();
    }
  }
);

it.each(['restored', 'recovered', 'malformed tag', 'caller message'])(
  'refuses %s before an owned destination gas prompt',
  async change => {
    const { id, leg } = await funded();
    if (change === 'restored') await Repo.transactions.update(id, { restoredFromBackup: true });
    if (change === 'recovered') await Repo.transactions.update(id, { recovered: true });
    if (change === 'malformed tag') await Repo.transactions.update(id, { 'extraInputs.bridgeOperation': {} });
    const root = renderHook(useCctpExecute);
    try {
      const outcome: unknown = await root.result
        .current(id, 11155111, change === 'caller message' ? { ...leg, message: '0x1234' } : leg)
        .catch(error => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(write).not.toHaveBeenCalled();
      expect(nativeWrite).not.toHaveBeenCalled();
    } finally {
      root.unmount();
    }
  }
);
it.each(['switch', 'session', 'fees', 'wallet RPC'])(
  'refuses original owner or wallet scope departure during %s before destination signing',
  async boundary => {
    const { id, leg } = await funded();
    native = boundary !== 'switch' && boundary !== 'wallet RPC';
    const depart = async () => {
      await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.revision': 'other' });
      return {};
    };
    if (boundary === 'switch') switchChain.mockImplementationOnce(depart);
    if (boundary === 'wallet RPC')
      switchChain.mockImplementationOnce(async () => {
        jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other.example/private');
      });
    if (boundary === 'session') prepare.mockImplementationOnce(depart);
    if (boundary === 'fees') fees.mockImplementationOnce(depart);
    const root = renderHook(useCctpExecute);
    try {
      const outcome: unknown = await root.result.current(id, 11155111, leg).catch(error => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(write).not.toHaveBeenCalled();
      expect(nativeWrite).not.toHaveBeenCalled();
    } finally {
      root.unmount();
    }
  }
);
it('admits only one concurrent real DB destination attempt and a loser cannot demote its returned hash', async () => {
  const { id, leg } = await funded();
  let release: (hash: Hash) => void = () => undefined;
  write.mockImplementationOnce(
    () =>
      new Promise<Hash>(resolve => {
        release = resolve;
      })
  );
  const one = renderHook(useCctpExecute);
  const two = renderHook(useCctpExecute);
  const first = one.result.current(id, 11155111, leg);
  try {
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const second: unknown = await two.result.current(id, 11155111, leg).catch(error => error);
    release(FORWARD_HASH);
    await first;
    expect(second).toBeInstanceOf(Error);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await Repo.transactions.get(id))?.extraInputs.cctp?.executeTxHash).toBe(FORWARD_HASH);
  } finally {
    release(FORWARD_HASH);
    await first;
    one.unmount();
    two.unmount();
  }
});
it.each([false, true])('keeps a hashless invoked attempt uncertain across unmount (native=%s)', async useNative => {
  const { id, leg } = await funded();
  native = useNative;
  (useNative ? nativeWrite : write).mockRejectedValueOnce(new Error('Wallet transport closed'));
  const one = renderHook(useCctpExecute);
  await one.result.current(id, 11155111, leg).catch(() => undefined);
  one.unmount();
  const two = renderHook(useCctpExecute);
  try {
    const outcome: unknown = await two.result.current(id, 11155111, leg).catch(error => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(useNative ? nativeWrite : write).toHaveBeenCalledTimes(1);
    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toMatchObject({
      executeAttempt: { phase: 'uncertain' }
    });
  } finally {
    two.unmount();
  }
});
it.each([false, true])(
  'does not expose raw wallet RPC or calldata errors from an uncertain owned execute (native=%s)',
  async useNative => {
    const { id, leg } = await funded();
    native = useNative;
    const privateData = 'https://private-rpc.example/?key=secret 0xprivate-calldata';
    (useNative ? nativeWrite : write).mockRejectedValueOnce(new Error(privateData));
    const root = renderHook(useCctpExecute);
    try {
      const outcome: unknown = await root.result.current(id, 11155111, leg).catch(error => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).not.toContain(privateData);
      expect(outcome).not.toHaveProperty('cause');
      expect((await Repo.transactions.get(id))?.extraInputs.cctp).toMatchObject({
        executeAttempt: { phase: 'uncertain' }
      });
    } finally {
      root.unmount();
    }
  }
);
it('keeps a known manual hash without logging private receipt RPC errors', async () => {
  const { id, leg } = await funded();
  const privateData = 'https://private-rpc.example/?key=secret receipt-request-bytes';
  jest.mocked(waitForEvmReceipt).mockRejectedValueOnce(new Error(privateData));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const root = renderHook(useCctpExecute);
  try {
    expect(await root.result.current(id, 11155111, leg)).toBe(FORWARD_HASH);
    expect(warn.mock.calls.flatMap(call => call.map(String)).join(' ')).not.toContain(privateData);
    expect((await Repo.transactions.get(id))?.extraInputs.cctp?.executeTxHash).toBe(FORWARD_HASH);
  } finally {
    root.unmount();
  }
});
it('records the original destination attempt hash after UI RPC departure in the wallet await', async () => {
  const { id, leg } = await funded();
  write.mockImplementationOnce(async () => {
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other.example/private');
    return FORWARD_HASH;
  });
  const root = renderHook(useCctpExecute);
  try {
    await root.result.current(id, 11155111, leg);
    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toMatchObject({
      executeTxHash: FORWARD_HASH,
      executeAttempt: { phase: 'known', hash: FORWARD_HASH }
    });
  } finally {
    root.unmount();
  }
});
it('retains a known manual hash while a passive Circle forward wins, then observes it if that forward reverts', async () => {
  const { id, leg, owner } = await funded();
  const source = getUsdcxExecutorSource(11155111);
  let release: (hash: Hash) => void = () => undefined;
  write.mockImplementationOnce(
    () =>
      new Promise<Hash>(resolve => {
        release = resolve;
      })
  );
  const root = renderHook(useCctpExecute);
  const execution = root.result.current(id, 11155111, leg);
  try {
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await updateBridgedReceivePhase(
      id,
      'delivering',
      { cctp: { sourceDomain: 0, executeTxHash: FORWARD_HASH } },
      undefined,
      { onlyIfNoExecuteHash: true }
    );
    release(retryHash);
    await execution;
    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toMatchObject({
      executeTxHash: FORWARD_HASH,
      executeAttempt: { phase: 'known', hash: retryHash }
    });
    receiptReader.mockResolvedValueOnce({ transactionHash: FORWARD_HASH, status: 'reverted', logs: [] });
    const receipt = cctpArcReceipt(source);
    receipt.transactionHash = retryHash;
    for (const entry of receipt.logs) entry.transactionHash = retryHash;
    receiptReader.mockResolvedValue(receipt);
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('/v2/messages/')
          ? {
              messages: [
                {
                  status: 'complete',
                  message: cctpSourceMessage(source, { executed: 1000 }),
                  attestation: '0xabcd',
                  forwardState: 'FAILED'
                }
              ]
            }
          : cctpDepositAttestation(source)
    }));
    await owner.reconcile();
    await owner.reconcile();
    await owner.reconcile();
    await owner.reconcile();
    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs.phase).toBe('ready');
    expect(row?.extraInputs.cctp?.executeTxHash).toBe(retryHash);
    expect(row?.extraInputs.cctp?.revertedExecuteTxHash).toBe(FORWARD_HASH);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    release(retryHash);
    await execution;
    root.unmount();
  }
});

it.each(['revert', 'known stall'])(
  'preserves authoritative %s destination reopening without rearming source funding',
  async kind => {
    const { id, leg, owner } = await funded();
    write.mockResolvedValueOnce(FORWARD_HASH).mockResolvedValueOnce(retryHash);
    if (kind === 'revert') jest.mocked(waitForEvmReceipt).mockRejectedValueOnce(new EvmTransactionRevertedError('Arc'));
    const root = renderHook(useCctpExecute);
    try {
      await root.result.current(id, 11155111, leg).catch(() => undefined);
      if (kind === 'known stall') {
        jest.spyOn(Date, 'now').mockReturnValue(now + 31 * 60 * 1000);
        receiptReader.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: FORWARD_HASH }));
      }
      await owner.reconcile();
      const row = await Repo.transactions.get(id);
      const next: IBridgedReceiveExtraInputs['cctp'] = row?.extraInputs.cctp;
      if (!next) throw new Error('Missing reopened leg');
      expect(next.executeTxHash).toBeUndefined();
      expect(await root.result.current(id, 11155111, next)).toBe(retryHash);
      expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.hash).toBe(sourceHash);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      root.unmount();
    }
  }
);

describe.each([false, true])('actual owned receipt boundaries (native=%s)', useNative => {
  it.each(unavailableReceipts)('does not reopen after foreground $label', async ({ receipt }) => {
    const { id, leg, owner } = await funded();
    native = useNative;
    write.mockResolvedValueOnce(FORWARD_HASH).mockResolvedValue(retryHash);
    nativeWrite.mockResolvedValueOnce({ hash: FORWARD_HASH }).mockResolvedValue({ hash: retryHash });
    jest
      .mocked(waitForEvmReceipt)
      .mockImplementation(
        jest.requireActual<typeof import('lib/walletconnect/receipt')>('lib/walletconnect/receipt').waitForEvmReceipt
      );
    waitReceiptReader
      .mockResolvedValueOnce(receipt)
      .mockResolvedValue({ transactionHash: retryHash, status: 'success' });
    receiptReader.mockRejectedValue(new Error('Receipt unavailable'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = renderHook(useCctpExecute);
    try {
      await root.result.current(id, 11155111, leg).catch(() => undefined);
      expect(waitReceiptReader).toHaveBeenCalledWith({ hash: FORWARD_HASH, confirmations: 1 });
      const retained = await Repo.transactions.get(id);
      await owner.reconcile();
      const next: IBridgedReceiveExtraInputs['cctp'] = (await Repo.transactions.get(id))?.extraInputs.cctp;
      if (!next) throw new Error('Missing original execution leg');
      await root.result.current(id, 11155111, next).catch(() => undefined);
      expect(useNative ? nativeWrite : write).toHaveBeenCalledTimes(1);
      expect(retained?.extraInputs.cctp).toMatchObject({
        executeTxHash: FORWARD_HASH,
        executeAttempt: { phase: 'known', hash: FORWARD_HASH }
      });
      expect(retained?.extraInputs.cctp?.revertedExecuteTxHash).toBeUndefined();
      expect(bridgeOperationOf(retained!)?.sourceAttempt?.hash).toBe(sourceHash);
    } finally {
      root.unmount();
    }
  });

  it.each(unavailableReceipts)('does not turn passive $label into a revert or stall retry', async ({ receipt }) => {
    const { id, leg, owner } = await funded();
    native = useNative;
    write.mockResolvedValueOnce(FORWARD_HASH).mockResolvedValue(retryHash);
    nativeWrite.mockResolvedValueOnce({ hash: FORWARD_HASH }).mockResolvedValue({ hash: retryHash });
    const root = renderHook(useCctpExecute);
    try {
      await root.result.current(id, 11155111, leg);
      jest.spyOn(Date, 'now').mockReturnValue(now + 31 * 60 * 1000);
      receiptReader.mockResolvedValue(receipt);
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await owner.reconcile();
      await owner.reconcile();
      expect(receiptReader).toHaveBeenCalledWith({ hash: FORWARD_HASH });
      const retained = await Repo.transactions.get(id);
      const next: IBridgedReceiveExtraInputs['cctp'] = retained?.extraInputs.cctp;
      if (!next) throw new Error('Missing original execution leg');
      await root.result.current(id, 11155111, next).catch(() => undefined);
      expect(useNative ? nativeWrite : write).toHaveBeenCalledTimes(1);
      expect(retained?.extraInputs.cctp).toMatchObject({
        executeTxHash: FORWARD_HASH,
        executeAttempt: { phase: 'known', hash: FORWARD_HASH }
      });
      expect(retained?.extraInputs.cctp?.revertedExecuteTxHash).toBeUndefined();
      expect(retained?.extraInputs.cctp?.stalledExecuteTxHash).toBeUndefined();
      expect(bridgeOperationOf(retained!)?.sourceAttempt?.hash).toBe(sourceHash);
    } finally {
      root.unmount();
    }
  });

  it('reopens an exact-hash foreground reverted receipt without success logs', async () => {
    const { id, leg, owner } = await funded();
    native = useNative;
    write.mockResolvedValueOnce(FORWARD_HASH).mockResolvedValue(retryHash);
    nativeWrite.mockResolvedValueOnce({ hash: FORWARD_HASH }).mockResolvedValue({ hash: retryHash });
    jest
      .mocked(waitForEvmReceipt)
      .mockImplementation(
        jest.requireActual<typeof import('lib/walletconnect/receipt')>('lib/walletconnect/receipt').waitForEvmReceipt
      );
    waitReceiptReader
      .mockResolvedValueOnce({ transactionHash: FORWARD_HASH, status: 'reverted', logs: [] })
      .mockResolvedValue({ transactionHash: retryHash, status: 'success' });
    const root = renderHook(useCctpExecute);
    try {
      await expect(root.result.current(id, 11155111, leg)).rejects.toBeInstanceOf(EvmTransactionRevertedError);
      await owner.reconcile();
      const next: IBridgedReceiveExtraInputs['cctp'] = (await Repo.transactions.get(id))?.extraInputs.cctp;
      if (!next) throw new Error('Missing exactly reverted execution leg');
      expect(next.revertedExecuteTxHash).toBe(FORWARD_HASH);
      expect(await root.result.current(id, 11155111, next)).toBe(retryHash);
      expect(useNative ? nativeWrite : write).toHaveBeenCalledTimes(2);
      expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.hash).toBe(sourceHash);
    } finally {
      root.unmount();
    }
  });

  it('reopens an exact-hash passive reverted receipt without success logs', async () => {
    const { id, leg, owner } = await funded();
    native = useNative;
    write.mockResolvedValueOnce(FORWARD_HASH).mockResolvedValue(retryHash);
    nativeWrite.mockResolvedValueOnce({ hash: FORWARD_HASH }).mockResolvedValue({ hash: retryHash });
    const root = renderHook(useCctpExecute);
    try {
      await root.result.current(id, 11155111, leg);
      receiptReader.mockResolvedValue({ transactionHash: FORWARD_HASH, status: 'reverted', logs: [] });
      await owner.reconcile();
      await owner.reconcile();
      const next: IBridgedReceiveExtraInputs['cctp'] = (await Repo.transactions.get(id))?.extraInputs.cctp;
      if (!next) throw new Error('Missing exactly reverted execution leg');
      expect(next.revertedExecuteTxHash).toBe(FORWARD_HASH);
      expect(await root.result.current(id, 11155111, next)).toBe(retryHash);
      expect(useNative ? nativeWrite : write).toHaveBeenCalledTimes(2);
      expect(bridgeOperationOf((await Repo.transactions.get(id))!)?.sourceAttempt?.hash).toBe(sourceHash);
    } finally {
      root.unmount();
    }
  });
});

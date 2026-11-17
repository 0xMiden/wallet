// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/deposit.test.ts (MIT).
import React from 'react';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  parseUnits,
  type EIP1193Provider,
  type Hash,
  type Hex
} from 'viem';

import { FlowPresentationProvider, CommandFlowBackProvider } from 'components/flow/FlowPresentation';
import { AGGLAYER_BRIDGE_ABI } from 'lib/agglayer/constant';
import { fetchDeposits } from 'lib/agglayer/status';
import { deriveBridgeRoutes } from 'lib/bridge/catalog';
import { assertReviewedBridge, type ReviewedTransfer } from 'lib/bridge/core/review';
import type { SourceRpcTransaction } from 'lib/bridge/evm/source-transaction';
import { bridgeOperationOf, type BridgeOperationSnapshot } from 'lib/bridge/operation';
import { accounts, now, referenceSnapshot, testRoute } from 'lib/bridge/testing/fixtures';
import { reviewedErc20Transfer } from 'lib/bridge/testing/operation-fixtures';
import { submitReviewedBridge } from 'lib/bridge/wallet-submit';
import { applyBridgeInToConsumeRow, takeAgglayerBridgeInInfo } from 'lib/miden/activity/bridge-in';
import { createBridgeReceiveReconciler } from 'lib/miden/activity/bridge-receive';
import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';
import { NativeReown, type ReownPlugin } from 'lib/walletconnect/native';
import { readEvmReceiptOutcome } from 'lib/walletconnect/receipt';
import { navigate } from 'lib/woozie';
import { CommandBridge } from 'screens/command/bridge/CommandBridge';
import { CommandDraftProvider } from 'screens/command/command-drafts';
import { CommandWorkbench } from 'screens/command/CommandWorkbench';

import { submitAgglayerDeposit, type AgglayerClient } from './deposit';
import { runAgglayerReceive } from './flows';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) }
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
const mockWalletState = {
  currentAccount: { publicKey: accounts.midenAccount },
  balances: { [accounts.midenAccount]: [] },
  balancesLoading: {},
  balanceReadFailed: {},
  tokenPricesStatus: 'ready',
  tokenPrices: {}
};
jest.mock('lib/store', () => ({
  getIntercom: jest.fn(),
  useWalletStore: Object.assign((select: (state: typeof mockWalletState) => unknown) => select(mockWalletState), {
    getState: () => mockWalletState
  })
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: jest.fn(() => 'testnet'),
  getEffectiveRpcUrl: jest.fn(() => 'https://wallet-rpc.example/private')
}));
jest.mock('lib/remote-config/runtime', () => ({
  initBridgeConfig: async () => undefined,
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/bridge/testing/fixtures')>('lib/bridge/testing/fixtures')
      .referenceSnapshot('testnet')
}));
let mockNative = false;
jest.mock('@reown/appkit/react', () => ({
  useAppKitNetwork: () => ({ chainId: 11155111 }),
  useDisconnect: () => ({ disconnect: jest.fn() })
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => null }));
jest.mock('lib/usdcx/use-burn-fee-reserve', () => ({
  useBurnFeeReserve: () => ({ status: 'pending' })
}));
jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ locked: false, signTransaction: jest.fn() }),
  useAllBalances: () => ({}),
  useAllTokensBaseMetadata: () => ({})
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => jest.requireActual('lib/bridge/testing/fixtures').referenceSnapshot('testnet')
}));
jest.mock('lib/bridge/wallet-transport', () => ({
  quoteBridgeTransfer: async (request: unknown) =>
    jest
      .requireActual('lib/bridge/core/quote')
      .bindTransferQuote(request, { kind: 'agglayer', received: '1', validity: { kind: 'provider' } })
}));
jest.mock('lib/epoch/client', () => ({
  getEvmConnection: async () => ({
    address: '0x1111111111111111111111111111111111111111',
    chainId: 11155111,
    isNative: mockNative
  }),
  buildEpochWalletClient: async (address: `0x${string}`) => {
    const viem = jest.requireActual<typeof import('viem')>('viem');
    const provider = mockNative
      ? jest
          .requireActual<typeof import('lib/walletconnect/native')>('lib/walletconnect/native')
          .buildNativeReownProvider({ chainId: 11155111, address, rpcUrl: 'https://rpc.example' })
      : { request: (...args: unknown[]) => wallet(...args) };
    return viem.createWalletClient({ account: address, transport: viem.custom(provider) });
  },
  switchWebWalletChain: jest.fn()
}));
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({
    address: '0x1111111111111111111111111111111111111111',
    connected: true,
    nativeReown: { state: { chainIds: [11155111] } },
    useNativeReownWallet: mockNative
  })
}));
jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: { getAccounts: async () => [], getPublicKeyForCommitment: async () => '', signWord: async () => '' }
}));
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  createLocationState: () => ({ historyPosition: 1 }),
  listen: () => () => {}
}));
jest.mock('lib/walletconnect/fees', () => ({
  readNativeFeeFields: async () => ({ maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' })
}));
var mockNativeSend: jest.MockedFunction<ReownPlugin['sendTransaction']>;
jest.mock('@capacitor/core', () => ({
  ...jest.requireActual('@capacitor/core'),
  registerPlugin: jest.fn((name: string) => {
    const plugin = {
      getState: jest.fn(),
      sendTransaction: jest.fn(),
      addListener: jest.fn(async () => ({ remove: async () => undefined }))
    };
    if (name === 'Reown') mockNativeSend = plugin.sendTransaction;
    return plugin;
  })
}));
jest.mock('lib/agglayer/status', () => ({ ...jest.requireActual('lib/agglayer/status'), fetchDeposits: jest.fn() }));
jest.mock('lib/walletconnect/receipt', () => ({
  ...jest.requireActual('lib/walletconnect/receipt'),
  readEvmReceiptOutcome: jest.fn()
}));
jest.mock('lib/bridge/providers/agglayer/provider', () => ({ agglayerReadClient: () => rpc }));
jest.mock('lib/agglayer/contract', () => ({
  midenAddrToEvmAddr: (value: string) => {
    if (value !== '0x387149ae66116cf114eebd60bb7381') throw new Error('Wrong destination');
    return '0x00000000387149ae66116cf114eebd60bb738100';
  }
}));

const depositHash: Hash = `0x${'c'.repeat(64)}`;
const resetHash: Hash = `0x${'a'.repeat(64)}`;
const approvalHash: Hash = `0x${'b'.repeat(64)}`;
const rpc = {
  readContract: jest.fn(),
  call: jest.fn(),
  estimateGas: jest.fn(),
  waitForTransactionReceipt: jest.fn(),
  getBalance: jest.fn(),
  getGasPrice: jest.fn(),
  getTransaction: jest.fn(),
  getBlockNumber: jest.fn(),
  getTransactionCount: jest.fn(),
  getBlock: jest.fn()
} satisfies AgglayerClient;
const wallet = jest.fn();
const provider: EIP1193Provider = { request: wallet, on: jest.fn(), removeListener: jest.fn() };
const sourceTransactions = new Map<Hash, SourceRpcTransaction>();
let allowance: bigint;
let activeAccount: string;
let tokenAddress: Hex;
let bridgeAddress: Hex;
let approvedAmount: bigint;
let signed: { to: string; data: Hex; value: Hex; chainId: Hex; from: string; gas: Hex }[];

function nativeReview(): ReviewedTransfer {
  const route = testRoute();
  return {
    route,
    amount: '1.00000000',
    accounts: { ...accounts },
    quote: {
      kind: 'agglayer',
      received: '1',
      validity: { kind: 'time', expiresAt: now + 60000 },
      request: { routeId: route.id, recovery: structuredClone(route.recovery), amount: '1.00000000', ...accounts }
    }
  };
}

async function drive(review = reviewedErc20Transfer('agglayer'), operationId = 'agglayer-operation') {
  assertReviewedBridge(review, structuredClone(review), now);
  const route = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
  if (!route || review.route.destination.kind !== 'miden') throw new Error('Missing accepted Agglayer route');
  bridgeAddress = route.contractAddress;
  const faucetId = review.route.destination.faucetId;
  if (review.route.source.kind === 'erc20') tokenAddress = `0x${review.route.source.address.slice(2)}`;
  approvedAmount = parseUnits(review.amount, review.route.source.decimals);
  let complete: (error?: unknown) => void = () => undefined;
  const finished = new Promise<unknown>(resolve => {
    complete = resolve;
  });
  let captured: BridgeOperationSnapshot | undefined;
  const wrapper = createBridgeReceiveReconciler({ getLocks: () => undefined });
  const id = await wrapper.startSubmission(
    () =>
      initiateBridgedReceiveTransaction({
        accountId: review.accounts.midenAccount,
        amount: parseUnits(review.quote?.received ?? '', review.route.destination.decimals),
        faucetId,
        provider: 'agglayer',
        sourceAddress: review.accounts.evmAddress,
        sourceChainId: route.chainId,
        sourceAmount: review.amount,
        sourceSymbol: review.route.source.symbol,
        agglayerRoute: route,
        operation: { operationId, review },
        agglayerDelivery:
          review.route.source.kind === 'erc20'
            ? { originToken: `0x${review.route.source.address.slice(2)}`, faucetId, scale: 10 }
            : undefined
      }),
    async (rowId, claimed) => {
      captured = claimed;
      if (!captured) {
        complete(new Error('Missing real CAS winner'));
        return;
      }
      try {
        await submitAgglayerDeposit({
          rowId,
          operation: captured,
          provider,
          client: rpc,
          checks: { readCurrent: async () => structuredClone(review), now: () => now }
        });
        complete();
      } catch (error) {
        complete(error);
      }
    }
  );
  const error = await finished;
  const row = await Repo.transactions.get(id);
  expect(row).toBeDefined();
  expect(bridgeOperationOf(row!)?.sourceAttempt).toBeDefined();
  return { id, row, error, captured };
}

beforeEach(async () => {
  jest.resetAllMocks();
  jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
  jest.spyOn(Date, 'now').mockReturnValue(now);
  await Repo.transactions.clear();
  mockNative = false;
  mockWalletState.currentAccount.publicKey = accounts.midenAccount;
  mockWalletState.tokenPricesStatus = 'ready';
  jest.mocked(NativeReown.getState).mockResolvedValue({
    configured: true,
    connected: true,
    topic: 'test-session',
    address: accounts.evmAddress,
    accounts: [`eip155:11155111:${accounts.evmAddress}`],
    chainId: 11155111,
    chainIds: [11155111]
  });
  jest.mocked(NativeReown.addListener).mockResolvedValue({ remove: async () => undefined });
  mockNativeSend.mockImplementation(async tx => ({
    hash: await wallet({ method: 'eth_sendTransaction', params: [tx] })
  }));
  allowance = 0n;
  activeAccount = accounts.evmAddress;
  signed = [];
  sourceTransactions.clear();
  rpc.readContract.mockImplementation(async ({ functionName }) => {
    if (functionName === 'allowance') return allowance;
    if (functionName === 'balanceOf') return 10n ** 25n;
    if (functionName === 'decimals') return 18;
    if (functionName === 'isEmergencyState') return false;
    throw new Error('Unexpected read');
  });
  jest.mocked(readEvmReceiptOutcome).mockResolvedValue('success');
  rpc.call.mockResolvedValue({ data: '0x' });
  rpc.estimateGas.mockResolvedValue(100000n);
  rpc.getBalance.mockResolvedValue(10n ** 25n);
  rpc.getGasPrice.mockResolvedValue(100n);
  rpc.getTransaction.mockImplementation(async ({ hash }) => {
    const tx = sourceTransactions.get(hash);
    if (!tx) throw new Error('Unmodelled transaction');
    return tx;
  });
  rpc.waitForTransactionReceipt.mockImplementation(async ({ hash }) => {
    const tx = sourceTransactions.get(hash);
    if (!tx) throw new Error('Unmodelled receipt');
    if (tx.input.startsWith('0x095ea7b3')) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.input });
      if (decoded.functionName === 'approve') allowance = decoded.args[1];
    }
    return { status: 'success', transactionHash: hash };
  });
  wallet.mockImplementation(async ({ method, params }) => {
    if (method === 'eth_accounts') return [activeAccount];
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method !== 'eth_sendTransaction') throw new Error('Unexpected wallet method');
    const tx = params[0];
    signed.push(tx);
    const deposit = tx.to.toLowerCase() === bridgeAddress.toLowerCase();
    let hash: Hash = depositHash;
    if (deposit)
      hash = signed.filter(item => item.to === bridgeAddress).length === 1 ? depositHash : `0x${'d'.repeat(64)}`;
    else {
      if (tx.to.toLowerCase() !== tokenAddress.toLowerCase()) throw new Error('Wrong signing target');
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (decoded.functionName !== 'approve' || decoded.args[0].toLowerCase() !== bridgeAddress.toLowerCase())
        throw new Error('Wrong approval call');
      hash = decoded.args[1] === 0n ? resetHash : approvalHash;
      if (sourceTransactions.has(hash)) hash = `0x${(10 + signed.length).toString(16).padStart(64, '0')}`;
    }
    sourceTransactions.set(hash, {
      hash,
      from: `0x${String(tx.from).slice(2)}`,
      to: deposit ? bridgeAddress : tokenAddress,
      input: tx.data,
      value: BigInt(tx.value),
      nonce: hash === resetHash ? 1 : hash === approvalHash ? 2 : 10 + signed.length,
      blockNumber: 1n
    });
    return hash;
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function reviewAmount(amount: string): ReviewedTransfer {
  const review = reviewedErc20Transfer('agglayer');
  if (!review.quote) throw new Error('Missing reviewed quote');
  review.amount = amount;
  review.quote.received = amount;
  review.quote.request.amount = amount;
  assertReviewedBridge(review, structuredClone(review), now);
  return review;
}

async function renderReceive() {
  const route = deriveBridgeRoutes(referenceSnapshot('testnet')).find(
    item => item.mode === 'receive' && item.provider === 'agglayer' && item.source.symbol === 'USDC'
  );
  const recovery = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
  if (!route || !recovery || route.source.kind !== 'erc20') throw new Error('Missing actual receive catalog');
  bridgeAddress = recovery.contractAddress;
  tokenAddress = `0x${route.source.address.slice(2)}`;
  const mounted = render(
    React.createElement(CommandDraftProvider, {
      scope: { accountId: accounts.midenAccount, network: 'testnet', rpcUrl: 'https://wallet-rpc.example/private' },
      children: React.createElement(FlowPresentationProvider, {
        value: 'command',
        children: React.createElement(CommandFlowBackProvider, {
          children: React.createElement(CommandWorkbench, {
            route: { kind: 'flow', action: 'bridge' },
            container: null,
            children: React.createElement(CommandBridge)
          })
        })
      })
    })
  );
  fireEvent.click(screen.getByTestId(`command-bridge-route-${route.id}`));
  fireEvent.change(screen.getByRole('textbox', { name: 'amount' }), { target: { value: '1.00000000' } });
  const form = screen.getByRole('textbox', { name: 'amount' }).closest('form');
  if (!form) throw new Error('Missing actual form');
  await waitFor(() => expect(screen.getByRole('button', { name: 'reviewDetails' })).toBeEnabled());
  fireEvent.submit(form);
  expect(screen.getByRole('button', { name: 'confirm' })).toBeEnabled();
  return { ...mounted, form };
}

it.each([false, true])(
  'the actual visible controller survives admission and drives original EVM prompts exactly once (native=%s)',
  async native => {
    mockNative = native;
    let release: (value: { data: Hex }) => void = () => undefined;
    rpc.call.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const { form } = await renderReceive();
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole('button', { name: 'commandBridgeViewStatus' })).toBeVisible());
    await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(1));
    expect(signed).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
    const row = (await Repo.transactions.toArray())[0];
    if (!row) throw new Error('Missing real admitted row');
    expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('running');
    fireEvent.submit(form);
    expect(await Repo.transactions.count()).toBe(1);
    release({ data: '0x' });
    await waitFor(async () => expect((await Repo.transactions.get(row.id))?.extraInputs.evmTxHash).toBe(depositHash));
    expect(signed).toHaveLength(2);
    expect(screen.getByTestId('command-bridge')).toBeVisible();
    expect(mockNativeSend).toHaveBeenCalledTimes(native ? 2 : 0);
    fireEvent.submit(form);
    expect(signed).toHaveLength(2);
    expect(await Repo.transactions.count()).toBe(1);
  }
);

it('explicit minimize before a later prompt refuses fresh spending and reopen does not replay the original row', async () => {
  let release: (value: { data: Hex }) => void = () => undefined;
  rpc.call.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  const { form, unmount } = await renderReceive();
  fireEvent.submit(form);
  await waitFor(() => expect(screen.getByRole('button', { name: 'commandBridgeViewStatus' })).toBeVisible());
  await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(1));
  const row = (await Repo.transactions.toArray())[0];
  if (!row) throw new Error('Missing real admitted row');
  fireEvent.click(screen.getByRole('button', { name: 'minimize' }));
  unmount();
  release({ data: '0x' });
  await waitFor(async () =>
    expect((await Repo.transactions.get(row.id))?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain')
  );
  expect(signed).toHaveLength(0);
  const reopened = await renderReceive();
  expect(await Repo.transactions.count()).toBe(1);
  expect(signed).toHaveLength(0);
  reopened.unmount();
});

it.each(['cap', 'miden-account'])(
  'live %s departure after admission refuses the later real source prompt',
  async change => {
    let release: (value: { data: Hex }) => void = () => undefined;
    rpc.call.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const { form } = await renderReceive();
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole('button', { name: 'commandBridgeViewStatus' })).toBeVisible());
    await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(1));
    const row = (await Repo.transactions.toArray())[0];
    if (!row) throw new Error('Missing admitted row');
    if (change === 'cap') mockWalletState.tokenPricesStatus = 'error';
    else mockWalletState.currentAccount.publicKey = '0x287149ae66116cf114eebd60bb7381';
    release({ data: '0x' });
    await waitFor(async () =>
      expect((await Repo.transactions.get(row.id))?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain')
    );
    expect(signed).toHaveLength(0);
    expect(await Repo.transactions.count()).toBe(1);
  }
);

it('the original receive driver never discloses raw external wallet failures from the real Command path', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  rpc.call.mockRejectedValueOnce(new Error('private-wallet-payload-placeholder'));
  const { form } = await renderReceive();
  fireEvent.submit(form);
  await waitFor(async () =>
    expect((await Repo.transactions.toArray())[0]?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain')
  );
  await waitFor(() => expect(log).toHaveBeenCalled());
  const diagnostics = log.mock.calls.flat().map(value => (value instanceof Error ? value.message : String(value)));
  expect(diagnostics.join(' ')).not.toContain('private-wallet-payload-placeholder');
  expect(signed).toHaveLength(0);
  expect(await Repo.transactions.count()).toBe(1);
});

it('a returned source hash is saved to the original owner after explicit UI departure', async () => {
  const originalWallet = wallet.getMockImplementation();
  let release: (hash: Hash) => void = () => undefined;
  wallet.mockImplementation(async request => {
    if (!originalWallet) throw new Error('Missing actual provider boundary');
    const hash = await originalWallet(request);
    if (request.method === 'eth_sendTransaction' && request.params[0].to.toLowerCase() === bridgeAddress.toLowerCase())
      return new Promise(resolve => {
        release = resolve;
      });
    return hash;
  });
  const { form, unmount } = await renderReceive();
  fireEvent.submit(form);
  await waitFor(() => expect(signed).toHaveLength(2));
  const row = (await Repo.transactions.toArray())[0];
  if (!row) throw new Error('Missing real admitted row');
  fireEvent.click(screen.getByRole('button', { name: 'minimize' }));
  unmount();
  release(depositHash);
  await waitFor(async () => expect((await Repo.transactions.get(row.id))?.extraInputs.evmTxHash).toBe(depositHash));
  expect((await Repo.transactions.get(row.id))?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('known');
  expect(await Repo.transactions.count()).toBe(1);
});

it('admits the public external-wallet receive through the original real DB/CAS and never blindly replays it', async () => {
  const review = reviewedErc20Transfer('agglayer');
  const recovery = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
  if (!recovery || review.route.source.kind !== 'erc20') throw new Error('Missing route');
  bridgeAddress = recovery.contractAddress;
  tokenAddress = `0x${review.route.source.address.slice(2)}`;
  const client = createWalletClient({ account: `0x${accounts.evmAddress.slice(2)}`, transport: custom(provider) });
  const deps = {
    signTransaction: async () => new Uint8Array(),
    guardianProvider: {
      getAccounts: async () => [],
      getPublicKeyForCommitment: async () => '',
      signWord: async () => ''
    },
    getContext: () => review,
    getEvmWallet: async () => client,
    onOperation: jest.fn()
  };
  const result = await submitReviewedBridge(review, deps);
  expect(result.kind).toBe('started');
  if (result.kind !== 'started') throw new Error('Expected admission');
  await waitFor(async () =>
    expect((await Repo.transactions.get(result.operationId))?.extraInputs.evmTxHash).toBe(depositHash)
  );
  const before = await Repo.transactions.get(result.operationId);
  const sent = signed.length;
  expect(before?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('known');
  expect(before?.extraInputs.bridgeOperation?.operationId).not.toBe(result.operationId);
  expect(await submitReviewedBridge(review, deps)).toEqual(result);
  expect(signed).toHaveLength(sent);
  expect(await Repo.transactions.count()).toBe(1);
});

it.each(['reset', 'smaller'])(
  'waits for another owned pending %s even when current allowance is sufficient, then makes only the new reviewed deposit',
  async stage => {
    allowance = stage === 'reset' ? 1n : 0n;
    rpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Old receipt unavailable'));
    const old = await drive(stage === 'reset' ? reviewAmount('1') : reviewAmount('0.5'), 'old-pending');
    expect(old.error).toBeInstanceOf(Error);
    const reference = old.row?.extraInputs.bridgeOperation?.approvals?.[0];
    if (!reference) throw new Error('Missing actual old approval');
    const transaction = sourceTransactions.get(reference.hash);
    if (!transaction) throw new Error('Missing original own call');
    sourceTransactions.set(reference.hash, { ...transaction, blockNumber: null });
    rpc.getBlockNumber.mockResolvedValue(20n);
    rpc.getTransactionCount.mockResolvedValue(transaction.nonce);
    allowance = 2000000000000000000n;
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const waiting = new Promise<void>(resolve => {
      entered = resolve;
    });
    rpc.waitForTransactionReceipt.mockImplementationOnce(async ({ hash }) => {
      expect(hash).toBe(reference.hash);
      entered();
      await released;
      allowance = stage === 'reset' ? 0n : 500000000000000000n;
      return { status: 'success', transactionHash: hash };
    });
    const current = drive(reviewAmount('1'), 'new-reviewed');
    try {
      expect(await Promise.race([waiting.then(() => true), current.then(() => false)])).toBe(true);
      expect(signed).toHaveLength(1);
      expect((await Repo.transactions.get(old.id))?.extraInputs.evmTxHash).toBeUndefined();
      release();
      const result = await current;
      expect(result.error).toBeUndefined();
      expect(result.row?.extraInputs.evmTxHash).toBe(depositHash);
      expect(signed.filter(tx => tx.to === bridgeAddress)).toHaveLength(1);
      const original = await Repo.transactions.get(old.id);
      expect(original?.extraInputs.bridgeOperation?.revision).toBe(old.captured?.revision);
      expect(original?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
      expect(original?.extraInputs.evmTxHash).toBeUndefined();
    } finally {
      release();
      await current;
    }
  }
);

it.each(['rpc', 'missing-call', 'nonce-conflict', 'receipt-hash', 'scope'])(
  'blocks the new operation when old reducing approval observation has %s uncertainty',
  async uncertainty => {
    allowance = 1n;
    rpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Old receipt unavailable'));
    const old = await drive(reviewAmount('1'), 'old-reset');
    expect(old.error).toBeInstanceOf(Error);
    allowance = 2000000000000000000n;
    if (uncertainty === 'rpc' || uncertainty === 'missing-call') {
      rpc.getTransaction.mockRejectedValue(new Error('Old transaction unreadable'));
      if (uncertainty === 'missing-call')
        await Repo.transactions.update(old.id, {
          'extraInputs.bridgeOperation.approvals': [
            { ...old.row?.extraInputs.bridgeOperation.approvals[0], transaction: undefined }
          ]
        });
    }
    if (uncertainty === 'nonce-conflict')
      await Repo.transactions.update(old.id, { 'extraInputs.bridgeOperation.approvals.0.transaction.nonce': 99 });
    rpc.waitForTransactionReceipt.mockImplementationOnce(async ({ hash }) => {
      if (uncertainty === 'scope')
        jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://departed-rpc.example/private');
      return { status: 'success', transactionHash: uncertainty === 'receipt-hash' ? `0x${'f'.repeat(64)}` : hash };
    });
    const current = await drive(reviewAmount('1'), 'new-reset-review');
    expect(current.error).toBeInstanceOf(Error);
    expect(signed).toHaveLength(1);
    expect(current.row?.extraInputs.evmTxHash).toBeUndefined();
    expect((await Repo.transactions.get(old.id))?.extraInputs.evmTxHash).toBeUndefined();
  }
);

it('allows a distinct fresh operation after independently verified mined cancellation of an old reset, without rearming it', async () => {
  allowance = 1n;
  rpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Old receipt unavailable'));
  const old = await drive(reviewAmount('1'), 'old-cancelled-reset');
  expect(old.error).toBeInstanceOf(Error);
  allowance = 2000000000000000000n;
  rpc.waitForTransactionReceipt.mockImplementationOnce(async ({ onReplaced }) => {
    const original = sourceTransactions.get(resetHash);
    if (!original) throw new Error('Missing original reset');
    const replacement: SourceRpcTransaction = {
      ...original,
      hash: `0x${'e'.repeat(64)}`,
      to: `0x${accounts.evmAddress.slice(2)}`,
      input: '0x',
      value: 0n
    };
    sourceTransactions.set(replacement.hash, replacement);
    onReplaced({ reason: 'cancelled', transaction: replacement });
    return { status: 'success', transactionHash: replacement.hash };
  });
  const current = await drive(reviewAmount('1'), 'distinct-fresh-operation');
  expect(current.error).toBeUndefined();
  expect(rpc.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
  expect(signed).toHaveLength(2);
  expect(current.row?.extraInputs.evmTxHash).toBe(depositHash);
  const original = await Repo.transactions.get(old.id);
  expect(original?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
  expect(original?.extraInputs.bridgeOperation?.approvals?.[1]?.replacementReason).toBe('cancelled');
  expect(original?.extraInputs.evmTxHash).toBeUndefined();
  const later = await drive(reviewAmount('1'), 'another-fresh-operation');
  expect(later.error).toBeUndefined();
  expect(later.row?.extraInputs.evmTxHash).toBe(`0x${'d'.repeat(64)}`);
  expect((await Repo.transactions.get(old.id))?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
});

it('keeps a verified non-reducing approval sufficient-allowance fast path for a separately reviewed operation', async () => {
  rpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Old receipt unavailable'));
  const old = await drive(reviewAmount('2'), 'old-nonreducing');
  expect(old.error).toBeInstanceOf(Error);
  allowance = 1000000000000000000n;
  const current = await drive(reviewAmount('1'), 'fresh-review');
  expect(current.error).toBeUndefined();
  expect(signed.filter(tx => tx.to === bridgeAddress)).toHaveLength(1);
  expect(rpc.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  expect((await Repo.transactions.get(old.id))?.extraInputs.evmTxHash).toBeUndefined();
});

it('does not let a pending approval by a different EVM account interfere with this account', async () => {
  const oldReview = reviewAmount('0.5');
  oldReview.accounts.evmAddress = `0x${'9'.repeat(40)}`;
  if (!oldReview.quote) throw new Error('Missing quote');
  oldReview.quote.request.evmAddress = oldReview.accounts.evmAddress;
  activeAccount = oldReview.accounts.evmAddress;
  rpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Other account receipt unavailable'));
  const old = await drive(oldReview, 'other-account');
  expect(old.error).toBeInstanceOf(Error);
  activeAccount = accounts.evmAddress;
  allowance = 1000000000000000000n;
  const current = await drive(reviewAmount('1'), 'this-account');
  expect(current.error).toBeUndefined();
  expect(rpc.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  expect(signed.filter(tx => tx.to === bridgeAddress)).toHaveLength(1);
});

it.each(['account', 'amount', 'route'])(
  'checks the actual live %s context again after approval without losing original approval facts',
  async change => {
    const review = reviewAmount('1');
    let current = structuredClone(review);
    const route = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
    if (!route || review.route.source.kind !== 'erc20') throw new Error('Missing live context fixture');
    bridgeAddress = route.contractAddress;
    tokenAddress = `0x${review.route.source.address.slice(2)}`;
    approvedAmount = 1000000000000000000n;
    const receipt = rpc.waitForTransactionReceipt.getMockImplementation()!;
    rpc.waitForTransactionReceipt.mockImplementationOnce(async args => {
      const result = await receipt(args);
      if (change === 'account') current.accounts.midenAccount = '0x1111111111111111111111111111';
      if (change === 'amount') current.amount = '2';
      if (change === 'route') current = { ...current, route: testRoute() };
      return result;
    });
    const id = await runAgglayerReceive(
      { operationId: 'live-context', review },
      {
        client: rpc,
        provider,
        checks: {
          readCurrent: async () => structuredClone(current),
          verifyBalanceCap: async () => undefined,
          now: () => now
        }
      }
    );
    await waitFor(async () =>
      expect(['known', 'uncertain']).toContain(
        (await Repo.transactions.get(id))?.extraInputs.bridgeOperation?.sourceAttempt?.phase
      )
    );
    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
    expect(row?.extraInputs.bridgeOperation?.approvals?.[0]?.hash).toBe(approvalHash);
    expect(row?.extraInputs.bridgeOperation?.review.accounts.midenAccount).toBe(accounts.midenAccount);
    expect(row?.extraInputs.evmTxHash).toBeUndefined();
    expect(signed).toHaveLength(1);
  }
);

it.each(['unchanged', 'account', 'rpc'])(
  'rechecks original guards after the live reader itself parks (departure=%s)',
  async departure => {
    const review = reviewAmount('1');
    const current = structuredClone(review);
    const route = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
    if (!route || review.route.source.kind !== 'erc20') throw new Error('Missing live reader fixture');
    bridgeAddress = route.contractAddress;
    tokenAddress = `0x${review.route.source.address.slice(2)}`;
    approvedAmount = 1000000000000000000n;
    let approved = false;
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => {
      entered = resolve;
    });
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const receipt = rpc.waitForTransactionReceipt.getMockImplementation()!;
    rpc.waitForTransactionReceipt.mockImplementationOnce(async args => {
      const result = await receipt(args);
      approved = true;
      return result;
    });
    const id = await runAgglayerReceive(
      { operationId: 'late-live-reader', review },
      {
        client: rpc,
        provider,
        checks: {
          readCurrent: async () => {
            if (approved) {
              entered();
              await released;
            }
            return structuredClone(current);
          },
          verifyBalanceCap: async () => undefined,
          now: () => now
        }
      }
    );
    const settled = waitFor(async () =>
      expect(['known', 'uncertain']).toContain(
        (await Repo.transactions.get(id))?.extraInputs.bridgeOperation?.sourceAttempt?.phase
      )
    );
    try {
      expect(await Promise.race([waiting.then(() => true), settled.then(() => false)])).toBe(true);
      expect(signed).toHaveLength(1);
      if (departure === 'account') current.accounts.midenAccount = '0x1111111111111111111111111111';
      if (departure === 'rpc') jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://departed-rpc.example/private');
      release();
      await settled;
      const row = await Repo.transactions.get(id);
      expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe(
        departure === 'unchanged' ? 'known' : 'uncertain'
      );
      expect(row?.extraInputs.bridgeOperation?.approvals?.[0]?.hash).toBe(approvalHash);
      expect(signed).toHaveLength(departure === 'unchanged' ? 2 : 1);
    } finally {
      release();
      await settled;
    }
  }
);

it('admits a reviewed receive through the provider and existing wrapper once, including duplicate requests', async () => {
  const review = reviewedErc20Transfer('agglayer');
  const route = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
  if (!route || review.route.source.kind !== 'erc20') throw new Error('Missing accepted provider fixture');
  bridgeAddress = route.contractAddress;
  tokenAddress = `0x${review.route.source.address.slice(2)}`;
  approvedAmount = 1000000000000000000n;
  const operation = { operationId: 'provider-receive', review };
  const deps = {
    client: rpc,
    provider,
    checks: {
      readCurrent: async () => structuredClone(review),
      verifyBalanceCap: async () => undefined,
      now: () => now
    }
  };
  const first = await runAgglayerReceive(operation, deps);
  const duplicate = await runAgglayerReceive(operation, deps);
  expect(duplicate).toBe(first);
  await waitFor(async () => expect((await Repo.transactions.get(first))?.extraInputs.evmTxHash).toBe(depositHash));
  expect(await Repo.transactions.count()).toBe(1);
  expect(signed.filter(tx => tx.to === bridgeAddress)).toHaveLength(1);
  expect((await Repo.transactions.get(first))?.extraInputs.agglayerDelivery).toEqual({
    originToken: tokenAddress,
    faucetId: '0xb41aed8db850a3d140fc2079216c60',
    scale: 10
  });
});

it.each([false, true])(
  'keeps the outer scope across the actual platform submission-lock await (departed=%s)',
  async departed => {
    const review = reviewedErc20Transfer('agglayer');
    const route = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
    if (!route || review.route.source.kind !== 'erc20') throw new Error('Missing accepted lock fixture');
    bridgeAddress = route.contractAddress;
    tokenAddress = `0x${review.route.source.address.slice(2)}`;
    approvedAmount = 1000000000000000000n;
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const waiting = new Promise<void>(resolve => {
      entered = resolve;
    });
    let done: () => void = () => undefined;
    const drained = new Promise<void>(resolve => {
      done = resolve;
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => {
          entered();
          await released;
          try {
            await callback({});
          } finally {
            done();
          }
        }
      }
    });
    try {
      const pending = runAgglayerReceive(
        { operationId: 'locked-receive', review },
        {
          client: rpc,
          provider,
          checks: {
            readCurrent: async () => structuredClone(review),
            verifyBalanceCap: async () => undefined,
            now: () => now
          }
        }
      );
      await waiting;
      expect(await Repo.transactions.count()).toBe(0);
      if (departed) jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://departed-rpc.example/private');
      release();
      const outcome = await pending.then(
        id => ({ id, error: undefined }),
        (error: unknown) => ({ id: undefined, error })
      );
      await drained;
      const refusal = expect.any(Error);
      const admittedId = expect.any(String);
      expect(outcome).toEqual(departed ? { id: undefined, error: refusal } : { id: admittedId, error: undefined });
      expect(await Repo.transactions.count()).toBe(departed ? 0 : 1);
      await waitFor(async () => {
        const row = outcome.id === undefined ? undefined : await Repo.transactions.get(outcome.id);
        expect(row?.extraInputs.evmTxHash).toBe(departed ? undefined : depositHash);
      });
      expect(signed.filter(tx => tx.to === bridgeAddress)).toHaveLength(departed ? 0 : 1);
      expect(signed).toHaveLength(departed ? 0 : 2);
    } finally {
      release();
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  }
);

it('does not adopt another RPC during the asynchronous receive balance-cap check', async () => {
  const review = reviewedErc20Transfer('agglayer');
  const deps = {
    client: rpc,
    provider,
    checks: {
      readCurrent: async () => structuredClone(review),
      verifyBalanceCap: async () => {
        jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example/private');
      },
      now: () => now
    }
  };
  await expect(runAgglayerReceive({ operationId: 'departed-receive', review }, deps)).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(0);
  expect(signed).toHaveLength(0);
});

it('bridges native value exactly once without token approval and saves the original source hash', async () => {
  const { error, row } = await drive(nativeReview());
  expect(error).toBeUndefined();
  expect(signed).toHaveLength(1);
  expect(signed[0]).toMatchObject({ value: '0xde0b6b3a7640000', chainId: '0xaa36a7', from: accounts.evmAddress });
  expect(decodeFunctionData({ abi: AGGLAYER_BRIDGE_ABI, data: signed[0]!.data })).toMatchObject({
    functionName: 'bridgeAsset',
    args: [
      expect.any(Number),
      '0x00000000387149AE66116cF114eEbd60Bb738100',
      1000000000000000000n,
      '0x0000000000000000000000000000000000000000',
      true,
      '0x'
    ]
  });
  expect(row?.extraInputs.evmTxHash).toBe(depositHash);
  expect(row?.extraInputs.phase).not.toBe('received');
});

it.each([0n, 1n, 2000000000000000000n])(
  'uses allowance %s without max approval, resetting a nonzero short allowance',
  async current => {
    allowance = current;
    const { error, row } = await drive();
    expect(error).toBeUndefined();
    const amounts = signed
      .filter(tx => tx.to === tokenAddress)
      .map(tx => decodeFunctionData({ abi: erc20Abi, data: tx.data }).args?.[1]);
    expect(amounts).toEqual(current === 0n ? [1000000000000000000n] : current === 1n ? [0n, 1000000000000000000n] : []);
    expect(signed.at(-1)).toMatchObject({ to: bridgeAddress, value: '0x0' });
    expect((row && bridgeOperationOf(row))?.approvals?.map(item => item.amount)).toEqual(
      current === 0n ? ['1000000000000000000'] : current === 1n ? ['0', '1000000000000000000'] : undefined
    );
    expect(row?.extraInputs.evmTxHash).toBe(depositHash);
  }
);

it.each(['native', 'token'])('reserves native gas before a %s wallet prompt', async kind => {
  rpc.getBalance.mockResolvedValue(0n);
  const { error, row } = await drive(kind === 'native' ? nativeReview() : reviewedErc20Transfer('agglayer'));
  expect(signed).toHaveLength(0);
  expect(error).toBeInstanceOf(Error);
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
});

it('refuses a changed contract decimal scale before ERC20 approval', async () => {
  const read = rpc.readContract.getMockImplementation()!;
  rpc.readContract.mockImplementation(async args => (args.functionName === 'decimals' ? 6 : read(args)));
  const { error } = await drive();
  expect(signed).toHaveLength(0);
  expect(error).toBeInstanceOf(Error);
});

it.each(['account', 'chain', 'rpc'])(
  'retains the approval but sends no deposit after %s changes during its receipt',
  async change => {
    rpc.waitForTransactionReceipt.mockImplementationOnce(async () => {
      allowance = approvedAmount;
      if (change === 'rpc') jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example/private');
      else
        wallet.mockImplementation(async ({ method }) =>
          method === 'eth_accounts' ? [change === 'account' ? `0x${'9'.repeat(40)}` : accounts.evmAddress] : '0x1'
        );
      return { status: 'success', transactionHash: approvalHash };
    });
    const { error, row } = await drive();
    expect(signed).toHaveLength(1);
    expect(error).toBeInstanceOf(Error);
    expect(row?.extraInputs.bridgeOperation?.approvals?.[0]?.hash).toBe(approvalHash);
    expect(row?.extraInputs.evmTxHash).toBeUndefined();
    expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
  }
);

it.each(['revision', 'operation', 'review'])(
  'does not adopt a changed %s after an asynchronous gas estimate or demote its owner',
  async changed => {
    rpc.estimateGas.mockImplementationOnce(async () => {
      const row = (await Repo.transactions.toArray())[0];
      if (!row) throw new Error('Missing real admitted row');
      if (!row) throw new Error('Missing claimed row');
      if (changed === 'revision')
        await Repo.transactions.update(row.id, { 'extraInputs.bridgeOperation.revision': 'another-owner' });
      if (changed === 'operation')
        await Repo.transactions.update(row.id, { 'extraInputs.bridgeOperation.operationId': 'another-operation' });
      if (changed === 'review')
        await Repo.transactions.update(row.id, { 'extraInputs.bridgeOperation.review.amount': '2' });
      return 100000n;
    });
    const { error, row } = await drive();
    expect(error).toBeInstanceOf(Error);
    expect(signed).toHaveLength(0);
    expect(row?.extraInputs.phase).toBe('submitting');
    expect(row?.extraInputs.evmTxHash).toBeUndefined();
    expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe(changed === 'review' ? 'uncertain' : 'running');
  }
);

it.each([0n, -1n])('keeps the exact native deposit plus buffered gas reserve boundary (offset=%s)', async offset => {
  rpc.getBalance.mockResolvedValue(1000000000012000000n + offset);
  const { error } = await drive(nativeReview());
  expect(signed).toHaveLength(offset === 0n ? 1 : 0);
  const refusal = expect.any(Error);
  expect(error).toEqual(offset === 0n ? undefined : refusal);
});

it('refuses a false-return approval without a signature', async () => {
  rpc.call.mockResolvedValue({ data: `0x${'0'.repeat(64)}` });
  const { error } = await drive();
  expect(error).toBeInstanceOf(Error);
  expect(signed).toHaveLength(0);
});

it('retains a first approval hash when metadata and receipt RPCs fail, without a deposit or reload replay', async () => {
  rpc.getTransaction.mockRejectedValue(new Error('RPC unavailable'));
  rpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Receipt unavailable'));
  const { id, error, row } = await drive();
  expect(error).toBeInstanceOf(Error);
  expect(signed).toHaveLength(1);
  expect(row?.extraInputs.bridgeOperation?.approvals).toEqual([
    expect.objectContaining({ hash: approvalHash, amount: '1000000000000000000' })
  ]);
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
  const replay = jest.fn();
  await createBridgeReceiveReconciler({ getLocks: () => undefined }).startSubmission(async () => id, replay);
  await Repo.transactions.get(id);
  expect(replay).not.toHaveBeenCalled();
});

it('persists the returned original source hash even when the wallet scope leaves during the prompt', async () => {
  const send = wallet.getMockImplementation()!;
  wallet.mockImplementation(async args => {
    const result = await send(args);
    if (args.method === 'eth_sendTransaction')
      jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://departed-rpc.example/private');
    return result;
  });
  const { error, row } = await drive(nativeReview());
  expect(error).toBeUndefined();
  expect(row?.extraInputs.evmTxHash).toBe(depositHash);
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.hash).toBe(depositHash);
});

it('matches an owned native-unit delivery after source readiness, expiry and RPC departure, then records only a completed local consume', async () => {
  const review = reviewedErc20Transfer('agglayer');
  const { error, id } = await drive(review);
  expect(error).toBeUndefined();
  expect(review.route.destination.kind).toBe('miden');
  await updateBridgedReceivePhase(id, 'ready');
  expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('ready');
  jest.spyOn(Date, 'now').mockReturnValue(now + 120000);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://departed-rpc.example/private');
  const info = await takeAgglayerBridgeInInfo({
    accountId: accounts.midenAccount,
    senderAccountId: '0xb41aed8db850a3d140fc2079216c60',
    amount: 100000000n
  });
  expect(info).toMatchObject({ bridgeReceiveTxId: id, evmTxHash: depositHash, sourceToken: tokenAddress });
  if (!info) throw new Error('Missing original delivery');
  await Repo.transactions.add({
    id: 'local-consume',
    accountId: accounts.midenAccount,
    type: 'consume',
    status: ITransactionStatus.Queued,
    initiatedAt: now / 1000,
    displayIcon: 'RECEIVE',
    amount: 100000000n,
    faucetId: '0xb41aed8db850a3d140fc2079216c60',
    transactionId: 'miden-consume'
  });
  await expect(applyBridgeInToConsumeRow('local-consume', info)).rejects.toThrow();
  expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('ready');
  await Repo.transactions.update('local-consume', { status: ITransactionStatus.Completed });
  await applyBridgeInToConsumeRow('local-consume', info);
  const received = await Repo.transactions.get(id);
  expect(received?.extraInputs.phase).toBe('received');
  expect(received?.amount).toBe(100000000n);
  expect(received?.transactionId).toBe('miden-consume');
  expect(received?.extraInputs.bridgeOperation?.sourceAttempt?.hash).toBe(depositHash);
});

it.each(['faucet', 'recipient', 'amount', 'malformed', 'restored', 'recovered', 'source-less', 'changed-review'])(
  'does not attribute an owned delivery with %s mismatch',
  async change => {
    const { id, error } = await drive();
    expect(error).toBeUndefined();
    if (change === 'restored') await Repo.transactions.update(id, { restoredFromBackup: true });
    if (change === 'recovered') await Repo.transactions.update(id, { recovered: true });
    if (change === 'source-less') await Repo.transactions.update(id, { 'extraInputs.evmTxHash': undefined });
    if (change === 'malformed')
      await Repo.transactions.update(id, { 'extraInputs.bridgeOperation': { owner: 'wallet' } });
    if (change === 'changed-review')
      await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.review.amount': '2' });
    const match = await takeAgglayerBridgeInInfo({
      accountId: change === 'recipient' ? '0x1111111111111111111111111111' : accounts.midenAccount,
      senderAccountId: change === 'faucet' ? '0x7c6d1dc7fb7045913d524bbef017f5' : '0xb41aed8db850a3d140fc2079216c60',
      amount: change === 'amount' ? 99999999n : 100000000n
    });
    expect(match).toBeUndefined();
    expect((await Repo.transactions.get(id))?.extraInputs.phase).not.toBe('received');
  }
);

it('does not invent the oldest owned recipient-and-amount identity for two different funded operations', async () => {
  const first = await drive();
  expect(first.error).toBeUndefined();
  expect(
    await takeAgglayerBridgeInInfo({
      accountId: accounts.midenAccount,
      senderAccountId: '0xb41aed8db850a3d140fc2079216c60',
      amount: 100000000n
    })
  ).toMatchObject({ bridgeReceiveTxId: first.id });
  const second = await drive(reviewedErc20Transfer('agglayer'), 'another-owned-operation');
  expect(second.error).toBeUndefined();
  expect(second.id).not.toBe(first.id);
  expect(second.row?.extraInputs.evmTxHash).toBe(`0x${'d'.repeat(64)}`);
  expect(
    await takeAgglayerBridgeInInfo({
      accountId: accounts.midenAccount,
      senderAccountId: '0xb41aed8db850a3d140fc2079216c60',
      amount: 100000000n
    })
  ).toBeUndefined();
  expect((await Repo.transactions.get(first.id))?.extraInputs.phase).not.toBe('received');
  expect((await Repo.transactions.get(second.id))?.extraInputs.phase).not.toBe('received');
});

it('retains the untagged legacy source-unit scaling contract', async () => {
  const { id, error } = await drive();
  expect(error).toBeUndefined();
  await Repo.transactions.where({ id }).modify(row => {
    Reflect.deleteProperty(row.extraInputs, 'bridgeOperation');
    row.amount = 1000000000000000000n;
  });
  expect(
    await takeAgglayerBridgeInInfo({
      accountId: accounts.midenAccount,
      senderAccountId: '0xb41aed8db850a3d140fc2079216c60',
      amount: 100000000n
    })
  ).toMatchObject({ bridgeReceiveTxId: id });
});

it.each(['repriced', 'cancelled', 'replaced'])(
  'records verified %s approval lineage without treating the approval as a deposit',
  async reason => {
    rpc.waitForTransactionReceipt.mockImplementationOnce(async ({ onReplaced }) => {
      const original = await rpc.getTransaction({ hash: approvalHash });
      const replacement = {
        ...original,
        hash: `0x${'e'.repeat(64)}`,
        to: reason === 'cancelled' ? accounts.evmAddress : tokenAddress,
        input: reason === 'cancelled' ? '0x' : reason === 'replaced' ? '0x1234' : original.input
      };
      onReplaced({ reason, transaction: replacement });
      allowance = approvedAmount;
      return { status: 'success', transactionHash: replacement.hash };
    });
    const { error, row } = await drive();
    const approvals = row?.extraInputs.bridgeOperation?.approvals;
    expect(approvals).toHaveLength(2);
    expect(approvals?.[1]).toMatchObject({
      hash: `0x${'e'.repeat(64)}`,
      replacementReason: reason,
      originalTransaction: { hash: approvalHash, nonce: 2 },
      transaction: { hash: `0x${'e'.repeat(64)}`, nonce: 2 }
    });
    expect(signed.filter(tx => tx.to === bridgeAddress)).toHaveLength(reason === 'repriced' ? 1 : 0);
    const refusal = expect.any(Error);
    expect(error).toEqual(reason === 'repriced' ? undefined : refusal);
    expect(row?.extraInputs.evmTxHash).toBe(reason === 'repriced' ? depositHash : undefined);
  }
);

it('recovers an approval cancellation through the existing tracker after departure without any source or approval replay', async () => {
  rpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Receipt unavailable'));
  const { id, error, row } = await drive();
  expect(error).toBeInstanceOf(Error);
  expect(row?.extraInputs.bridgeOperation?.approvals?.[0]?.transaction?.nonce).toBe(2);
  const own = await rpc.getTransaction({ hash: approvalHash });
  rpc.getTransaction.mockResolvedValue({ ...own, blockNumber: null });
  rpc.getBlockNumber.mockResolvedValue(20n);
  rpc.getTransactionCount.mockImplementation(async ({ blockNumber }) => (blockNumber >= 10n ? 3 : 2));
  rpc.getBlock.mockResolvedValue({
    timestamp: 1800000010n,
    transactions: [
      { ...own, hash: `0x${'e'.repeat(64)}`, to: accounts.evmAddress, input: '0x', value: 0n, blockNumber: 10n }
    ]
  });
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://departed-rpc.example/private');
  jest.spyOn(Date, 'now').mockReturnValue(now + 120000);
  await createBridgeReceiveReconciler({ getLocks: () => undefined }).reconcile();
  const recovered = await Repo.transactions.get(id);
  expect(recovered?.extraInputs.bridgeOperation?.approvals).toHaveLength(2);
  expect(recovered?.extraInputs.bridgeOperation?.approvals?.[1]).toMatchObject({
    hash: `0x${'e'.repeat(64)}`,
    replacementReason: 'cancelled',
    originalTransaction: { hash: approvalHash, nonce: 2 }
  });
  expect(recovered?.extraInputs.evmTxHash).toBeUndefined();
  expect(recovered?.extraInputs.phase).toBe('submitting');
  expect(signed).toHaveLength(1);
});

it.each([
  'valid',
  'recipient',
  'token',
  'network',
  'amount',
  'finality-false',
  'finality-only',
  'contradictory',
  'claimed'
])('separates source receipt from exact %s destination observation and local consumption', async field => {
  const { id, error } = await drive();
  expect(error).toBeUndefined();
  const deposit = {
    leaf_type: 0,
    orig_net: 0,
    orig_addr: field === 'token' ? `0x${'8'.repeat(40)}` : tokenAddress,
    amount: field === 'amount' ? '2000000000000000000' : '1000000000000000000',
    dest_net: field === 'network' ? 99 : 73,
    dest_addr: field === 'recipient' ? `0x${'8'.repeat(40)}` : '0x00000000387149ae66116cf114eebd60bb738100',
    block_num: '1',
    deposit_cnt: 42,
    network_id: 0,
    tx_hash: depositHash,
    claim_tx_hash: field === 'claimed' ? `0x${'e'.repeat(64)}` : '',
    metadata: '0x',
    ready_for_claim:
      field === 'finality-only' ? undefined : field === 'finality-false' || field === 'claimed' ? false : true,
    ready_to_claim: field === 'contradictory' ? false : undefined,
    finalized: field === 'finality-false' || field === 'finality-only',
    global_index: '42'
  };
  jest.mocked(fetchDeposits).mockResolvedValueOnce([deposit]);
  await createBridgeReceiveReconciler({ getLocks: () => undefined }).reconcile();
  const row = await Repo.transactions.get(id);
  expect(row?.extraInputs.phase).toBe(
    field === 'valid' || field === 'claimed' || field === 'contradictory' ? 'ready' : 'delivering'
  );
  expect(row?.extraInputs.phase).not.toBe('received');
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.hash).toBe(depositHash);
});

it.each(['receipt-unavailable', 'receipt-pending', 'all-unavailable'])(
  'keeps exact destination evidence independent of %s source reads',
  async observation => {
    const { id, error } = await drive();
    expect(error).toBeUndefined();
    const deposit = {
      leaf_type: 0,
      orig_net: 0,
      orig_addr: tokenAddress,
      amount: '1000000000000000000',
      dest_net: 73,
      dest_addr: '0x00000000387149ae66116cf114eebd60bb738100',
      block_num: '1',
      deposit_cnt: 42,
      network_id: 0,
      tx_hash: depositHash,
      claim_tx_hash: '',
      metadata: '0x',
      ready_for_claim: true,
      global_index: '42'
    };
    if (observation === 'receipt-pending') jest.mocked(readEvmReceiptOutcome).mockResolvedValueOnce('pending');
    else jest.mocked(readEvmReceiptOutcome).mockRejectedValueOnce(new Error('Receipt RPC unavailable'));
    if (observation === 'all-unavailable')
      jest.mocked(fetchDeposits).mockRejectedValueOnce(new Error('Indexer unavailable'));
    else jest.mocked(fetchDeposits).mockResolvedValueOnce([deposit]);
    await createBridgeReceiveReconciler({ getLocks: () => undefined }).reconcile();
    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs.phase).toBe(observation === 'all-unavailable' ? 'submitting' : 'ready');
    expect(row?.extraInputs.phase).not.toBe('received');
    expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.hash).toBe(depositHash);
  }
);

it('accepts no-return approval and requires its confirmed allowance before bridging', async () => {
  const { error, row } = await drive();
  expect(error).toBeUndefined();
  expect(rpc.call).toHaveBeenCalledWith(
    expect.objectContaining({
      to: tokenAddress,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [bridgeAddress, 1000000000000000000n] })
    })
  );
  expect(row?.extraInputs.bridgeOperation?.approvals?.[0]?.hash).toBe(approvalHash);
  expect(signed).toHaveLength(2);
});

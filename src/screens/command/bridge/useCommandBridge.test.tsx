import React from 'react';

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

import { deriveBridgeRoutes } from 'lib/bridge/catalog';

import { bindTransferQuote, type QuoteRequest, type TransferQuote } from 'lib/bridge/core/quote';
import { accounts, native, now, referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { quoteBridgeTransfer } from 'lib/bridge/wallet-transport';
import { switchWebWalletChain } from 'lib/epoch/client';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { BurnFeeReserve } from 'lib/usdcx/use-burn-fee-reserve';

import { CommandDraftProvider, useCommandDrafts } from '../command-drafts';
import { CommandWorkbench } from '../CommandWorkbench';
import { CommandBridge } from './CommandBridge';
import { useCommandBridge } from './useCommandBridge';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let mockSnapshot: BridgeConfigSnapshot;
let mockLocked = false;
let mockRpc = 'https://wallet-rpc.example/private';
let mockAddress = accounts.evmAddress;
let mockFee: BurnFeeReserve;
let mockNativeCorroborated = true;
let mockNativeScaleKnown = true;
jest.mock('lib/usdcx/use-burn-fee-reserve', () => ({ useBurnFeeReserve: () => mockFee }));
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  cacheScope: () => 'rpc-a|testnet',
  getNativeAssetIdSync: () => jest.requireActual('lib/bridge/testing/fixtures').native.faucetId,
  getSdkSyncedNativeAssetIdSync: () =>
    mockNativeCorroborated ? jest.requireActual('lib/bridge/testing/fixtures').native.faucetId : null
}));
jest.mock('lib/miden/metadata/resolve', () => ({
  resolveDisplayMetadata: () => ({
    symbol: mockNativeScaleKnown ? 'USDCx' : 'Unknown',
    name: mockNativeScaleKnown ? 'USDCx' : 'Unknown',
    decimals: 6,
    scaleIsUnknown: !mockNativeScaleKnown
  })
}));
const mockState = {
  currentAccount: { publicKey: accounts.midenAccount },
  balances: {} satisfies Record<string, TokenBalanceData[]>,
  balancesLoading: {},
  balanceReadFailed: {},
  tokenPricesStatus: 'ready',
  tokenPrices: {}
};
jest.mock('@reown/appkit/react', () => ({
  useAppKitNetwork: () => ({ chainId: 11155111 }),
  useDisconnect: () => ({ disconnect: jest.fn() })
}));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => jest.fn() }));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => null }));
jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ locked: mockLocked, signTransaction: jest.fn() }),
  useAllBalances: () => ({}),
  useAllTokensBaseMetadata: () => ({})
}));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => mockSnapshot }));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: () => mockSnapshot }));
jest.mock('lib/bridge/wallet-transport', () => ({ quoteBridgeTransfer: jest.fn() }));
jest.mock('lib/epoch/client', () => ({
  buildEpochWalletClient: jest.fn(),
  getEvmConnection: jest.fn(),
  switchWebWalletChain: jest.fn()
}));
jest.mock('lib/walletconnect/native', () => ({ ensureNativeSessionChain: jest.fn() }));
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({
    address: mockAddress,
    connected: true,
    nativeReown: {},
    useNativeReownWallet: false
  })
}));
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign((select: (state: typeof mockState) => unknown) => select(mockState), {
    getState: () => mockState
  })
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: () => mockRpc
}));

const scope = { accountId: accounts.midenAccount, network: 'testnet', rpcUrl: 'https://wallet-rpc.example/private' };
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CommandDraftProvider scope={{ ...scope, accountId: mockState.currentAccount.publicKey, rpcUrl: mockRpc }}>
    {children}
  </CommandDraftProvider>
);
const useConsumer = () => ({ bridge: useCommandBridge(), drafts: useCommandDrafts() });
function quote(request: QuoteRequest, received = '1'): TransferQuote {
  return bindTransferQuote(request, {
    kind:
      request.route.provider === 'epoch'
        ? 'epoch'
        : request.route.provider === 'xreserve'
          ? request.route.mode === 'send'
            ? 'withdrawal'
            : 'arc-deposit'
          : 'agglayer',
    received,
    validity: { kind: 'time', expiresAt: now + 60000 }
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  mockSnapshot = referenceSnapshot('testnet');
  mockLocked = false;
  mockRpc = scope.rpcUrl;
  mockState.currentAccount.publicKey = accounts.midenAccount;
  mockAddress = accounts.evmAddress;
  mockFee = {
    status: 'measured',
    reserve: 300n,
    faucetId: native.faucetId,
    scope: '0eab4363008ac48565a556005f9429c4a85838ec79dc00c463d15dcbb4c14c5c'
  };
  mockNativeCorroborated = true;
  mockNativeScaleKnown = true;
  jest.mocked(quoteBridgeTransfer).mockImplementation(async request => quote(request));
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

it('the real Bridge consumer stores exact unsigned direction, amount and external account in the shared Command draft', () => {
  const { result } = renderHook(useConsumer, { wrapper });
  act(() => {
    result.current.bridge.setDirection('out');
    result.current.bridge.setAmount('1.000001');
    result.current.bridge.setExternalAccountId('0x2222222222222222222222222222222222222222');
  });
  expect(result.current.drafts.readDraft('bridge')).toEqual(
    expect.objectContaining({
      direction: 'out',
      amount: '1.000001',
      externalAccountId: '0x2222222222222222222222222222222222222222'
    })
  );
  expect(result.current.bridge.amount).toBe('1.000001');
});

it('retains literal source input on a compatible provider change but discards the actual reviewed consent', async () => {
  const { result } = renderHook(useConsumer, { wrapper });
  const agglayer = result.current.bridge.routes.find(
    item => item.provider === 'agglayer' && item.source.symbol === 'USDC'
  );
  const epoch = result.current.bridge.routes.find(item => item.provider === 'epoch' && item.source.symbol === 'USDC');
  if (!agglayer || !epoch) throw new Error('Missing compatible real catalog sources');
  act(() => result.current.bridge.selectRoute(agglayer.id));
  act(() => result.current.bridge.setAmount('1.00000000'));
  // No ceiling is needed to isolate provider selection; current cap guard remains real.
  mockSnapshot.config!.limits = undefined;
  act(() => result.current.bridge.setAmount('1.00000000'));
  await waitFor(() => expect(result.current.bridge.canReview).toBe(true));
  act(() => result.current.bridge.reviewTransfer());
  expect(result.current.bridge.review?.amount).toBe('1.00000000');
  act(() => result.current.bridge.selectRoute(epoch.id));
  expect(result.current.bridge.amount).toBe('1.00000000');
  expect(result.current.bridge.review).toBeUndefined();
  expect(result.current.bridge.quote).toBeNull();
  expect(result.current.bridge.blocked).toBe(true);
});

it('source asset changes clear input while withdrawal destination browsing never switches the EVM source', () => {
  const { result } = renderHook(useConsumer, { wrapper });
  act(() => result.current.bridge.setDirection('out'));
  const routes = result.current.bridge.routes;
  const usdc = routes.find(item => item.provider === 'agglayer' && item.source.symbol === 'USDC');
  const eth = routes.find(item => item.provider === 'agglayer' && item.source.symbol === 'ETH');
  if (!usdc || !eth) throw new Error('Missing real native source choices');
  act(() => result.current.bridge.selectRoute(usdc.id));
  act(() => result.current.bridge.setAmount('1.00000000'));
  act(() => result.current.bridge.selectRoute(eth.id));
  expect(result.current.bridge.amount).toBe('');
  expect(switchWebWalletChain).not.toHaveBeenCalled();
});

it('a late quote cannot replace the current amount or grant its review', async () => {
  const pending: Array<{ request: QuoteRequest; resolve: (quote: TransferQuote) => void }> = [];
  jest
    .mocked(quoteBridgeTransfer)
    .mockImplementation(request => new Promise(resolve => pending.push({ request, resolve })));
  const { result } = renderHook(useConsumer, { wrapper });
  act(() => result.current.bridge.setDirection('out'));
  const route = result.current.bridge.routes.find(item => item.provider === 'agglayer');
  if (!route) throw new Error('Missing real source');
  act(() => result.current.bridge.selectRoute(route.id));
  act(() => result.current.bridge.setExternalAccountId(accounts.evmAddress));
  act(() => result.current.bridge.setAmount('1'));
  act(() => result.current.bridge.setAmount('2'));
  expect(pending).toHaveLength(2);
  const [first, second] = pending;
  if (!first || !second) throw new Error('Missing actual pending quote requests');
  await act(async () => second.resolve(quote(second.request, '2')));
  expect(result.current.bridge.quote?.received).toBe('2');
  await act(async () => first.resolve(quote(first.request, '1')));
  expect(result.current.bridge.amount).toBe('2');
  expect(result.current.bridge.quote?.received).toBe('2');
  expect(result.current.bridge.review).toBeUndefined();
});

it.each(['account', 'rpc', 'lock'])('scope %s clears unsigned selections and rejects retained stale setters', kind => {
  const { result, rerender } = renderHook(useConsumer, { wrapper });
  const staleSetter = result.current.bridge.setAmount;
  act(() => result.current.bridge.setAmount('1.00000000'));
  if (kind === 'account') mockState.currentAccount.publicKey = '0x287149ae66116cf114eebd60bb7381';
  if (kind === 'rpc') mockRpc = 'https://changed-rpc.example';
  if (kind === 'lock') mockLocked = true;
  rerender();
  expect(result.current.bridge.amount).toBe('');
  act(() => staleSetter('99'));
  expect(result.current.bridge.amount).toBe('');
  expect(result.current.drafts.readDraft('bridge')).toBeUndefined();
});

it('A to B to A never revives a retained setter from the original account scope', () => {
  const { result, rerender } = renderHook(useConsumer, { wrapper });
  const staleSetter = result.current.bridge.setAmount;
  act(() => result.current.bridge.setAmount('1.00000000'));
  mockState.currentAccount.publicKey = '0x287149ae66116cf114eebd60bb7381';
  rerender();
  mockState.currentAccount.publicKey = accounts.midenAccount;
  rerender();
  act(() => staleSetter('99'));
  expect(result.current.bridge.amount).toBe('');
  expect(result.current.drafts.readDraft('bridge')).toBeUndefined();
  act(() => result.current.bridge.setAmount('2.00000000'));
  expect(result.current.bridge.amount).toBe('2.00000000');
});

it('a retained setter after minimize/unmount cannot overwrite the reopened consumer shared draft', () => {
  let setter: (value: string) => void = () => undefined;
  let readDraft: ReturnType<typeof useCommandDrafts>['readDraft'] | undefined;
  function Consumer() {
    const bridge = useCommandBridge();
    setter = bridge.setAmount;
    readDraft = useCommandDrafts().readDraft;
    return <span data-testid="amount">{bridge.amount}</span>;
  }
  const view = (show: boolean) => <CommandDraftProvider scope={scope}>{show && <Consumer />}</CommandDraftProvider>;
  const { rerender } = render(view(true));
  act(() => setter('1.00000000'));
  const staleSetter = setter;
  rerender(view(false));
  rerender(view(true));
  act(() => staleSetter('99'));
  expect(screen.getByTestId('amount')).toHaveTextContent('1.00000000');
  expect(readDraft?.('bridge')?.amount).toBe('1.00000000');
  act(() => setter('2.00000000'));
  expect(screen.getByTestId('amount')).toHaveTextContent('2.00000000');
  expect(readDraft?.('bridge')?.amount).toBe('2.00000000');
});

it('minimize/reopen restores only unsigned literals, never quote/review/signature or submit permission', async () => {
  function Consumer() {
    const bridge = useCommandBridge();
    return (
      <>
        <span data-testid="amount">{bridge.amount}</span>
        <span data-testid="review">{String(Boolean(bridge.review))}</span>
        <button
          onClick={() => {
            bridge.setDirection('out');
            bridge.setAmount('1.000001');
            bridge.setExternalAccountId(accounts.evmAddress);
          }}
        >
          edit
        </button>
      </>
    );
  }
  const view = (show: boolean) => <CommandDraftProvider scope={scope}>{show && <Consumer />}</CommandDraftProvider>;
  const { rerender } = render(view(true));
  act(() => screen.getByText('edit').click());
  expect(screen.getByTestId('amount')).toHaveTextContent('1.000001');
  rerender(view(false));
  rerender(view(true));
  expect(screen.getByTestId('amount')).toHaveTextContent('1.000001');
  expect(screen.getByTestId('review')).toHaveTextContent('false');
  await waitFor(() => expect(quoteBridgeTransfer).toHaveBeenCalled());
  rerender(
    <CommandDraftProvider key="reload" scope={scope}>
      <Consumer />
    </CommandDraftProvider>
  );
  expect(screen.getByTestId('amount')).toBeEmptyDOMElement();
  expect(screen.getByTestId('review')).toHaveTextContent('false');
});

function composeCircle() {
  const consumer = renderHook(useConsumer, { wrapper });
  act(() => consumer.result.current.bridge.setDirection('out'));
  const route = consumer.result.current.bridge.routes.find(item => item.provider === 'xreserve');
  if (!route) throw new Error('Missing available actual Circle catalog route');
  act(() => {
    consumer.result.current.bridge.selectRoute(route.id);
    consumer.result.current.bridge.setAmount('6');
    consumer.result.current.bridge.setExternalAccountId(accounts.evmAddress);
  });
  return consumer;
}

it('captures only the measured displayed native cap in Circle review, never in its unsigned draft', async () => {
  const { result } = composeCircle();
  await waitFor(() => expect(result.current.bridge.canReview).toBe(true));
  act(() => result.current.bridge.reviewTransfer());
  expect(result.current.bridge.review?.networkFeeBudget).toEqual({
    faucetId: native.faucetId,
    maxAmount: '300',
    scope: mockFee.scope
  });
  expect(result.current.drafts.readDraft('bridge')).not.toHaveProperty('networkFeeBudget');
});

it.each(['pending', 'failed', 'wrong faucet', 'wrong source', 'unknown scale', 'uncorroborated native'])(
  'cannot review Circle from a %s native fee measurement',
  async kind => {
    if (kind === 'pending') mockFee = { status: 'pending' };
    if (kind === 'failed') mockFee = { status: 'failed' };
    if (kind === 'wrong faucet') mockFee.faucetId = 'other';
    if (kind === 'wrong source') mockFee.scope = 'b'.repeat(64);
    if (kind === 'unknown scale') mockNativeScaleKnown = false;
    if (kind === 'uncorroborated native') mockNativeCorroborated = false;
    const { result } = composeCircle();
    await waitFor(() => expect(result.current.bridge.quote).not.toBeNull());
    expect(result.current.bridge.canReview).toBe(false);
    act(() => result.current.bridge.reviewTransfer());
    expect(result.current.bridge.review).toBeUndefined();
  }
);

it('invalidates actual Circle review on a changed displayed native cap, not same-cap transport churn', async () => {
  const { result, rerender } = composeCircle();
  await waitFor(() => expect(result.current.bridge.canReview).toBe(true));
  act(() => result.current.bridge.reviewTransfer());
  const original = result.current.bridge.review;
  expect(original).toBeDefined();
  mockFee = { ...mockFee };
  rerender();
  expect(result.current.bridge.review).toBe(original);
  mockFee = { ...mockFee, reserve: 301n };
  rerender();
  expect(result.current.bridge.review).toBeUndefined();
});

it('shows the exact reviewed native maximum in the actual Command Bridge workbench disclosure', async () => {
  render(
    <CommandDraftProvider scope={scope}>
      <CommandWorkbench route={{ kind: 'flow', action: 'bridge' }} container={null}>
        <CommandBridge />
      </CommandWorkbench>
    </CommandDraftProvider>
  );
  fireEvent.click(screen.getByRole('radio', { name: 'commandBridgeOut' }));
  const route = deriveBridgeRoutes(mockSnapshot).find(item => item.provider === 'xreserve' && item.mode === 'send');
  if (!route) throw new Error('Missing native Circle fixture');
  fireEvent.click(screen.getByTestId(`command-bridge-route-${route.id}`));
  fireEvent.change(screen.getByRole('textbox', { name: 'amount' }), { target: { value: '6' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'commandBridgeExternalAccount' }), {
    target: { value: accounts.evmAddress }
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'reviewDetails' })).toBeEnabled());
  const form = screen.getByRole('textbox', { name: 'amount' }).closest('form');
  if (!form) throw new Error('Missing real Command Bridge form');
  fireEvent.submit(form);
  expect(screen.getByRole('button', { name: 'confirm' })).toBeEnabled();
  fireEvent.click(screen.getByText('commandDetails'));
  expect(screen.getByText('networkFeeMax')).toBeVisible();
  expect(screen.getByText('0.0003 USDCx')).toBeVisible();
});

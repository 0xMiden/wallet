import React from 'react';

import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';

import { bindTransferQuote, type QuoteRequest, type TransferQuote } from 'lib/bridge/core/quote';
import { accounts, now, referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { quoteBridgeTransfer } from 'lib/bridge/wallet-transport';
import { switchWebWalletChain } from 'lib/epoch/client';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { CommandDraftProvider, useCommandDrafts } from '../command-drafts';
import { useCommandBridge } from './useCommandBridge';

let mockSnapshot: BridgeConfigSnapshot;
let mockLocked = false;
let mockRpc = 'https://wallet-rpc.example/private';
let mockAddress = accounts.evmAddress;
const mockState = {
  currentAccount: { publicKey: accounts.midenAccount },
  balances: {} satisfies Record<string, TokenBalanceData[]>,
  balancesLoading: {}, balanceReadFailed: {}, tokenPricesStatus: 'ready', tokenPrices: {}
};
jest.mock('@reown/appkit/react', () => ({ useAppKitNetwork: () => ({ chainId: 11155111 }), useDisconnect: () => ({ disconnect: jest.fn() }) }));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => jest.fn() }));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => null }));
jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ locked: mockLocked, signTransaction: jest.fn() }),
  useAllBalances: () => ({}), useAllTokensBaseMetadata: () => ({})
}));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: {} }));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => mockSnapshot }));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: () => mockSnapshot }));
jest.mock('lib/bridge/wallet-transport', () => ({ quoteBridgeTransfer: jest.fn() }));
jest.mock('lib/epoch/client', () => ({ buildEpochWalletClient: jest.fn(), getEvmConnection: jest.fn(), switchWebWalletChain: jest.fn() }));
jest.mock('lib/walletconnect/native', () => ({ ensureNativeSessionChain: jest.fn() }));
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({ useEvmWalletConnection: () => ({ address: mockAddress, connected: true, nativeReown: {}, useNativeReownWallet: false }) }));
jest.mock('lib/store', () => ({ useWalletStore: Object.assign((select: (state: typeof mockState) => unknown) => select(mockState), { getState: () => mockState }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => 'testnet', getEffectiveRpcUrl: () => mockRpc
}));

const scope = { accountId: accounts.midenAccount, network: 'testnet', rpcUrl: 'https://wallet-rpc.example/private' };
const wrapper = ({ children }: { children: React.ReactNode }) => <CommandDraftProvider scope={{ ...scope, accountId: mockState.currentAccount.publicKey, rpcUrl: mockRpc }}>{children}</CommandDraftProvider>;
const useConsumer = () => ({ bridge: useCommandBridge(), drafts: useCommandDrafts() });
function quote(request: QuoteRequest, received = '1'): TransferQuote {
  return bindTransferQuote(request, { kind: request.route.provider === 'epoch' ? 'epoch' : 'agglayer', received, validity: { kind: 'time', expiresAt: now + 60000 } });
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  mockSnapshot = referenceSnapshot('testnet');
  mockLocked = false;
  mockRpc = scope.rpcUrl;
  mockState.currentAccount.publicKey = accounts.midenAccount;
  mockAddress = accounts.evmAddress;
  jest.mocked(quoteBridgeTransfer).mockImplementation(async request => quote(request));
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

it('the real Bridge consumer stores exact unsigned direction, amount and external account in the shared Command draft', () => {
  const { result } = renderHook(useConsumer, { wrapper });
  act(() => {
    result.current.bridge.setDirection('out');
    result.current.bridge.setAmount('1.000001');
    result.current.bridge.setExternalAccountId('0x2222222222222222222222222222222222222222');
  });
  expect(result.current.drafts.readDraft('bridge')).toEqual(expect.objectContaining({
    direction: 'out', amount: '1.000001', externalAccountId: '0x2222222222222222222222222222222222222222'
  }));
  expect(result.current.bridge.amount).toBe('1.000001');
});

it('retains literal source input on a compatible provider change but discards the actual reviewed consent', async () => {
  const { result } = renderHook(useConsumer, { wrapper });
  const agglayer = result.current.bridge.routes.find(item => item.provider === 'agglayer' && item.source.symbol === 'USDC');
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
  jest.mocked(quoteBridgeTransfer).mockImplementation(request => new Promise(resolve => pending.push({ request, resolve })));
  const { result } = renderHook(useConsumer, { wrapper });
  act(() => result.current.bridge.setDirection('out'));
  const route = result.current.bridge.routes.find(item => item.provider === 'agglayer');
  if (!route) throw new Error('Missing real source');
  act(() => result.current.bridge.selectRoute(route.id));
  act(() => result.current.bridge.setExternalAccountId(accounts.evmAddress));
  act(() => result.current.bridge.setAmount('1'));
  act(() => result.current.bridge.setAmount('2'));
  expect(pending).toHaveLength(2);
  await act(async () => pending[1].resolve(quote(pending[1].request, '2')));
  expect(result.current.bridge.quote?.received).toBe('2');
  await act(async () => pending[0].resolve(quote(pending[0].request, '1')));
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

it('minimize/reopen restores only unsigned literals, never quote/review/signature or submit permission', async () => {
  function Consumer() {
    const bridge = useCommandBridge();
    return <><span data-testid="amount">{bridge.amount}</span><span data-testid="review">{String(Boolean(bridge.review))}</span>
      <button onClick={() => { bridge.setDirection('out'); bridge.setAmount('1.000001'); bridge.setExternalAccountId(accounts.evmAddress); }}>edit</button></>;
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
  rerender(<CommandDraftProvider key="reload" scope={scope}><Consumer /></CommandDraftProvider>);
  expect(screen.getByTestId('amount')).toBeEmptyDOMElement();
  expect(screen.getByTestId('review')).toHaveTextContent('false');
});

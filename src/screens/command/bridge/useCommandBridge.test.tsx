import React from 'react';

import { act, renderHook } from '@testing-library/react';

import { CommandDraftProvider, useCommandDrafts } from '../command-drafts';
import { useCommandBridge } from './useCommandBridge';

jest.mock('@reown/appkit/react', () => ({ useDisconnect: () => ({ disconnect: jest.fn() }) }));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => jest.fn() }));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => null }));
jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ locked: false, signTransaction: jest.fn() }),
  useAllBalances: () => ({}), useAllTokensBaseMetadata: () => ({})
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({ network: 'testnet', status: 'loading', config: null, derived: null }) }));
jest.mock('lib/bridge/wallet-transport', () => ({ quoteBridgeTransfer: jest.fn() }));
jest.mock('lib/bridge/wallet-submit', () => ({ walletBridgeBalanceCap: () => ({ status: 'allowed' }) }));
jest.mock('lib/epoch/client', () => ({ buildEpochWalletClient: jest.fn(), getEvmConnection: jest.fn(), switchWebWalletChain: jest.fn() }));
jest.mock('lib/walletconnect/native', () => ({ ensureNativeSessionChain: jest.fn() }));
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({ useEvmWalletConnection: () => ({ connected: false, nativeReown: {}, useNativeReownWallet: false }) }));
jest.mock('lib/store', () => ({ useWalletStore: (select: (state: unknown) => unknown) => select({ currentAccount: { publicKey: 'account-a' } }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet', getEffectiveRpcUrl: () => 'https://rpc.example' }));

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://rpc.example' };
const wrapper = ({ children }: { children: React.ReactNode }) => <CommandDraftProvider scope={scope}>{children}</CommandDraftProvider>;

it('the real Bridge consumer stores exact unsigned direction, amount and external account in the shared Command draft', () => {
  const { result } = renderHook(() => ({ bridge: useCommandBridge(), drafts: useCommandDrafts() }), { wrapper });
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

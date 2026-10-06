import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { NavigatorProvider, type Route } from 'components/Navigator';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { AssetMetadata } from 'lib/miden/metadata/types';
import {
  getNativeAssetId,
  getNativeAssetIdSync,
  getVerificationBaseFee,
  getVerificationBaseFeeSync,
  onNativeAssetChanged
} from 'lib/miden-chain/native-asset';
import type { TokenPrices } from 'lib/prices';

import { SendManager } from './SendManager';
import { SendFlowStep } from './types';

jest.unmock('components/Navigator');
jest.unmock('lib/i18n/numbers');
jest.unmock('app/hooks/useNativeFeeFaucetId');
jest.unmock('app/hooks/useVerificationBaseFee');

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => false }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({ useHideNavbarWhileOpen: jest.fn() }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('lib/telemetry/use-route-dwell', () => ({ useRouteDwell: () => false }));
jest.mock('lib/qr', () => ({ isScanAvailable: () => false }));
jest.mock('lib/woozie', () => ({ useLocation: () => ({ pathname: '/send' }), navigate: jest.fn() }));
jest.mock('lib/miden/assets', () => ({ getFaucetIdSetting: () => Promise.resolve('legacy-display-override') }));
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({ useFilteredContacts: () => ({ contacts: [] }) }));
jest.mock('lib/miden/sdk/helpers', () => ({ sameWalletAccountId: (a: string, b: string) => a === b }));
jest.mock('utils/miden', () => ({
  isValidRecipientAddress: () => true,
  detectAddressChain: () => 'miden'
}));
jest.mock('./useEpochQuote', () => ({ useEpochQuote: () => ({ loading: false }) }));
jest.mock('./useRecentRecipients', () => ({ useRecentRecipients: () => [] }));
jest.mock('./SelectRecipient', () => ({ SelectRecipient: () => null }));
jest.mock('./SelectToken', () => ({ SelectTokenDrawer: () => null }));
jest.mock('./AccountsList', () => ({ AccountsListDrawer: () => null }));
jest.mock('./AddContactDrawer', () => ({ AddContactDrawer: () => null }));
jest.mock('./ScanQrDrawer', () => ({ ScanQrDrawer: () => null }));
jest.mock('./SendRoute', () => ({ SendRoute: () => null }));
jest.mock('components/TokenLogo', () => ({ TokenLogo: () => null }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn(),
  getNativeAssetIdSync: jest.fn(),
  getNativeAssetMetadataSync: () => ({ symbol: 'USDCX', decimals: 6 }),
  getSdkSyncedNativeAssetIdSync: () => 'current-native',
  getVerificationBaseFee: jest.fn(),
  getVerificationBaseFeeSync: jest.fn(),
  onNativeAssetChanged: jest.fn()
}));

const metadata: AssetMetadata = { symbol: 'USDCX', name: 'USDCX', decimals: 6 };
const balances: TokenBalanceData[] = [
  { tokenId: 'current-native', tokenSlug: 'USDCX', metadata, balance: 10, fiatPrice: 1, change24h: 0 }
];
const assetsMetadata = { 'current-native': metadata };
const tokenPrices: TokenPrices = {};
const state = {
  tokenPrices,
  isTransactionModalOpen: false,
  lastCompletedTxHash: null,
  closeTransactionModal: jest.fn(),
  setLastCompletedTxHash: jest.fn()
};
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'sender-account' }),
  useAllAccounts: () => [],
  useAllBalances: () => ({ data: balances, isLoading: false }),
  useAllTokensBaseMetadata: () => assetsMetadata
}));
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign((select: (current: typeof state) => unknown) => select(state), {
    getState: () => state
  })
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

const amountRoute: Route = { name: SendFlowStep.SelectAmount, animationIn: 'push', animationOut: 'pop' };

beforeEach(() => {
  jest.mocked(getNativeAssetId).mockReset();
  jest.mocked(getNativeAssetIdSync).mockReset();
  jest.mocked(getVerificationBaseFee).mockReset().mockResolvedValue(7);
  jest.mocked(getVerificationBaseFeeSync).mockReset().mockReturnValue(7);
  jest.mocked(onNativeAssetChanged).mockReset();
});

it('keeps the real Send reserve when an obsolete fee-identity read finishes after discovery', async () => {
  const initial = deferred<string>();
  const current = deferred<string>();
  jest.mocked(getNativeAssetId).mockReturnValueOnce(initial.promise).mockReturnValueOnce(current.promise);
  jest.mocked(getNativeAssetIdSync).mockReturnValue(null);
  const listeners = new Set<(id: string) => void>();
  jest.mocked(onNativeAssetChanged).mockImplementation(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  render(
    <NavigatorProvider routes={[amountRoute]} initialRouteName={SendFlowStep.SelectAmount}>
      <SendManager isLoading={false} preselectedTokenId="current-native" />
    </NavigatorProvider>
  );
  expect(screen.getByTestId('send-amount-available')).toHaveTextContent('available 10');

  jest.mocked(getNativeAssetIdSync).mockReturnValue('current-native');
  await act(async () => {
    listeners.forEach(listener => listener('current-native'));
    current.resolve('current-native');
  });
  expect(screen.getByTestId('send-amount-available')).toHaveTextContent('available 9.9997');

  fireEvent.change(screen.getByTestId('send-amount-input'), { target: { value: '10' } });
  expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
  expect(screen.getByText('amountMustBeLessThanBalance')).toBeInTheDocument();

  await act(async () => initial.resolve('obsolete-native'));
  expect(screen.getByTestId('send-amount-available')).toHaveTextContent('available 9.9997');
  expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
  expect(screen.getByText('amountMustBeLessThanBalance')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('send-amount-max'));
  expect(screen.getByTestId('send-amount-input')).toHaveValue('9.9997');
  expect(screen.getByTestId('send-amount-confirm')).toBeEnabled();
});

it('keeps the real Send reserve when an obsolete base-fee read finishes after discovery', async () => {
  const initial = deferred<number | null>();
  const current = deferred<number | null>();
  jest.mocked(getNativeAssetId).mockResolvedValue('current-native');
  jest.mocked(getNativeAssetIdSync).mockReturnValue('current-native');
  jest.mocked(getVerificationBaseFee).mockReturnValueOnce(initial.promise).mockReturnValueOnce(current.promise);
  jest.mocked(getVerificationBaseFeeSync).mockReturnValue(null);
  const listeners = new Set<(id: string) => void>();
  jest.mocked(onNativeAssetChanged).mockImplementation(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  render(
    <NavigatorProvider routes={[amountRoute]} initialRouteName={SendFlowStep.SelectAmount}>
      <SendManager isLoading={false} preselectedTokenId="current-native" />
    </NavigatorProvider>
  );
  expect(screen.getByTestId('send-amount-available')).toHaveTextContent('available 10');

  await act(async () => {
    listeners.forEach(listener => listener('current-native'));
    current.resolve(7);
  });
  expect(screen.getByTestId('send-amount-available')).toHaveTextContent('available 9.9997');
  fireEvent.change(screen.getByTestId('send-amount-input'), { target: { value: '10' } });
  expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
  expect(screen.getByText('amountMustBeLessThanBalance')).toBeInTheDocument();

  await act(async () => initial.resolve(null));
  expect(screen.getByTestId('send-amount-available')).toHaveTextContent('available 9.9997');
  expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
  expect(screen.getByText('amountMustBeLessThanBalance')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('send-amount-max'));
  expect(screen.getByTestId('send-amount-input')).toHaveValue('9.9997');
  expect(screen.getByTestId('send-amount-confirm')).toBeEnabled();
});

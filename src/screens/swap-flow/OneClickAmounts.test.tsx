import React from 'react';

import { render, screen } from '@testing-library/react';

import { OneClickAsset } from 'lib/one-click/types';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';

import { OneClickAmounts, OneClickAmountsProps } from './OneClickAmounts';
import { OneClickNetworkOption } from './OneClickPickers';

const messages = {
  oneClickRecipientSection: 'Recipient',
  oneClickRefundSection: 'Refund account'
};

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (messages as Record<string, string>)[key] ?? key })
}));

jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));

const midenNetwork: OneClickNetworkOption = { id: 'miden', name: 'Miden', kind: 'miden' };
const ethereumNetwork: OneClickNetworkOption = { id: 'eth', name: 'Ethereum', kind: 'ethereum' };
const midenAsset: OneClickAsset = {
  assetId: 'miden:token',
  blockchain: 'miden',
  symbol: 'MIDEN',
  decimals: 6,
  faucetId: '0x111111111111111111111111111111'
};
const ethereumAsset: OneClickAsset = {
  assetId: 'eth:token',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x2222222222222222222222222222222222222222',
  chainId: 1
};

function amountsProps(overrides: Partial<OneClickAmountsProps> = {}): OneClickAmountsProps {
  return {
    assets: [midenAsset, ethereumAsset],
    networks: [midenNetwork, ethereumNetwork],
    offerNetwork: midenNetwork,
    requestNetwork: ethereumNetwork,
    offerAsset: midenAsset,
    requestAsset: ethereumAsset,
    offerAmount: '1',
    previewAmount: '0.9',
    externalAddressLabel: 'recipient',
    externalAddressNetwork: ethereumNetwork,
    externalAddress: '0x3333333333333333333333333333333333333333',
    canContinue: true,
    onOfferNetworkChange: jest.fn(),
    onRequestNetworkChange: jest.fn(),
    onOfferAssetChange: jest.fn(),
    onRequestAssetChange: jest.fn(),
    onOfferAmountChange: jest.fn(),
    onExternalAddressChange: jest.fn(),
    onContinue: jest.fn(),
    ...overrides
  };
}

function renderAmounts(overrides: Partial<OneClickAmountsProps> = {}) {
  return render(<OneClickAmounts {...amountsProps(overrides)} />);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('OneClickAmounts error reporting', () => {
  it.each([
    ['recipient', 'Recipient'],
    ['refund', 'Refund account']
  ] as const)('labels the external address section for the %s route', (externalAddressLabel, accessibleName) => {
    renderAmounts({ externalAddressLabel });
    expect(screen.getByRole('region', { name: accessibleName })).toBeInTheDocument();
  });

  it('reports an external balance read failure with a closed ID only', async () => {
    renderAmounts({
      offerNetwork: ethereumNetwork,
      offerAsset: ethereumAsset,
      requestNetwork: midenNetwork,
      requestAsset: midenAsset,
      externalAddressLabel: 'refund',
      externalAddressNetwork: ethereumNetwork,
      externalAddress: '',
      connectedExternalAddress: '0x3333333333333333333333333333333333333333',
      evmBalance: { status: 'error', error: 'private balance error with address 0x1234', gasSymbol: 'ETH' }
    });

    expect(useUserVisibleError).toHaveBeenCalledWith('oneClickBalanceUnavailable', 'notice');
    expect(JSON.stringify(jest.mocked(useUserVisibleError).mock.calls)).not.toContain('0x1234');
  });

  it('reports a classified quote error but leaves route guidance unreported', async () => {
    const view = renderAmounts({
      routeError: 'oneClickChooseForeignNetwork',
      routeErrorId: null
    });
    expect(jest.mocked(useUserVisibleError).mock.calls.filter(([id]) => id !== null && id !== undefined)).toEqual([]);

    view.rerender(
      <OneClickAmounts
        {...amountsProps({
          routeError: 'oneClickQuoteUnavailable',
          routeErrorId: 'oneClickQuoteUnavailable',
          canContinue: false
        })}
      />
    );

    expect(useUserVisibleError).toHaveBeenCalledWith('oneClickQuoteUnavailable', 'inline', undefined, undefined);
    expect(screen.getByTestId('one-click-route-error')).toBeInTheDocument();
  });
});

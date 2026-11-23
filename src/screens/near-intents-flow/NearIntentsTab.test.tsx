import React from 'react';

import { act, cleanup, render, screen } from '@testing-library/react';

import type { NearIntentsCatalog, NearIntentsConfig } from 'lib/one-click/types';

import { NearIntentsTab } from './NearIntentsTab';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => 'https://rpc.example' }));
jest.mock('lib/remote-config/derive', () => ({ readMidenFaucetMetadata: jest.fn() }));
jest.mock('lib/one-click/client', () => ({ createMidenAssetMetadataResolver: jest.fn(() => jest.fn()) }));

const mockFetchCatalog = jest.fn<Promise<NearIntentsCatalog>, [NearIntentsConfig]>();
jest.mock('lib/one-click/catalog', () => ({
  fetchNearIntentsCatalog: (config: NearIntentsConfig) => mockFetchCatalog(config)
}));
jest.mock('./NearIntentsForm', () => ({
  NearIntentsForm: ({ catalog }: { catalog: NearIntentsCatalog }) => (
    <div data-testid="form">{catalog.chains.map(chain => chain.id).join(',')}</div>
  )
}));

const newConfig = (): NearIntentsConfig => ({ serviceUrl: 'https://1click.example', chains: [], midenAssets: [] });

const routeCatalog: NearIntentsCatalog = {
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [
        {
          symbol: 'USDC',
          asset: { assetId: 'nep141:eth-usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6 },
          outputs: [{ assetId: 'miden:usdcx', blockchain: 'miden', symbol: 'USDCx', decimals: 6, faucetId: 'f' }]
        }
      ]
    }
  ]
};

const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

beforeEach(() => mockFetchCatalog.mockReset());
afterEach(cleanup);

describe('NearIntentsTab', () => {
  it('draws the tabs and a spinner while the catalog loads, then the form', async () => {
    mockFetchCatalog.mockResolvedValue(routeCatalog);
    render(<NearIntentsTab config={newConfig()} tabs={<div data-testid="tabs" />} />);
    expect(screen.getByTestId('tabs')).toBeInTheDocument();
    expect(screen.getByTestId('near-intents-catalog-loading')).toBeInTheDocument();
    await settle();
    expect(screen.getByTestId('form')).toHaveTextContent('eth');
  });

  it('shows the unavailable notice for an empty catalog', async () => {
    mockFetchCatalog.mockResolvedValue({ chains: [] });
    render(<NearIntentsTab config={newConfig()} />);
    await settle();
    expect(screen.getByTestId('near-intents-unavailable-notice')).toHaveTextContent('nearIntentsUnavailableTitle');
    expect(screen.queryByTestId('form')).not.toBeInTheDocument();
  });

  it('shows the unavailable notice when the catalog does not load', async () => {
    mockFetchCatalog.mockRejectedValue(new Error('offline'));
    render(<NearIntentsTab config={newConfig()} />);
    await settle();
    await settle();
    expect(screen.getByTestId('near-intents-unavailable-notice')).toBeInTheDocument();
  });

  it('loads the catalog once for one config, across mounts', async () => {
    mockFetchCatalog.mockResolvedValue(routeCatalog);
    const config = newConfig();
    const first = render(<NearIntentsTab config={config} />);
    await settle();
    first.unmount();
    render(<NearIntentsTab config={config} />);
    await settle();
    expect(screen.getByTestId('form')).toBeInTheDocument();
    expect(mockFetchCatalog).toHaveBeenCalledTimes(1);
  });

  it('tries again on the next mount after a failed load', async () => {
    mockFetchCatalog.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(routeCatalog);
    const config = newConfig();
    const first = render(<NearIntentsTab config={config} />);
    await settle();
    await settle();
    first.unmount();
    render(<NearIntentsTab config={config} />);
    await settle();
    expect(screen.getByTestId('form')).toBeInTheDocument();
    expect(mockFetchCatalog).toHaveBeenCalledTimes(2);
  });
});

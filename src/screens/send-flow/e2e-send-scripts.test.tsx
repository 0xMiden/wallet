import React, { useState } from 'react';

import { act, render, screen } from '@testing-library/react';

import type { FeatureAvailability } from 'lib/remote-config/availability';

import { NetworkField } from './NetworkField';
import { RouteOptions } from './Route';
import {
  SEND_NETWORK_JS,
  selectSendNetworkByScript,
  USDCX_ROUTE_JS,
  type ScriptedSendPage,
  type SendNetworkView,
  type UsdcxRouteView
} from '../../../playwright/e2e/helpers/send-flow-scripts';

jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(
      () =>
        jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
          .TEST_BRIDGE_CONFIG_SNAPSHOT
    )
);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { symbol?: string; amount?: string }) => {
      const value = params?.symbol ?? params?.amount;
      return value === undefined ? key : `${key}|${value}`;
    }
  })
}));
jest.mock('./bridge-networks', () => ({ BRIDGE_NETWORKS: [] }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'mtst1usdcxnative' }));
jest.mock('lib/store', () => ({
  useWalletStore: (
    selector: (state: { assetsMetadata: Record<string, never>; tokenPrices: Record<string, never> }) => unknown
  ) => selector({ assetsMetadata: {}, tokenPrices: {} })
}));
jest.mock('lib/miden/metadata/resolve', () => ({
  resolveDisplayMetadata: jest.fn(() => ({ symbol: 'USDCx', name: 'USDCx', decimals: 6 }))
}));

const NETWORKS = [
  { id: 'arc-testnet', name: 'Arc Testnet', chainId: 5042002 },
  { id: 'sepolia', name: 'Sepolia', chainId: 11155111 },
  { id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532 },
  { id: 'arbitrum-sepolia', name: 'Arbitrum Sepolia', chainId: 421614 }
];
const AVAILABLE: FeatureAvailability = { state: 'available' };

// The page objects run each body as a CDP eval and click through `el.click()`; here both act on this document.
const webView: ScriptedSendPage = {
  evalJs: async (js: string) => {
    // eslint-disable-next-line no-new-func -- runs the driver's script body in this document, as cdp.eval does
    return new Function(js)();
  },
  click: async (selector: string) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`no element matched ${selector}`);
    await act(async () => {
      element.click();
    });
  }
};

function SendNetworkFixture({
  networks = NETWORKS,
  follows = true
}: {
  networks?: typeof NETWORKS;
  follows?: boolean;
}) {
  const [network, setNetwork] = useState('arc-testnet');
  return (
    <div data-testid="send-flow">
      <NetworkField
        chain="ethereum"
        networks={networks}
        network={network}
        onSelect={follows ? setNetwork : () => undefined}
        testIdPrefix="send"
      />
    </div>
  );
}

describe('SEND_NETWORK_JS', () => {
  it('reads the closed summary, then the open sheet with only the chosen destination pressed', async () => {
    render(<SendNetworkFixture />);
    await expect(webView.evalJs<SendNetworkView>(SEND_NETWORK_JS)).resolves.toEqual({
      summary: 'Arc Testnet',
      rows: []
    });

    await webView.click('[data-testid="send-flow"] [data-testid="send-network-picker"]');

    await expect(webView.evalJs<SendNetworkView>(SEND_NETWORK_JS)).resolves.toEqual({
      summary: 'Arc Testnet',
      rows: NETWORKS.map(({ id }) => ({
        testId: `send-network-${id}`,
        pressed: id === 'arc-testnet' ? 'true' : 'false'
      }))
    });
  });
});

describe('USDCX_ROUTE_JS', () => {
  it.each([
    ['usdcx', 'true'],
    ['epoch', 'false']
  ] as const)(
    'reads the USDCx card of a %s route as pressed=%s, with its payout rows and notice',
    async (route, pressed) => {
      render(
        <div data-testid="send-flow">
          <RouteOptions
            usdcxAvailable
            route={route}
            onRouteChange={jest.fn()}
            fastQuoteLoading={false}
            slowStatus="allowed"
            fastAvailability={AVAILABLE}
            slowAvailability={AVAILABLE}
            usdcxPayout={{ chainId: 5042002, amount: 1_000_001n }}
          />
        </div>
      );

      const view = await webView.evalJs<UsdcxRouteView>(USDCX_ROUTE_JS);

      expect(view).toEqual({
        pressed,
        cardText: expect.stringContaining('usdcxMidenFees|USDCx'),
        fee: 'usdcxPayoutFeeUpTo|0.1',
        net: 'usdcxPayoutAtLeast|0.900001',
        notice: 'usdcxWithdrawalNotice'
      });
    }
  );
});

describe('selectSendNetworkByScript', () => {
  it('opens the sheet, picks the row and checks that the closed summary names it', async () => {
    render(<SendNetworkFixture />);

    await selectSendNetworkByScript(webView, { id: 'sepolia', name: 'Sepolia' }, 1_000, 10);

    expect(screen.getByTestId('send-network-picker')).toHaveTextContent('Sepolia');
    expect(screen.getByRole('dialog', { name: 'selectNetwork' })).toHaveAttribute('data-state', 'closed');
  });

  it('reads a single destination from its static row without opening a sheet', async () => {
    render(<SendNetworkFixture networks={NETWORKS.slice(1, 2)} />);

    await selectSendNetworkByScript(webView, { id: 'sepolia', name: 'Sepolia' }, 1_000, 10);

    expect(screen.queryByTestId('send-network-picker')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rejects a pick that closed the sheet without changing the selection', async () => {
    render(<SendNetworkFixture follows={false} />);

    await expect(selectSendNetworkByScript(webView, { id: 'sepolia', name: 'Sepolia' }, 1_000, 10)).rejects.toThrow(
      'Send network selection stayed "Arc Testnet", expected "Sepolia".'
    );
  });
});

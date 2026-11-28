import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { RelaySource } from 'lib/evm-relay/source';
import type { RelayServiceState } from 'lib/evm-relay/use-relay-service';
import type { NearIntentsCatalog, NearIntentsConfig, OneClickQuoteResponse } from 'lib/one-click/types';
import type { WalletAccount } from 'lib/shared/types';
import type { NearIntentsCatalogState } from 'screens/near-intents-flow/useNearIntentsCatalog';
import { WalletType } from 'screens/onboarding/types';

import { DepositFlow, type DepositFlowProps } from './DepositFlow';
import type { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';
import type { NearDepositFlowProps } from './NearDepositFlow';
import type { RelayTokenChoice } from './relay-token-choices';
import type { NearDepositQuote, NearDepositQuoteInput } from './useNearDepositQuote';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/layouts/page-active', () => ({ usePageActive: () => true }));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'usdcx' }));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({ status: 'ready' })
}));
jest.mock('lib/miden/swap/faucet-ids', () => ({ normalizedFaucetId: (id: string) => id }));
jest.mock('screens/send-flow/bridge-networks', () => ({
  getBridgeNetworkByChainId: (chainId: number) =>
    chainId === 1 ? { id: 'ethereum', name: 'Ethereum', chainId: 1 } : undefined
}));
jest.mock('components/NetworkModeBanner', () => ({ NetworkModeBanner: () => null }));
jest.mock('components/PageHeader', () => ({
  PageHeader: ({ title, onBack }: { title: string; onBack?: () => void }) => (
    <button type="button" onClick={onBack}>
      {title}
    </button>
  )
}));
jest.mock('components/ui/Spinner', () => ({ Spinner: () => <span>spinner</span> }));

let mockCatalogState: NearIntentsCatalogState = { status: 'unavailable' };
const mockCatalogConfigs: Array<NearIntentsConfig | null> = [];
jest.mock('screens/near-intents-flow/useNearIntentsCatalog', () => ({
  useNearIntentsCatalog: (config: NearIntentsConfig | null) => {
    mockCatalogConfigs.push(config);
    return mockCatalogState;
  }
}));

let mockQuote: NearDepositQuote = { loading: false };
const mockQuoteInputs: NearDepositQuoteInput[] = [];
jest.mock('./useNearDepositQuote', () => ({
  useNearDepositQuote: (input: NearDepositQuoteInput) => {
    mockQuoteInputs.push(input);
    return mockQuote;
  }
}));

const ETHEREUM = { id: 'ethereum', name: 'Ethereum' };
const mockChoices: RelayTokenChoice[] = [
  {
    option: { id: '1:CIRCLE_USDC', symbol: 'USDC', receivedSymbol: 'USDCx', logoFaucetId: 'usdcx', network: ETHEREUM },
    chainId: 1,
    token: 'CIRCLE_USDC',
    address: '0x00000000000000000000000000000000000000c1',
    routes: ['usdcx', 'epoch']
  },
  {
    option: { id: '1:ETH', symbol: 'ETH', receivedSymbol: 'ETH', logoFaucetId: 'eth', network: ETHEREUM },
    chainId: 1,
    token: 'ETH',
    address: '0x0000000000000000000000000000000000000000',
    routes: ['agglayer']
  }
];
const mockSourceNetworkChains: Array<readonly number[] | null> = [];
jest.mock('./relay-token-choices', () => ({
  ...jest.requireActual('./relay-token-choices'),
  depositSourceNetworks: (_snapshot: unknown, chains: readonly number[] | null) => {
    mockSourceNetworkChains.push(chains);
    return [];
  },
  relayTokenChoices: () => mockChoices
}));

// What the relay service answers (`GET /v1/chains`). The flow reads no deposit address before the address step.
let mockService: RelayServiceState = {
  status: 'ready',
  service: { mode: 'sponsor', executor: '0x00000000000000000000000000000000000000e1', chains: [1] }
};
const mockServiceEnabled: boolean[] = [];
jest.mock('lib/evm-relay/use-relay-service', () => ({
  useRelayService: (enabled: boolean) => {
    mockServiceEnabled.push(enabled);
    return enabled ? mockService : { status: 'off' };
  }
}));

type RelayScreenProps = React.ComponentProps<typeof EvmBridgeDepositScreen>;
let relayProps: RelayScreenProps | undefined;
jest.mock('./EvmBridgeDepositScreen', () => ({
  EvmBridgeDepositScreen: (props: RelayScreenProps) => {
    relayProps = props;
    return <div data-testid="relay-screen" />;
  }
}));
jest.mock('./DepositUnavailable', () => ({
  DepositUnavailable: ({ cause }: { cause: string }) => <div data-testid="unavailable" data-cause={cause} />
}));
let nearProps: NearDepositFlowProps | undefined;
jest.mock('./NearDepositFlow', () => ({
  NearDepositFlow: (props: NearDepositFlowProps) => {
    nearProps = props;
    return <div data-testid="near-screen" />;
  }
}));

const RELAY: RelaySource = {
  accountPublicKey: 'miden-account',
  address: '0x00000000000000000000000000000000000000e5'
};
const CONFIG: NearIntentsConfig = { serviceUrl: 'https://one-click.test', chains: [], midenAssets: [] };
const USDCX = { assetId: 'miden:usdcx', blockchain: 'miden', symbol: 'USDCx', decimals: 6, faucetId: 'usdcx' };
const CATALOG: NearIntentsCatalog = {
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [
        {
          symbol: 'USDC',
          asset: {
            assetId: 'eth:USDC',
            blockchain: 'eth',
            symbol: 'USDC',
            decimals: 6,
            contractAddress: '0x00000000000000000000000000000000000000c1'
          },
          outputs: [USDCX]
        }
      ]
    },
    {
      id: 'sol',
      name: 'Solana',
      addressKind: 'solana',
      tokens: [
        {
          symbol: 'USDC',
          asset: { assetId: 'sol:USDC', blockchain: 'sol', symbol: 'USDC', decimals: 6 },
          outputs: [USDCX]
        }
      ]
    }
  ]
};
const SOL_PAIR = 'near:sol:sol:USDC:miden:usdcx';
const ACCOUNT: WalletAccount = {
  publicKey: 'miden-account',
  name: 'Account 1',
  isPublic: true,
  type: WalletType.Guardian,
  hdIndex: 0,
  authScheme: 'ecdsa',
  relayEvmAddress: RELAY.address
};
const QUOTE: OneClickQuoteResponse = {
  correlationId: 'c',
  timestamp: '2026-11-27T00:00:00.000Z',
  signature: 's',
  quoteRequest: {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'eth:USDC',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'miden:usdcx',
    amount: '5000000',
    refundTo: RELAY.address,
    refundType: 'ORIGIN_CHAIN',
    recipient: 'miden-account',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-27T00:05:00.000Z'
  },
  quote: {
    amountIn: '5000000',
    amountInFormatted: '5',
    amountInUsd: '5',
    minAmountIn: '5000000',
    amountOut: '4900000',
    amountOutFormatted: '4.9',
    amountOutUsd: '4.9',
    minAmountOut: '4800000',
    timeEstimate: 120
  }
};

function props(overrides: Partial<DepositFlowProps> = {}): DepositFlowProps {
  return {
    midenAccount: ACCOUNT,
    relaySource: RELAY,
    nearConfig: CONFIG,
    pendingDepositId: 'pending-1',
    onClose: jest.fn(),
    onExit: jest.fn(),
    relayOffCause: 'off',
    ...overrides
  };
}

function lastQuoteInput(): NearDepositQuoteInput | undefined {
  return mockQuoteInputs[mockQuoteInputs.length - 1];
}

const SPONSOR: RelayServiceState = {
  status: 'ready',
  service: { mode: 'sponsor', executor: '0x00000000000000000000000000000000000000e1', chains: [1] }
};

beforeEach(() => {
  mockService = SPONSOR;
  mockServiceEnabled.length = 0;
  mockSourceNetworkChains.length = 0;
  mockCatalogState = { status: 'ready', catalog: CATALOG };
  mockCatalogConfigs.length = 0;
  mockQuote = { loading: false };
  mockQuoteInputs.length = 0;
  relayProps = undefined;
  nearProps = undefined;
});
afterEach(cleanup);

describe('DepositFlow', () => {
  it('opens the relay screen with the union in its token sheet', () => {
    render(<DepositFlow {...props()} />);

    expect(screen.getByTestId('relay-screen')).toBeInTheDocument();
    expect(relayProps?.evmAddress).toBe(RELAY.address);
    expect(relayProps?.pendingDepositId).toBe('pending-1');
    expect(relayProps?.initialForm).toBeUndefined();
    expect(relayProps?.tokenSheet?.networks.map(network => network.id)).toEqual(['ethereum', 'solana']);
    expect(relayProps?.tokenSheet?.tokens.map(token => token.id)).toEqual(['1:CIRCLE_USDC', '1:ETH', SOL_PAIR]);
    // No form reported yet: no NEAR Intents route, and no quote asked for.
    expect(relayProps?.otherRoutes).toBeUndefined();
    expect(lastQuoteInput()).toMatchObject({ route: undefined, amount: '', active: false });
  });

  it('gives the relay screen its own sheet while the catalogue loads, and leaves without NEAR Intents', () => {
    mockCatalogState = { status: 'loading' };
    render(<DepositFlow {...props()} />);
    expect(relayProps?.tokenSheet).toBeUndefined();

    cleanup();
    mockCatalogState = { status: 'unavailable' };
    render(<DepositFlow {...props({ nearConfig: null })} />);
    expect(mockCatalogConfigs[mockCatalogConfigs.length - 1]).toBeNull();
    expect(screen.getByTestId('relay-screen')).toBeInTheDocument();
  });

  it('quotes NEAR Intents for the relay pair on the amount step and offers it as a route', () => {
    mockQuote = { loading: false, quote: QUOTE, amountUnits: 5_000_000n };
    render(<DepositFlow {...props()} />);
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'CIRCLE_USDC', amount: '5', step: 'amount' }));

    expect(lastQuoteInput()).toMatchObject({
      config: CONFIG,
      amount: '5',
      refundTo: RELAY.address,
      recipient: 'miden-account',
      active: true
    });
    expect(lastQuoteInput()?.route?.token.asset.assetId).toBe('eth:USDC');
    expect(relayProps?.otherRoutes).toEqual([
      expect.objectContaining({
        id: 'near-intents',
        name: 'depositFlowNearRoute',
        arrivesIn: 'depositFlowNearArrives',
        received: { amount: 4_900_000n, decimals: 6 },
        selected: false
      })
    ]);

    // Off the amount step the quote stops.
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'CIRCLE_USDC', amount: '5', step: 'review' }));
    expect(lastQuoteInput()?.active).toBe(false);
    // A pair that only the relay serves has no NEAR Intents route.
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'ETH', amount: '5', step: 'amount' }));
    expect(relayProps?.otherRoutes).toBeUndefined();
  });

  it('hands the relay pair to NEAR Intents when the route sheet picks it, with the amount', () => {
    render(<DepositFlow {...props()} />);
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'CIRCLE_USDC', amount: '5', step: 'amount' }));
    act(() => relayProps?.onOtherRoute?.('other'));
    expect(screen.getByTestId('relay-screen')).toBeInTheDocument();

    act(() => relayProps?.onOtherRoute?.('near-intents'));

    expect(screen.getByTestId('near-screen')).toBeInTheDocument();
    expect(nearProps).toMatchObject({
      config: CONFIG,
      catalog: CATALOG,
      initialPairId: '1:CIRCLE_USDC',
      initialAmount: '5'
    });
    expect(nearProps?.pairs.pairs.map(pair => pair.option.id)).toEqual(['1:CIRCLE_USDC', '1:ETH', SOL_PAIR]);
  });

  it('hands a row that only NEAR Intents serves to NEAR Intents, and keeps a relay row', () => {
    render(<DepositFlow {...props()} />);
    act(() => relayProps?.onOtherToken?.('1:ETH'));
    expect(screen.getByTestId('relay-screen')).toBeInTheDocument();

    act(() => relayProps?.onOtherToken?.(SOL_PAIR));
    expect(nearProps).toMatchObject({ initialPairId: SOL_PAIR, initialAmount: '' });
  });

  it('hands back to the relay screen with the pair, the amount and the route, and no pending deposit', () => {
    render(<DepositFlow {...props()} />);
    act(() => relayProps?.onOtherToken?.(SOL_PAIR));
    act(() => nearProps?.onRelay({ pairId: SOL_PAIR, amount: '7' }));
    expect(screen.getByTestId('near-screen')).toBeInTheDocument();

    act(() => nearProps?.onRelay({ pairId: '1:CIRCLE_USDC', amount: '7', route: 'epoch' }));

    expect(screen.getByTestId('relay-screen')).toBeInTheDocument();
    expect(relayProps?.initialForm).toEqual({ chainId: 1, token: 'CIRCLE_USDC', amount: '7', route: 'epoch' });
    expect(relayProps?.pendingDepositId).toBeUndefined();
  });

  it('runs NEAR Intents alone when the relay is off', () => {
    render(<DepositFlow {...props({ relaySource: null })} />);

    expect(screen.queryByTestId('relay-screen')).not.toBeInTheDocument();
    expect(nearProps).toMatchObject({ initialPairId: undefined, initialAmount: '' });
    expect(nearProps?.pairs.pairs.map(pair => pair.option.id)).toEqual(['near:eth:eth:USDC:miden:usdcx', SOL_PAIR]);
    // With no relay, a hand-back does nothing.
    act(() => nearProps?.onRelay({ pairId: 'near:eth:eth:USDC:miden:usdcx', amount: '1' }));
    expect(screen.getByTestId('near-screen')).toBeInTheDocument();
  });

  it('hands the pair to NEAR Intents when the relay answers deduct mode and NEAR Intents serves it', () => {
    render(<DepositFlow {...props()} />);
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'CIRCLE_USDC', amount: '5', step: 'amount' }));
    act(() => relayProps?.onRelayUnsupported?.());

    expect(nearProps).toMatchObject({ initialPairId: '1:CIRCLE_USDC', initialAmount: '5' });
    expect(screen.queryByTestId('unavailable')).not.toBeInTheDocument();
  });

  it('says the flow is not available when the relay answers deduct mode for a pair NEAR Intents does not serve', () => {
    render(<DepositFlow {...props()} />);
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'ETH', amount: '5', step: 'amount' }));
    act(() => relayProps?.onRelayUnsupported?.());

    expect(screen.getByTestId('unavailable')).toHaveAttribute('data-cause', 'deduct');
    expect(screen.queryByTestId('relay-screen')).not.toBeInTheDocument();
  });

  it('opens the relay screen again on a hand-back after deduct mode', () => {
    render(<DepositFlow {...props()} />);
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'ETH', amount: '5', step: 'amount' }));
    act(() => relayProps?.onRelayUnsupported?.());
    expect(screen.getByTestId('unavailable')).toBeInTheDocument();
    // The NEAR Intents flow is not on screen, so this hand-back comes from a stale callback: the relay opens again.
    act(() => relayProps?.onOtherToken?.(SOL_PAIR));
    act(() => nearProps?.onRelay({ pairId: '1:ETH', amount: '5' }));
    expect(screen.getByTestId('relay-screen')).toBeInTheDocument();
  });

  it('shows a spinner while the catalogue loads, and the relay cause when it has no route', () => {
    const onClose = jest.fn();
    mockCatalogState = { status: 'loading' };
    render(<DepositFlow {...props({ relaySource: null, onClose })} />);
    expect(screen.getByTestId('deposit-near-loading')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'depositFlowTitle' }));
    expect(onClose).toHaveBeenCalled();

    cleanup();
    mockCatalogState = { status: 'unavailable' };
    render(<DepositFlow {...props({ relaySource: null, relayOffCause: 'no-address' })} />);
    expect(screen.getByTestId('unavailable')).toHaveAttribute('data-cause', 'no-address');
  });
});

describe('DepositFlow: the relay service', () => {
  const UNREACHABLE: RelayServiceState = { status: 'unreachable', error: new Error('relay /v1/chains: network') };

  it('offers the relay routes only on the chains that the service serves, and gives them to the screen', () => {
    mockService = {
      status: 'ready',
      service: { mode: 'sponsor', executor: '0x00000000000000000000000000000000000000e1', chains: [1, 8453] }
    };
    render(<DepositFlow {...props({ pendingDepositId: undefined })} />);

    expect(mockServiceEnabled[mockServiceEnabled.length - 1]).toBe(true);
    expect(mockSourceNetworkChains[mockSourceNetworkChains.length - 1]).toEqual([1, 8453]);
    expect(relayProps?.relayServedChains).toEqual([1, 8453]);
  });

  it('asks the service nothing when the relay is off', () => {
    render(<DepositFlow {...props({ relaySource: null })} />);

    expect(mockServiceEnabled.every(enabled => !enabled)).toBe(true);
  });

  it('waits for the service answer with a spinner, and opens no route before it', () => {
    mockService = { status: 'loading' };
    render(<DepositFlow {...props({ pendingDepositId: undefined })} />);

    expect(screen.getByTestId('deposit-near-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('relay-screen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('near-screen')).not.toBeInTheDocument();
  });

  it('continues with NEAR Intents, with no relay row, when the service cannot be reached', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockService = UNREACHABLE;
    render(<DepositFlow {...props({ pendingDepositId: undefined })} />);

    expect(screen.queryByTestId('relay-screen')).not.toBeInTheDocument();
    expect(nearProps?.pairs.pairs.map(pair => pair.option.id)).toEqual(['near:eth:eth:USDC:miden:usdcx', SOL_PAIR]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[deposit]');
    // No relay route: a hand-back does nothing.
    act(() => nearProps?.onRelay({ pairId: 'near:eth:eth:USDC:miden:usdcx', amount: '1' }));
    expect(screen.getByTestId('near-screen')).toBeInTheDocument();
  });

  it('says the deposit service cannot be reached when NEAR Intents does not serve the selection either', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockService = UNREACHABLE;
    mockCatalogState = { status: 'unavailable' };
    render(<DepositFlow {...props({ pendingDepositId: undefined, nearConfig: null })} />);

    expect(screen.getByTestId('unavailable')).toHaveAttribute('data-cause', 'unreachable');
  });

  it('says that deduct mode is not supported when the service answers it and NEAR Intents has no route', () => {
    mockService = {
      status: 'ready',
      service: { mode: 'deduct', executor: '0x00000000000000000000000000000000000000e1', chains: [1] }
    };
    mockCatalogState = { status: 'unavailable' };
    render(<DepositFlow {...props({ pendingDepositId: undefined, nearConfig: null })} />);

    expect(screen.getByTestId('unavailable')).toHaveAttribute('data-cause', 'deduct');
    expect(relayProps).toBeUndefined();
  });

  it('says the flow is off when the service serves no chain of the document', () => {
    mockService = {
      status: 'ready',
      service: { mode: 'sponsor', executor: '0x00000000000000000000000000000000000000e1', chains: [] }
    };
    mockCatalogState = { status: 'unavailable' };
    const choices = mockChoices.splice(0, mockChoices.length);
    try {
      render(<DepositFlow {...props({ pendingDepositId: undefined, nearConfig: null })} />);
      expect(screen.getByTestId('unavailable')).toHaveAttribute('data-cause', 'off');
    } finally {
      mockChoices.push(...choices);
    }
  });

  it('opens a pending deposit on the relay screen when the service cannot be reached, then leaves it', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockService = UNREACHABLE;
    render(<DepositFlow {...props()} />);

    expect(screen.getByTestId('relay-screen')).toBeInTheDocument();
    expect(relayProps?.pendingDepositId).toBe('pending-1');
    expect(relayProps?.relayServedChains).toBeUndefined();
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'ETH', amount: '5', step: 'address' }));
    expect(screen.getByTestId('relay-screen')).toBeInTheDocument();

    // Back to the review: no relay route is offered, so NEAR Intents takes the flow.
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'ETH', amount: '5', step: 'review' }));
    expect(screen.queryByTestId('relay-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('near-screen')).toBeInTheDocument();
  });
});

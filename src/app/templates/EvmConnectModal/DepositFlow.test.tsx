import React from 'react';

import { act, cleanup, render, screen } from '@testing-library/react';

import type { RelaySource } from 'lib/evm-relay/source';
import type { RelayServiceState } from 'lib/evm-relay/use-relay-service';
import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { DepositFlow, type DepositFlowProps } from './DepositFlow';
import type { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';
import type { RelayTokenChoice } from './relay-token-choices';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'usdcx' }));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({ status: 'ready' })
}));
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

const ETHEREUM = { id: 'ethereum', name: 'Ethereum' };
const mockChoices: RelayTokenChoice[] = [
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

const RELAY: RelaySource = {
  accountPublicKey: 'miden-account',
  address: '0x00000000000000000000000000000000000000e5'
};
const ACCOUNT: WalletAccount = {
  publicKey: 'miden-account',
  name: 'Account 1',
  isPublic: true,
  type: WalletType.Guardian,
  hdIndex: 0,
  authScheme: 'ecdsa',
  relayEvmAddress: RELAY.address
};

function props(overrides: Partial<DepositFlowProps> = {}): DepositFlowProps {
  return {
    midenAccount: ACCOUNT,
    relaySource: RELAY,
    pendingDepositId: 'pending-1',
    onClose: jest.fn(),
    onExit: jest.fn(),
    relayOffCause: 'off',
    ...overrides
  };
}

const SPONSOR: RelayServiceState = {
  status: 'ready',
  service: { mode: 'sponsor', executor: '0x00000000000000000000000000000000000000e1', chains: [1] }
};

beforeEach(() => {
  mockService = SPONSOR;
  mockServiceEnabled.length = 0;
  mockSourceNetworkChains.length = 0;
  relayProps = undefined;
});
afterEach(cleanup);

describe('DepositFlow', () => {
  it('says the flow is not available when the relay answers deduct mode for a pair NEAR Intents does not serve', () => {
    render(<DepositFlow {...props()} />);
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'ETH', amount: '5', step: 'amount' }));
    act(() => relayProps?.onRelayUnsupported?.());

    expect(screen.getByTestId('unavailable')).toHaveAttribute('data-cause', 'deduct');
    expect(screen.queryByTestId('relay-screen')).not.toBeInTheDocument();
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
  });

  it('says the deposit service cannot be reached when NEAR Intents does not serve the selection either', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockService = UNREACHABLE;
    render(<DepositFlow {...props({ pendingDepositId: undefined })} />);

    expect(screen.getByTestId('unavailable')).toHaveAttribute('data-cause', 'unreachable');
  });

  it('says that deduct mode is not supported when the service answers it and NEAR Intents has no route', () => {
    mockService = {
      status: 'ready',
      service: { mode: 'deduct', executor: '0x00000000000000000000000000000000000000e1', chains: [1] }
    };
    render(<DepositFlow {...props({ pendingDepositId: undefined })} />);

    expect(screen.getByTestId('unavailable')).toHaveAttribute('data-cause', 'deduct');
    expect(relayProps).toBeUndefined();
  });

  it('says the flow is off when the service serves no chain of the document', () => {
    mockService = {
      status: 'ready',
      service: { mode: 'sponsor', executor: '0x00000000000000000000000000000000000000e1', chains: [] }
    };
    const choices = mockChoices.splice(0, mockChoices.length);
    try {
      render(<DepositFlow {...props({ pendingDepositId: undefined })} />);
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

    // Back to the review: no relay route is offered.
    act(() => relayProps?.onFormChange?.({ chainId: 1, token: 'ETH', amount: '5', step: 'review' }));
    expect(screen.queryByTestId('relay-screen')).not.toBeInTheDocument();
  });
});

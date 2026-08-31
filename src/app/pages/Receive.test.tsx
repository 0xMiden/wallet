import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { Receive } from './Receive';

// Pending (claimable) notes moved to their own `/pending-notes` page — see
// Pending.test.tsx for the claim-flow coverage. Receive is address-only plus an
// optional Cross-chain (EVM deposit address) tab.

const mockAccount: { publicKey: string; evmAddress?: string } = { publicKey: 'test-account-123' };
let mockDepositBridgeEnabled = false;
let mockWcBridgeEnabled = false;
let mockSearch = '';
const mockDepositState = {
  balances: { ETH: null as bigint | null, USDC: null as bigint | null },
  status: 'watching' as 'idle' | 'watching' | 'error',
  poll: jest.fn(),
  recentTxs: [] as Array<Record<string, unknown>>
};

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>
}));

jest.mock('@capacitor/share', () => ({
  Share: { share: jest.fn() }
}));

jest.mock('app/atoms/FormField', () => React.forwardRef(() => null));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: false, sidePanel: false })
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: {
    Add: 'Add',
    CrossChain: 'CrossChain',
    Receive: 'Receive',
    Share: 'Share',
    Warning: 'Warning'
  }
}));

jest.mock('app/templates/EvmConnectModal', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('app/pages/BridgeDeposit', () => ({
  __esModule: true,
  default: () => <div data-testid="bridge-deposit" />
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: jest.fn()
}));

jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    <div data-testid="drawer" data-open={String(open)}>
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));

jest.mock('components/Button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    title,
    ...rest
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    title?: string;
    'data-testid'?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} data-testid={rest['data-testid']}>
      {children ?? title}
    </button>
  ),
  ButtonVariant: { Ghost: 'ghost', Primary: 'primary', Secondary: 'secondary' }
}));

jest.mock('components/QRCode', () => ({
  QRCode: React.forwardRef(() => null)
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: () => null
}));

jest.mock('components/TabPicker', () => ({
  TabPicker: ({
    tabs,
    onTabChange
  }: {
    tabs: Array<{ id: string; title: string }>;
    onTabChange?: (i: number) => void;
  }) => (
    <div data-testid="receive-tab-picker">
      {tabs.map((tab, index) => (
        <button key={tab.id} data-testid={`receive-tab-${tab.id}`} onClick={() => onTabChange?.(index)}>
          {tab.title}
        </button>
      ))}
    </div>
  )
}));

// The route the Cross-chain tab picks is persisted, so these are the two ends of
// that contract; the quote drives the Fast card's fee and the Bridge gate.
const mockReadPreferredRoute = jest.fn<Promise<string>, [string, string]>(async (_address, token) =>
  token === 'ETH' ? 'agglayer' : 'epoch'
);
const mockWritePreferredRoute = jest.fn<Promise<void>, [string, string, string]>(async () => {});
const mockQuoteDepositViaEpoch = jest.fn<Promise<{ quoteResult: { tokenOut: string } }>, [unknown]>(async () => ({
  quoteResult: { tokenOut: (10n ** 18n).toString() }
}));

jest.mock('lib/deposit-bridge', () => ({
  DEPOSIT_TOKEN_IDS: ['ETH', 'USDC'],
  DEPOSIT_WALLETS: [],
  buildDepositPaymentUri: jest.fn(() => 'ethereum:mock'),
  openPaymentDeeplink: jest.fn(),
  getDepositToken: (id: string) => ({
    id,
    symbol: id,
    decimals: 18,
    route: id === 'ETH' ? 'agglayer' : 'epoch',
    dustFloor: id === 'ETH' ? 100_000_000_000_000n : 10_000_000_000_000_000n
  }),
  availableRoutes: (id: string) => (id === 'ETH' ? ['agglayer', 'epoch'] : ['epoch']),
  readPreferredRoute: (address: string, id: string) => mockReadPreferredRoute(address, id),
  writePreferredRoute: (address: string, id: string, route: string) => mockWritePreferredRoute(address, id, route),
  quoteDepositViaEpoch: (args: unknown) => mockQuoteDepositViaEpoch(args),
  isDepositTokenId: (value: string) => value === 'ETH' || value === 'USDC',
  formatBalance: (value: bigint) => value.toString(),
  useDepositAddressStore: (selector: (state: typeof mockDepositState) => unknown) => selector(mockDepositState)
}));

jest.mock('lib/feature-flags', () => ({
  isBridgeDepositEnabled: () => mockWcBridgeEnabled,
  isDepositAddressBridgeEnabled: () => mockDepositBridgeEnabled
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount
}));

jest.mock('lib/mobile/external-browser', () => ({
  openExternalUrl: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isExtension: () => false
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticSelection: jest.fn()
}));

jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: () => ({ fieldRef: { current: null }, copy: jest.fn(), copied: false })
}));

jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({ address: undefined, connected: false })
}));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (path: string) => mockNavigate(path),
  useLocation: () => ({ search: mockSearch })
}));

jest.mock('utils/string', () => ({
  truncateAddress: (addr: string) => addr?.slice(0, 8) || ''
}));

describe('Receive - Address', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  const render = async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    await act(async () => {
      testRoot!.render(<Receive />);
    });
    return testContainer;
  };

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockAccount.evmAddress = undefined;
    mockDepositBridgeEnabled = false;
    mockWcBridgeEnabled = false;
    mockSearch = '';
    mockDepositState.balances = { ETH: null, USDC: null };
    mockDepositState.status = 'watching';
    mockDepositState.recentTxs = [];
    mockReadPreferredRoute
      .mockClear()
      .mockImplementation(async (_address, token) => (token === 'ETH' ? 'agglayer' : 'epoch'));
    mockWritePreferredRoute.mockClear().mockResolvedValue(undefined);
    mockQuoteDepositViaEpoch.mockClear().mockResolvedValue({ quoteResult: { tokenOut: (10n ** 18n).toString() } });
    mockNavigate.mockClear();
  });

  afterEach(async () => {
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('renders the account address', async () => {
    const container = await render();

    const full = container.querySelector('[data-testid="receive-address-full"]');
    expect(full?.textContent).toBe('test-account-123');
  });

  it('does not render a pending tab switcher', async () => {
    const container = await render();

    expect(container.querySelector('[data-testid="receive-tab-pending"]')).toBeNull();
  });

  it('hides the cross-chain toggle when the deposit bridge flag is off', async () => {
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';

    const container = await render();

    expect(container.querySelector('[data-testid="receive-tab-picker"]')).toBeNull();
  });

  it('hides the cross-chain toggle when the account has no EVM address', async () => {
    mockDepositBridgeEnabled = true;

    const container = await render();

    expect(container.querySelector('[data-testid="receive-tab-picker"]')).toBeNull();
  });

  it('shows the cross-chain toggle when enabled and the account has an EVM address', async () => {
    mockDepositBridgeEnabled = true;
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';

    const container = await render();

    expect(container.querySelector('[data-testid="receive-tab-picker"]')).not.toBeNull();
    // Miden tab is the default.
    expect(container.querySelector('[data-testid="receive-address-full"]')).not.toBeNull();
  });

  it('preselects the cross-chain tab from ?tab=crosschain and shows the EVM address', async () => {
    mockDepositBridgeEnabled = true;
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';
    mockSearch = '?tab=crosschain';

    const container = await render();

    const full = container.querySelector('[data-testid="receive-evm-address-full"]');
    expect(full?.textContent).toBe('0xabc0000000000000000000000000000000000001');
  });

  it('offers both routes for ETH, restoring the one this address last chose', async () => {
    mockDepositBridgeEnabled = true;
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';
    mockSearch = '?tab=crosschain';
    mockReadPreferredRoute.mockResolvedValue('epoch');

    const container = await render();

    expect(mockReadPreferredRoute).toHaveBeenCalledWith(mockAccount.evmAddress, 'ETH');
    const fast = container.querySelector('[data-testid="bridge-route-fast"]');
    const slow = container.querySelector('[data-testid="bridge-route-slow"]');
    expect(fast?.hasAttribute('disabled')).toBe(false);
    expect(slow?.hasAttribute('disabled')).toBe(false);
    // The stored Fast choice is the selected one, not the ETH default.
    expect(fast?.className).toContain('border-primary-500');
  });

  it('remembers the route the user picks, so the later bridge uses it', async () => {
    mockDepositBridgeEnabled = true;
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';
    mockSearch = '?tab=crosschain';

    const container = await render();

    const fast = container.querySelector('[data-testid="bridge-route-fast"]');
    await act(async () => {
      fast?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockWritePreferredRoute).toHaveBeenCalledWith(mockAccount.evmAddress, 'ETH', 'epoch');
  });

  it('holds Bridge closed until the Fast quote lands', async () => {
    mockDepositBridgeEnabled = true;
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';
    mockSearch = '?tab=crosschain';
    mockReadPreferredRoute.mockResolvedValue('epoch');
    mockQuoteDepositViaEpoch.mockRejectedValue(new Error('no liquidity'));

    const container = await render();

    const input = container.querySelector<HTMLInputElement>('[data-testid="deposit-amount-input"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '1');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Guards the assertion below: without a parsable amount the CTA would be
    // disabled for that reason alone and the quote gate would go untested.
    expect(input?.value).toBe('1');

    // An unquotable Fast route must not hand the user a funding request it
    // cannot honour, so the CTA stays disabled rather than failing later.
    expect(container.querySelector('[data-testid="deposit-entry-bridge"]')?.hasAttribute('disabled')).toBe(true);
  });

  it('sends ?bridge=1&token=ETH to the full-screen review page', async () => {
    mockDepositBridgeEnabled = true;
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';
    mockSearch = '?tab=crosschain&bridge=1&token=ETH';

    await render();

    // Review is a route, not a sheet — the deep link has to navigate, not
    // open something inside Receive.
    expect(mockNavigate).toHaveBeenCalledWith('/deposit-bridge/review?token=ETH');
  });

  it('keeps the WalletConnect entry on the address tab when the account has no EVM address', async () => {
    mockWcBridgeEnabled = true;

    const container = await render();

    expect(container.querySelector('[data-testid="receive-cross-chain"]')).not.toBeNull();
  });
});

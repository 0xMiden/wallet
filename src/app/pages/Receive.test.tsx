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
  useTranslation: () => ({ t: (key: string) => key })
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

jest.mock('app/templates/DepositBridge', () => ({
  DepositBridgeDrawer: ({ open, initialToken }: { open: boolean; initialToken?: string }) =>
    open ? <div data-testid="deposit-bridge-drawer" data-token={initialToken ?? 'any'} /> : null
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

// The amount field is the shared SelectAmount input; stub it to a plain input so
// the test drives the value contract directly.
jest.mock('screens/send-flow/SelectAmount', () => ({
  SelectAmount: ({ amount, onAmountChange }: { amount: string; onAmountChange: (v: string) => void }) => (
    <input data-testid="deposit-amount-input" value={amount} onChange={e => onAmountChange(e.target.value)} />
  )
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

jest.mock('lib/deposit-bridge', () => ({
  DEPOSIT_TOKEN_IDS: ['ETH', 'USDC'],
  buildDepositPaymentUri: jest.fn(() => 'ethereum:mock'),
  openPaymentDeeplink: jest.fn(),
  getDepositToken: (id: string) => ({
    id,
    symbol: id,
    decimals: 18,
    dustFloor: id === 'ETH' ? 100_000_000_000_000n : 10_000_000_000_000_000n
  }),
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

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
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

  it('opens the bridge drawer from ?bridge=1&token=ETH', async () => {
    mockDepositBridgeEnabled = true;
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';
    mockSearch = '?tab=crosschain&bridge=1&token=ETH';

    const container = await render();

    expect(container.querySelector('[data-testid="deposit-bridge-drawer"]')?.getAttribute('data-token')).toBe('ETH');
  });

  it('renders a bridge row for a funded token above its dust floor', async () => {
    mockDepositBridgeEnabled = true;
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';
    mockSearch = '?tab=crosschain';
    mockDepositState.balances = { ETH: 500_000_000_000_000_000n, USDC: null };

    const container = await render();

    expect(container.querySelector('[data-testid="deposit-balance-ETH"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="deposit-balance-USDC"]')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="deposit-bridge-ETH"]')?.click();
    });

    expect(container.querySelector('[data-testid="deposit-bridge-drawer"]')?.getAttribute('data-token')).toBe('ETH');
  });

  it('keeps the WalletConnect entry on the address tab when the account has no EVM address', async () => {
    mockWcBridgeEnabled = true;

    const container = await render();

    expect(container.querySelector('[data-testid="receive-cross-chain"]')).not.toBeNull();
  });

  it('offers a retry when the balance check failed', async () => {
    mockDepositBridgeEnabled = true;
    mockAccount.evmAddress = '0xabc0000000000000000000000000000000000001';
    mockSearch = '?tab=crosschain';
    mockDepositState.status = 'error';

    const container = await render();

    const retry = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'retry');
    expect(retry).toBeDefined();

    await act(async () => {
      retry!.click();
    });
    expect(mockDepositState.poll).toHaveBeenCalled();
  });
});

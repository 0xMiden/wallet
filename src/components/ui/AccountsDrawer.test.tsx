import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { initializeAccountCardColors, setCardColor, useCardColor } from 'lib/settings/card-color';
import { CARD_COLORS } from 'lib/settings/constants';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

import AccountsDrawerDefault, { AccountsDrawer } from './AccountsDrawer';

interface MockMotionDivProps extends React.HTMLAttributes<HTMLDivElement> {
  whileHover?: { y: number };
  transition?: { type?: string };
}

jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    motion: {
      div: ({ children, whileHover, transition, ...props }: MockMotionDivProps) =>
        ReactActual.createElement(
          'div',
          {
            ...props,
            'data-hover-y': whileHover?.y,
            'data-transition-type': transition?.type
          },
          children
        )
    },
    useReducedMotion: () => false
  };
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

jest.mock('lib/i18n/numbers', () => ({
  toLocalFormat: (value: number) => value.toFixed(2)
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: {
    Checkmark: 'Checkmark',
    SettingsNew: 'SettingsNew',
    Add: 'Add',
    Edit: 'Edit'
  }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('lib/settings/card-color', () => ({
  getCardColor: jest.fn((accountId: string) => (accountId === 'mtst1secondary' ? 'orange' : 'slate')),
  initializeAccountCardColors: jest.fn(),
  setCardColor: jest.fn(),
  useCardColor: jest.fn((_accountId?: string) => 'slate')
}));

const mockUpdateCurrentAccount = jest.fn(() => Promise.resolve());
const mockEditAccountName = jest.fn(() => Promise.resolve());

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ editAccountName: mockEditAccountName, updateCurrentAccount: mockUpdateCurrentAccount })
}));

const mockAccounts = [
  { publicKey: 'mtst1primary', name: 'Account 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 },
  { publicKey: 'mtst1secondary', name: 'Account 2', isPublic: false, type: WalletType.OffChain, hdIndex: 0 }
];
const mockWalletState = {
  accounts: mockAccounts,
  currentAccount: mockAccounts[0]!,
  balances: {
    mtst1primary: [
      {
        tokenId: 'miden',
        tokenSlug: 'MIDEN',
        metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 6, scaleIsUnknown: false },
        balance: 4,
        fiatPrice: 2,
        change24h: 0
      }
    ],
    mtst1secondary: [
      {
        tokenId: 'usdc',
        tokenSlug: 'USDC',
        metadata: { symbol: 'USDC', name: 'USD Coin', decimals: 6, scaleIsUnknown: false },
        balance: 3,
        fiatPrice: 5,
        change24h: 0
      }
    ]
  },
  tokenPrices: {
    MIDEN: { price: 2, change24h: 0, percentageChange24h: 0 },
    USDC: { price: 5, change24h: 0, percentageChange24h: 0 }
  }
};

jest.mock('lib/store', () => ({
  useWalletStore: <Selected,>(selector: (state: typeof mockWalletState) => Selected): Selected =>
    selector(mockWalletState)
}));

// CARD_COLOR_BG is a plain className map shared with the BalanceCard; mock the
// module so the whole BalanceCard render tree isn't dragged in.
jest.mock('./BalanceCard', () => ({
  CARD_COLOR_BG: {
    slate: 'bg-card-slate',
    orange: 'bg-card-orange',
    blue: 'bg-card-blue',
    green: 'bg-card-green',
    purple: 'bg-card-purple'
  }
}));

jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="drawer" data-open={String(open)}>
      <button data-testid="drawer-onOpenChange-false" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

const mockedUseCardColor = useCardColor as jest.Mock;

const renderDrawer = (props: Partial<React.ComponentProps<typeof AccountsDrawer>> = {}) =>
  render(<AccountsDrawer open onOpenChange={jest.fn()} {...props} />);

describe('AccountsDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseCardColor.mockReturnValue('slate');
    mockWalletState.currentAccount = mockAccounts[0]!;
  });

  it('exports the same component as default and named', () => {
    expect(AccountsDrawerDefault).toBe(AccountsDrawer);
  });

  it('forwards the open flag to the underlying Drawer', () => {
    const { rerender } = renderDrawer({ open: true });
    expect(screen.getByTestId('drawer').getAttribute('data-open')).toBe('true');

    rerender(<AccountsDrawer open={false} onOpenChange={jest.fn()} />);
    expect(screen.getByTestId('drawer').getAttribute('data-open')).toBe('false');
  });

  it('renders the title, card-color label, and both action buttons', () => {
    renderDrawer();

    expect(screen.getByTestId('drawer-title').textContent).toBe('accounts');
    expect(screen.getByText('cardColor')).toBeTruthy();
    expect(screen.getByText('settings').closest('button')?.className).toContain('dark:text-pure-white');
    expect(screen.getByText('addAccount')).toBeTruthy();
  });

  it('renders one swatch per card color with its background class', () => {
    renderDrawer();

    CARD_COLORS.forEach(color => {
      const swatch = screen.getByRole('button', { name: color });
      expect(swatch.className).toContain(`bg-card-${color}`);
    });
  });

  it('marks only the selected color as pressed and shows its checkmark', () => {
    mockedUseCardColor.mockReturnValue('blue');
    renderDrawer();

    const selected = screen.getByRole('button', { name: 'blue' });
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    // The checkmark icon lives inside the selected swatch only.
    expect(selected.querySelector('[data-name="Checkmark"]')).not.toBeNull();

    CARD_COLORS.filter(c => c !== 'blue').forEach(color => {
      const other = screen.getByRole('button', { name: color });
      expect(other.getAttribute('aria-pressed')).toBe('false');
      expect(other.querySelector('[data-name="Checkmark"]')).toBeNull();
    });
  });

  it('does nothing when the already-selected color is clicked', () => {
    mockedUseCardColor.mockReturnValue('slate');
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'slate' }));

    expect(hapticLight).not.toHaveBeenCalled();
    expect(setCardColor).not.toHaveBeenCalled();
  });

  it('persists the color and fires haptics when a new color is clicked', () => {
    mockedUseCardColor.mockReturnValue('slate');
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'green' }));

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(setCardColor).toHaveBeenCalledTimes(1);
    expect(setCardColor).toHaveBeenCalledWith('mtst1primary', 'green');
  });

  it('closes the drawer, fires haptics, and navigates on Settings click', () => {
    const onOpenChange = jest.fn();
    renderDrawer({ onOpenChange });

    fireEvent.click(screen.getByText('settings').closest('button')!);

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith('/settings');
  });

  it('closes the drawer and opens the add-account picker on Add Account click', () => {
    const onOpenChange = jest.fn();
    const onAddAccount = jest.fn();
    renderDrawer({ onOpenChange, onAddAccount });

    fireEvent.click(screen.getByTestId('accounts-drawer-add-account'));

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onAddAccount).toHaveBeenCalledTimes(1);
  });

  it('renders the 390 by 170 card stack with 40px between card tops', () => {
    renderDrawer();

    const rows = screen.getAllByTestId('accounts-drawer-account');
    const cards = screen.getAllByTestId('accounts-drawer-card');
    const stack = screen.getByRole('radiogroup', { name: 'accounts' });
    expect(rows).toHaveLength(2);
    expect(cards).toHaveLength(2);
    expect(stack.className).toContain('w-[390px]');
    expect(cards[0]!.className).toContain('h-[170px]');
    expect(cards[0]!.parentElement?.className).toContain('h-42.5');
    expect(cards[1]!.parentElement?.className).toContain('h-10');
    expect(rows[0]!.getAttribute('aria-checked')).toBe('true');
    expect(rows[1]!.getAttribute('aria-checked')).toBe('false');
    expect(rows[0]!.querySelector('[data-name="Checkmark"]')).toBeNull();
    expect(rows[1]!.querySelector('[data-name="Checkmark"]')).toBeNull();
    expect(cards[0]!.className).toContain('bg-card-slate');
    expect(cards[1]!.className).toContain('bg-card-orange');
    expect(screen.getByText('accountTypePublic')).toBeTruthy();
    expect(screen.getByText('accountTypePrivate')).toBeTruthy();
    expect(screen.getByText('$8.00')).toBeTruthy();
    expect(screen.getByText('$15.00')).toBeTruthy();
    const accountNames = screen.getAllByTestId('accounts-drawer-account-name');
    const editButtons = screen.getAllByRole('button', { name: /editAccountName:/ });
    expect(accountNames[0]!.className).toContain('text-sm');
    expect(accountNames[0]!.className).toContain('font-semibold');
    expect(accountNames[0]!.className).toContain('text-pure-white');
    expect(accountNames[0]!.parentElement?.className).not.toContain('gap-');
    expect(editButtons[0]!.querySelector('[data-name="Edit"]')).not.toBeNull();
    expect(rows[0]!.className).not.toContain('hover:');
    expect(editButtons[0]!.className).not.toContain('hover:');
    expect(cards[0]!.getAttribute('data-hover-y')).toBeNull();
    expect(cards[1]!.getAttribute('data-hover-y')).toBe('-8');
    expect(cards[1]!.getAttribute('data-transition-type')).toBe('spring');
    expect(initializeAccountCardColors).toHaveBeenCalledWith(['mtst1primary', 'mtst1secondary']);
  });

  it('places the current account first even when it is later in the stored account list', () => {
    mockWalletState.currentAccount = mockAccounts[1]!;
    renderDrawer();

    const rows = screen.getAllByTestId('accounts-drawer-account');
    const accountNames = screen.getAllByTestId('accounts-drawer-account-name');
    expect(rows[0]!.getAttribute('aria-checked')).toBe('true');
    expect(accountNames[0]!.textContent).toContain('Account 2');
    expect(accountNames[1]!.textContent).toContain('Account 1');
  });

  it('switches to the tapped account and closes the drawer', () => {
    const onOpenChange = jest.fn();
    renderDrawer({ onOpenChange });

    fireEvent.click(screen.getAllByTestId('accounts-drawer-account')[1]!);

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockUpdateCurrentAccount).toHaveBeenCalledWith('mtst1secondary');
  });

  it('only closes the drawer when the active account is tapped', () => {
    const onOpenChange = jest.fn();
    renderDrawer({ onOpenChange });

    fireEvent.click(screen.getAllByTestId('accounts-drawer-account')[0]!);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockUpdateCurrentAccount).not.toHaveBeenCalled();
  });

  it('renames an account inline without switching accounts', async () => {
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'editAccountName: Account 2' }));
    const nameInput = screen.getByRole('textbox', { name: 'editAccountName' });
    fireEvent.change(nameInput, { target: { value: 'Savings' } });
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    await waitFor(() => expect(mockEditAccountName).toHaveBeenCalledWith('mtst1secondary', 'Savings'));
    expect(mockUpdateCurrentAccount).not.toHaveBeenCalled();
    expect(hapticLight).toHaveBeenCalledTimes(2);
  });

  it('disables rename confirmation for a duplicate account name', () => {
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'editAccountName: Account 2' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'editAccountName' }), {
      target: { value: 'Account 1' }
    });

    expect(screen.getByRole('button', { name: 'confirm' }).hasAttribute('disabled')).toBe(true);
    expect(mockEditAccountName).not.toHaveBeenCalled();
  });
});

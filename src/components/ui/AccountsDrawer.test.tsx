import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { setCardColor, useCardColor } from 'lib/settings/card-color';
import { CARD_COLORS } from 'lib/settings/constants';
import { navigate } from 'lib/woozie';

import { AccountsDrawer } from './AccountsDrawer';
import AccountsDrawerDefault from './AccountsDrawer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: {
    Checkmark: 'Checkmark',
    SettingsNew: 'SettingsNew',
    Add: 'Add'
  }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('lib/settings/card-color', () => ({
  setCardColor: jest.fn(),
  useCardColor: jest.fn(() => 'slate')
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
    expect(screen.getByText('settings')).toBeTruthy();
    expect(screen.getByText('addAccountComingSoon')).toBeTruthy();
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
    expect(setCardColor).toHaveBeenCalledWith('green');
  });

  it('closes the drawer, fires haptics, and navigates on Settings click', () => {
    const onOpenChange = jest.fn();
    renderDrawer({ onOpenChange });

    fireEvent.click(screen.getByText('settings').closest('button')!);

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith('/settings');
  });

  it('renders the "Add Account" placeholder as a disabled button', () => {
    renderDrawer();

    const addButton = screen.getByText('addAccountComingSoon').closest('button')!;
    expect(addButton).toBeDisabled();
    expect(addButton.getAttribute('aria-disabled')).toBe('true');
  });
});

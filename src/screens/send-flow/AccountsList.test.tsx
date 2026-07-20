import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AccountsListDrawer } from './AccountsList';
import { Contact } from './types';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and we can assert rendered labels directly.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `lib/ui/drawer` wraps `vaul`, which renders through a portal and drives
// open/close via animation — not useful for a unit test of the list logic.
// Render children inline and surface the `open`/`onOpenChange` props the
// component wires up so we can assert them.
const drawerOpenChangeSpy = jest.fn();
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => {
    drawerOpenChangeSpy(open);
    // Expose the handler so a test can invoke the drawer's own close path.
    (globalThis as unknown as { __drawerOnOpenChange?: typeof onOpenChange }).__drawerOnOpenChange = onOpenChange;
    return (
      <div data-testid="drawer" data-open={String(open)}>
        {children}
      </div>
    );
  },
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

// `app/icons/v2` is a barrel of SVG re-exports; AccountsList only reads the
// `IconName` enum from it. Stub the two members it references.
jest.mock('app/icons/v2', () => ({
  IconName: {
    Users: 'Users',
    CheckboxCircleFill: 'CheckboxCircleFill'
  }
}));

// Stub the leaf presentational components so this test exercises only the
// prop-wiring / branching inside AccountsList. Each stub reflects the props
// AccountsList sets back out as inspectable DOM.
jest.mock('components/Avatar', () => ({
  Avatar: ({ image, size }: { image?: string; size?: string }) => (
    <span data-testid="avatar" data-image={image} data-size={size} />
  )
}));

jest.mock('components/EmptyState', () => ({
  EmptyState: ({
    icon,
    title,
    description,
    className
  }: {
    icon: string;
    title: string;
    description: string;
    className?: string;
  }) => (
    <div data-testid="empty-state" data-icon={icon} data-classname={className}>
      <span data-testid="empty-title">{title}</span>
      <span data-testid="empty-description">{description}</span>
    </div>
  )
}));

jest.mock('components/CardItem', () => ({
  CardItem: ({
    title,
    subtitle,
    iconLeft,
    iconRight,
    titleRight,
    hoverable,
    onClick
  }: {
    title?: string;
    subtitle?: string;
    iconLeft?: React.ReactNode;
    iconRight?: unknown;
    titleRight?: React.ReactNode;
    hoverable?: boolean;
    onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  }) => (
    <div
      data-testid="card-item"
      data-icon-right={iconRight === undefined ? 'none' : String(iconRight)}
      data-hoverable={String(hoverable)}
      onClick={onClick}
    >
      <span data-testid="card-icon-left">{iconLeft}</span>
      <span data-testid="card-title">{title}</span>
      <span data-testid="card-subtitle">{subtitle}</span>
      <span data-testid="card-title-right">{titleRight}</span>
    </div>
  )
}));

// Deterministic, dependency-free truncation for stable subtitle assertions.
jest.mock('utils/string', () => ({
  truncateAddress: (addr: string) => `trunc(${addr})`
}));

const guardian: Contact = {
  id: 'guardian_addr_1',
  name: 'Guardian Account',
  isOwned: false,
  contactType: 'external',
  isGuardian: true
};

const plainPublic: Contact = {
  id: 'public_addr_2',
  name: 'Public Account',
  isOwned: true,
  contactType: 'public'
};

const plainPrivate: Contact = {
  id: 'private_addr_3',
  name: 'Private Account',
  isOwned: false,
  contactType: 'private',
  isGuardian: false
};

const renderDrawer = (props: Partial<React.ComponentProps<typeof AccountsListDrawer>> = {}) => {
  const onOpenChange = jest.fn();
  const onSelectContact = jest.fn();
  const utils = render(
    <AccountsListDrawer
      open={true}
      onOpenChange={onOpenChange}
      accounts={[]}
      onSelectContact={onSelectContact}
      {...props}
    />
  );
  return { onOpenChange, onSelectContact, ...utils };
};

beforeEach(() => {
  drawerOpenChangeSpy.mockClear();
});

describe('AccountsListDrawer', () => {
  it('renders the drawer shell with the translated title and forwards `open`', () => {
    renderDrawer({ open: true });

    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('contacts');
    expect(drawerOpenChangeSpy).toHaveBeenCalledWith(true);
  });

  it('passes `open={false}` through to the underlying Drawer', () => {
    renderDrawer({ open: false });

    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
    expect(drawerOpenChangeSpy).toHaveBeenCalledWith(false);
  });

  describe('empty state', () => {
    it('renders EmptyState (and no cards) when there are no accounts', () => {
      renderDrawer({ accounts: [] });

      const empty = screen.getByTestId('empty-state');
      expect(empty).toBeInTheDocument();
      expect(empty).toHaveAttribute('data-icon', 'Users');
      expect(empty).toHaveAttribute('data-classname', 'flex-1');
      expect(screen.getByTestId('empty-title')).toHaveTextContent('noOtherAccounts');
      expect(screen.getByTestId('empty-description')).toHaveTextContent('noOtherAccountsDescription');
      expect(screen.queryByTestId('card-item')).not.toBeInTheDocument();
    });
  });

  describe('populated list', () => {
    it('renders one CardItem per account and never an EmptyState', () => {
      renderDrawer({ accounts: [guardian, plainPublic, plainPrivate] });

      expect(screen.getAllByTestId('card-item')).toHaveLength(3);
      expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
    });

    it('composes each card title/subtitle from the contact name, type and truncated id', () => {
      renderDrawer({ accounts: [plainPublic] });

      expect(screen.getByTestId('card-title')).toHaveTextContent('Public Account');
      // subtitle = `${t(contactType)} · ${truncateAddress(id)}`
      expect(screen.getByTestId('card-subtitle')).toHaveTextContent('public · trunc(public_addr_2)');
    });

    it('marks a card hoverable and renders an Avatar for it', () => {
      renderDrawer({ accounts: [plainPublic] });

      expect(screen.getByTestId('card-item')).toHaveAttribute('data-hoverable', 'true');
      const avatar = screen.getByTestId('avatar');
      expect(avatar).toHaveAttribute('data-image', '/misc/avatars/miden-orange.png');
      expect(avatar).toHaveAttribute('data-size', 'lg');
    });

    it('shows the check icon on the account matching recipientAccountId and none on others', () => {
      renderDrawer({
        accounts: [plainPublic, plainPrivate],
        recipientAccountId: 'private_addr_3'
      });

      const cards = screen.getAllByTestId('card-item');
      // First card (public) does not match → no icon.
      expect(cards[0]).toHaveAttribute('data-icon-right', 'none');
      // Second card (private) matches the recipient → check icon.
      expect(cards[1]).toHaveAttribute('data-icon-right', 'CheckboxCircleFill');
    });

    it('shows no check icon on any card when recipientAccountId is undefined', () => {
      renderDrawer({ accounts: [plainPublic, plainPrivate] });

      for (const card of screen.getAllByTestId('card-item')) {
        expect(card).toHaveAttribute('data-icon-right', 'none');
      }
    });

    it('renders the guardian badge only for guardian contacts', () => {
      renderDrawer({ accounts: [guardian, plainPublic, plainPrivate] });

      const titleRights = screen.getAllByTestId('card-title-right');
      // guardian → badge label present
      expect(titleRights[0]).toHaveTextContent('guardianBadge');
      // non-guardian (isGuardian undefined) → empty
      expect(titleRights[1]).toBeEmptyDOMElement();
      // non-guardian (isGuardian === false) → empty
      expect(titleRights[2]).toBeEmptyDOMElement();
    });

    it('invokes onSelectContact with the contact and closes the drawer on click', () => {
      const { onSelectContact, onOpenChange } = renderDrawer({
        accounts: [plainPublic, plainPrivate]
      });

      fireEvent.click(screen.getAllByTestId('card-item')[1]);

      expect(onSelectContact).toHaveBeenCalledTimes(1);
      expect(onSelectContact).toHaveBeenCalledWith(plainPrivate);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

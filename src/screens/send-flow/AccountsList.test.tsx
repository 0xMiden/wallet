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
// The sheet's closeOnBack, captured so a test can see which tier owns its mobile back.
let mockDrawerCloseOnBack: boolean | undefined;
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    closeOnBack,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    closeOnBack?: boolean;
    children: React.ReactNode;
  }) => {
    drawerOpenChangeSpy(open);
    mockDrawerCloseOnBack = closeOnBack;
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

// `app/icons/v2` is a barrel of SVG re-exports; stub the glyph component and
// the one enum member AccountsList references.
jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { Users: 'Users', Search: 'Search', CloseCircleFill: 'CloseCircleFill' }
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/woozie', () => ({ Link: () => null }));
jest.mock('screens/send-flow/bridge-networks', () => ({
  BRIDGE_NETWORKS: [{ id: 'sepolia', name: 'Sepolia', chainId: 1 }],
  DEFAULT_BRIDGE_NETWORK: { id: 'sepolia', name: 'Sepolia', chainId: 1 }
}));
jest.mock('utils/miden', () => ({
  detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden')
}));

// Stub the leaf presentational components so this test exercises only the
// prop-wiring / branching inside AccountsList. Each stub reflects the props
// AccountsList sets back out as inspectable DOM.
jest.mock('components/contacts/ContactAvatar', () => ({
  ContactAvatar: ({ address, name, network }: { address: string; name?: string; network?: string }) => (
    <span data-testid="avatar" data-address={address} data-name={name} data-network={network} />
  )
}));

jest.mock('components/ui/EmptyState', () => ({
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

// Deterministic, dependency-free truncation for stable subtitle assertions.
jest.mock('utils/string', () => ({
  truncateAddress: (addr: string) => `trunc(${addr})`
}));

jest.mock('components/ui/Pill', () => ({
  Pill: ({ children }: { children: React.ReactNode }) => <span data-testid="pill">{children}</span>
}));

const guardian: Contact = {
  id: 'guardian_addr_1',
  name: 'Guardian Account',
  isOwned: true,
  contactType: 'private',
  isGuardian: true
};

const plainPublic: Contact = {
  id: 'public_addr_2',
  name: 'Public Account',
  isOwned: true,
  contactType: 'public'
};

const alice: Contact = {
  id: 'mtst1alice',
  name: 'Alice',
  isOwned: false,
  contactType: 'external'
};

const zed: Contact = {
  id: '0xzed',
  name: 'Zed',
  isOwned: false,
  contactType: 'external',
  network: 'sepolia'
};

const row = (id: string) => screen.getByTestId(`send-contact-${id}`);

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
  it("leaves mobile back to SendManager's handler, which closes the sheet", () => {
    renderDrawer({ open: true });
    expect(mockDrawerCloseOnBack).toBe(false);
  });

  it('renders the drawer shell titled Address Book and forwards `open`', () => {
    renderDrawer({ open: true });

    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('addressBook');
    expect(drawerOpenChangeSpy).toHaveBeenCalledWith(true);
  });

  it('passes `open={false}` through to the underlying Drawer', () => {
    renderDrawer({ open: false });

    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
    expect(drawerOpenChangeSpy).toHaveBeenCalledWith(false);
  });

  describe('empty state', () => {
    it('renders EmptyState, and no search or rows, when there is no one to pick', () => {
      renderDrawer({ accounts: [] });

      const empty = screen.getByTestId('empty-state');
      expect(empty).toHaveAttribute('data-icon', 'Users');
      expect(empty).toHaveAttribute('data-classname', 'flex-1');
      expect(screen.getByTestId('empty-title')).toHaveTextContent('noOtherAccounts');
      expect(screen.getByTestId('empty-description')).toHaveTextContent('noOtherAccountsDescription');
      expect(screen.getByTestId('send-contacts-list')).toContainElement(empty);
      expect(screen.queryByTestId('send-contacts-search')).not.toBeInTheDocument();
      expect(screen.queryAllByTestId(/^send-contact-/)).toHaveLength(0);
    });
  });

  describe('populated list', () => {
    it('lists my accounts, then contacts, each under its own label in its own group', () => {
      renderDrawer({ accounts: [alice, plainPublic, zed, guardian] });

      const rows = screen.getAllByTestId(/^send-contact-/);
      expect(rows.map(r => r.getAttribute('data-testid'))).toEqual([
        'send-contact-public_addr_2',
        'send-contact-guardian_addr_1',
        'send-contact-mtst1alice',
        'send-contact-0xzed'
      ]);
      const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
      expect(headings).toEqual(['myAccounts', 'contacts']);
      expect(row('public_addr_2').parentElement).toHaveClass('bg-fill', 'rounded-2xl');
      expect(row('mtst1alice').parentElement).not.toBe(row('public_addr_2').parentElement);
      expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
    });

    it('omits a section with no one in it', () => {
      renderDrawer({ accounts: [alice] });

      expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['contacts']);
    });

    it("subtitles my accounts with their visibility and contacts with their network, and drops 'External'", () => {
      renderDrawer({ accounts: [plainPublic, guardian, alice, zed] });

      expect(row('public_addr_2')).toHaveTextContent('public · trunc(public_addr_2)');
      expect(row('guardian_addr_1')).toHaveTextContent('private · trunc(guardian_addr_1)');
      expect(row('mtst1alice')).toHaveTextContent('miden · trunc(mtst1alice)');
      expect(row('0xzed')).toHaveTextContent('Sepolia · trunc(0xzed)');
      expect(screen.queryByText(/external/)).not.toBeInTheDocument();
    });

    it("gives each row the contact's own avatar, badged only for a 0x contact", () => {
      renderDrawer({ accounts: [plainPublic, alice, zed] });

      const avatar = (id: string) => row(id).querySelector('[data-testid="avatar"]');
      expect(avatar('public_addr_2')).toHaveAttribute('data-name', 'Public Account');
      expect(avatar('public_addr_2')).not.toHaveAttribute('data-network');
      expect(avatar('mtst1alice')).not.toHaveAttribute('data-network');
      expect(avatar('0xzed')).toHaveAttribute('data-network', 'ethereum');
    });

    it('checks the row matching recipientAccountId and no other', () => {
      renderDrawer({ accounts: [plainPublic, alice], recipientAccountId: 'mtst1alice' });

      expect(row('mtst1alice')).toHaveAttribute('aria-pressed', 'true');
      expect(row('public_addr_2')).toHaveAttribute('aria-pressed', 'false');
    });

    it('shows the guardian badge only on a guardian account', () => {
      renderDrawer({ accounts: [guardian, plainPublic] });

      expect(row('guardian_addr_1')).toHaveTextContent('guardianBadge');
      expect(row('public_addr_2')).not.toHaveTextContent('guardianBadge');
    });

    it('invokes onSelectContact with the contact and closes the drawer on tap', () => {
      const { onSelectContact, onOpenChange } = renderDrawer({ accounts: [plainPublic, alice] });

      fireEvent.click(row('mtst1alice'));

      expect(onSelectContact).toHaveBeenCalledTimes(1);
      expect(onSelectContact).toHaveBeenCalledWith(alice);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('search', () => {
    it('filters both sections by name or address, and says when nothing matches', () => {
      renderDrawer({ accounts: [plainPublic, alice, zed] });
      const search = screen.getByTestId('send-contacts-search');

      fireEvent.change(search, { target: { value: 'ALI' } });
      expect(screen.getAllByTestId(/^send-contact-/).map(r => r.getAttribute('data-testid'))).toEqual([
        'send-contact-mtst1alice'
      ]);
      expect(screen.queryByText('myAccounts')).not.toBeInTheDocument();

      fireEvent.change(search, { target: { value: '0xz' } });
      expect(screen.getAllByTestId(/^send-contact-/).map(r => r.getAttribute('data-testid'))).toEqual([
        'send-contact-0xzed'
      ]);

      fireEvent.change(search, { target: { value: 'nobody' } });
      expect(screen.queryAllByTestId(/^send-contact-/)).toHaveLength(0);
      expect(screen.getByText('noContactsFound')).toBeInTheDocument();
      expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
    });

    it('starts over empty each time the sheet opens', () => {
      const { rerender, onOpenChange, onSelectContact } = renderDrawer({ accounts: [plainPublic, alice] });
      fireEvent.change(screen.getByTestId('send-contacts-search'), { target: { value: 'ali' } });

      const props = { onOpenChange, onSelectContact, accounts: [plainPublic, alice] };
      rerender(<AccountsListDrawer open={false} {...props} />);
      rerender(<AccountsListDrawer open {...props} />);

      expect(screen.getByTestId('send-contacts-search')).toHaveValue('');
      expect(screen.getAllByTestId(/^send-contact-/)).toHaveLength(2);
    });
  });
});

import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { getCurrentLocale } from 'lib/i18n/core';
import { hapticLight } from 'lib/mobile/haptics';
import { SeedPhraseStatus } from 'lib/shared/types';
import { goBack, navigate } from 'lib/woozie';

import { PRIVACY_POLICY_URL } from '../constants';
// Import the component under test AFTER the mocks are declared.
import Settings from './Settings';

// ---------------------------------------------------------------------------
// Mutable state used by the store / platform / motion mocks. Names are
// `mock`-prefixed so jest allows them inside the (hoisted) mock factories.
// ---------------------------------------------------------------------------
type MockAccount = { type?: string; hotPublicKey?: string } | undefined;
const mockWalletState: { currentAccount: MockAccount; seedPhraseStatus?: SeedPhraseStatus } = {
  currentAccount: { type: 'on-chain' },
  seedPhraseStatus: 'stored'
};
let mockIsMobile = false;
let mockHistoryPosition = 1;
let mockReduceMotion: boolean | null = false;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// framer-motion: AnimatePresence renders children; every `motion.X` becomes
// the plain tag it wraps (so `motion.h1` still exposes an `h1`, e.g. the
// TabHeader title/search swap), with the animation-only props dropped and
// everything else (including `data-testid`, `className`) passed through.
jest.mock('framer-motion', () => {
  const react = require('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get:
          (_target: unknown, tag: string) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ({ children, initial, animate, exit, transition, ...rest }: any) =>
            react.createElement(tag, rest, children)
      }
    ),
    useReducedMotion: () => mockReduceMotion
  };
});

// Deterministic network so the module-level `isDevnet` picks the "orange"
// icon set. The devnet branch is exercised separately via isolateModules.
jest.mock('lib/miden-chain/constants', () => ({
  DEFAULT_NETWORK: 'testnet',
  MIDEN_NETWORK_NAME: { DEVNET: 'devnet', TESTNET: 'testnet', MAINNET: 'mainnet' }
}));

// Defaults to hidden; individual tests flip `mockShowDevEndpoints.value` to
// exercise the row's async, cancellation-safe mount effect.
const mockShowDevEndpoints = { value: false };
const mockIsEndpointOverrideActive = jest.fn(() => Promise.resolve(mockShowDevEndpoints.value));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  isEndpointOverrideActive: () => mockIsEndpointOverrideActive()
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: typeof mockWalletState) => unknown) => selector(mockWalletState)
}));

jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn()
}));

// External-browser helper: window.open a new tab on desktop / native
// InAppBrowser overlay on mobile. Mocked so the "Send feedback" row can be
// asserted without touching the real platform bridge.
const mockOpenExternalUrl = jest.fn();
jest.mock('lib/mobile/external-browser', () => ({
  openExternalUrl: (...args: unknown[]) => mockOpenExternalUrl(...args)
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  HistoryAction: { Push: 'push', Replace: 'replace' },
  // Read by useBackWithFallback at call time, which decides whether the sub-page
  // header's back chevron pops history or falls back to the settings root.
  createLocationState: () => ({ historyPosition: mockHistoryPosition, href: 'http://localhost/#/settings/sub' }),
  listen: () => () => undefined
}));

jest.mock('lib/i18n/core', () => ({
  getCurrentLocale: jest.fn(() => 'en-US')
}));

jest.mock('screens/onboarding/types', () => ({
  WalletType: { OffChain: 'off-chain', Guardian: 'guardian', OnChain: 'on-chain' }
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: new Proxy({}, { get: (_t, prop) => String(prop) })
}));

jest.mock('components/Button', () => ({
  __esModule: true,
  // Fires the haptic the real Button fires on every click (Button.tsx). Without
  // it the mock made a caller adding its own invisible here — which is exactly
  // how both seed-warning handlers came to double-buzz.
  Button: ({ title, onClick, variant }: { title: string; onClick?: () => void; variant?: string }) => (
    <button
      type="button"
      data-testid={`btn-${title}`}
      data-variant={variant}
      onClick={() => {
        hapticLight();
        onClick?.();
      }}
    >
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' }
}));

jest.mock('components/PageHeader', () => ({
  PageHeader: ({
    title,
    onBack,
    focusTitleOnMount
  }: {
    title: string;
    onBack?: () => void;
    focusTitleOnMount?: boolean;
  }) => (
    <div data-testid="nav-header" data-focus-title={String(Boolean(focusTitleOnMount))}>
      <span data-testid="nav-title">{title}</span>
      <button type="button" data-testid="nav-back" onClick={onBack}>
        back
      </button>
    </div>
  )
}));

// ListRow stub surfaces every prop the page wires up so we can assert routing
// intent (route or external link), per-item testID, trailing value, chevron and
// the click handler.
jest.mock('components/ui/ListRow', () => ({
  ListRow: ({
    title,
    to,
    href,
    value,
    chevron,
    onClick,
    'data-testid': dataTestId
  }: {
    title: string;
    to?: string;
    href?: string;
    value?: string;
    chevron?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button
      type="button"
      data-testid={`row-${title}`}
      data-selector={dataTestId}
      data-slug={String(to ?? href)}
      data-external={String(href !== undefined)}
      data-righttext={value === undefined ? 'undefined' : String(value)}
      data-chevron={String(chevron ?? Boolean(to || href))}
      // The real ListRow produces exactly one hapticLight per tap on every
      // branch: the external anchor and the <button> call it directly, and the
      // routed <Link> gets one from woozie's Link (Link.tsx). The mock has to
      // buzz, or a caller adding its own — which the recovery-phrase row once
      // did, buzzing twice — is invisible here.
      onClick={() => {
        hapticLight();
        onClick?.();
      }}
    >
      {title}
    </button>
  )
}));

// Every settings template renders as an inert stub. Pages that render the shared
// SubPageLayout are stubbed THROUGH it (the real layout, over the PageHeader mock
// above), so the header they take from this host is still what is asserted.
function mockLayoutPage(testId: string) {
  return function MockLayoutPage() {
    const { SubPageLayout } = jest.requireActual('components/ui/SubPageLayout');
    return (
      <SubPageLayout data-testid={testId}>
        <span />
      </SubPageLayout>
    );
  };
}

jest.mock('app/templates/GeneralSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="general-settings" />
}));

jest.mock('app/templates/AddressBook', () => ({ __esModule: true, default: () => <div data-testid="address-book" /> }));
jest.mock('app/templates/DAppDrawerSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="dapp-drawer-settings" />
}));
jest.mock('app/templates/DAppSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="dapp-settings" />
}));
jest.mock('app/templates/EditMidenFaucetId', () => ({
  __esModule: true,
  default: () => <div data-testid="edit-faucet" />
}));
jest.mock('app/templates/GuardianSettings', () => ({
  __esModule: true,
  default: mockLayoutPage('guardian-settings-body')
}));
jest.mock('app/templates/KeysSettings', () => ({
  __esModule: true,
  default: mockLayoutPage('keys-settings')
}));
jest.mock('app/templates/LanguageSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="language-settings" />
}));
jest.mock('app/templates/RevealSecret', () => ({
  __esModule: true,
  default: function MockRevealSecret({ reveal }: { reveal: string }) {
    const { SubPageLayout } = jest.requireActual('components/ui/SubPageLayout');
    return (
      <SubPageLayout data-testid="reveal-secret">
        <span>{reveal}</span>
      </SubPageLayout>
    );
  }
}));
jest.mock('app/templates/RevealSeedPhrase', () => ({
  __esModule: true,
  default: () => <div data-testid="reveal-seed-flow" />
}));
jest.mock('app/templates/VerifySeedPhraseFlow', () => ({
  __esModule: true,
  default: () => <div data-testid="verify-seed-flow" />
}));
jest.mock('screens/encrypted-file-flow/EncryptedFileManager', () => ({
  EncryptedFileFlow: () => <div data-testid="encrypted-file-flow" />
}));
jest.mock('./AdvancedSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="advanced-settings" />
}));
jest.mock('./Networks', () => ({
  __esModule: true,
  default: () => <div data-testid="networks-settings" />
}));

const mockNavigate = navigate as jest.Mock;
const mockGoBack = goBack as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;
const mockGetCurrentLocale = getCurrentLocale as jest.Mock;

function setAccount(account: MockAccount) {
  mockWalletState.currentAccount = account;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMobile = false;
  mockHistoryPosition = 1;
  mockReduceMotion = false;
  mockShowDevEndpoints.value = false;
  mockWalletState.seedPhraseStatus = 'stored';
  setAccount({ type: 'on-chain' });
  mockGetCurrentLocale.mockReturnValue('en-US');
  document.body.removeAttribute('data-drawer-open');
  document.body.removeAttribute('data-edge-to-edge');
});

afterEach(() => {
  document.body.removeAttribute('data-drawer-open');
  document.body.removeAttribute('data-edge-to-edge');
});

describe('Settings page — root menu (non-guardian)', () => {
  it.each<SeedPhraseStatus | undefined>(['removing', 'removed', 'unavailable', undefined])(
    'hides recovery phrase settings when seed status is %s',
    status => {
      mockWalletState.seedPhraseStatus = status;
      render(<Settings tabSlug={null} />);

      expect(screen.queryByTestId('row-recoveryPhrase')).not.toBeInTheDocument();
      expect(screen.queryByTestId('row-removeSeedPhrase')).not.toBeInTheDocument();
    }
  );

  // Hiding the ROW is deliberate (above). Hiding the ROUTE is not: `allTabs` is
  // what resolves a sub-page, and the panel behind this slug is the only place
  // that reports an interrupted removal. Without it a wallet stuck at 'removing'
  // is indistinguishable from a finished one while the seed stays unusable.
  it.each<SeedPhraseStatus>(['removing', 'removed', 'unavailable'])(
    'still resolves the seed sub-page route when the row is hidden, status %s',
    status => {
      mockWalletState.seedPhraseStatus = status;
      mockNavigate.mockClear();

      render(<Settings tabSlug="remove-seed-phrase" />);

      expect(screen.getByTestId('verify-seed-flow')).toBeInTheDocument();
      // invalidTab would bounce the user back to the menu instead.
      expect(mockNavigate).not.toHaveBeenCalledWith('/settings', expect.anything());
    }
  );

  // The other side of that rule. RevealSecret returns null once the seed is gone,
  // so restoring this route would resolve to a header over an empty body. Only a
  // tab whose panel actually reports the state earns its route back.
  it('does not restore the route of a seed-gated tab whose panel renders nothing', () => {
    mockWalletState.seedPhraseStatus = 'removed';
    mockNavigate.mockClear();

    render(<Settings tabSlug="reveal-private-key" />);

    expect(mockNavigate).toHaveBeenCalledWith('/settings', expect.anything());
  });

  it('removes the recovery phrase settings when the seed status changes', () => {
    const view = render(<Settings tabSlug={null} />);
    expect(screen.getByTestId('row-recoveryPhrase')).toBeInTheDocument();
    expect(screen.getByTestId('row-removeSeedPhrase')).toBeInTheDocument();

    mockWalletState.seedPhraseStatus = 'removed';
    view.rerender(<Settings tabSlug={null} />);

    expect(screen.queryByTestId('row-recoveryPhrase')).not.toBeInTheDocument();
    expect(screen.queryByTestId('row-removeSeedPhrase')).not.toBeInTheDocument();
  });

  it('renders the settings header and version footer', () => {
    render(<Settings tabSlug={null} />);

    // The root wears the same TabHeader as Activity and Explore — a plain
    // heading, not the sub-page PageHeader.
    expect(screen.getByRole('heading', { level: 1, name: 'settings' })).toBeInTheDocument();
    expect(screen.queryByTestId('nav-header')).toBeNull();
    expect(screen.getByText('settingsVersion')).toBeInTheDocument();
  });

  it('gives the root no back affordance, since it is a tab destination', () => {
    render(<Settings tabSlug={null} />);

    expect(screen.queryByTestId('nav-back')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders all four group headings', () => {
    render(<Settings tabSlug={null} />);

    ['preferences', 'security', 'developer', 'about'].forEach(key => {
      expect(screen.getByRole('heading', { name: key })).toBeInTheDocument();
    });
  });

  it('renders preference / security / developer menu items but hides guardian-only entries', () => {
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('row-generalSettings')).toBeInTheDocument();
    expect(screen.getByTestId('row-addressBook')).toBeInTheDocument();
    expect(screen.getByTestId('row-language')).toBeInTheDocument();
    expect(screen.getByTestId('row-recoveryPhrase')).toBeInTheDocument();
    expect(screen.getByTestId('row-keys')).toBeInTheDocument();
    expect(screen.getByTestId('row-encryptedWalletFile')).toBeInTheDocument();
    expect(screen.getByTestId('row-advancedSettings')).toBeInTheDocument();
    expect(screen.getByTestId('row-authorizedDApps')).toBeInTheDocument();

    // Guardian-gated entry absent for a non-guardian account.
    expect(screen.queryByTestId('row-guardianSettings')).not.toBeInTheDocument();
  });

  it('draws each group as a section label over a fill group whose rows all show a chevron', () => {
    render(<Settings tabSlug={null} />);

    // Settings' group headers are the `lg` SectionHeader variant, not the plain
    // 13px muted list-group label: 18px Nunito extrabold `ink`.
    const heading = screen.getByRole('heading', { level: 2, name: 'preferences' });
    expect(heading).toHaveClass('text-ink', 'text-lg', 'font-extrabold', 'font-heading');
    const row = screen.getByTestId('row-generalSettings');
    expect(row.parentElement).toHaveClass('bg-fill', 'rounded-2xl');
    screen.getAllByTestId(/^row-/).forEach(r => expect(r).toHaveAttribute('data-chevron', 'true'));
  });

  it('shows each group header with its coloured glyph in a 32px circle', () => {
    render(<Settings tabSlug={null} />);

    ['preferences', 'security', 'developer', 'about'].forEach(key => {
      const heading = screen.getByRole('heading', { level: 2, name: key });
      // The icon circle is `heading`'s sibling, both under the icon+label wrapper.
      const glyphCircle = heading.previousElementSibling;
      expect(glyphCircle).toHaveAttribute('aria-hidden', 'true');
      expect(glyphCircle).toHaveClass('h-8', 'w-8', 'rounded-full', 'bg-fill');
      expect(glyphCircle?.querySelector('svg')).toBeInTheDocument();
    });
  });

  it('passes the per-item testID through to menu items', () => {
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('row-generalSettings')).toHaveAttribute('data-selector', 'Settings/GeneralButton');
  });

  it('links each preference menu item to its routed settings page', () => {
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('row-generalSettings')).toHaveAttribute('data-slug', '/settings/general-settings');
    expect(screen.getByTestId('row-addressBook')).toHaveAttribute('data-slug', '/settings/address-book');
    expect(screen.getByTestId('row-language')).toHaveAttribute('data-slug', '/settings/language');
    expect(screen.getByTestId('row-keys')).toHaveAttribute('data-slug', '/settings/keys');
    expect(screen.getByTestId('row-encryptedWalletFile')).toHaveAttribute(
      'data-slug',
      '/settings/encrypted-wallet-file'
    );
    expect(screen.getByTestId('row-advancedSettings')).toHaveAttribute('data-slug', '/settings/advanced-settings');
    // Distinct slug: '/settings/dapps' belongs to the connected-dApps list page.
    expect(screen.getByTestId('row-authorizedDApps')).toHaveAttribute('data-slug', '/settings/dapp-settings');
  });

  it('renders the encrypted wallet export flow on its routed settings page', () => {
    render(<Settings tabSlug="encrypted-wallet-file" />);

    expect(screen.getByTestId('encrypted-file-flow')).toBeInTheDocument();
  });

  it('renders the about group as external links with the canonical URLs and no testID', () => {
    render(<Settings tabSlug={null} />);

    const privacy = screen.getByTestId('row-privacyPolicy');
    const tos = screen.getByTestId('row-termsOfService');

    expect(privacy).toHaveAttribute('data-external', 'true');
    // Literals, not the imported constants: comparing production against the same
    // binding it reads holds for any value either of them takes, so an accidental
    // edit to `app/constants` would sail through. The "Send feedback" row in the
    // next test already pins its URL this way.
    expect(privacy).toHaveAttribute('data-slug', 'https://0xmiden.github.io/wallet/privacy/');
    // Passed through as undefined rather than coerced to '': Link tracks a
    // ButtonPress for any testID that is merely `!== undefined`, so the empty
    // string bought an analytics event with no name.
    expect(privacy).not.toHaveAttribute('data-selector');

    expect(tos).toHaveAttribute('data-external', 'true');
    // Deliberately pinning a KNOWN BUG, so that it is a bug this test describes
    // rather than one it endorses: `TERMS_OF_USE_URL` in app/constants is set to
    // the same string as `PRIVACY_POLICY_URL`, so the Terms of Service row links
    // to the privacy policy. Whoever gives Terms its own URL should change the
    // expectation on the next line to it and delete this comment — the red build
    // is a reminder, not a verdict on the fix.
    expect(tos).toHaveAttribute('data-slug', 'https://0xmiden.github.io/wallet/privacy/');
  });

  it('renders a discoverable "Support" row in the about group as a button (no route, keyboard-accessible)', () => {
    render(<Settings tabSlug={null} />);

    const support = screen.getByTestId('row-support');
    expect(support).toBeInTheDocument();
    expect(support).toHaveAttribute('data-selector', 'Settings/SupportButton');
    // Not an external anchor and no route → the real ListRow renders a
    // focusable <button>.
    expect(support).toHaveAttribute('data-external', 'false');
    expect(support).toHaveAttribute('data-slug', 'undefined');
  });

  it('opens the support site via the external browser (native webview on mobile / new tab on desktop) when clicked', () => {
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('row-support'));

    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith({
      url: 'https://support.miden.xyz/',
      // Translated via t('support'), unlike FEEDBACK_URL's hard-coded English
      // title — the i18n mock above returns the key itself.
      title: 'support'
    });
  });

  it('fires exactly one haptic when the Support row is tapped', () => {
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('row-support'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
  });

  it('renders a discoverable "Send feedback" row in the about group as a button (no route, keyboard-accessible)', () => {
    render(<Settings tabSlug={null} />);

    const feedback = screen.getByTestId('row-sendFeedback');
    expect(feedback).toBeInTheDocument();
    expect(feedback).toHaveAttribute('data-selector', 'Settings/SendFeedbackButton');
    // Not an external anchor and no route → the real ListRow renders a
    // focusable <button>.
    expect(feedback).toHaveAttribute('data-external', 'false');
    expect(feedback).toHaveAttribute('data-slug', 'undefined');
  });

  it('opens the feedback form via the external browser (native webview on mobile / new tab on desktop) when clicked', () => {
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('row-sendFeedback'));

    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith({
      url: 'https://miden-feedback-form.miden-feedback-relay.workers.dev/',
      title: 'Send feedback'
    });
  });

  it('shows the resolved language label on the language item (known locale)', () => {
    mockGetCurrentLocale.mockReturnValue('en-US');
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('row-language')).toHaveAttribute('data-righttext', 'English');
  });

  it('falls back to the raw base locale when there is no label mapping', () => {
    mockGetCurrentLocale.mockReturnValue('xx-YY');
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('row-language')).toHaveAttribute('data-righttext', 'xx');
  });

  it('keeps the header out of the scroll region so the only back affordance stays reachable', () => {
    render(<Settings tabSlug="language" />);

    const header = screen.getByTestId('nav-header');
    const scroller = document.querySelector('.overflow-y-auto');
    // Language and Address Book overflow the popup; a header inside the scroller
    // scrolls away with them, and these pages have no other way back.
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(header)).toBe(false);
  });

  it('gives each page its own scroll container so offsets do not carry across', () => {
    const { rerender } = render(<Settings tabSlug={null} />);
    const listScroller = document.querySelector('.overflow-y-auto');

    rerender(<Settings tabSlug="language" />);

    // Same route, so React would otherwise reconcile one container and keep its
    // scrollTop: the sub-page opened at the list's offset and vice versa.
    expect(document.querySelector('.overflow-y-auto')).not.toBe(listScroller);
  });

  it('restores the list scroll position when the user comes back from a sub-page', () => {
    const rootScrollTop = { current: 0 };
    const { unmount } = render(<Settings tabSlug={null} rootScrollTop={rootScrollTop} />);
    const listScroller = document.querySelector<HTMLElement>('.overflow-y-auto');
    if (!listScroller) throw new Error('List scroller did not render');

    listScroller.scrollTop = 420;
    fireEvent.scroll(listScroller);

    // Root and sub-pages use different layouts, so Settings itself remounts.
    unmount();
    const subpage = render(<Settings tabSlug="language" />);
    expect(document.querySelector<HTMLElement>('.overflow-y-auto')!.scrollTop).toBe(0);
    subpage.unmount();
    render(<Settings tabSlug={null} rootScrollTop={rootScrollTop} />);

    // The key that gives each page its own scroller is also what loses the list's
    // place: returning built a fresh one at the top, so a user who opened Language
    // from the bottom of a long list came back to the top. The drawers this
    // replaced kept the list mounted underneath.
    expect(document.querySelector<HTMLElement>('.overflow-y-auto')!.scrollTop).toBe(420);
  });

  it('does not carry the list offset into the sub-page it opens', () => {
    const { rerender } = render(<Settings tabSlug={null} />);
    const listScroller = document.querySelector<HTMLElement>('.overflow-y-auto');
    listScroller!.scrollTop = 420;
    fireEvent.scroll(listScroller!);

    rerender(<Settings tabSlug="language" />);

    // The restore is for the root only — a sub-page still opens at its top.
    expect(document.querySelector<HTMLElement>('.overflow-y-auto')!.scrollTop).toBe(0);
  });

  it('takes focus to the sub-page title, which a route change does not announce', () => {
    render(<Settings tabSlug="language" />);

    // As drawers these were dialogs and took focus on open; as routes nothing
    // moves focus and the row that opened them is gone, so it lands on <body>.
    expect(screen.getByTestId('nav-header')).toHaveAttribute('data-focus-title', 'true');
  });

  it('keeps the display face on the sub-page body', () => {
    // Removing this class was once used to get Inter into RevealSecret's secret
    // textareas — Preflight sets `font: inherit` on form controls, so they were
    // picking up the display face. That fix restyled all twelve routed Settings
    // screens to fix two fields; the textareas ask for `font-sans` themselves.
    const { container } = render(<Settings tabSlug="general-settings" />);

    expect(container.querySelector('.font-heading')).not.toBeNull();
  });

  // Both platforms, because the previous shape of this had to special-case them:
  // the flag was a predicate purely so it could return false on mobile.
  // `reveal-hot-key` takes the same code path but is `guardianOnly`, so it is not
  // routable from this non-guardian fixture.
  it.each([[false], [true]])('announces reveal-private-key on mobile=%s without guessing', mobile => {
    // These pages no longer declare `ownsInitialFocus`. RevealSecret focuses its
    // password box in a passive effect, which runs after the title focus and so
    // takes the caret on its own — and when there is no box to focus, the title
    // focus stands. That second case is why the host must not guess: RevealSecret
    // renders no password input at all when a hardware protector is present, so
    // suppressing the title focus there left these two recovery-material screens
    // with focus on <body> and nothing announced.
    mockIsMobile = mobile;
    render(<Settings tabSlug="reveal-private-key" />);

    expect(screen.getByTestId('nav-header')).toHaveAttribute('data-focus-title', 'true');
  });

  it('still yields on the faucet-id page, which focuses its field on every platform', () => {
    mockIsMobile = true;
    render(<Settings tabSlug="edit-miden-faucet-id" />);

    expect(screen.getByTestId('nav-header')).toHaveAttribute('data-focus-title', 'false');
  });

  it('leaves focus alone on the settings list itself', () => {
    render(<Settings tabSlug={null} />);

    // Arriving from the wallet home, not from within Settings — stealing focus
    // here would fight the navigation the user already made. The root's
    // TabHeader has no focus-on-mount behaviour at all, so there is nothing to
    // steal it.
    expect(screen.queryByTestId('nav-header')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('re-announces on a sibling-to-sibling move, where only the title changes', () => {
    const { rerender } = render(<Settings tabSlug="language" />);
    const first = screen.getByTestId('nav-header');

    rerender(<Settings tabSlug="general-settings" />);

    // Keyed on the slug so the header remounts and its focus effect re-runs;
    // reconciling one header would announce the first page's name only.
    expect(screen.getByTestId('nav-header')).not.toBe(first);
    expect(screen.getByTestId('nav-title')).toHaveTextContent('generalSettings');
  });

  // The root's back-to-home chevron is gone: Settings is a bottom-nav
  // destination, and tab roots don't carry one (see the tab-destination test
  // in the root-menu block above). Sub-page back behaviour is unchanged and
  // still covered below.

  it('renders a preference slug as a full-screen page under a navigation header', () => {
    render(<Settings tabSlug="general-settings" />);

    expect(screen.getByTestId('nav-title')).toHaveTextContent('generalSettings');
    expect(screen.getByTestId('general-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('row-generalSettings')).not.toBeInTheDocument();
  });

  it('replaces an unknown slug with the Settings root route so the footer is restored', () => {
    render(<Settings tabSlug="does-not-exist" />);

    expect(mockNavigate).toHaveBeenCalledWith('/settings', 'replace');
    expect(screen.queryByTestId('row-generalSettings')).not.toBeInTheDocument();
  });
});

describe('Settings page — guardian account', () => {
  it('links the guardian settings entry to its routed page', () => {
    setAccount({ type: 'guardian' });
    render(<Settings tabSlug={null} />);

    const row = screen.getByTestId('row-guardianSettings');
    // Was a drawer opened by an onClick; now a route, so it has to carry a slug
    // (and a selector, without which the ButtonPress fires unnamed).
    expect(row).toHaveAttribute('data-slug', '/settings/guardian-settings');
    expect(row).toHaveAttribute('data-selector', 'Settings/GuardianSettingsButton');
    expect(row).toHaveAttribute('data-external', 'false');
  });

  it('shows the guardian settings entry for guardian accounts', () => {
    setAccount({ type: 'guardian' });
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('row-guardianSettings')).toBeInTheDocument();
  });

  it('titles the guardian settings page the same as the row that opens it', () => {
    setAccount({ type: 'guardian' });
    render(<Settings tabSlug="guardian-settings" />);

    // Not 'rotateGuardian'. That came over from the drawer title, where it named a
    // task sheet; as a routed page the <h1> is the page's identity, and this page
    // is the Guardian overview with Rotate as its CTA. `focusTitleOnMount` reads it
    // aloud, so tapping "Guardian Settings" announced "Rotate Guardian".
    expect(screen.getByTestId('nav-title')).toHaveTextContent('guardianSettings');
    expect(screen.getByTestId('guardian-settings-body')).toBeInTheDocument();
  });

  it('does not expose the guardian settings page to non-guardian accounts', () => {
    setAccount({ type: 'on-chain' });
    render(<Settings tabSlug="guardian-settings" />);

    // Redirect out of the full-screen layout to the root's tab layout.
    expect(screen.queryByTestId('guardian-settings-body')).not.toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledWith('/settings', 'replace');
  });
});

describe('Settings page — recovery phrase row', () => {
  // The row used to open a warning overlay on the Settings root, which is a tab
  // page, so the tab bar covered the overlay's Close and View. It now routes to
  // its full-screen sub-page like every other row, and the warning is that
  // page's first step (RevealSeedPhrase).
  it('routes to /settings/reveal-seed-phrase like every other row', () => {
    render(<Settings tabSlug={null} />);

    const row = screen.getByTestId('row-recoveryPhrase');
    expect(row).toHaveAttribute('data-slug', '/settings/reveal-seed-phrase');
    expect(row).toHaveAttribute('data-selector', 'Settings/RevealSeedPhraseButton');
  });

  it('renders no overlay on the Settings root when the row is tapped, with a single haptic', () => {
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('row-recoveryPhrase'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('viewThisInPrivatePlace')).not.toBeInTheDocument();
    expect(screen.queryByText('pleaseWriteDownRecoveryPhrase')).not.toBeInTheDocument();
    expect(screen.queryByTestId('btn-view')).not.toBeInTheDocument();
    // Still the root menu: nothing replaced it.
    expect(screen.getByTestId('row-generalSettings')).toBeInTheDocument();
  });
});

describe('Settings page — active tab routing', () => {
  it('renders a hasOwnLayout tab without a navigation header', () => {
    render(<Settings tabSlug="reveal-seed-phrase" />);

    expect(screen.getByTestId('reveal-seed-flow')).toBeInTheDocument();
    // Own-layout pages render neither the header nor the root menu.
    expect(screen.queryByTestId('nav-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('row-generalSettings')).not.toBeInTheDocument();
  });

  it('renders a standard tab with a navigation header wired to goBack', () => {
    render(<Settings tabSlug="networks" />);

    expect(screen.getByTestId('nav-title')).toHaveTextContent('networks');
    expect(screen.getByTestId('networks-settings')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('hands a SubPageLayout page its title, back and focus from the route', () => {
    render(<Settings tabSlug="keys" />);

    const page = screen.getByTestId('keys-settings');
    // One header, the page's own: the host renders none of its own around it.
    expect(screen.getAllByTestId('nav-header')).toHaveLength(1);
    expect(page).toContainElement(screen.getByTestId('nav-header'));
    expect(screen.getByTestId('nav-title')).toHaveTextContent('keys');
    expect(screen.getByTestId('nav-header')).toHaveAttribute('data-focus-title', 'true');
    // The layout's body is the only scroller; the host adds no padded wrapper.
    expect(page.querySelector('[data-slot="body"]')).toHaveClass('overflow-y-auto', 'px-4');
    expect(document.querySelectorAll('.overflow-y-auto')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('nav-back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('remounts a SubPageLayout page, header and all, on a sibling move', () => {
    const { rerender } = render(<Settings tabSlug="keys" />);
    const first = screen.getByTestId('nav-header');

    rerender(<Settings tabSlug="general-settings" />);
    rerender(<Settings tabSlug="keys" />);

    expect(screen.getByTestId('nav-header')).not.toBe(first);
  });

  it('sends back to the settings root, replacing, when a sub-page was opened cold', () => {
    // A deep link or a reload lands on the sub-page at the first history entry,
    // where goBack() is a no-op — the chevron has to route instead, and replace so
    // forward does not walk back into the page just left.
    mockHistoryPosition = 0;
    render(<Settings tabSlug="networks" />);

    fireEvent.click(screen.getByTestId('nav-back'));

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/settings', 'replace');
  });

  it('renders the edit-miden-faucet-id tab', () => {
    render(<Settings tabSlug="edit-miden-faucet-id" />);

    expect(screen.getByTestId('edit-faucet')).toBeInTheDocument();
  });

  it('resolves the hidden dapps slug to the connected-dApps list page', () => {
    render(<Settings tabSlug="dapps" />);

    expect(screen.getByTestId('dapp-settings')).toBeInTheDocument();
  });

  it('resolves the dapp-settings slug to the dApps toggle page', () => {
    render(<Settings tabSlug="dapp-settings" />);

    expect(screen.getByTestId('nav-title')).toHaveTextContent('authorizedDApps');
    expect(screen.getByTestId('dapp-drawer-settings')).toBeInTheDocument();
  });

  it('routes to an external "about" tab (renders its empty Component under a header)', () => {
    render(<Settings tabSlug={PRIVACY_POLICY_URL} />);

    // Every tab's slug resolves to an active tab now, external ones included
    // whose Component renders nothing under the navigation header.
    expect(screen.getByTestId('nav-title')).toHaveTextContent('privacyPolicy');
    expect(screen.queryByTestId('row-generalSettings')).not.toBeInTheDocument();
  });

  it('reveals the private key for a non-guardian account', () => {
    setAccount({ type: 'on-chain' });
    render(<Settings tabSlug="reveal-private-key" />);

    expect(screen.getByTestId('reveal-secret')).toHaveTextContent('private-key');
  });

  it('reveals the guardian keys for a guardian account', () => {
    setAccount({ type: 'guardian' });
    render(<Settings tabSlug="reveal-private-key" />);

    expect(screen.getByTestId('reveal-secret')).toHaveTextContent('guardian-keys');
  });

  it('reveals the hot key for a guardian with an activated hot key', () => {
    setAccount({ type: 'guardian', hotPublicKey: '0xhotkey' });
    render(<Settings tabSlug="reveal-hot-key" />);

    expect(screen.getByTestId('reveal-secret')).toHaveTextContent('hot-key');
  });

  it('does not expose the hot key page for a guardian without an activated hot key', () => {
    setAccount({ type: 'guardian' });
    render(<Settings tabSlug="reveal-hot-key" />);

    expect(screen.queryByTestId('reveal-secret')).not.toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledWith('/settings', 'replace');
  });

  it('does not expose the hot key page for a non-guardian account', () => {
    setAccount({ type: 'on-chain', hotPublicKey: '0xhotkey' });
    render(<Settings tabSlug="reveal-hot-key" />);

    expect(screen.queryByTestId('reveal-secret')).not.toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledWith('/settings', 'replace');
  });
});

describe('Settings page — developer endpoints row', () => {
  it('stays hidden once the override-active check resolves false (default)', async () => {
    render(<Settings tabSlug={null} />);

    await waitFor(() => expect(mockIsEndpointOverrideActive).toHaveBeenCalled());
    expect(screen.queryByTestId('row-devEndpointsRow')).not.toBeInTheDocument();
  });

  it('appears in the developer group, linked to /settings/network-endpoints, once an override is active', async () => {
    mockShowDevEndpoints.value = true;
    render(<Settings tabSlug={null} />);

    const row = await screen.findByTestId('row-devEndpointsRow');
    expect(row).toHaveAttribute('data-slug', '/settings/network-endpoints');
  });
});

describe('Settings page — mobile body attribute effects', () => {
  it('marks the body edge-to-edge on the root view and clears it on unmount', () => {
    mockIsMobile = true;
    const { unmount } = render(<Settings tabSlug={null} />);

    expect(document.body.hasAttribute('data-edge-to-edge')).toBe(true);
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);

    unmount();
    expect(document.body.hasAttribute('data-edge-to-edge')).toBe(false);
  });

  it('does not mark the body edge-to-edge when an active tab is open', () => {
    mockIsMobile = true;
    render(<Settings tabSlug="networks" />);

    expect(document.body.hasAttribute('data-edge-to-edge')).toBe(false);
  });

  it('parks dApp trays on the recovery phrase sub-page and releases them on the way out', () => {
    mockIsMobile = true;
    const { unmount } = render(<Settings tabSlug="reveal-seed-phrase" />);

    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);

    unmount();
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('does not park dApp trays on the root when the recovery phrase row is tapped', () => {
    mockIsMobile = true;
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('row-recoveryPhrase'));

    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('does not touch body attributes on non-mobile platforms', () => {
    mockIsMobile = false;
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('row-recoveryPhrase'));

    expect(document.body.hasAttribute('data-edge-to-edge')).toBe(false);
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('parks dApp trays for the whole time a sub-page is open, and releases them on the way out', () => {
    // A sub-page pins its primary action to the bottom of the viewport, which is
    // exactly where a parked dApp tray floats — so the flag has to be held for
    // the whole sub-page.
    mockIsMobile = true;
    const { unmount } = render(<Settings tabSlug="keys" />);

    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);

    unmount();
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('leaves the tray flag alone on a sub-page when the platform is not mobile', () => {
    mockIsMobile = false;
    render(<Settings tabSlug="keys" />);

    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });
});

// NOTE ON UNREACHABLE CODE (intentionally uncovered, no source change made):
//   • The module-level `isDevnet ? …Devnet : …Orange` icon selectors (one per
//     settings icon) are decided once from the build-time DEFAULT_NETWORK
//     constant, so only one side is reachable within a single test process.
//   • `Component: () => null` on the Terms-of-Service tab is dead because
//     TERMS_OF_USE_URL currently equals PRIVACY_POLICY_URL, so the tab lookup
//     always resolves the Privacy tab first.
//   Covering these would require changing the source, which the task forbids.

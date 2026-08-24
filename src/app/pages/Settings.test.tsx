import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { getCurrentLocale } from 'lib/i18n/core';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { goBack, navigate } from 'lib/woozie';

import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '../constants';
// Import the component under test AFTER the mocks are declared.
import Settings from './Settings';

// ---------------------------------------------------------------------------
// Mutable state used by the store / platform / motion mocks. Names are
// `mock`-prefixed so jest allows them inside the (hoisted) mock factories.
// ---------------------------------------------------------------------------
type MockAccount = { type?: string; hotPublicKey?: string } | undefined;
const mockWalletState: { currentAccount: MockAccount } = { currentAccount: { type: 'on-chain' } };
let mockIsMobile = false;
let mockHistoryPosition = 1;
let mockReduceMotion: boolean | null = false;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// framer-motion: AnimatePresence renders children; every `motion.X` becomes a
// plain wrapper that drops the animation props and just renders children.
jest.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
    }
  ),
  useReducedMotion: () => mockReduceMotion
}));

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
  // Read by useBackWithFallback, which decides whether the sub-page header's
  // back chevron pops history or falls back to the settings root.
  useLocation: jest.fn(() => ({ historyPosition: mockHistoryPosition }))
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

jest.mock('components/NavigationHeader', () => ({
  NavigationHeader: ({
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

// MenuItem stub surfaces every prop the page wires up so we can assert routing
// intent (slug), external-link flag, per-item testID, right-hand label and the
// click handler.
jest.mock('app/templates/MenuItem', () => ({
  __esModule: true,
  default: ({
    slug,
    titleI18nKey,
    testID,
    linksOutsideOfWallet,
    rightText,
    onClick
  }: {
    slug?: string;
    titleI18nKey: string;
    testID?: string;
    linksOutsideOfWallet?: boolean;
    rightText?: string;
    onClick?: () => void;
  }) => (
    <button
      type="button"
      data-testid={`menuitem-${titleI18nKey}`}
      data-selector={testID}
      data-slug={slug === undefined ? 'undefined' : String(slug)}
      data-external={String(!!linksOutsideOfWallet)}
      data-righttext={rightText === undefined ? 'undefined' : String(rightText)}
      // The real MenuItem produces exactly one hapticLight per tap on every
      // branch: the external anchor and the <button> call it directly, and the
      // routed <Link> gets one from woozie's Link (Link.tsx). MenuItem's own unit
      // test mocks Link and so sees none on that branch — don't take that as the
      // product behaviour. The mock has to buzz, or a caller adding its own —
      // which the recovery-phrase row did, buzzing twice — is invisible here.
      onClick={() => {
        hapticLight();
        onClick?.();
      }}
    >
      {titleI18nKey}
    </button>
  )
}));

// Every settings template renders as an inert stub.
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
  default: () => <div data-testid="guardian-settings-body" />
}));
jest.mock('app/templates/KeysSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="keys-settings" />
}));
jest.mock('app/templates/LanguageSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="language-settings" />
}));
jest.mock('app/templates/RevealSecret', () => ({
  __esModule: true,
  default: ({ reveal }: { reveal: string }) => <div data-testid="reveal-secret">{reveal}</div>
}));
jest.mock('app/templates/RevealSeedPhrase', () => ({
  __esModule: true,
  default: () => <div data-testid="reveal-seed-flow" />
}));
jest.mock('app/templates/VerifySeedPhraseFlow', () => ({
  __esModule: true,
  default: () => <div data-testid="verify-seed-flow" />
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
const mockHapticMedium = hapticMedium as jest.Mock;
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
  it('renders the settings header and version footer', () => {
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('nav-title')).toHaveTextContent('settings');
    expect(screen.getByText('settingsVersion')).toBeInTheDocument();
  });

  it('renders all four group headings', () => {
    render(<Settings tabSlug={null} />);

    ['preferences', 'security', 'developer', 'about'].forEach(key => {
      expect(screen.getByRole('heading', { name: key })).toBeInTheDocument();
    });
  });

  it('renders preference / security / developer menu items but hides guardian-only entries', () => {
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('menuitem-generalSettings')).toBeInTheDocument();
    expect(screen.getByTestId('menuitem-addressBook')).toBeInTheDocument();
    expect(screen.getByTestId('menuitem-language')).toBeInTheDocument();
    expect(screen.getByTestId('menuitem-recoveryPhrase')).toBeInTheDocument();
    expect(screen.getByTestId('menuitem-keys')).toBeInTheDocument();
    expect(screen.getByTestId('menuitem-advancedSettings')).toBeInTheDocument();
    expect(screen.getByTestId('menuitem-authorizedDApps')).toBeInTheDocument();

    // Guardian-gated entry absent for a non-guardian account.
    expect(screen.queryByTestId('menuitem-guardianSettings')).not.toBeInTheDocument();
  });

  it('passes the per-item testID through to menu items', () => {
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('menuitem-generalSettings')).toHaveAttribute('data-selector', 'Settings/GeneralButton');
  });

  it('links each preference menu item to its routed settings page', () => {
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('menuitem-generalSettings')).toHaveAttribute('data-slug', '/settings/general-settings');
    expect(screen.getByTestId('menuitem-addressBook')).toHaveAttribute('data-slug', '/settings/address-book');
    expect(screen.getByTestId('menuitem-language')).toHaveAttribute('data-slug', '/settings/language');
    expect(screen.getByTestId('menuitem-keys')).toHaveAttribute('data-slug', '/settings/keys');
    expect(screen.getByTestId('menuitem-advancedSettings')).toHaveAttribute('data-slug', '/settings/advanced-settings');
    // Distinct slug: '/settings/dapps' belongs to the connected-dApps list page.
    expect(screen.getByTestId('menuitem-authorizedDApps')).toHaveAttribute('data-slug', '/settings/dapp-settings');
  });

  it('renders the about group as external links with the canonical URLs and no testID', () => {
    render(<Settings tabSlug={null} />);

    const privacy = screen.getByTestId('menuitem-privacyPolicy');
    const tos = screen.getByTestId('menuitem-termsOfService');

    expect(privacy).toHaveAttribute('data-external', 'true');
    expect(privacy).toHaveAttribute('data-slug', PRIVACY_POLICY_URL);
    // Passed through as undefined rather than coerced to '': Link tracks a
    // ButtonPress for any testID that is merely `!== undefined`, so the empty
    // string bought an analytics event with no name.
    expect(privacy).not.toHaveAttribute('data-selector');

    expect(tos).toHaveAttribute('data-external', 'true');
    expect(tos).toHaveAttribute('data-slug', TERMS_OF_USE_URL);
  });

  it('renders a discoverable "Send feedback" row in the about group as a button (no route, keyboard-accessible)', () => {
    render(<Settings tabSlug={null} />);

    const feedback = screen.getByTestId('menuitem-sendFeedback');
    expect(feedback).toBeInTheDocument();
    expect(feedback).toHaveAttribute('data-selector', 'Settings/SendFeedbackButton');
    // Not an external anchor and no route slug → the real MenuItem takes the
    // `onClick && !slug` branch and renders a focusable <button>.
    expect(feedback).toHaveAttribute('data-external', 'false');
    expect(feedback).toHaveAttribute('data-slug', 'undefined');
  });

  it('opens the feedback form via the external browser (native webview on mobile / new tab on desktop) when clicked', () => {
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('menuitem-sendFeedback'));

    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith({
      url: 'https://miden-feedback-form.miden-feedback-relay.workers.dev/',
      title: 'Send feedback'
    });
  });

  it('shows the resolved language label on the language item (known locale)', () => {
    mockGetCurrentLocale.mockReturnValue('en-US');
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('menuitem-language')).toHaveAttribute('data-righttext', 'English');
  });

  it('falls back to the raw base locale when there is no label mapping', () => {
    mockGetCurrentLocale.mockReturnValue('xx-YY');
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('menuitem-language')).toHaveAttribute('data-righttext', 'xx');
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

  it('takes focus to the sub-page title, which a route change does not announce', () => {
    render(<Settings tabSlug="language" />);

    // As drawers these were dialogs and took focus on open; as routes nothing
    // moves focus and the row that opened them is gone, so it lands on <body>.
    expect(screen.getByTestId('nav-header')).toHaveAttribute('data-focus-title', 'true');
  });

  it('yields to a sub-page that focuses its own field', () => {
    render(<Settings tabSlug="reveal-private-key" />);

    // RevealSecret puts the caret in the password box in a useLayoutEffect;
    // the host's title focus is a plain useEffect and so runs after it, which
    // would pull focus straight back out of the field.
    expect(screen.getByTestId('nav-header')).toHaveAttribute('data-focus-title', 'false');
  });

  it('leaves focus alone on the settings list itself', () => {
    render(<Settings tabSlug={null} />);

    // Arriving from the wallet home, not from within Settings — stealing focus
    // here would fight the navigation the user already made.
    expect(screen.getByTestId('nav-header')).toHaveAttribute('data-focus-title', 'false');
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

  it('navigates home when the root header back button is pressed', () => {
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('nav-back'));

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('renders a preference slug as a full-screen page under a navigation header', () => {
    render(<Settings tabSlug="general-settings" />);

    expect(screen.getByTestId('nav-title')).toHaveTextContent('generalSettings');
    expect(screen.getByTestId('general-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('menuitem-generalSettings')).not.toBeInTheDocument();
  });

  it('renders the root menu for an unknown slug', () => {
    render(<Settings tabSlug="does-not-exist" />);

    expect(screen.getByTestId('menuitem-generalSettings')).toBeInTheDocument();
  });
});

describe('Settings page — guardian account', () => {
  it('links the guardian settings entry to its routed page', () => {
    setAccount({ type: 'guardian' });
    render(<Settings tabSlug={null} />);

    const row = screen.getByTestId('menuitem-guardianSettings');
    // Was a drawer opened by an onClick; now a route, so it has to carry a slug
    // (and a selector, without which the ButtonPress fires unnamed).
    expect(row).toHaveAttribute('data-slug', '/settings/guardian-settings');
    expect(row).toHaveAttribute('data-selector', 'Settings/GuardianSettingsButton');
    expect(row).toHaveAttribute('data-external', 'false');
  });

  it('shows the guardian settings entry for guardian accounts', () => {
    setAccount({ type: 'guardian' });
    render(<Settings tabSlug={null} />);

    expect(screen.getByTestId('menuitem-guardianSettings')).toBeInTheDocument();
  });

  it('renders the guardian settings page with the rotation title for guardian accounts', () => {
    setAccount({ type: 'guardian' });
    render(<Settings tabSlug="guardian-settings" />);

    expect(screen.getByTestId('nav-title')).toHaveTextContent('rotateGuardian');
    expect(screen.getByTestId('guardian-settings-body')).toBeInTheDocument();
  });

  it('does not expose the guardian settings page to non-guardian accounts', () => {
    setAccount({ type: 'on-chain' });
    render(<Settings tabSlug="guardian-settings" />);

    // Tab is filtered out → falls back to the root menu.
    expect(screen.queryByTestId('guardian-settings-body')).not.toBeInTheDocument();
    expect(screen.getByTestId('menuitem-generalSettings')).toBeInTheDocument();
  });
});

describe('Settings page — seed phrase warning overlay', () => {
  it('shows the warning overlay when the recovery phrase item is clicked', () => {
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('menuitem-recoveryPhrase'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(screen.getByText('viewThisInPrivatePlace')).toBeInTheDocument();
    expect(screen.getByText('pleaseWriteDownRecoveryPhrase')).toBeInTheDocument();
  });

  // Each of these taps must produce exactly ONE buzz, from Button. The handlers
  // used to add their own on top, so Close buzzed twice and View fired a medium
  // and a light together.
  it('closes the overlay via the Close button with a single haptic and no navigation', () => {
    render(<Settings tabSlug={null} />);
    fireEvent.click(screen.getByTestId('menuitem-recoveryPhrase'));

    fireEvent.click(screen.getByTestId('btn-close'));

    expect(mockHapticLight).toHaveBeenCalledTimes(2); // one for the row, one for Close
    expect(mockHapticMedium).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText('viewThisInPrivatePlace')).not.toBeInTheDocument();
  });

  it('navigates to reveal-seed-phrase via the View button with a single haptic', () => {
    render(<Settings tabSlug={null} />);
    fireEvent.click(screen.getByTestId('menuitem-recoveryPhrase'));

    fireEvent.click(screen.getByTestId('btn-view'));

    expect(mockHapticLight).toHaveBeenCalledTimes(2); // one for the row, one for View
    expect(mockHapticMedium).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/settings/reveal-seed-phrase');
    expect(screen.queryByText('viewThisInPrivatePlace')).not.toBeInTheDocument();
  });

  it('still renders the overlay when reduced motion is requested', () => {
    mockReduceMotion = true;
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('menuitem-recoveryPhrase'));

    expect(screen.getByText('viewThisInPrivatePlace')).toBeInTheDocument();
  });
});

describe('Settings page — active tab routing', () => {
  it('renders a hasOwnLayout tab without a navigation header', () => {
    render(<Settings tabSlug="reveal-seed-phrase" />);

    expect(screen.getByTestId('reveal-seed-flow')).toBeInTheDocument();
    // Own-layout pages render neither the header nor the root menu.
    expect(screen.queryByTestId('nav-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('menuitem-generalSettings')).not.toBeInTheDocument();
  });

  it('renders a standard tab with a navigation header wired to goBack', () => {
    render(<Settings tabSlug="networks" />);

    expect(screen.getByTestId('nav-title')).toHaveTextContent('networks');
    expect(screen.getByTestId('networks-settings')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
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
    expect(screen.queryByTestId('menuitem-generalSettings')).not.toBeInTheDocument();
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

    // Tab is filtered out → falls back to the root menu.
    expect(screen.queryByTestId('reveal-secret')).not.toBeInTheDocument();
    expect(screen.getByTestId('menuitem-generalSettings')).toBeInTheDocument();
  });

  it('does not expose the hot key page for a non-guardian account', () => {
    setAccount({ type: 'on-chain', hotPublicKey: '0xhotkey' });
    render(<Settings tabSlug="reveal-hot-key" />);

    expect(screen.queryByTestId('reveal-secret')).not.toBeInTheDocument();
    expect(screen.getByTestId('menuitem-generalSettings')).toBeInTheDocument();
  });
});

describe('Settings page — developer endpoints row', () => {
  it('stays hidden once the override-active check resolves false (default)', async () => {
    render(<Settings tabSlug={null} />);

    await waitFor(() => expect(mockIsEndpointOverrideActive).toHaveBeenCalled());
    expect(screen.queryByTestId('menuitem-devEndpointsRow')).not.toBeInTheDocument();
  });

  it('appears in the developer group, linked to /settings/network-endpoints, once an override is active', async () => {
    mockShowDevEndpoints.value = true;
    render(<Settings tabSlug={null} />);

    const row = await screen.findByTestId('menuitem-devEndpointsRow');
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

  it('clears data-drawer-open when unmounted while the seed warning is open', () => {
    mockIsMobile = true;
    const { unmount } = render(<Settings tabSlug={null} />);

    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);

    fireEvent.click(screen.getByTestId('menuitem-recoveryPhrase'));
    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);

    // Unmounting while the overlay is still open exercises the cleanup path.
    unmount();
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('sets data-drawer-open while the seed warning is open and clears it on close', () => {
    mockIsMobile = true;
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('menuitem-recoveryPhrase'));
    expect(document.body.hasAttribute('data-drawer-open')).toBe(true);

    fireEvent.click(screen.getByTestId('btn-close'));
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('does not touch body attributes on non-mobile platforms', () => {
    mockIsMobile = false;
    render(<Settings tabSlug={null} />);

    fireEvent.click(screen.getByTestId('menuitem-recoveryPhrase'));

    expect(document.body.hasAttribute('data-edge-to-edge')).toBe(false);
    expect(document.body.hasAttribute('data-drawer-open')).toBe(false);
  });

  it('parks dApp trays for the whole time a sub-page is open, and releases them on the way out', () => {
    // A sub-page pins its primary action to the bottom of the viewport, which is
    // exactly where a parked dApp tray floats — so the flag has to be held for
    // the sub-page, not just for the seed-warning overlay.
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

import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import GuardianSettings from './GuardianSettings';

const mockUseCurrentGuardianEndpoint = jest.fn();
const mockGuardianOptionForEndpoint = jest.fn();
jest.mock('app/hooks/useCurrentGuardianEndpoint', () => ({
  useCurrentGuardianEndpoint: () => mockUseCurrentGuardianEndpoint(),
  guardianOptionForEndpoint: (endpoint: string) => mockGuardianOptionForEndpoint(endpoint),
  guardianEndpointHost: (endpoint: string) => (endpoint ? new URL(endpoint).host : '')
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>
}));

// `lastSyncedAt` is fixtured RECENT and non-null on purpose. It is the
// wallet-wide stamp, and the bug this page had was rendering it as the guardian's
// "Last sync" — so with it pinned to `null` no test could tell the two apart:
// the row read "never" whatever the guardian was doing. A fresh value here means
// any regression back to the store field shows up as a relative time next to an
// Offline pill.
const WALLET_SYNCED_AT = 1_700_000_000_000;
jest.mock('lib/store', () => ({
  useWalletStore: (
    selector: (state: { lastSyncedAt: number | null; currentAccount: { publicKey: string } }) => unknown
  ) => selector({ lastSyncedAt: WALLET_SYNCED_AT, currentAccount: { publicKey: 'acc-1' } })
}));

// Guardian sync state: the outage flag the status pill derives Online/Offline
// from, and the guardian-scoped last-sync stamp the Details row reads. Both come
// from the same module and the same subscription, and the mock keeps the real
// module's subscribe/notify shape so a test can flip a value and observe the
// mounted page react — a `() => () => {}` stub could never show the pill moving.
const mockIsGuardianSyncOutage = jest.fn((_pk: string) => false);
const mockGetGuardianLastSyncAt = jest.fn((_pk: string): number | undefined => undefined);
const syncListeners = new Set<() => void>();
const notifySyncListeners = () => {
  for (const listener of syncListeners) listener();
};
jest.mock('lib/miden/front/guardian-sync', () => ({
  isGuardianSyncOutage: (pk: string) => mockIsGuardianSyncOutage(pk),
  getGuardianLastSyncAt: (pk: string) => mockGetGuardianLastSyncAt(pk),
  subscribeGuardianSyncOutage: (listener: () => void) => {
    syncListeners.add(listener);
    return () => syncListeners.delete(listener);
  }
}));

jest.mock('components/Button', () => ({
  // Fires the haptic the real Button fires on every click (Button.tsx). Without it
  // a handler adding its own looked like the only one, which is how the rotate CTA
  // came to buzz twice — the mock counted one call either way.
  Button: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button
      onClick={() => {
        mockHapticLight();
        onClick();
      }}
    >
      {title}
    </button>
  )
}));

const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({ hapticLight: () => mockHapticLight() }));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (path: string) => mockNavigate(path) }));

// GuardianInfoDrawer — the real component renders through vaul portals; a
// passthrough stub exposes its `open` prop so the "Learn more" wiring is testable.
jest.mock('screens/onboarding/common/GuardianInfoDrawer', () => ({
  GuardianInfoDrawer: ({ open }: { open: boolean }) => (
    <div data-testid="guardian-info-drawer" data-open={String(open)} />
  )
}));

beforeEach(() => {
  jest.clearAllMocks();
  syncListeners.clear();
  // clearAllMocks does not undo mockReturnValue, so the outage test's `true`
  // would otherwise leak into every test after it.
  mockIsGuardianSyncOutage.mockReturnValue(false);
  mockGetGuardianLastSyncAt.mockReturnValue(undefined);
  mockUseCurrentGuardianEndpoint.mockReturnValue({ endpoint: 'https://guardian.one', refresh: jest.fn() });
  mockGuardianOptionForEndpoint.mockReturnValue({
    id: 'open-zeppelin',
    name: 'Guardian One',
    operatedBy: 'Provider One',
    location: 'US-EAST'
  });
});

it('renders the configured guardian summary and live details', () => {
  render(<GuardianSettings />);

  expect(mockGuardianOptionForEndpoint).toHaveBeenCalledWith('https://guardian.one');
  expect(screen.getByTestId('guardian-operator-logo')).toBeInTheDocument();
  expect(screen.getByText('Guardian One')).toBeInTheDocument();
  expect(screen.getByText('online')).toBeInTheDocument();
  expect(screen.getByText('guardianInfoDescription')).toBeInTheDocument();
  expect(screen.getByText('Provider One')).toBeInTheDocument();
  expect(screen.getByText('guardian.one')).toBeInTheDocument();
  expect(screen.getByText('US-EAST')).toBeInTheDocument();
  expect(screen.getByText('never')).toBeInTheDocument();
});

it('shows the offline pill while the sync loop reports a guardian outage', () => {
  mockIsGuardianSyncOutage.mockReturnValue(true);
  render(<GuardianSettings />);

  expect(mockIsGuardianSyncOutage).toHaveBeenCalledWith('acc-1');
  expect(screen.getByText('guardianOfflineLabel')).toBeInTheDocument();
  expect(screen.queryByText('online')).not.toBeInTheDocument();
});

it('reads "Last sync" from the guardian, not the wallet-wide sync stamp', () => {
  // An outage with a wallet that is otherwise syncing happily — the exact state
  // that produced "Offline" beside a seconds-old "Last sync". The guardian has
  // never answered this session, so the honest value is "never".
  mockIsGuardianSyncOutage.mockReturnValue(true);
  mockGetGuardianLastSyncAt.mockReturnValue(undefined);
  render(<GuardianSettings />);

  expect(mockGetGuardianLastSyncAt).toHaveBeenCalledWith('acc-1');
  expect(screen.getByText('guardianOfflineLabel')).toBeInTheDocument();
  expect(screen.getByText('never')).toBeInTheDocument();
});

it('renders the guardian last-sync stamp as a relative time once one lands', () => {
  jest.useFakeTimers().setSystemTime(WALLET_SYNCED_AT);
  try {
    mockGetGuardianLastSyncAt.mockReturnValue(WALLET_SYNCED_AT - 120_000);
    render(<GuardianSettings />);

    // Intl.RelativeTimeFormat, narrow style: "2m ago". Matched loosely so a CLDR
    // data change cannot fail this on the unit's abbreviation.
    expect(screen.getByText(/^2\s?m(in\.?)? ago$/)).toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});

it('updates the pill in place when the outage arms under a mounted page', () => {
  render(<GuardianSettings />);
  expect(screen.getByText('online')).toBeInTheDocument();

  // The page subscribes rather than polling, so an outage arming from a
  // background sync tick has to repaint what is already on screen.
  mockIsGuardianSyncOutage.mockReturnValue(true);
  act(() => notifySyncListeners());

  expect(screen.getByText('guardianOfflineLabel')).toBeInTheDocument();
  expect(screen.queryByText('online')).not.toBeInTheDocument();
});

it('announces the status pill as a polite live region', () => {
  render(<GuardianSettings />);

  // Without this the flip above is silent to assistive tech: the pill is the
  // only thing on the page that says the guardian is unreachable.
  const pill = screen.getByRole('status');
  expect(pill).toHaveAttribute('aria-live', 'polite');
  expect(pill).toHaveTextContent('online');
});

it('labels an unmatched endpoint as a custom guardian', () => {
  mockGuardianOptionForEndpoint.mockReturnValue(undefined);
  render(<GuardianSettings />);

  expect(screen.getByRole('heading', { name: 'customGuardian' })).toBeInTheDocument();
  expect(screen.getByTestId('guardian-avatar')).toBeInTheDocument();
});

it('shows loading while the guardian endpoint is unresolved', () => {
  mockUseCurrentGuardianEndpoint.mockReturnValue({ endpoint: '', refresh: jest.fn() });
  mockGuardianOptionForEndpoint.mockReturnValue(undefined);
  render(<GuardianSettings />);

  expect(screen.getByRole('heading', { name: 'loading' })).toBeInTheDocument();
});

it('opens the Guardian explainer drawer from the About section', () => {
  render(<GuardianSettings />);

  expect(screen.getByTestId('guardian-info-drawer')).toHaveAttribute('data-open', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'learnMoreAboutGuardian' }));

  expect(mockHapticLight).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('guardian-info-drawer')).toHaveAttribute('data-open', 'true');
});

it('navigates to guardian rotation, buzzing once', () => {
  render(<GuardianSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'rotateGuardian' }));

  // Once, from Button's own wrapper — the handler must not add a second. The
  // "Learn more" button above is a plain <button>, so its haptic is its own.
  expect(mockHapticLight).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledWith('/rotate-guardian');
});

it('keeps the status pill readable in both themes', () => {
  render(<GuardianSettings />);

  // green-700 is the darkest shade that existed and reaches only 4.34:1 on the
  // green-50 fill, short of AA for text this size; green-800 (#1F5C33) is 7.34:1.
  // The palette entry is additive and this pill is its only consumer, so without
  // this assertion dropping either the shade or the class would leave
  // `text-green-800` compiling to nothing, with the ink silently inherited.
  const pill = screen.getByText('online').closest('div');
  expect(pill).toHaveClass('text-green-800', 'dark:text-green-300');
});

it('keeps the OFFLINE pill readable in both themes', () => {
  // Same failure mode as the online case, and the one that matters more: red-300
  // exists only because this pill needs it (tailwind-colors.js), and
  // `theme.colors` replaces Tailwind's palette rather than extending it — so
  // dropping the shade leaves `dark:text-red-300` compiling to nothing and the
  // ink inherited, on the state the user is being warned about.
  mockIsGuardianSyncOutage.mockReturnValue(true);
  render(<GuardianSettings />);

  const pill = screen.getByText('guardianOfflineLabel').closest('div');
  expect(pill).toHaveClass('text-red-700', 'dark:text-red-300');
});

it('nests the section headings under the guardian name rather than beside it', () => {
  render(<GuardianSettings />);

  // The rendered outline is h1 (Settings' NavigationHeader) → h2 (guardian name)
  // → h3 (these two). Promoting them to h2 put them on a level with the name they
  // sit under, which is what a screen reader's heading list shows.
  expect(screen.getByText('about').tagName).toBe('H3');
  expect(screen.getByText('details').tagName).toBe('H3');
});

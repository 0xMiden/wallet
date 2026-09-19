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
// `hotPublicKey` is read too: the guardian sync loop skips accounts without one,
// so the pill has a fourth state for them. Default to an activated account —
// the not-connected case sets `mockHotPublicKey` to undefined.
let mockHotPublicKey: string | undefined = 'hot-1';
// The rotate CTA is cold-signed, so it renders only for accounts with a cold
// key. Default present; the hot-key-only-import test clears it.
let mockColdPublicKey: string | undefined = 'cold-1';
// The reconciler's verdict on whether the operator this screen NAMES is still the
// account's on-chain guardian. Default `in-sync`; the drift tests flip it.
let mockGuardianSyncStatus: string | undefined = 'in-sync';
jest.mock('lib/store', () => ({
  useWalletStore: (
    selector: (state: {
      lastSyncedAt: number | null;
      currentAccount: { publicKey: string; hotPublicKey?: string; coldPublicKey?: string; guardianSyncStatus?: string };
    }) => unknown
  ) =>
    selector({
      lastSyncedAt: WALLET_SYNCED_AT,
      currentAccount: {
        publicKey: 'acc-1',
        hotPublicKey: mockHotPublicKey,
        coldPublicKey: mockColdPublicKey,
        guardianSyncStatus: mockGuardianSyncStatus
      }
    })
}));

// Guardian sync state: the outage flag the status pill derives Online/Offline
// from, and the guardian-scoped last-sync stamp the Details row reads. Both come
// from the same module and the same subscription, and the mock keeps the real
// module's subscribe/notify shape so a test can flip a value and observe the
// mounted page react — a `() => () => {}` stub could never show the pill moving.
const mockIsGuardianSyncOutage = jest.fn((_pk: string) => false);
const mockGetGuardianLastSyncAt = jest.fn((_pk: string): number | undefined => undefined);
// Mirrors `GUARDIAN_SYNC_STAMP_FRESH_MS`, which is itself derived
// (`SYNC_RATE_LIMIT_MAX_COOLDOWN_MS + 30s`) so it cannot end up shorter than the
// rate-limit cooldown it has to outlast. Not imported: the real module is mocked
// wholesale here, and `requireActual` on it would pull the store and guardian
// stack into a component test for one number. The tests below use it RELATIVELY
// (stamp = now - (this + 1)), so they assert the rule, not the number.
const MOCK_STAMP_FRESH_MS = 150_000;
const syncListeners = new Set<() => void>();
const mockIsGuardianUnrepairable = jest.fn((_pk: string) => false);
const notifySyncListeners = () => {
  for (const listener of syncListeners) listener();
};
jest.mock('lib/miden/front/guardian-sync', () => ({
  isGuardianSyncOutage: (pk: string) => mockIsGuardianSyncOutage(pk),
  isGuardianUnrepairable: (pk: string) => mockIsGuardianUnrepairable(pk),
  getGuardianLastSyncAt: (pk: string) => mockGetGuardianLastSyncAt(pk),
  // Implements the REAL rule over the stamp mock rather than being a third
  // independent knob: the pill's freshness and the row's timestamp must come from
  // one value, which is the property the stale-stamp tests below check.
  isGuardianLastSyncFresh: (pk: string) => {
    const at = mockGetGuardianLastSyncAt(pk);
    return at !== undefined && Date.now() - at <= MOCK_STAMP_FRESH_MS;
  },
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
  mockGuardianSyncStatus = 'in-sync';
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
  // No sync has landed yet this session (the default mock), so there is no
  // positive evidence of liveness — the pill must not claim "online" on
  // endpoint presence alone. The "Last sync" row shares the same text, so the
  // pill is identified by its `role="status"` rather than by the label alone.
  expect(screen.getByRole('status')).toHaveTextContent('guardianCheckingLabel');
  expect(screen.queryByText('online')).not.toBeInTheDocument();
  expect(screen.getByText('guardianInfoDescription')).toBeInTheDocument();
  expect(screen.getByText('Provider One')).toBeInTheDocument();
  expect(screen.getByText('guardian.one')).toBeInTheDocument();
  expect(screen.getByText('US-EAST')).toBeInTheDocument();
});

// GUARDIAN_LOGOS['open-zeppelin'] carries a `Mark` (its standalone colour "Z"),
// which switches the hero from the wordmark-plus-repeated-name tile to the
// design-system Hero: the mark in a circle, the name once as the Hero title,
// and the same status pill underneath — see GuardianSettings.tsx's `logoEntry?.Mark`
// branch.
it('renders the OpenZeppelin mark in the design-system Hero, the name once, and the status pill', () => {
  mockGetGuardianLastSyncAt.mockReturnValue(Date.now());
  render(<GuardianSettings />);

  const mark = screen.getByTestId('guardian-operator-logo');
  expect(mark).toBeInTheDocument();
  // The brand-kit tile: pure white in light mode, a dark neutral in dark
  // mode with a hairline ring for definition — not the grey
  // `bg-fill` tile every other provider still gets.
  const tile = mark.parentElement;
  expect(tile).toHaveClass('bg-pure-white', 'dark:bg-grey-800', 'border-hairline');

  // The name is the Hero title now, not a wordmark tile PLUS a repeated name
  // below it.
  expect(screen.getAllByText('Guardian One')).toHaveLength(1);
  expect(screen.getByRole('heading', { name: 'Guardian One' })).toBeInTheDocument();

  // The status pill survives the layout swap unchanged.
  const pill = screen.getByRole('status');
  expect(pill).toHaveTextContent('online');
});

// Every other provider (no `Mark` on its GUARDIAN_LOGOS entry) keeps the
// original wordmark-in-a-tile hero layout untouched by the OpenZeppelin
// brand-kit work.
it('keeps the wordmark-tile hero layout for a provider with no Mark', () => {
  mockGuardianOptionForEndpoint.mockReturnValue({
    id: 'gateway',
    name: 'Gateway One',
    operatedBy: 'Gateway Provider',
    location: 'EU-WEST'
  });
  render(<GuardianSettings />);

  const logo = screen.getByTestId('guardian-operator-logo');
  expect(logo).toBeInTheDocument();
  // The legacy grey tile, not the OpenZeppelin brand-kit tile.
  expect(logo.parentElement).toHaveClass('bg-fill');
  expect(logo.parentElement).not.toHaveClass('bg-pure-white');

  expect(screen.getByRole('heading', { name: 'Gateway One' })).toBeInTheDocument();
});

it('shows the offline pill while the sync loop reports a guardian outage', () => {
  mockIsGuardianSyncOutage.mockReturnValue(true);
  render(<GuardianSettings />);

  expect(mockIsGuardianSyncOutage).toHaveBeenCalledWith('acc-1');
  expect(screen.getByText('guardianOfflineLabel')).toBeInTheDocument();
  expect(screen.queryByText('online')).not.toBeInTheDocument();
});

it('shows "Online" only once a guardian sync has actually landed this session', () => {
  // Endpoint presence + no outage is NOT evidence of liveness — a guardian that
  // is dead from the moment the popup opens sits under the 6-consecutive-failure
  // outage threshold (~18s) the whole time. `getGuardianLastSyncAt` returning a
  // stamp is the one signal that is actually evidence a sync completed.
  mockIsGuardianSyncOutage.mockReturnValue(false);
  mockGetGuardianLastSyncAt.mockReturnValue(undefined);
  render(<GuardianSettings />);

  // The "Last sync" row shows the same "Checking" text while unsynced, so the
  // pill is identified by its `role="status"` rather than by the label alone.
  const pill = screen.getByRole('status');
  expect(pill).toHaveTextContent('guardianCheckingLabel');
  expect(screen.queryByText('online')).not.toBeInTheDocument();
  expect(screen.queryByText('guardianOfflineLabel')).not.toBeInTheDocument();

  mockGetGuardianLastSyncAt.mockReturnValue(Date.now());
  act(() => notifySyncListeners());

  expect(pill).toHaveTextContent('online');
  expect(screen.queryByText('guardianCheckingLabel')).not.toBeInTheDocument();
});

it('reads "Last sync" from the guardian, not the wallet-wide sync stamp', () => {
  // An outage with a wallet that is otherwise syncing happily — the exact state
  // that produced "Offline" beside a seconds-old "Last sync".
  mockIsGuardianSyncOutage.mockReturnValue(true);
  mockGetGuardianLastSyncAt.mockReturnValue(undefined);
  render(<GuardianSettings />);

  expect(mockGetGuardianLastSyncAt).toHaveBeenCalledWith('acc-1');
  expect(screen.getByText('guardianOfflineLabel')).toBeInTheDocument();
});

// The pill and the row are two readings of one fact, so no state may produce two
// answers. An outage arms without ever stamping a sync, which used to leave the
// row saying "Checking" under an Offline pill for the whole outage.
it('does not say it is still checking under a pill that has already said Offline', () => {
  mockIsGuardianSyncOutage.mockReturnValue(true);
  mockGetGuardianLastSyncAt.mockReturnValue(undefined);
  render(<GuardianSettings />);

  expect(screen.getByText('guardianOfflineLabel')).toBeInTheDocument();
  expect(screen.queryByText('guardianCheckingLabel')).not.toBeInTheDocument();
  // Not "Never" either: the stamp is session-local, so its absence during an
  // outage is no evidence about whether this account has ever synced.
  expect(screen.getByText('unknown')).toBeInTheDocument();
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

describe('a stale success stamp', () => {
  // The stamp records a MOMENT and the pill asserts a PRESENT state. Reading its
  // mere existence as "Online" was unbounded in the two paths that stop syncing
  // without arming any fault flag — a sustained 429 (which clears the outage,
  // because the server answered) and any sustained local error. Both leave the
  // last stamp in place, so the pill read green for the life of the realm on an
  // account that had not synced in an hour.
  it('reads "Checking" rather than "Online", since it says nothing about now', () => {
    jest.useFakeTimers().setSystemTime(WALLET_SYNCED_AT);
    try {
      mockGetGuardianLastSyncAt.mockReturnValue(WALLET_SYNCED_AT - (MOCK_STAMP_FRESH_MS + 1));
      render(<GuardianSettings />);

      expect(screen.getByText('guardianCheckingLabel')).toBeInTheDocument();
      expect(screen.queryByText('online')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('still renders its real age beside that pill — the row is history, not a claim about now', () => {
    jest.useFakeTimers().setSystemTime(WALLET_SYNCED_AT);
    try {
      mockGetGuardianLastSyncAt.mockReturnValue(WALLET_SYNCED_AT - 600_000);
      render(<GuardianSettings />);

      // "10m ago" — the most useful fact on the screen in exactly the state where
      // the user is working out how long something has been wrong. Replacing it
      // with "Unknown" would be the wrong reading of the pill/row consistency rule.
      expect(screen.getByText(/^10\s?m(in\.?)? ago$/)).toBeInTheDocument();
      expect(screen.queryByText('unknown')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('is reached by the clock alone, with no sync notification to repaint the page', () => {
    // Nothing else on this screen re-renders on time passing: the sync module
    // notifies only on a completed sync or an observable flag change, and the
    // other subscriptions are primitives. So a screen left open kept rendering
    // the string computed at the last notification, and the freshness check would
    // never re-evaluate. This is the interval that fixes both.
    jest.useFakeTimers().setSystemTime(WALLET_SYNCED_AT);
    try {
      const syncedAt = WALLET_SYNCED_AT - 30_000;
      mockGetGuardianLastSyncAt.mockReturnValue(syncedAt);
      render(<GuardianSettings />);
      expect(screen.getByText('online')).toBeInTheDocument();

      // Cross the freshness window with no store change and no outage notification.
      act(() => {
        jest.advanceTimersByTime(MOCK_STAMP_FRESH_MS);
      });

      expect(screen.getByText('guardianCheckingLabel')).toBeInTheDocument();
      expect(screen.queryByText('online')).not.toBeInTheDocument();
      // And the row moved with the clock rather than freezing at "30s ago":
      // 30s + the freshness window, rendered in minutes.
      expect(screen.getByText(/^3\s?m(in\.?)? ago$/)).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});

it('updates the pill in place when the outage arms under a mounted page', () => {
  // A guardian sync has already landed this session — the one state that
  // legitimately reads "Online" rather than "Checking".
  mockGetGuardianLastSyncAt.mockReturnValue(Date.now());
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
  mockGetGuardianLastSyncAt.mockReturnValue(Date.now());
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
  mockGetGuardianLastSyncAt.mockReturnValue(Date.now());
  render(<GuardianSettings />);

  // The shared StatusBadge: the positive ink on its own opaque tint, 4.61:1 light
  // and 5.64:1 dark (`lib/ui/design-tokens.test.ts`), with no per-pill palette.
  const pill = screen.getByRole('status');
  expect(pill).toHaveTextContent('online');
  expect(pill).toHaveClass('bg-positive-tint', 'text-positive-ink');
});

it('renders the checking pill in the neutral badge tone, which flips with the theme', () => {
  // The default mock state: no outage, no sync landed yet this session. The
  // "Last sync" row shares the same text, so the pill is identified by its
  // `role="status"` rather than by the label alone.
  render(<GuardianSettings />);

  const pill = screen.getByRole('status');
  expect(pill).toHaveTextContent('guardianCheckingLabel');
  expect(pill).toHaveClass('bg-fill-pressed', 'text-ink');
});

it('keeps the OFFLINE pill readable in both themes', () => {
  // The state the user is being warned about: the negative ink on its own tint,
  // 4.62:1 light and 5.50:1 dark.
  mockIsGuardianSyncOutage.mockReturnValue(true);
  render(<GuardianSettings />);

  const pill = screen.getByRole('status');
  expect(pill).toHaveTextContent('guardianOfflineLabel');
  expect(pill).toHaveClass('bg-negative-tint', 'text-negative-ink');
});

// An operator that ANSWERS and still rejects this device clears the outage flag
// (the server is up) and stamps no sync, so the two signals the pill was built on
// both read "nothing to report" — leaving "Checking" on an account that cannot
// transact and whose automatic repair has already given up.
it('names the state where the guardian answers, the account cannot use it, and repair has stopped', () => {
  mockIsGuardianUnrepairable.mockReturnValue(true);
  try {
    render(<GuardianSettings />);

    const pill = screen.getByRole('status');
    expect(pill).toHaveTextContent('guardianNeedsAttentionLabel');
    expect(pill).not.toHaveTextContent('guardianCheckingLabel');
    // And the row below agrees: nothing is checking. "Unknown" rather than
    // "Never" — the operator answered, so the absence of a stamp this session is
    // not evidence the account has never synced.
    expect(screen.getByText('unknown')).toBeInTheDocument();
  } finally {
    mockIsGuardianUnrepairable.mockReturnValue(false);
  }
});

// Drift means the operator this screen names is NOT the account's on-chain
// guardian — so every other fact on the page (name, provider, region, host) is
// about the previous one. The dangerous combination is drift plus a healthy old
// operator: it keeps answering our syncs, so the outage flag stays down and the
// stamp keeps refreshing, and the pill said "Online" with a seconds-old "Last
// sync" on the one screen the user visits to find out who guards their account.
describe('drift', () => {
  it('does not report Online off the previous operator’s sync when the guardian has drifted', () => {
    mockGuardianSyncStatus = 'needs-user-input';
    mockGetGuardianLastSyncAt.mockReturnValue(Date.now() - 2_000);

    render(<GuardianSettings />);

    const pill = screen.getByRole('status');
    expect(pill).toHaveTextContent('guardianNeedsAttentionLabel');
    expect(pill).not.toHaveTextContent('online');
    // And the stamp goes with it: a fresh timestamp here would attribute the old
    // operator's success to the account's actual guardian.
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('outranks a liveness signal in either direction', () => {
    mockGuardianSyncStatus = 'needs-user-input';
    mockIsGuardianSyncOutage.mockReturnValue(true);

    render(<GuardianSettings />);

    // Both statements are true, but "we do not know who your guardian is" is the
    // one the user has to act on, and the Offline CTA points at a rotation away
    // from an operator that may not be theirs any more.
    expect(screen.getByRole('status')).toHaveTextContent('guardianNeedsAttentionLabel');
  });

  // `resolving` is written at the START of an ordinary reconciliation round that
  // normally ends `in-sync`. Treating it as a fault would flash "Needs attention"
  // through every routine check.
  it('does not treat an in-progress reconciliation as a fault', () => {
    mockGuardianSyncStatus = 'resolving';
    mockGetGuardianLastSyncAt.mockReturnValue(Date.now() - 2_000);

    render(<GuardianSettings />);

    expect(screen.getByRole('status')).not.toHaveTextContent('guardianNeedsAttentionLabel');
  });

  // ...but it is not Online either, and a fresh stamp used to make it read that
  // way. `assertGuardianInSync` refuses every transaction on any status other
  // than `in-sync`, `resolving` included — so a green pill during that window
  // told the user the guardian was usable while the wallet was refusing to use
  // it. "Checking" declines to certify without accusing, which is what this
  // state actually is.
  it('does not claim Online while a reconciliation is still blocking transactions', () => {
    mockGuardianSyncStatus = 'resolving';
    mockGetGuardianLastSyncAt.mockReturnValue(Date.now() - 2_000);

    render(<GuardianSettings />);

    const pill = screen.getByRole('status');
    expect(pill).toHaveTextContent('guardianCheckingLabel');
    expect(pill).not.toHaveTextContent('online');
  });
});

// Unreachable outranks answering-but-unusable: it is the more immediate fault and
// the one with a CTA on this screen.
it('still says Offline when the operator is unreachable, even if repair has also stopped', () => {
  mockIsGuardianUnrepairable.mockReturnValue(true);
  mockIsGuardianSyncOutage.mockReturnValue(true);
  try {
    render(<GuardianSettings />);

    expect(screen.getByRole('status')).toHaveTextContent('guardianOfflineLabel');
  } finally {
    mockIsGuardianUnrepairable.mockReturnValue(false);
    mockIsGuardianSyncOutage.mockReturnValue(false);
  }
});

// The sync loop filters out accounts with no hot key (see the filter's docstring
// in `guardian-sync.ts`), so such an account never stamps a sync and never arms
// an outage. Reading that as "checking" left the pill spinning for the lifetime
// of the account, next to a "Last sync" row saying the same thing.
it('says Not connected, not Checking, for an account with no activated hot key', () => {
  mockHotPublicKey = undefined;
  try {
    render(<GuardianSettings />);

    const pill = screen.getByRole('status');
    expect(pill).toHaveTextContent('guardianNotConnectedLabel');
    // "Last sync" is `never` here, not "checking": nothing is checking, and this
    // device genuinely has not synced with the guardian.
    expect(screen.getByText('never')).toBeInTheDocument();
    expect(screen.queryByText('guardianCheckingLabel')).not.toBeInTheDocument();
  } finally {
    mockHotPublicKey = 'hot-1';
  }
});

it('nests the section headings under the guardian name rather than beside it', () => {
  render(<GuardianSettings />);

  // The rendered outline is h1 (Settings' PageHeader) → h2 (guardian name)
  // → h3 (these two). Promoting them to h2 put them on a level with the name they
  // sit under, which is what a screen reader's heading list shows.
  expect(screen.getByText('about').tagName).toBe('H3');
  expect(screen.getByText('details').tagName).toBe('H3');
});

it('renders through SubPageLayout: section labels, muted copy, details card, Rotate pinned in the footer', () => {
  render(<GuardianSettings />);

  const page = screen.getByTestId('guardian-settings');
  const footer = page.querySelector('[data-slot="footer"]')!;
  expect(footer).toContainElement(screen.getByRole('button', { name: 'rotateGuardian' }));
  expect(page.querySelector('[data-slot="body"]')).not.toContainElement(
    screen.getByRole('button', { name: 'rotateGuardian' })
  );
  // Section labels are the shared SectionHeader, not grey chips; no rule between sections.
  expect(screen.getByText('about')).toHaveClass('text-[13px]', 'text-muted');
  expect(screen.getByText('about')).not.toHaveClass('bg-gray-25');
  expect(page.querySelector('hr')).toBeNull();
  // The explanation is 14px muted section copy; the details sit in the shared DetailCard.
  expect(screen.getByText('guardianInfoDescription').closest('.text-muted')).toHaveClass('text-sm');
  expect(screen.getByText('guardianProvider').closest('.rounded-2xl')).toHaveClass('bg-fill');
});

// Hot-key-only import: no cold key on the account. This guards the CTA's
// VISIBILITY only, and passes on the base commit by construction - the CTA was
// never gated on the cold key. The pipeline it fronts (prompt for the seed,
// derive against the on-chain cold signer, bind the key to that one
// transaction) is covered in vault.test.ts, 'derives and binds a cold key for
// an account that has none'.
it('keeps the rotate CTA for an account with no cold key', () => {
  mockColdPublicKey = undefined;
  try {
    render(<GuardianSettings />);

    expect(screen.getByRole('button', { name: 'rotateGuardian' })).toBeInTheDocument();
  } finally {
    mockColdPublicKey = 'cold-1';
  }
});

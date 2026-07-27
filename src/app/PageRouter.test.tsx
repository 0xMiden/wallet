/**
 * app/PageRouter — the Woozie route table + the top-level <PageRouter/>.
 *
 * The real `Woozie.Router` (createMap/resolve/SKIP) drives resolution so every
 * route factory and the `onlyReady` guard execute for real; only `useLocation`
 * (pathname + trigger), `HistoryAction`, `resetHistoryPosition` and `Redirect`
 * are stubbed so a test can drive any pathname/ctx combination. Every screen,
 * layout, page and env/miden hook the router pulls in is replaced with a tiny
 * identifiable stub, keeping this a pure routing unit test.
 *
 * Top-level view selection now flows through `resolveRootView(ctx)` (locked →
 * `unlock`, un-hydrated → `loading`, un-ready → `welcome`, else → `app`). The
 * catch-all `*` route (registered BEFORE `/` and every ready-only route) is the
 * one that renders Unlock / RootSuspenseFallback / Welcome and only SKIPs — so a
 * specific route runs — when `resolveRootView` returns `app`. `root-view` is a
 * partial mock: it delegates to the real helper for the ctx-driven tests, and a
 * couple of tests override it with `mockReturnValueOnce` to reach branches that
 * are otherwise structurally unreachable:
 *   - the `/` route's `unlock` / `loading` / `: <Welcome/>` arms, and
 *   - `onlyReady`'s `SKIP` arm,
 * because whenever `resolveRootView` is `app` (the only value that lets those
 * factories run) `ctx.ready` is already true and `ctx` never resolves to
 * anything but `app`. They exist as defense-in-depth; the overrides document and
 * cover that defensive fallback behaviour.
 */

import React from 'react';

import { render, screen } from '@testing-library/react';

import * as Woozie from 'lib/woozie';

import PageRouter from './PageRouter';
import { resolveRootView } from './root-view';

// ---------------------------------------------------------------------------
// Mutable mock state (prefixed `mock*` so the jest hoister lets factories close
// over them). Each render reads pathname/trigger/env/miden from these objects.
// ---------------------------------------------------------------------------
const mockLocation: { pathname: string; trigger: string | null } = {
  pathname: '/',
  trigger: null
};
const mockEnv = { popup: false, fullPage: false };
const mockMiden = { ready: false, locked: false, hydrated: false };
const mockSwapEnabled = { value: true };

// `lib/woozie` bundles the full history/location stack; keep the real Router so
// createMap/resolve/SKIP behave exactly as in production, and stub the four
// symbols <PageRouter/> uses that need to be driven or silenced.
jest.mock('lib/woozie', () => ({
  __esModule: true,
  Router: jest.requireActual('lib/woozie/router'),
  useLocation: () => mockLocation,
  HistoryAction: { Push: 'PUSH', Pop: 'POP', Replace: 'REPLACE' },
  resetHistoryPosition: jest.fn(),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect" data-to={to} />
}));

// root-view: partial mock. By default `resolveRootView` delegates to the real
// helper so ctx-driven tests exercise production logic; a couple of tests
// override it per-call to reach the structurally-defensive fallback branches.
jest.mock('./root-view', () => {
  const actual = jest.requireActual('./root-view');
  return {
    __esModule: true,
    ...actual,
    resolveRootView: jest.fn(actual.resolveRootView)
  };
});

// env: `useAppEnv` reads shared state; `OpenInFullPage` is a stub screen.
jest.mock('app/env', () => ({
  useAppEnv: () => mockEnv,
  OpenInFullPage: () => <div data-testid="open-in-full-page" />
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => mockMiden
}));

// The loading spinner shown during MV3 cold-start (before hydration).
jest.mock('app/a11y/RootSuspenseFallback', () => ({
  __esModule: true,
  default: () => <div data-testid="root-suspense-fallback" />
}));

// Layouts render their children so the wrapped page stays assertable.
jest.mock('app/layouts/FullScreenPage', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div data-testid="full-screen-page">{children}</div>
}));
jest.mock('app/layouts/TabLayout', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div data-testid="tab-layout">{children}</div>
}));

// Leaf screens — identifiable stubs, echoing any route params they receive.
jest.mock('app/pages/Explore', () => ({ __esModule: true, default: () => <div data-testid="explore" /> }));
jest.mock('app/pages/OpenSidePanel', () => ({
  __esModule: true,
  default: () => <div data-testid="open-side-panel" />
}));
jest.mock('app/pages/Pending', () => ({ Pending: () => <div data-testid="pending" /> }));
jest.mock('app/pages/Receive', () => ({ Receive: () => <div data-testid="receive" /> }));
jest.mock('app/pages/RotateGuardian', () => ({
  __esModule: true,
  default: () => <div data-testid="rotate-guardian" />
}));
jest.mock('app/pages/RotateGuardianReview', () => ({
  __esModule: true,
  default: () => <div data-testid="rotate-guardian-review" />
}));
jest.mock('app/pages/Settings', () => ({
  __esModule: true,
  default: ({ tabSlug }: { tabSlug?: string }) => <div data-testid="settings" data-tab-slug={tabSlug ?? ''} />
}));
jest.mock('app/pages/Unlock', () => ({ __esModule: true, default: () => <div data-testid="unlock" /> }));
jest.mock('app/pages/Welcome', () => ({ __esModule: true, default: () => <div data-testid="welcome" /> }));

jest.mock('screens/earn-flow/EarnDepositAmount', () => ({
  __esModule: true,
  default: ({ vaultId }: { vaultId?: string }) => <div data-testid="earn-deposit-amount" data-vault-id={vaultId} />
}));
jest.mock('screens/earn-flow/EarnDepositReview', () => ({
  __esModule: true,
  default: ({ vaultId }: { vaultId?: string }) => <div data-testid="earn-deposit-review" data-vault-id={vaultId} />
}));
jest.mock('screens/earn-flow/EarnPositionDetail', () => ({
  __esModule: true,
  default: ({ positionId }: { positionId?: string }) => (
    <div data-testid="earn-position-detail" data-position-id={positionId} />
  )
}));
jest.mock('screens/earn-flow/EarnPositions', () => ({
  __esModule: true,
  default: () => <div data-testid="earn-positions" />
}));
jest.mock('screens/earn-flow/EarnVaultDetail', () => ({
  __esModule: true,
  default: ({ vaultId }: { vaultId?: string }) => <div data-testid="earn-vault-detail" data-vault-id={vaultId} />
}));
jest.mock('screens/generating-transaction/GeneratingTransaction', () => ({
  GeneratingTransactionPage: ({ txId, keepOpen }: { txId?: string; keepOpen?: boolean }) => (
    <div data-testid="generating-transaction" data-tx-id={txId} data-keep-open={String(!!keepOpen)} />
  )
}));
jest.mock('screens/send-flow/ReviewTransaction', () => ({
  ReviewTransaction: () => <div data-testid="review-transaction" />
}));
jest.mock('screens/send-flow/SendManager', () => ({
  SendFlow: ({ isLoading }: { isLoading?: boolean }) => (
    <div data-testid="send-flow" data-is-loading={String(!!isLoading)} />
  )
}));
jest.mock('screens/swap-flow/SwapManager', () => ({ SwapFlow: () => <div data-testid="swap-flow" /> }));

// Swap is disabled on iOS; toggle the flag to assert `/swap` renders vs redirects.
jest.mock('lib/feature-flags', () => ({
  isSwapEnabled: () => mockSwapEnabled.value
}));

jest.mock('./pages/AllHistory', () => ({
  __esModule: true,
  default: ({ programId }: { programId?: string | null }) => (
    <div data-testid="all-history" data-program-id={programId ?? ''} />
  )
}));
jest.mock('./pages/Browser', () => ({ __esModule: true, default: () => <div data-testid="browser" /> }));
jest.mock('./pages/ForgotPassword/ForgotPassword', () => ({
  __esModule: true,
  default: () => <div data-testid="forgot-password" />
}));
jest.mock('./pages/ForgotPassword/ForgotPasswordInfo', () => ({
  __esModule: true,
  default: () => <div data-testid="forgot-password-info" />
}));
jest.mock('./pages/ResetRequired', () => ({ __esModule: true, default: () => <div data-testid="reset-required" /> }));
jest.mock('./pages/TokenDetail', () => ({
  __esModule: true,
  default: ({ tokenId }: { tokenId?: string }) => <div data-testid="token-detail" data-token-id={tokenId} />
}));
jest.mock('./templates/history/HistoryDetails', () => ({
  HistoryDetails: ({ transactionId }: { transactionId?: string }) => (
    <div data-testid="history-details" data-transaction-id={transactionId} />
  )
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type Ctx = { ready?: boolean; locked?: boolean; hydrated?: boolean; popup?: boolean; fullPage?: boolean };

function renderAt(pathname: string, ctx: Ctx = {}, trigger: string | null = null) {
  mockLocation.pathname = pathname;
  mockLocation.trigger = trigger;
  mockEnv.popup = ctx.popup ?? false;
  mockEnv.fullPage = ctx.fullPage ?? false;
  mockMiden.ready = ctx.ready ?? false;
  mockMiden.locked = ctx.locked ?? false;
  mockMiden.hydrated = ctx.hydrated ?? false;
  return render(<PageRouter />);
}

// A fully booted wallet: unlocked, ready, and hydrated → resolveRootView `app`,
// which is the only ctx that lets a specific `/`-or-deeper route resolve.
const ready: Ctx = { ready: true, locked: false, hydrated: true };

const resetHistoryPositionMock = Woozie.resetHistoryPosition as unknown as jest.Mock;
const resolveRootViewMock = resolveRootView as unknown as jest.Mock;
const realResolveRootView = jest.requireActual('./root-view').resolveRootView;
const scrollToMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset wipes both the call log and any leftover `*Once` queue, then we
  // re-point the default implementation back at the real helper.
  resolveRootViewMock.mockReset();
  resolveRootViewMock.mockImplementation(realResolveRootView);
  window.scrollTo = scrollToMock as unknown as typeof window.scrollTo;
  mockSwapEnabled.value = true;
});

describe('app/PageRouter — pre-ready / special routes', () => {
  it('/finish-side-panel renders OpenSidePanel when unlocked', () => {
    renderAt('/finish-side-panel', { locked: false });
    expect(screen.getByTestId('open-side-panel')).toBeInTheDocument();
  });

  it('/finish-side-panel SKIPs to the locked catch-all (Unlock) when locked', () => {
    renderAt('/finish-side-panel', { locked: true });
    expect(screen.getByTestId('unlock')).toBeInTheDocument();
    expect(screen.queryByTestId('open-side-panel')).not.toBeInTheDocument();
  });

  it('/reset-required renders ResetRequired', () => {
    renderAt('/reset-required');
    expect(screen.getByTestId('reset-required')).toBeInTheDocument();
  });

  it('/reset-wallet renders OpenInFullPage when not on the full page', () => {
    renderAt('/reset-wallet', { fullPage: false });
    expect(screen.getByTestId('open-in-full-page')).toBeInTheDocument();
  });

  it('/reset-wallet renders ForgotPassword on the full page', () => {
    renderAt('/reset-wallet', { fullPage: true });
    expect(screen.getByTestId('forgot-password')).toBeInTheDocument();
  });

  it('/forgot-password-info renders ForgotPasswordInfo', () => {
    renderAt('/forgot-password-info');
    expect(screen.getByTestId('forgot-password-info')).toBeInTheDocument();
  });

  it('/forgot-password renders OpenInFullPage when not ready and not full page', () => {
    renderAt('/forgot-password', { ready: false, fullPage: false });
    expect(screen.getByTestId('open-in-full-page')).toBeInTheDocument();
  });

  it('/forgot-password renders ForgotPassword when not ready and full page', () => {
    renderAt('/forgot-password', { ready: false, fullPage: true });
    expect(screen.getByTestId('forgot-password')).toBeInTheDocument();
  });

  it('/forgot-password SKIPs when ready and falls through to the final Redirect', () => {
    renderAt('/forgot-password', ready);
    const redirect = screen.getByTestId('redirect');
    expect(redirect).toBeInTheDocument();
    expect(redirect).toHaveAttribute('data-to', '/');
  });
});

describe('app/PageRouter — the `*` catch-all (resolveRootView)', () => {
  it('renders Unlock when locked (resolveRootView → unlock)', () => {
    renderAt('/some/locked/path', { locked: true, ready: true, hydrated: true });
    expect(screen.getByTestId('unlock')).toBeInTheDocument();
  });

  it('renders the loading spinner before hydration, even while status is Idle (resolveRootView → loading)', () => {
    // MV3 service-worker cold-start: unlocked, not yet hydrated. Must show the
    // spinner, NEVER onboarding.
    renderAt('/some/cold-start/path', { locked: false, ready: false, hydrated: false });
    expect(screen.getByTestId('root-suspense-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('welcome')).not.toBeInTheDocument();
  });

  it('still shows the loading spinner for a returning (ready) user before hydration', () => {
    renderAt('/some/cold-start/path', { locked: false, ready: true, hydrated: false });
    expect(screen.getByTestId('root-suspense-fallback')).toBeInTheDocument();
  });

  it('renders Welcome once hydrated but not ready (resolveRootView → welcome)', () => {
    renderAt('/some/not-ready/path', { locked: false, ready: false, hydrated: true });
    expect(screen.getByTestId('welcome')).toBeInTheDocument();
  });

  it('SKIPs (resolveRootView → app) so an unknown path reaches the final Redirect', () => {
    renderAt('/totally-unknown-path', ready);
    const redirect = screen.getByTestId('redirect');
    expect(redirect).toBeInTheDocument();
    expect(redirect).toHaveAttribute('data-to', '/');
  });
});

describe('app/PageRouter — the `/` root route', () => {
  it('renders Explore inside TabLayout and resets history position (resolveRootView → app)', () => {
    renderAt('/', ready);
    expect(screen.getByTestId('tab-layout')).toContainElement(screen.getByTestId('explore'));
    expect(resetHistoryPositionMock).toHaveBeenCalledTimes(1);
  });

  // The remaining `/` arms are defense-in-depth: the earlier `*` catch-all
  // already handles every non-`app` ctx, so the `/` factory only ever runs with
  // `app` in production. We force the fallback by making `resolveRootView` return
  // `app` for the `*` call (so it SKIPs) and a different value for the `/` call.
  it('falls back to Unlock if resolveRootView unexpectedly reports unlock at the `/` factory', () => {
    resolveRootViewMock.mockReturnValueOnce('app').mockReturnValueOnce('unlock');
    renderAt('/', ready);
    expect(screen.getByTestId('unlock')).toBeInTheDocument();
  });

  it('falls back to the loading spinner if resolveRootView reports loading at the `/` factory', () => {
    resolveRootViewMock.mockReturnValueOnce('app').mockReturnValueOnce('loading');
    renderAt('/', ready);
    expect(screen.getByTestId('root-suspense-fallback')).toBeInTheDocument();
  });

  it('falls back to Welcome (default arm) for any other resolveRootView value at the `/` factory', () => {
    resolveRootViewMock.mockReturnValueOnce('app').mockReturnValueOnce('welcome');
    renderAt('/', ready);
    expect(screen.getByTestId('welcome')).toBeInTheDocument();
  });
});

describe('app/PageRouter — ready tab & full-screen routes', () => {
  it('/history/:programId passes the program id into AllHistory', () => {
    renderAt('/history/prog-1', ready);
    const el = screen.getByTestId('all-history');
    expect(screen.getByTestId('tab-layout')).toContainElement(el);
    expect(el).toHaveAttribute('data-program-id', 'prog-1');
  });

  it('/history renders AllHistory with an empty (optional) program id', () => {
    renderAt('/history', ready);
    expect(screen.getByTestId('all-history')).toHaveAttribute('data-program-id', '');
  });

  it('/settings/:tabSlug passes the tab slug into Settings inside FullScreenPage', () => {
    renderAt('/settings/general', ready);
    const el = screen.getByTestId('settings');
    expect(screen.getByTestId('full-screen-page')).toContainElement(el);
    expect(el).toHaveAttribute('data-tab-slug', 'general');
  });

  it('/settings renders Settings with no tab slug', () => {
    renderAt('/settings', ready);
    expect(screen.getByTestId('settings')).toHaveAttribute('data-tab-slug', '');
  });

  it('/browser renders Browser inside TabLayout', () => {
    renderAt('/browser', ready);
    expect(screen.getByTestId('tab-layout')).toContainElement(screen.getByTestId('browser'));
  });

  it('/receive renders Receive inside TabLayout', () => {
    renderAt('/receive', ready);
    expect(screen.getByTestId('tab-layout')).toContainElement(screen.getByTestId('receive'));
  });

  it('/pending renders Pending inside FullScreenPage', () => {
    renderAt('/pending', ready);
    expect(screen.getByTestId('full-screen-page')).toContainElement(screen.getByTestId('pending'));
  });

  it('/rotate-guardian renders RotateGuardian inside FullScreenPage', () => {
    renderAt('/rotate-guardian', ready);
    expect(screen.getByTestId('full-screen-page')).toContainElement(screen.getByTestId('rotate-guardian'));
  });

  it('/rotate-guardian/review renders RotateGuardianReview inside FullScreenPage', () => {
    renderAt('/rotate-guardian/review', ready);
    expect(screen.getByTestId('full-screen-page')).toContainElement(screen.getByTestId('rotate-guardian-review'));
  });

  it('/history-details/:transactionId passes the id into HistoryDetails', () => {
    renderAt('/history-details/tx-42', ready);
    const el = screen.getByTestId('history-details');
    expect(screen.getByTestId('full-screen-page')).toContainElement(el);
    expect(el).toHaveAttribute('data-transaction-id', 'tx-42');
  });

  it('/token-detail/:tokenId passes the id into TokenDetail', () => {
    renderAt('/token-detail/tok-9', ready);
    const el = screen.getByTestId('token-detail');
    expect(screen.getByTestId('full-screen-page')).toContainElement(el);
    expect(el).toHaveAttribute('data-token-id', 'tok-9');
  });

  it('/send/review renders ReviewTransaction inside FullScreenPage', () => {
    renderAt('/send/review', ready);
    expect(screen.getByTestId('full-screen-page')).toContainElement(screen.getByTestId('review-transaction'));
  });

  it('/send renders SendFlow (isLoading=false) inside TabLayout', () => {
    renderAt('/send', ready);
    const el = screen.getByTestId('send-flow');
    expect(screen.getByTestId('tab-layout')).toContainElement(el);
    expect(el).toHaveAttribute('data-is-loading', 'false');
  });

  it('/swap renders SwapFlow inside TabLayout when swap is enabled', () => {
    renderAt('/swap', ready);
    expect(screen.getByTestId('tab-layout')).toContainElement(screen.getByTestId('swap-flow'));
  });

  it('/swap redirects home when swap is disabled', () => {
    mockSwapEnabled.value = false;
    renderAt('/swap', ready);
    expect(screen.queryByTestId('swap-flow')).toBeNull();
    const redirect = screen.getByTestId('redirect');
    expect(redirect).toHaveAttribute('data-to', '/');
  });

  it('/earn/vaults/:vaultId/deposit/review passes the vault id into EarnDepositReview', () => {
    renderAt('/earn/vaults/v-1/deposit/review', ready);
    const el = screen.getByTestId('earn-deposit-review');
    expect(screen.getByTestId('full-screen-page')).toContainElement(el);
    expect(el).toHaveAttribute('data-vault-id', 'v-1');
  });

  it('/earn/vaults/:vaultId/deposit passes the vault id into EarnDepositAmount', () => {
    renderAt('/earn/vaults/v-2/deposit', ready);
    expect(screen.getByTestId('earn-deposit-amount')).toHaveAttribute('data-vault-id', 'v-2');
  });

  it('/earn/vaults/:vaultId passes the vault id into EarnVaultDetail', () => {
    renderAt('/earn/vaults/v-3', ready);
    expect(screen.getByTestId('earn-vault-detail')).toHaveAttribute('data-vault-id', 'v-3');
  });

  it('/earn/positions/:positionId passes the position id into EarnPositionDetail', () => {
    renderAt('/earn/positions/p-1', ready);
    expect(screen.getByTestId('earn-position-detail')).toHaveAttribute('data-position-id', 'p-1');
  });

  it('/earn/positions renders EarnPositions inside FullScreenPage', () => {
    renderAt('/earn/positions', ready);
    expect(screen.getByTestId('full-screen-page')).toContainElement(screen.getByTestId('earn-positions'));
  });

  it('/earn renders an (empty) TabLayout', () => {
    renderAt('/earn', ready);
    expect(screen.getByTestId('tab-layout')).toBeInTheDocument();
  });

  it('/generating-transaction/:txId renders the page without keepOpen', () => {
    renderAt('/generating-transaction/tx-a', ready);
    const el = screen.getByTestId('generating-transaction');
    expect(screen.getByTestId('full-screen-page')).toContainElement(el);
    expect(el).toHaveAttribute('data-tx-id', 'tx-a');
    expect(el).toHaveAttribute('data-keep-open', 'false');
  });

  it('/generating-transaction-full/:txId renders the page with keepOpen=true', () => {
    renderAt('/generating-transaction-full/tx-b', ready);
    const el = screen.getByTestId('generating-transaction');
    expect(el).toHaveAttribute('data-tx-id', 'tx-b');
    expect(el).toHaveAttribute('data-keep-open', 'true');
  });

  // Defense-in-depth: `onlyReady` guards every route above with `ctx.ready`, but
  // a ready-only factory can only be reached once `resolveRootView` is `app`,
  // which itself implies ready. Force `app` while ctx is NOT ready to exercise
  // `onlyReady`'s SKIP arm — the route drops through to the final Redirect.
  it('onlyReady SKIPs to the final Redirect when a route is reached without ctx.ready', () => {
    resolveRootViewMock.mockReturnValueOnce('app');
    renderAt('/send', { ready: false, locked: false, hydrated: true });
    const redirect = screen.getByTestId('redirect');
    expect(redirect).toBeInTheDocument();
    expect(redirect).toHaveAttribute('data-to', '/');
  });
});

describe('app/PageRouter — scroll & history side effects', () => {
  it('scrolls to top when the location trigger is a Push', () => {
    renderAt('/send', ready, Woozie.HistoryAction.Push);
    expect(scrollToMock).toHaveBeenCalledWith(0, 0);
  });

  it('does not scroll when the trigger is not a Push', () => {
    renderAt('/send', ready, Woozie.HistoryAction.Pop);
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it('does not reset history position for a non-root pathname', () => {
    renderAt('/send', ready);
    expect(resetHistoryPositionMock).not.toHaveBeenCalled();
  });

  it('both scrolls and resets history position on a Push to the root pathname', () => {
    renderAt('/', ready, Woozie.HistoryAction.Push);
    expect(scrollToMock).toHaveBeenCalledWith(0, 0);
    expect(resetHistoryPositionMock).toHaveBeenCalledTimes(1);
  });
});

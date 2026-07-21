import React, { FC, useLayoutEffect, useMemo } from 'react';

import RootSuspenseFallback from 'app/a11y/RootSuspenseFallback';
import { OpenInFullPage, useAppEnv } from 'app/env';
import FullScreenPage from 'app/layouts/FullScreenPage';
import TabLayout from 'app/layouts/TabLayout';
import Explore from 'app/pages/Explore';
import OpenSidePanel from 'app/pages/OpenSidePanel';
import { Pending } from 'app/pages/Pending';
import { Receive } from 'app/pages/Receive';
import Settings from 'app/pages/Settings';
import Unlock from 'app/pages/Unlock';
import Welcome from 'app/pages/Welcome';
import { useMidenContext } from 'lib/miden/front';
import * as Woozie from 'lib/woozie';
import EarnDepositAmount from 'screens/earn-flow/EarnDepositAmount';
import EarnDepositReview from 'screens/earn-flow/EarnDepositReview';
import EarnPositionDetail from 'screens/earn-flow/EarnPositionDetail';
import EarnPositions from 'screens/earn-flow/EarnPositions';
import EarnVaultDetail from 'screens/earn-flow/EarnVaultDetail';
import { GeneratingTransactionPage } from 'screens/generating-transaction/GeneratingTransaction';
import { ReviewTransaction } from 'screens/send-flow/ReviewTransaction';
import { SendFlow } from 'screens/send-flow/SendManager';
import { SwapFlow } from 'screens/swap-flow/SwapManager';

import AllHistory from './pages/AllHistory';
import Browser from './pages/Browser';
import ForgotPassword from './pages/ForgotPassword/ForgotPassword';
import ForgotPasswordInfo from './pages/ForgotPassword/ForgotPasswordInfo';
import ResetRequired from './pages/ResetRequired';
import TokenDetail from './pages/TokenDetail';
import { resolveRootView } from './root-view';
import { HistoryDetails } from './templates/history/HistoryDetails';

interface RouteContext {
  popup: boolean;
  fullPage: boolean;
  ready: boolean;
  locked: boolean;
  hydrated: boolean;
}

type RouteFactory = Woozie.Router.ResolveResult<RouteContext>;

const ROUTE_MAP = Woozie.Router.createMap<RouteContext>([
  // Onboarding → side panel handoff (Chrome). Placed before the `!ready`
  // catch-all so it renders regardless of Ready: creating the wallet flips the
  // app to the wallet home, and this screen must survive that to let the user
  // open the panel. Still defers to Unlock when locked (e.g. the wallet
  // auto-locks while a tab is parked here) by SKIPping to the `*` catch-all.
  ['/finish-side-panel', (_p, ctx) => (ctx.locked ? Woozie.Router.SKIP : <OpenSidePanel />)],
  ['/reset-required', () => <ResetRequired />],
  [
    '/reset-wallet',
    (_p, ctx) => {
      switch (true) {
        case !ctx.fullPage:
          return <OpenInFullPage />;

        default:
          return <ForgotPassword />;
      }
    }
  ],
  ['/forgot-password-info', () => <ForgotPasswordInfo />],
  [
    '/forgot-password',
    (_p, ctx) => {
      switch (true) {
        case ctx.ready:
          return Woozie.Router.SKIP;

        case !ctx.fullPage:
          return <OpenInFullPage />;

        default:
          return <ForgotPassword />;
      }
    }
  ],
  [
    '*',
    (_p, ctx) => {
      switch (resolveRootView(ctx)) {
        case 'unlock':
          return <Unlock />;

        // Backend not yet heard from (MV3 SW cold-start): show the loading
        // spinner, NOT onboarding — status is still the initial Idle here.
        case 'loading':
          return <RootSuspenseFallback />;

        case 'welcome':
          return <Welcome />;

        default:
          return Woozie.Router.SKIP;
      }
    }
  ],
  // Tab pages - wrapped in TabLayout with persistent footer
  [
    '/',
    (_p, ctx) => {
      switch (resolveRootView(ctx)) {
        case 'app':
          return (
            <TabLayout>
              <Explore />
            </TabLayout>
          );

        case 'unlock':
          return <Unlock />;

        case 'loading':
          return <RootSuspenseFallback />;

        default:
          return <Welcome />;
      }
    }
  ],
  [
    '/history/:programId?',
    onlyReady(({ programId }) => (
      <TabLayout>
        <AllHistory programId={programId} />
      </TabLayout>
    ))
  ],
  [
    '/settings/:tabSlug?',
    onlyReady(({ tabSlug }) => (
      <FullScreenPage>
        <Settings tabSlug={tabSlug} />
      </FullScreenPage>
    ))
  ],
  [
    '/browser',
    onlyReady(() => (
      <TabLayout>
        <Browser />
      </TabLayout>
    ))
  ],
  // Full-screen pages - wrapped in FullScreenPage for slide animation
  [
    '/receive',
    onlyReady(() => (
      <TabLayout>
        <Receive />
      </TabLayout>
    ))
  ],
  [
    '/pending',
    onlyReady(() => (
      <FullScreenPage>
        <Pending />
      </FullScreenPage>
    ))
  ],
  [
    '/history-details/:transactionId',
    onlyReady(({ transactionId }) => (
      <FullScreenPage>
        <HistoryDetails transactionId={transactionId!} />
      </FullScreenPage>
    ))
  ],
  [
    '/token-detail/:tokenId',
    onlyReady(({ tokenId }) => (
      <FullScreenPage>
        <TokenDetail tokenId={tokenId!} />
      </FullScreenPage>
    ))
  ],
  [
    // Full-screen review page — registered before /send (earn convention).
    // The send form hands off here via query params; see send-flow/send-draft.ts.
    '/send/review',
    onlyReady(() => (
      <FullScreenPage>
        <ReviewTransaction />
      </FullScreenPage>
    ))
  ],
  [
    '/send',
    onlyReady(() => (
      <TabLayout>
        <SendFlow isLoading={false} />
      </TabLayout>
    ))
  ],
  [
    '/swap',
    onlyReady(() => (
      <TabLayout>
        <SwapFlow />
      </TabLayout>
    ))
  ],
  [
    '/earn/vaults/:vaultId/deposit/review',
    onlyReady(({ vaultId }) => (
      <FullScreenPage>
        <EarnDepositReview vaultId={vaultId!} />
      </FullScreenPage>
    ))
  ],
  [
    '/earn/vaults/:vaultId/deposit',
    onlyReady(({ vaultId }) => (
      <FullScreenPage>
        <EarnDepositAmount vaultId={vaultId!} />
      </FullScreenPage>
    ))
  ],
  [
    '/earn/vaults/:vaultId',
    onlyReady(({ vaultId }) => (
      <FullScreenPage>
        <EarnVaultDetail vaultId={vaultId!} />
      </FullScreenPage>
    ))
  ],
  [
    '/earn/positions/:positionId',
    onlyReady(({ positionId }) => (
      <FullScreenPage>
        <EarnPositionDetail positionId={positionId!} />
      </FullScreenPage>
    ))
  ],
  [
    '/earn/positions',
    onlyReady(() => (
      <FullScreenPage>
        <EarnPositions />
      </FullScreenPage>
    ))
  ],
  [
    '/earn',
    onlyReady(() => (
      <TabLayout>
        <></>
      </TabLayout>
    ))
  ],
  [
    '/generating-transaction/:txId',
    onlyReady(({ txId }) => (
      <FullScreenPage>
        <GeneratingTransactionPage txId={txId!} />
      </FullScreenPage>
    ))
  ],
  [
    '/generating-transaction-full/:txId',
    onlyReady(({ txId }) => (
      <FullScreenPage>
        <GeneratingTransactionPage txId={txId!} keepOpen={true} />
      </FullScreenPage>
    ))
  ],
  ['*', () => <Woozie.Redirect to="/" />]
]);

const PageRouter: FC = () => {
  const { trigger, pathname } = Woozie.useLocation();

  // Scroll to top after new location pushed.
  useLayoutEffect(() => {
    if (trigger === Woozie.HistoryAction.Push) {
      window.scrollTo(0, 0);
    }

    if (pathname === '/') {
      Woozie.resetHistoryPosition();
    }
  }, [trigger, pathname]);

  const appEnv = useAppEnv();
  const miden = useMidenContext();

  const ctx = useMemo<RouteContext>(
    () => ({
      popup: appEnv.popup,
      fullPage: appEnv.fullPage,
      ready: miden.ready,
      locked: miden.locked,
      hydrated: miden.hydrated
    }),
    [appEnv.popup, appEnv.fullPage, miden]
  );

  return useMemo(() => Woozie.Router.resolve(ROUTE_MAP, pathname, ctx), [pathname, ctx]);
};

export default PageRouter;

function onlyReady(factory: RouteFactory): RouteFactory {
  return (params, ctx) => (ctx.ready ? factory(params, ctx) : Woozie.Router.SKIP);
}

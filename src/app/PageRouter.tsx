import React, { FC, useLayoutEffect, useMemo } from 'react';

import { OpenInFullPage, useAppEnv } from 'app/env';
import FullScreenPage from 'app/layouts/FullScreenPage';
import TabLayout from 'app/layouts/TabLayout';
import CreateAccount from 'app/pages/CreateAccount';
import Explore from 'app/pages/Explore';
import Faucet from 'app/pages/Faucet';
import ImportAccount from 'app/pages/ImportAccount';
import { Receive } from 'app/pages/Receive';
import Settings from 'app/pages/Settings';
import Unlock from 'app/pages/Unlock';
import Welcome from 'app/pages/Welcome';
import { useMidenContext } from 'lib/miden/front';
import * as Woozie from 'lib/woozie';
import { ConsumingNotePage } from 'screens/consuming-note/ConsumingNote';
import { EncryptedFileFlow } from 'screens/encrypted-file-flow/EncryptedFileManager';
import { GeneratingTransactionPage } from 'screens/generating-transaction/GeneratingTransaction';
import { SendFlow } from 'screens/send-flow/SendManager';

import RootSuspenseFallback from './a11y/RootSuspenseFallback';
import AllHistory from './pages/AllHistory';
import Browser from './pages/Browser';
import EditAccountName from './pages/EditAccountName';
import ForgotPassword from './pages/ForgotPassword/ForgotPassword';
import ForgotPasswordInfo from './pages/ForgotPassword/ForgotPasswordInfo';
import { GetTokens } from './pages/GetTokens';
import ImportNotePending from './pages/ImportNotePending';
import ImportNoteResult from './pages/ImportNoteResult';
import ManageAssets from './pages/ManageAssets';
import ResetRequired from './pages/ResetRequired';
import SelectAccount from './pages/SelectAccount';
import TokenHistory from './pages/TokenHistory';
import { HistoryDetails } from './templates/history/HistoryDetails';

interface RouteContext {
  popup: boolean;
  fullPage: boolean;
  ready: boolean;
  locked: boolean;
}

type RouteFactory = Woozie.Router.ResolveResult<RouteContext>;

const ROUTE_MAP = Woozie.Router.createMap<RouteContext>([
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
      console.log('LOCKED STATUS', ctx);
      switch (true) {
        case ctx.locked:
          return <Unlock />;

        case !ctx.ready:
          return <Welcome />;

        default:
          return Woozie.Router.SKIP;
      }
    }
  ],
  ['/loading', (_p, ctx) => (ctx.ready ? <Woozie.Redirect to={'/'} /> : <RootSuspenseFallback />)],
  // Tab pages - wrapped in TabLayout with persistent footer
  [
    '/',
    (_p, ctx) =>
      ctx.ready ? (
        <TabLayout>
          <Explore />
        </TabLayout>
      ) : (
        <Welcome />
      )
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
      <TabLayout>
        <Settings tabSlug={tabSlug} />
      </TabLayout>
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
    '/select-account',
    onlyReady(() => (
      <FullScreenPage>
        <SelectAccount />
      </FullScreenPage>
    ))
  ],
  [
    '/create-account',
    onlyReady(() => (
      <FullScreenPage>
        <CreateAccount />
      </FullScreenPage>
    ))
  ],
  [
    '/edit-name',
    onlyReady(() => (
      <FullScreenPage>
        <EditAccountName />
      </FullScreenPage>
    ))
  ],
  [
    '/import-account/:tabSlug?',
    onlyReady(({ tabSlug }) => (
      <FullScreenPage>
        <ImportAccount tabSlug={tabSlug} />
      </FullScreenPage>
    ))
  ],
  [
    '/receive',
    onlyReady(() => (
      <FullScreenPage>
        <Receive />
      </FullScreenPage>
    ))
  ],
  [
    '/faucet',
    onlyReady(() => (
      <FullScreenPage>
        <Faucet />
      </FullScreenPage>
    ))
  ],
  [
    '/get-tokens',
    onlyReady(() => (
      <FullScreenPage>
        <GetTokens />
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
    '/token-history/:tokenId',
    onlyReady(({ tokenId }) => (
      <FullScreenPage>
        <TokenHistory tokenId={tokenId!} />
      </FullScreenPage>
    ))
  ],
  [
    '/manage-assets/:assetType?',
    onlyReady(({ assetType }) => (
      <FullScreenPage>
        <ManageAssets assetType={assetType!} />
      </FullScreenPage>
    ))
  ],
  [
    '/send',
    onlyReady(() => (
      <FullScreenPage>
        <SendFlow isLoading={false} />
      </FullScreenPage>
    ))
  ],
  [
    '/encrypted-wallet-file',
    onlyReady(() => (
      <FullScreenPage>
        <EncryptedFileFlow />
      </FullScreenPage>
    ))
  ],
  [
    '/generating-transaction',
    onlyReady(() => (
      <FullScreenPage>
        <GeneratingTransactionPage />
      </FullScreenPage>
    ))
  ],
  [
    '/generating-transaction-full',
    onlyReady(() => (
      <FullScreenPage>
        <GeneratingTransactionPage keepOpen={true} />
      </FullScreenPage>
    ))
  ],
  [
    '/consuming-note/:noteId',
    onlyReady(({ noteId }) => (
      <FullScreenPage>
        <ConsumingNotePage noteId={noteId!} />
      </FullScreenPage>
    ))
  ],
  [
    '/import-note-pending/:noteId',
    onlyReady(({ noteId }) => (
      <FullScreenPage>
        <ImportNotePending noteId={noteId!} />
      </FullScreenPage>
    ))
  ],
  [
    '/import-note-success',
    onlyReady(() => (
      <FullScreenPage>
        <ImportNoteResult success={true} />
      </FullScreenPage>
    ))
  ],
  [
    '/import-note-failure',
    onlyReady(() => (
      <FullScreenPage>
        <ImportNoteResult success={false} />
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
      locked: miden.locked
    }),
    [appEnv.popup, appEnv.fullPage, miden]
  );

  return useMemo(() => Woozie.Router.resolve(ROUTE_MAP, pathname, ctx), [pathname, ctx]);
};

export default PageRouter;

function onlyReady(factory: RouteFactory): RouteFactory {
  return (params, ctx) => (ctx.ready ? factory(params, ctx) : Woozie.Router.SKIP);
}

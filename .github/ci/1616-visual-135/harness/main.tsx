import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { I18nextProvider } from 'react-i18next';
import { SWRConfig } from 'swr';

import i18n from '../../../src/i18n';
import '../../../src/main.css';
import AwaitFonts from '../../../src/app/a11y/AwaitFonts';
import FullScreenPage from '../../../src/app/layouts/FullScreenPage';
import { PageActiveContext } from '../../../src/app/layouts/page-active';
import { EvmBridgeDepositStatus } from '../../../src/app/templates/EvmConnectModal/EvmBridgeDepositStatus';
import { applyTheme } from '../../../src/lib/settings/theme';
import EarnDepositAmount from '../../../src/screens/earn-flow/EarnDepositAmount';
import { SelectAmount } from '../../../src/screens/send-flow/SelectAmount';
import { boundaryCalls, COLLATERAL_ID, failBridge, forbidden, scenario, TX_ID, VAULT_ID } from './data';

const themes = ['light', 'dark'] as const;
const theme = new URLSearchParams(location.search).get('theme');
if (!themes.includes(theme as (typeof themes)[number])) throw new Error('Missing visual theme');
applyTheme(theme as (typeof themes)[number]);
await i18n.changeLanguage('en');

function App() {
  if (scenario === 'bridge-empty-failure') {
    return <EvmBridgeDepositStatus txId={TX_ID} newSubmissionTxId={TX_ID} onDone={() => undefined} />;
  }
  if (
    scenario === 'earn-no-collateral' ||
    scenario === 'earn-selected-unknown-metadata' ||
    scenario === 'earn-feature-unavailable'
  ) {
    return <EarnDepositAmount vaultId={VAULT_ID} />;
  }
  if (scenario === 'amount-helper-without-error' || scenario === 'amount-visible-error') {
    const invalid = scenario === 'amount-visible-error';
    return (
      <SelectAmount
        token={{ id: COLLATERAL_ID, name: 'USDC', decimals: 6, balance: 200, fiatPrice: 0, scaleIsKnown: true }}
        amount="12.5"
        isValidAmount={!invalid}
        errorId="invalidAmount"
        error={invalid ? 'invalidAmount' : undefined}
        onAmountChange={() => forbidden('amount mutation')}
        onSelectToken={() => forbidden('token selection')}
        onConfirm={() => forbidden('confirmation')}
        pageInset
        showNetworkPill={false}
      />
    );
  }
  return forbidden('unknown scenario');
}

Object.assign(window, {
  __displayAcceptance: {
    failBridge,
    boundaryCalls,
    copy: Object.fromEntries(
      [
        'transactionErrorDescription',
        'bridgeDepositFailed',
        'done',
        'available',
        'invalidAmount',
        'unknownTokenScale',
        'earnCollateralLoading',
        'bridgeFeatureUnavailableTitle',
        'bridgeFeatureUnavailableBody'
      ].map(key => [key, i18n.t(key)])
    )
  }
});
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={i18n}>
    <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, revalidateOnReconnect: false }}>
      <MotionConfig reducedMotion="always">
        <PageActiveContext.Provider value={true}>
          <React.Suspense fallback={null}>
            <AwaitFonts name="Inter" weights={[400, 500, 600]} className="antialiased font-inter">
              <AwaitFonts name="Nunito" weights={[700, 800]}>
                <FullScreenPage>
                  <App />
                </FullScreenPage>
              </AwaitFonts>
            </AwaitFonts>
          </React.Suspense>
        </PageActiveContext.Provider>
      </MotionConfig>
    </SWRConfig>
  </I18nextProvider>
);

import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody, HomeGroupPaneRoot } from 'app/layouts/HomeGroupPane';
import { AmountInput } from 'components/AmountInput';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { Numpad } from 'components/Numpad';
import { TokenLogo } from 'components/TokenLogo';
import { Button } from 'components/ui/Button';
import { Pill } from 'components/ui/Pill';
import { SegmentedControl } from 'components/ui/SegmentedControl';
import { TabRootHeader } from 'components/ui/TabRootHeader';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';

import CashProviders, { CashMode } from './CashProviders';

const routes: Route[] = [
  { name: 'amount', animationIn: 'push', animationOut: 'pop' },
  { name: 'providers', animationIn: 'push', animationOut: 'pop' }
];

const CashFlow = () => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<CashMode>('buy');
  const [amounts, setAmounts] = useState({ buy: '', sell: '' });
  const amount = amounts[mode];
  const decimals = mode === 'buy' ? 2 : 6;
  const label = t(mode === 'buy' ? 'cashPayAmount' : 'cashSellAmount');
  const { navigateTo, goBack, cardStack } = useNavigator();
  const canContinue = Number(amount) > 0;

  useMobileBackHandler(() => {
    if (cardStack.length < 2) return false;
    goBack();
    return true;
  }, [cardStack.length, goBack]);

  const updateAmount = (value = '') => {
    const normalized = value.replace(/^0+(?=\d)/, '');
    if (!/^\d*(\.\d*)?$/.test(normalized) || normalized.length > 14) return;
    if ((normalized.split('.')[1]?.length ?? 0) > decimals) return;
    setAmounts(previous => ({ ...previous, [mode]: normalized }));
  };

  const amountStep = (
    <>
      <TabRootHeader
        title={t('cash')}
        actions={
          <SegmentedControl<CashMode>
            items={[
              { id: 'buy', label: t('cashBuy') },
              { id: 'sell', label: t('cashSell') }
            ]}
            value={mode}
            onChange={setMode}
            aria-label={t('cashAction')}
          />
        }
      />
      <HomeGroupPaneBody
        top="header"
        footer={
          <Button className="w-full" disabled={!canContinue} onClick={() => canContinue && navigateTo('providers')}>
            {t('continue')}
          </Button>
        }
      >
        <div className="flex flex-1 flex-col gap-3">
          <AmountInput
            value={amount}
            onValueChange={updateAmount}
            inputMode="none"
            decimalsLimit={decimals}
            maxLength={14}
            size="hero"
            prefix={mode === 'buy' ? '$' : undefined}
            placeholder={mode === 'buy' ? '$0.00' : '0.00'}
            aria-label={label}
            data-testid="cash-amount"
            showDivider={false}
            label={
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-label text-muted">{label}</span>
                </div>
                <Pill>
                  <span className="flex items-center gap-2">
                    <TokenLogo symbol="USDCx" size="sm" />
                    <span>USDCx</span>
                  </span>
                </Pill>
              </div>
            }
          />
          <div className="flex flex-1 items-center justify-center">
            <Numpad
              size="amount"
              onDigit={digit => updateAmount(amount + digit)}
              onDecimal={() => updateAmount(amount.includes('.') ? amount : `${amount || '0'}.`)}
              onDelete={() => updateAmount(amount.slice(0, -1))}
            />
          </div>
        </div>
      </HomeGroupPaneBody>
    </>
  );

  return (
    <HomeGroupPaneRoot testId="cash-page">
      <Navigator
        renderRoute={route =>
          route.name === 'providers' ? <CashProviders mode={mode} amount={amount} onBack={goBack} /> : amountStep
        }
      />
    </HomeGroupPaneRoot>
  );
};

const Cash = () => (
  <NavigatorProvider routes={routes} initialRouteName="amount">
    <CashFlow />
  </NavigatorProvider>
);

export default Cash;

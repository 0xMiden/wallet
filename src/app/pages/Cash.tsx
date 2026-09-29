import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneRoot } from 'app/layouts/HomeGroupPane';
import { AmountInput } from 'components/AmountInput';
import { FlowLayout } from 'components/flow/FlowLayout';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { Numpad } from 'components/Numpad';
import { TokenLogo } from 'components/TokenLogo';
import { Button } from 'components/ui/Button';
import { Pill } from 'components/ui/Pill';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { goBack as leavePage } from 'lib/woozie';

import CashProviders, { CashAction } from './CashProviders';

// A token symbol is a name, not copy: it is not translated.
const USDCX_SYMBOL = 'USDCx';

const routes: Route[] = [
  { name: 'amount', animationIn: 'push', animationOut: 'pop' },
  { name: 'providers', animationIn: 'push', animationOut: 'pop' }
];

interface CashProps {
  action: CashAction;
}

const CashFlow = ({ action }: CashProps) => {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const decimals = action === 'buy' ? 2 : 6;
  const label = t(action === 'buy' ? 'cashPayAmount' : 'cashSellAmount');
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
    setAmount(normalized);
  };

  const amountStep = (
    <FlowLayout
      title={t(action === 'buy' ? 'cashBuyingUsdc' : 'cashSellingUsdc')}
      onBack={leavePage}
      footer={
        <Button className="w-full" disabled={!canContinue} onClick={() => canContinue && navigateTo('providers')}>
          {t('continue')}
        </Button>
      }
    >
      {/* The label row, the amount and the numpad are one block, centered in the page. */}
      <div className="flex flex-1 flex-col justify-center gap-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-title-tab text-ink">{label}</span>
            <Pill>
              <span className="flex items-center gap-2">
                <TokenLogo symbol={USDCX_SYMBOL} size="sm" />
                <span>{USDCX_SYMBOL}</span>
              </span>
            </Pill>
          </div>
          <AmountInput
            value={amount}
            onValueChange={updateAmount}
            inputMode="none"
            decimalsLimit={decimals}
            maxLength={14}
            size="hero"
            align="center"
            prefix={action === 'buy' ? '$' : undefined}
            placeholder={action === 'buy' ? '$0.00' : '0.00'}
            aria-label={label}
            data-testid="cash-amount"
            showDivider={false}
          />
        </div>
        <div className="flex justify-center">
          <Numpad
            size="amount"
            onDigit={digit => updateAmount(amount + digit)}
            onDecimal={() => updateAmount(amount.includes('.') ? amount : `${amount || '0'}.`)}
            onDelete={() => updateAmount(amount.slice(0, -1))}
          />
        </div>
      </div>
    </FlowLayout>
  );

  return (
    <HomeGroupPaneRoot testId="cash-page">
      <Navigator
        renderRoute={route =>
          route.name === 'providers' ? <CashProviders action={action} amount={amount} onBack={goBack} /> : amountStep
        }
      />
    </HomeGroupPaneRoot>
  );
};

const Cash = ({ action }: CashProps) => (
  <NavigatorProvider routes={routes} initialRouteName="amount">
    <CashFlow action={action} />
  </NavigatorProvider>
);

export default Cash;

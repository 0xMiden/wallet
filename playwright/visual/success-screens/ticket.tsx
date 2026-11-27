// One Swap success design, worked through: the trade as a ticket. The shell, buttons, token logos,
// icons, type scale and colours are the app's own. Nothing here ships: it exists to be looked at.
import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { Button, ButtonVariant } from '../../../src/components/Button';
import { FlowLayout } from '../../../src/components/flow/FlowLayout';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { IETH, USDCX } from './fixture';

const swap = 'var(--accent-swap)';
const swapTint = 'var(--accent-swap-tint)';
const swapInk = 'var(--accent-swap-ink)';

const Side: FC<{
  label: string;
  amount: string;
  token: string;
  faucetId: string;
  tinted?: boolean;
  foot: React.ReactNode;
  className?: string;
}> = ({ label, amount, token, faucetId, tinted, foot, className }) => (
  <div className={`rounded-[28px] px-5 ${className ?? ''}`} style={{ background: tinted ? swapTint : 'var(--ds-fill)' }}>
    <div className="flex items-center justify-between">
      <span className="font-heading text-sm font-bold" style={{ color: tinted ? swapInk : 'var(--ds-muted)' }}>
        {label}
      </span>
      <TokenLogo faucetId={faucetId} size="md" />
    </div>
    <div className="mt-1 flex items-baseline gap-2 font-heading font-extrabold text-ink">
      <span className="text-[44px] leading-[48px] tracking-tight">{amount}</span>
      <span className="text-[22px] leading-7 text-muted">{token}</span>
    </div>
    <div
      className="mt-3 flex items-center gap-1.5 font-heading text-[13px] font-bold leading-5"
      style={{ color: tinted ? swapInk : 'var(--ds-muted)' }}
    >
      {foot}
    </div>
  </div>
);

export const SwapTicket: FC = () => {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
      <FlowLayout
        title={t('success')}
        onClose={() => undefined}
        footer={
          <div className="flex w-full flex-col items-center gap-3">
            <Button
              type="button"
              variant={ButtonVariant.Primary}
              accent="swap"
              title={t('done')}
              onClick={() => undefined}
              className="w-full max-w-none"
            />
            <Button
              type="button"
              variant={ButtonVariant.Secondary}
              accent="swap"
              title={t('viewInActivities')}
              onClick={() => undefined}
              className="w-full max-w-none"
            />
          </div>
        }
      >
        <section className="tx-stage-rise flex w-full flex-col pt-5" style={{ minHeight: '100%' }}>
          <h2 className="font-heading text-[28px] font-extrabold leading-9 text-ink">{t('swapOrderCreated')}</h2>
          <p className="mt-1 font-heading text-[15px] font-semibold leading-6 text-muted">
            Usually fills in about 30 seconds.
          </p>

          <div className="my-auto flex flex-col py-5">
            <Side
              label={t('youPay')}
              amount="25"
              token="USDCX"
              faucetId={USDCX}
              className="pb-8 pt-4"
              foot={
                <>
                  <Icon name={IconName.LockFilled} size="xs" fill="currentColor" />
                  Reserved until the order fills
                </>
              }
            />
            <div className="relative z-10 -my-5 flex justify-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-page shadow-[0_0_0_1px_var(--ds-hairline)]">
                <Icon name={IconName.ArrowDown} size="sm" fill="var(--ds-ink)" />
              </span>
            </div>
            <Side
              label={t('youReceive')}
              amount="0.0071"
              token="Test iETH"
              faucetId={IETH}
              tinted
              className="pb-4 pt-8"
              foot={
                <>
                  <span className="relative flex size-2 shrink-0">
                    <span
                      className="absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
                      style={{ background: swap }}
                    />
                    <span className="relative inline-flex size-2 rounded-full" style={{ background: swap }} />
                  </span>
                  Sourcing liquidity
                </>
              }
            />
          </div>

          <div className="flex items-center justify-between border-t border-hairline pb-4 pt-4 font-heading">
            <span className="text-sm font-semibold text-muted">{t('networkFee')}</span>
            <span className="text-[15px] font-extrabold text-ink">0.01 USDCX</span>
          </div>
        </section>
      </FlowLayout>
    </div>
  );
};

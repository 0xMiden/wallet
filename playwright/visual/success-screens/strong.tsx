// Five structural designs for the Swap success screen. The shell (header, pinned buttons), the
// buttons, the receipt card, the type scale and the colours are the app's own; the arrangement
// and a few short labels are proposals. Nothing here ships: it exists to be looked at.
import React, { FC, ReactNode } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as InfoIcon } from '../../../src/app/icons/information.svg';
import { Button, ButtonVariant } from '../../../src/components/Button';
import { FlowLayout } from '../../../src/components/flow/FlowLayout';
import { ReceiptRows, SuccessHero } from '../../../src/screens/generating-transaction/success/TransactionSuccessLayout';

export type StrongVariant = 'ticket' | 'timeline' | 'receive' | 'ring' | 'band';

// The fixture's order, as the screens above print it.
const PAY = { amount: '25', token: 'USDCX' };
const GET = { amount: '0.0071', token: 'Test iETH' };
const FEE = '0.01 USDCX';

const swap = 'var(--accent-swap)';
const swapTint = 'var(--accent-swap-tint)';
const swapInk = 'var(--accent-swap-ink)';

/** A dot that breathes: the order is still filling. Still under reduced motion. */
const LiveDot: FC<{ color?: string }> = ({ color = swap }) => (
  <span className="relative flex size-2.5 shrink-0">
    <span
      className="absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
      style={{ background: color }}
    />
    <span className="relative inline-flex size-2.5 rounded-full" style={{ background: color }} />
  </span>
);

const Shell: FC<{ children: ReactNode }> = ({ children }) => {
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
        <section className="tx-stage-rise flex w-full flex-col pt-6">{children}</section>
      </FlowLayout>
    </div>
  );
};

const FeeLine: FC = () => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between border-t border-hairline py-3 font-heading">
      <span className="text-sm font-semibold text-muted">{t('networkFee')}</span>
      <span className="text-[15px] font-extrabold text-ink">{FEE}</span>
    </div>
  );
};

export const SwapStrong: FC<{ variant: StrongVariant }> = ({ variant }) => {
  const { t } = useTranslation();
  const reserved = t('swapOrderReservedNote', { amount: `${PAY.amount} ${PAY.token}` });
  const sourcing = t('swapSuccessSourcingLiquidity');
  const track = t('swapSuccessTrackProgress');
  const title = t('swapOrderCreated');

  if (variant === 'ticket') {
    return (
      <Shell>
        <h2 className="font-heading text-[26px] font-extrabold leading-8 text-ink">{title}</h2>
        <div className="mt-2 flex items-center gap-2 font-heading text-sm font-semibold" style={{ color: swapInk }}>
          <LiveDot />
          <span>{sourcing}</span>
        </div>

        {/* The trade itself: what leaves, what arrives, joined at the seam. */}
        <div className="mt-6 flex flex-col">
          <div className="rounded-3xl bg-fill px-5 pb-7 pt-4">
            <div className="font-heading text-sm font-semibold text-muted">{t('youPay')}</div>
            <div className="mt-1 font-heading text-[34px] font-extrabold leading-10 text-ink">
              {PAY.amount} <span className="text-[22px] text-muted">{PAY.token}</span>
            </div>
          </div>
          <div className="relative z-10 -my-4 flex justify-center">
            <span className="flex size-9 items-center justify-center rounded-full border border-hairline bg-page font-heading text-lg font-extrabold text-ink">
              ↓
            </span>
          </div>
          <div className="rounded-3xl px-5 pb-4 pt-7" style={{ background: swapTint }}>
            <div className="font-heading text-sm font-semibold" style={{ color: swapInk }}>
              {t('youReceive')}
            </div>
            <div className="mt-1 font-heading text-[34px] font-extrabold leading-10 text-ink">
              {GET.amount} <span className="text-[22px] text-muted">{GET.token}</span>
            </div>
          </div>
        </div>

        <div className="mt-5">
          <FeeLine />
          <p className="border-t border-hairline pt-3 font-heading text-[13px] font-semibold leading-5 text-muted">
            {reserved} {track}
          </p>
        </div>
      </Shell>
    );
  }

  if (variant === 'timeline') {
    const steps = [
      { state: 'done', name: 'Order created', body: reserved },
      { state: 'live', name: 'Sourcing liquidity', body: 'It usually fills in about 30 seconds.' },
      { state: 'next', name: 'Filled', body: `${GET.amount} ${GET.token} arrives in your wallet.` }
    ];
    return (
      <Shell>
        <div className="flex flex-col items-center">
          <SuccessHero />
          <h2 className="mt-4 text-center text-hero-name text-ink">{title}</h2>
          <div className="mt-1 font-heading text-[17px] font-extrabold text-ink">
            {PAY.amount} {PAY.token} <span className="text-muted">→</span> {GET.amount} {GET.token}
          </div>
        </div>

        {/* What happens next, in order: the order is created, not yet filled. */}
        <ol className="mt-6 flex flex-col rounded-2xl border border-hairline px-4 py-4">
          {steps.map((step, index) => (
            <li key={step.name} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className="flex size-6 shrink-0 items-center justify-center rounded-full font-heading text-xs font-extrabold text-white"
                  style={{
                    background: step.state === 'done' ? 'var(--status-positive)' : step.state === 'live' ? swap : 'transparent',
                    boxShadow: step.state === 'next' ? 'inset 0 0 0 2px var(--ds-hairline)' : undefined
                  }}
                >
                  {step.state === 'done' ? '✓' : step.state === 'live' ? <LiveDot color="#fff" /> : null}
                </span>
                {index < steps.length - 1 && <span className="my-1 w-0.5 flex-1 rounded-full bg-fill-pressed" />}
              </div>
              <div className={index < steps.length - 1 ? 'pb-5' : ''}>
                <div className={`font-heading text-[15px] font-extrabold ${step.state === 'next' ? 'text-muted' : 'text-ink'}`}>
                  {step.name}
                </div>
                <div className="mt-0.5 font-heading text-[13px] font-semibold leading-5 text-muted">{step.body}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-4">
          <FeeLine />
        </div>
      </Shell>
    );
  }

  if (variant === 'receive') {
    return (
      <Shell>
        <span
          className="inline-flex items-center gap-2 self-start rounded-full px-3 py-1.5 font-heading text-sm font-extrabold"
          style={{ background: swapTint, color: swapInk }}
        >
          <LiveDot />
          Filling
        </span>

        {/* One figure owns the screen: what is on its way to you. */}
        <div className="mt-5 font-heading text-sm font-semibold text-muted">{t('youReceive')}</div>
        <div className="font-heading text-[64px] font-extrabold leading-[68px] tracking-tight text-ink">{GET.amount}</div>
        <div className="font-heading text-[26px] font-extrabold leading-8 text-muted">{GET.token}</div>
        <div className="mt-3 font-heading text-[17px] font-extrabold text-ink">
          <span className="text-muted">for</span> {PAY.amount} {PAY.token}
        </div>

        <div className="mt-6">
          <FeeLine />
          <div className="flex items-center justify-between border-t border-hairline py-3 font-heading">
            <span className="text-sm font-semibold text-muted">Reserved until filled</span>
            <span className="text-[15px] font-extrabold text-ink">
              {PAY.amount} {PAY.token}
            </span>
          </div>
          <p className="border-t border-hairline pt-3 font-heading text-[13px] font-semibold leading-5 text-muted">
            {sourcing} {track}
          </p>
        </div>
      </Shell>
    );
  }

  if (variant === 'ring') {
    return (
      <Shell>
        <div className="flex flex-col items-center">
          {/* Not a finished check: a ring still turning around the swap, in the swap colour. */}
          <div className="relative flex size-28 items-center justify-center">
            <svg className="absolute inset-0 animate-spin motion-reduce:animate-none" style={{ animationDuration: '2.4s' }} viewBox="0 0 112 112">
              <circle cx="56" cy="56" r="50" fill="none" stroke="var(--ds-fill-pressed)" strokeWidth="8" />
              <circle
                cx="56"
                cy="56"
                r="50"
                fill="none"
                stroke={swap}
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray="110 314"
              />
            </svg>
            <span className="font-heading text-[34px] font-extrabold" style={{ color: swapInk }}>
              ⇄
            </span>
          </div>
          <h2 className="mt-4 text-center text-hero-name text-ink">{title}</h2>
          <p className="mt-1 text-center font-heading text-[15px] font-semibold text-muted">It usually fills in about 30 seconds.</p>
        </div>

        <ReceiptRows
          rows={[
            { label: t('youPay'), value: `${PAY.amount} ${PAY.token}` },
            { label: t('youReceive'), value: `${GET.amount} ${GET.token}` },
            { label: t('networkFee'), value: FEE }
          ]}
          className="mt-6"
        />
        <div className="mt-4 flex w-full items-start gap-1.5 font-heading text-[13px] font-semibold leading-5 text-muted">
          <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 fill-current" />
          <span>
            {reserved} {track}
          </span>
        </div>
      </Shell>
    );
  }

  // band
  return (
    <Shell>
      {/* The order's state as one solid block in the swap colour, with a runner while it fills. */}
      <div className="rounded-3xl px-5 py-5 text-white" style={{ background: swap }}>
        <h2 className="font-heading text-[24px] font-extrabold leading-8">{title}</h2>
        <div className="mt-4 font-heading text-[30px] font-extrabold leading-9">
          {PAY.amount} {PAY.token}
        </div>
        <div className="font-heading text-[30px] font-extrabold leading-9">
          <span className="opacity-70">→</span> {GET.amount} {GET.token}
        </div>
        <div className="relative mt-5 h-1.5 overflow-hidden rounded-full bg-white/25">
          <span className="swap-band-runner absolute inset-y-0 w-1/3 rounded-full bg-white" />
        </div>
        <div className="mt-3 font-heading text-sm font-semibold text-white/85">{sourcing}</div>
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between py-3 font-heading">
          <span className="text-sm font-semibold text-muted">{t('networkFee')}</span>
          <span className="text-[15px] font-extrabold text-ink">{FEE}</span>
        </div>
        <p className="border-t border-hairline pt-3 font-heading text-[13px] font-semibold leading-5 text-muted">
          {reserved} {track}
        </p>
      </div>
    </Shell>
  );
};

// Bread's Send success drawn in the manner of nine shipped apps. Bread's own font, colours, buttons,
// token logo, avatar and brand mark throughout; the arrangement of each is borrowed. The copy
// in the sentence headlines is proposed. Nothing here ships: it exists to be looked at.
import React, { FC, ReactNode } from 'react';

import { ReactComponent as BreadMark } from '../../../src/app/icons/brand/new-bread.svg';
import { Icon, IconName } from '../../../src/app/icons/v2';
import { Button, ButtonVariant } from '../../../src/components/Button';
import { FlowLayout } from '../../../src/components/flow/FlowLayout';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { Avatar } from '../../../src/components/ui/Avatar';
import { CopyChip } from '../../../src/components/ui/CopyChip';
import { HeaderRule } from '../../../src/components/ui/HeaderRule';
import { SuccessHero } from '../../../src/screens/generating-transaction/success/TransactionSuccessLayout';
import { USDCX } from './fixture';

export type SendStyle = 'yours' | 'centered' | 'stacked' | 'sharp' | 'guide' | 'm1' | 'm2' | 'm3' | 'wise' | 'cashapp' | 'kraken' | 'coinbase' | 'monzo' | 'gojek' | 'worldapp' | 'wealthsimple' | 'chime';

const AMOUNT = '25 USDCX';
const TO = 'mtst1apq…wk6x';
const TO_FULL = 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x';
const FEE = '0.01 USDCX';
const TXID = '0x91c4…07a4';

const orange = 'var(--accent-primary)';
const ink = 'var(--ds-ink)';

const Check: FC<{ size: number; stroke?: string; width?: number }> = ({ size, stroke = '#fff', width = 5 }) => (
  <svg width={size} height={size} viewBox="0 0 44 44" fill="none" aria-hidden="true">
    <path d="M11 23L18.5 30.5L33 15" stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Screen: FC<{ children: ReactNode; className?: string; style?: React.CSSProperties }> = ({ children, className, style }) => (
  <div className={`tx-stage-rise flex h-full w-full flex-col px-4 pb-6 pt-14 font-heading ${className ?? ''}`} style={style}>
    {children}
  </div>
);

const Actions: FC<{ second?: string; accent?: 'brand' | 'send'; firstTitle?: string }> = ({ second, accent = 'brand', firstTitle = 'Done' }) => (
  <div className="mt-auto flex w-full flex-col gap-3">
    <Button type="button" variant={ButtonVariant.Primary} accent={accent} title={firstTitle} onClick={() => undefined} className="w-full max-w-none" />
    {second && (
      <Button type="button" variant={ButtonVariant.Secondary} accent={accent} title={second} onClick={() => undefined} className="w-full max-w-none" />
    )}
  </div>
);

const Row: FC<{ label: string; children: ReactNode; last?: boolean }> = ({ label, children, last }) => (
  <div className={`flex items-center justify-between py-3.5 ${last ? '' : 'border-b border-hairline'}`}>
    <span className="text-[15px] font-semibold text-muted">{label}</span>
    <span className="text-[15px] font-extrabold text-ink">{children}</span>
  </div>
);

export const SendInStyle: FC<{ style: SendStyle; amount?: string; to?: string; faucetId?: string }> = ({ style, amount, to, faucetId }) => {
  if (style === 'yours' || style === 'centered') {
    const centered = style === 'centered';
    // The user's own mock, built as drawn: the app's header and buttons, the check on the left edge,
    // "You sent" with the token and amount, the full address in a pill, a rule, then plain rows.
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
        <FlowLayout
          title="Success"
          onClose={() => undefined}
          footer={
            <div className="flex w-full flex-col items-center gap-3">
              <Button type="button" variant={ButtonVariant.Primary} accent="send" title="Done" onClick={() => undefined} className="w-full max-w-none" />
              <Button
                type="button"
                variant={ButtonVariant.Secondary}
                accent="send"
                title="View in Activities"
                onClick={() => undefined}
                className="w-full max-w-none"
              />
            </div>
          }
        >
          <section className="tx-stage-rise flex w-full flex-col pt-6 font-heading">
            <div className={centered ? 'self-center' : 'self-start'}>
              <SuccessHero />
            </div>
            <div
              className={`mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-extrabold tracking-[-0.02em] text-ink ${centered ? 'justify-center' : ''}`}
            >
              <span className="text-[32px] leading-10">You sent</span>
              {/* The logo belongs to the amount: a tighter gap on that side than between the words. */}
              <span className="inline-flex items-center gap-1.5">
                <TokenLogo faucetId={USDCX} size="sm" />
                <span className="text-[26px] leading-10">{AMOUNT}</span>
              </span>
            </div>
            <div className={`mt-1 flex items-center gap-2 ${centered ? 'justify-center' : ''}`}>
              <span className="text-[22px] font-extrabold leading-8 text-muted">to:</span>
              <span className="min-w-0 truncate rounded-full bg-fill px-2.5 py-1 text-[13px] font-extrabold leading-5 text-ink">{TO_FULL}</span>
            </div>
            <HeaderRule className="mt-4" />
            <div className="mt-1">
              <Row label="Total Paid">{AMOUNT}</Row>
              <Row label="Network Fee">{FEE}</Row>
              <Row label="Transaction ID" last>
                <span className="text-accent-tint-ink">{TXID}</span>
              </Row>
            </div>
          </section>
        </FlowLayout>
      </div>
    );
  }

  if (style === 'stacked') {
    // The user's third mock, as drawn: centred, "You sent" small over the amount large, the token
    // logo after the amount, and a smaller "to:" line.
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
        <FlowLayout
          title="Success"
          onClose={() => undefined}
          footer={
            <div className="flex w-full flex-col items-center gap-3">
              <Button type="button" variant={ButtonVariant.Primary} accent="send" title="Done" onClick={() => undefined} className="w-full max-w-none" />
              <Button
                type="button"
                variant={ButtonVariant.Secondary}
                accent="send"
                title="View in Activities"
                onClick={() => undefined}
                className="w-full max-w-none"
              />
            </div>
          }
        >
          <section className="tx-stage-rise flex w-full flex-col items-center pt-6 font-heading">
            <SuccessHero />
            <div className="mt-4 text-[20px] font-extrabold leading-7 tracking-[-0.01em] text-ink">You sent</div>
            <div className="flex items-center gap-1.5 font-extrabold tracking-[-0.02em] text-ink">
              <span className="text-[36px] leading-[44px]">{AMOUNT}</span>
              <TokenLogo faucetId={USDCX} size="sm" />
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-[14px] font-extrabold leading-5 text-muted">to:</span>
              <span className="min-w-0 truncate rounded-full bg-fill px-2 py-0.5 text-[11px] font-extrabold leading-4 text-ink">{TO_FULL}</span>
            </div>
            <HeaderRule className="mt-5 w-full" />
            <div className="mt-1 w-full">
              <Row label="Total Paid">{AMOUNT}</Row>
              <Row label="Network Fee">{FEE}</Row>
              <Row label="Transaction ID" last>
                <span className="text-accent-tint-ink">{TXID}</span>
              </Row>
            </div>
          </section>
        </FlowLayout>
      </div>
    );
  }

  if (style === 'sharp') {
    // The third mock with the top half put on one scale: every size and gap is a step of the same
    // rhythm, the token logo is as tall as the amount's capitals, and the address is readable.
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
        <FlowLayout
          title="Success"
          onClose={() => undefined}
          footer={
            <div className="flex w-full flex-col items-center gap-3">
              <Button type="button" variant={ButtonVariant.Primary} accent="send" title="Done" onClick={() => undefined} className="w-full max-w-none" />
              <Button
                type="button"
                variant={ButtonVariant.Secondary}
                accent="send"
                title="View in Activities"
                onClick={() => undefined}
                className="w-full max-w-none"
              />
            </div>
          }
        >
          <section className="tx-stage-rise flex w-full flex-col items-center pt-8 font-heading">
            <SuccessHero />
            <div className="mt-5 text-[17px] font-extrabold leading-6 text-muted">You sent</div>
            <div className="mt-0.5 flex items-center gap-2.5 font-extrabold tracking-[-0.02em] text-ink">
              <span className="text-[40px] leading-[48px]">{AMOUNT}</span>
              <TokenLogo faucetId={USDCX} size="md" />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[15px] font-extrabold leading-5 text-muted">to</span>
              <span className="min-w-0 truncate rounded-full bg-fill px-3 py-1 text-[13px] font-extrabold leading-5 text-ink">{TO_FULL}</span>
            </div>
            <HeaderRule className="mt-7 w-full" />
            <div className="mt-1 w-full">
              <Row label="Total Paid">{AMOUNT}</Row>
              <Row label="Network Fee">{FEE}</Row>
              <Row label="Transaction ID" last>
                <span className="text-accent-tint-ink">{TXID}</span>
              </Row>
            </div>
          </section>
        </FlowLayout>
      </div>
    );
  }

  if (style === 'guide') {
    // Built to the measurements in the user's Background.svg (391x850): check 64 at y96, "You sent"
    // 20px, amount 32px with the token mark right after it, a 35px address pill that fills the row
    // beside "to:", a rule at y289, then rows on a 53px pitch with no dividers.
    const rows: [string, ReactNode][] = [
      ['Total Paid', amount ?? AMOUNT],
      ['Network Fee', FEE],
      ['Transaction ID', <span key="id" className="text-accent-tint-ink">{TXID}</span>]
    ];
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
        <FlowLayout
          title="Success"
          onClose={() => undefined}
          footer={
            <div className="flex w-full flex-col items-center gap-3">
              <Button type="button" variant={ButtonVariant.Primary} accent="send" title="Done" onClick={() => undefined} className="w-full max-w-none" />
              <Button
                type="button"
                variant={ButtonVariant.Secondary}
                accent="send"
                title="View in Activities"
                onClick={() => undefined}
                className="w-full max-w-none"
              />
            </div>
          }
        >
          <section className="tx-stage-rise flex w-full flex-col items-center pt-8 font-heading">
            <SuccessHero />
            <div className="mt-3.5 text-[20px] font-extrabold leading-7 text-ink">You sent</div>
            <div className="flex items-center gap-1 font-extrabold text-ink">
              <span className="text-[32px] leading-10">{amount ?? AMOUNT}</span>
              <TokenLogo faucetId={faucetId ?? USDCX} size="sm" />
            </div>
            <div className="mt-1 flex w-full items-center gap-2">
              <span className="text-[17px] font-extrabold leading-6 text-muted">to:</span>
              <span className="flex h-[35px] min-w-0 flex-1 items-center justify-center rounded-full bg-fill px-2.5 text-[14px] font-extrabold text-ink">
                <span className="truncate">{to ?? TO_FULL}</span>
              </span>
            </div>
            <HeaderRule className="mt-4 w-full" />
            <div className="mt-1.5 w-full">
              {rows.map(([label, value]) => (
                <div key={label} className="flex h-[53px] items-center justify-between">
                  <span className="text-[15px] font-semibold text-muted">{label}</span>
                  <span className="text-[15px] font-extrabold text-ink">{value}</span>
                </div>
              ))}
            </div>
          </section>
        </FlowLayout>
      </div>
    );
  }

  if (style === 'm1' || style === 'm2' || style === 'm3') {
    // Three refinements of the user's mock. m1 tightens it; m2 lets the amount lead; m3 also uses the height.
    const amountLeads = style !== 'm1';
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
        <FlowLayout
          title="Success"
          onClose={() => undefined}
          footer={
            <div className="flex w-full flex-col items-center gap-3">
              <Button type="button" variant={ButtonVariant.Primary} accent="send" title="Done" onClick={() => undefined} className="w-full max-w-none" />
              <Button
                type="button"
                variant={ButtonVariant.Secondary}
                accent="send"
                title="View in Activities"
                onClick={() => undefined}
                className="w-full max-w-none"
              />
            </div>
          }
        >
          <section className="tx-stage-rise flex w-full flex-col pt-6 font-heading" style={style === 'm3' ? { minHeight: '100%' } : undefined}>
            <div className="self-start">
              <SuccessHero />
            </div>
            {amountLeads ? (
              <>
                <div className="mt-5 text-[22px] font-extrabold leading-7 text-muted">You sent</div>
                <div className="mt-1 flex items-center gap-3 font-extrabold text-ink">
                  <TokenLogo faucetId={USDCX} size="md" />
                  <span className="text-[44px] leading-[48px] tracking-tight">25</span>
                  <span className="text-[28px] leading-[48px] text-muted">USDCX</span>
                </div>
              </>
            ) : (
              <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[32px] font-extrabold leading-10 tracking-[-0.02em] text-ink">
                <span>You sent</span>
                <span className="inline-flex items-center gap-1.5">
                  <TokenLogo faucetId={USDCX} size="sm" />
                  <span>{AMOUNT}</span>
                </span>
              </div>
            )}
            <div className={`flex items-center gap-2 ${amountLeads ? 'mt-3' : 'mt-2'}`}>
              <span className="text-[17px] font-extrabold leading-6 text-muted">to</span>
              <CopyChip text={TO_FULL} aria-label="Copy address">
                {TO_FULL}
              </CopyChip>
            </div>
            <div className={style === 'm3' ? 'mt-auto pt-6' : 'mt-5'}>
              <HeaderRule />
              <div className="mt-1">
                <Row label="Network Fee">{FEE}</Row>
                <Row label="Transaction ID" last>
                  <span className="text-accent-tint-ink">{TXID}</span>
                </Row>
              </div>
            </div>
          </section>
        </FlowLayout>
      </div>
    );
  }

  if (style === 'wise') {
    // One colour, one huge mark, a few words.
    return (
      <Screen style={{ background: '#3b2415', color: '#fff' }}>
        <div className="flex flex-1 flex-col items-center justify-center">
          <svg width="230" height="200" viewBox="0 0 230 200" fill="none" aria-hidden="true">
            <path d="M30 108L88 166L206 40" stroke="#8f3d12" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round" transform="translate(6 10)" />
            <path d="M30 108L88 166L206 40" stroke={orange} strokeWidth="44" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="mt-8 text-[44px] font-extrabold leading-[48px]" style={{ color: '#f6a577' }}>
            Payment sent
          </div>
          <div className="mt-3 text-center text-[17px] font-semibold text-white/85">
            {AMOUNT} is on its way to {TO}
          </div>
        </div>
        <Actions />
      </Screen>
    );
  }

  if (style === 'cashapp') {
    // A check and one sentence. The receipt is a button.
    return (
      <Screen className="bg-page">
        <div className="flex size-14 items-center justify-center rounded-full" style={{ background: 'var(--status-positive)' }}>
          <Check size={30} />
        </div>
        <div className="mt-5 text-[34px] font-extrabold leading-10 text-ink">
          You sent {AMOUNT} to {TO}
        </div>
        <Actions second="View in Activities" />
      </Screen>
    );
  }

  if (style === 'kraken') {
    // Who it went to on top, the sentence, then plain rows with no card.
    return (
      <Screen className="bg-page">
        <div className="flex flex-col items-center">
          <Avatar size={88} initials="MT" color="var(--accent-send)" badge={<TokenLogo faucetId={USDCX} size="sm" />} />
          <div className="mt-2 text-[15px] font-semibold text-muted">{TO}</div>
          <div className="mt-2 text-[26px] font-extrabold leading-8 text-ink">You sent {AMOUNT}</div>
        </div>
        <div className="mt-8">
          <Row label="To">{TO}</Row>
          <Row label="Total Paid">{AMOUNT}</Row>
          <Row label="Network Fee">{FEE}</Row>
          <Row label="Status">
            <span className="rounded-full px-2.5 py-1 text-[13px]" style={{ background: 'color-mix(in srgb, var(--status-positive) 30%, transparent)' }}>
              Completed
            </span>
          </Row>
          <Row label="Transaction ID" last>
            <span className="text-accent-tint-ink">{TXID}</span>
          </Row>
        </div>
        <Actions />
      </Screen>
    );
  }

  if (style === 'coinbase') {
    // Dark, centred, the amount in the brand colour. Everything else behind a button.
    return (
      <Screen style={{ background: '#17171a', color: '#fff' }}>
        <div className="flex flex-1 flex-col items-center justify-center">
          <div className="flex size-16 items-center justify-center rounded-full" style={{ background: orange }}>
            <Check size={34} />
          </div>
          <div className="mt-10 text-[15px] font-semibold text-white/60">You sent</div>
          <div className="mt-1 text-[40px] font-extrabold leading-[44px]" style={{ color: '#f08a4f' }}>
            {AMOUNT}
          </div>
          <div className="mt-2 text-[15px] font-semibold text-white/60">To: {TO}</div>
        </div>
        <Actions second="Show details" />
      </Screen>
    );
  }

  if (style === 'monzo') {
    // A soft tinted page, the brand mark as the picture, one sentence.
    return (
      <Screen style={{ background: 'var(--ds-accent-tint)' }}>
        <div className="flex flex-1 flex-col items-center justify-center">
          <BreadMark width={132} height={127} aria-hidden="true" />
          <div className="mt-8 text-center text-[30px] font-extrabold leading-9 text-ink">
            You&apos;ve sent {AMOUNT} to {TO}
          </div>
          <div className="mt-3 text-center text-[15px] font-semibold text-muted">It arrives as soon as they claim it.</div>
        </div>
        <Actions />
      </Screen>
    );
  }

  if (style === 'gojek') {
    // The whole screen in the brand colour: check, title, both parties, the amount.
    return (
      <Screen style={{ background: orange, color: '#fff' }}>
        <div className="flex flex-1 flex-col items-center justify-center">
          <div className="flex size-28 items-center justify-center rounded-full bg-white/25">
            <div className="flex size-20 items-center justify-center rounded-full bg-white">
              <Check size={46} stroke="var(--accent-primary)" width={5.5} />
            </div>
          </div>
          <div className="mt-6 text-[32px] font-extrabold leading-9">Payment Sent!</div>
          <div className="mt-6 flex items-center">
            <Avatar size={40} initials="A1" color="#3f3f3f" className="ring-2 ring-white" />
            <Avatar size={40} initials="MT" color="var(--accent-send)" className="-ml-2 ring-2 ring-white" />
          </div>
          <div className="mt-8 w-full border-t border-dashed border-white/50 pt-6 text-center">
            <div className="text-[15px] font-semibold text-white/85">Amount sent</div>
            <div className="mt-1 text-[28px] font-extrabold leading-8">{AMOUNT}</div>
          </div>
        </div>
        <button type="button" className="h-[52px] w-full rounded-full bg-white text-[17px] font-extrabold" style={{ color: 'var(--accent-primary-hover)' }}>
          Done
        </button>
      </Screen>
    );
  }

  if (style === 'worldapp') {
    // Big check, title, one card with the two sides of the transfer.
    return (
      <Screen className="bg-page">
        <div className="flex flex-col items-center pt-4">
          <div className="flex size-24 items-center justify-center rounded-full" style={{ background: 'var(--status-positive)' }}>
            <Check size={52} />
          </div>
          <div className="mt-6 text-[32px] font-extrabold leading-9 text-ink">Payment Sent!</div>
        </div>
        <div className="mt-8 rounded-3xl border border-hairline">
          <div className="flex items-center gap-3 px-4 py-4">
            <Avatar size={40} initials="A1" color="#3f3f3f" />
            <div className="flex-1">
              <div className="text-[17px] font-extrabold text-ink">Send</div>
              <div className="text-[13px] font-semibold text-muted">from Account 1</div>
            </div>
            <div className="text-[17px] font-extrabold text-ink">{AMOUNT}</div>
          </div>
          <div className="relative border-t border-hairline">
            <span className="absolute left-1/2 top-0 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-page shadow-[0_0_0_1px_var(--ds-hairline)]">
              <Icon name={IconName.ArrowDown} size="xs" fill={ink} />
            </span>
          </div>
          <div className="flex items-center gap-3 px-4 py-4">
            <Avatar size={40} initials="MT" color="var(--accent-send)" />
            <div className="flex-1">
              <div className="text-[17px] font-extrabold text-ink">Receive</div>
              <div className="text-[13px] font-semibold text-muted">to {TO}</div>
            </div>
            <div className="text-[17px] font-extrabold text-ink">{AMOUNT}</div>
          </div>
        </div>
        <Actions />
      </Screen>
    );
  }

  if (style === 'wealthsimple') {
    // Words at the top left, one large object below: here the token itself, twice, as coins.
    return (
      <Screen className="bg-page">
        <div className="text-[30px] font-extrabold leading-9 text-ink">Your payment is sent!</div>
        <div className="mt-3 text-[17px] font-semibold leading-6 text-muted">
          <span className="font-extrabold text-ink">{AMOUNT}</span> is on its way to <span className="font-extrabold text-ink">{TO}</span>.
        </div>
        <div className="relative mx-auto mt-16 h-56 w-72">
          <div className="absolute left-2 top-10 -rotate-12 scale-[2.1] drop-shadow-xl">
            <TokenLogo faucetId={USDCX} size="xl" />
          </div>
          <div className="absolute right-4 top-2 rotate-12 scale-[1.5] opacity-90 drop-shadow-xl">
            <TokenLogo faucetId={USDCX} size="xl" />
          </div>
        </div>
        <Actions />
      </Screen>
    );
  }

  // chime: outline check, title, one card with the amount large inside it.
  return (
    <Screen className="bg-page">
      <div className="flex flex-col items-center pt-10">
        <div className="flex size-14 items-center justify-center rounded-full" style={{ boxShadow: 'inset 0 0 0 3px var(--status-positive)' }}>
          <Check size={30} stroke="var(--status-positive)" />
        </div>
        <div className="mt-4 text-[24px] font-extrabold leading-8 text-ink">Payment Sent!</div>
      </div>
      <div className="mt-6 rounded-3xl border border-hairline px-5 py-2">
        <div className="border-b border-hairline py-6 text-center text-[44px] font-extrabold leading-[48px] text-ink">
          25 <span className="text-[24px] text-muted">USDCX</span>
        </div>
        <Row label="From">Account 1</Row>
        <Row label="To">{TO}</Row>
        <Row label="Network Fee" last>
          {FEE}
        </Row>
      </div>
      <Actions />
    </Screen>
  );
};

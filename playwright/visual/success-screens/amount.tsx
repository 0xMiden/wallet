// Three arrangements of Send's "Enter amount" step. The header, button, token logo, network chip,
// shortcut chips, cards and avatar are the app's own. The amount field itself is a stand-in set in
// Bread's type and colours: the real field's layout is fixed (amount left, unit right), so it
// cannot be rearranged without changing the component. Nothing here ships.
import React, { FC, ReactNode, useState } from 'react';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { Button, ButtonVariant } from '../../../src/components/Button';
import { NetworkChip } from '../../../src/components/NetworkChip';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { Avatar } from '../../../src/components/ui/Avatar';
import { AmountShortcuts } from '../../../src/screens/send-flow/AmountShortcuts';
import { SendStepLayout } from '../../../src/screens/send-flow/SendStepLayout';
import { USDCX } from './fixture';

export type AmountVariant = 'centered' | 'card' | 'tidy';

const BALANCE = 140.5;
const NAME = 'Maya';
const SHORT = 'mtst1apq…wk6x';

const usd = (value: string) => `$${(Number(value) || 0).toFixed(2)}`;

/** The amount as typed text that grows with its content, so a unit can sit right after it. */
const AmountField: FC<{ value: string; onChange: (value: string) => void; className: string; align?: 'left' | 'center' }> = ({
  value,
  onChange,
  className,
  align = 'left'
}) => (
  // The hidden copy of the text sets the width, so the field is exactly as wide as what is typed.
  <span className={`inline-grid font-heading font-extrabold tracking-[-0.02em] ${className}`}>
    <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre">
      {value || '0'}
    </span>
    <input
      size={1}
      inputMode="decimal"
      aria-label="Amount in USDCX"
      placeholder="0"
      value={value}
      onChange={event => onChange(event.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
      style={{ textAlign: align }}
      className="col-start-1 row-start-1 w-full min-w-0 bg-transparent text-ink outline-none placeholder:text-[color:var(--ds-fill-pressed)]"
    />
  </span>
);

const Recipient: FC<{ className?: string }> = ({ className }) => (
  <div className={`inline-flex items-center gap-2 rounded-full bg-fill py-1.5 pl-1.5 pr-3 font-heading ${className ?? ''}`}>
    <Avatar size={24} initials="M" color="var(--accent-send)" />
    <span className="text-[13px] font-semibold text-muted">To</span>
    <span className="text-[15px] font-extrabold text-ink">{NAME}</span>
    <span className="text-[13px] font-semibold text-muted">{SHORT}</span>
  </div>
);

const TokenChip: FC = () => (
  <button type="button" className="flex shrink-0 items-center gap-1.5 rounded-full bg-fill py-1.5 pl-1.5 pr-2.5 font-heading text-[15px] font-extrabold text-ink">
    <TokenLogo faucetId={USDCX} size="sm" />
    USDCX
    <Icon name={IconName.ChevronDown} size="xs" className="text-accent-send" fill="currentColor" />
  </button>
);

const Shell: FC<{ valid: boolean; children: ReactNode }> = ({ valid, children }) => (
  <SendStepLayout
    title="Enter amount"
    onBack={() => undefined}
    footer={
      <Button title="Continue" variant={ButtonVariant.Primary} accent="send" onClick={() => undefined} disabled={!valid} className="w-full max-w-none" />
    }
  >
    {children}
  </SendStepLayout>
);

export const AmountIdea: FC<{ variant: AmountVariant }> = ({ variant }) => {
  const [value, setValue] = useState('');
  const numeric = Number(value);
  const valid = value !== '' && numeric > 0 && numeric <= BALANCE;
  const over = numeric > BALANCE;
  const shortcuts = (className: string) => (
    <AmountShortcuts balance={BALANCE} decimals={6} scaleIsKnown onAmountChange={setValue} compact className={className} />
  );

  if (variant === 'centered') {
    // Who it's going to at the top, then the amount as the one centred thing on the screen.
    return (
      <Shell valid={valid}>
        <div className="flex min-h-full flex-col items-center">
          <Recipient className="mt-2" />
          <div className="my-auto flex w-full flex-col items-center py-8">
            <div className="flex max-w-full items-baseline justify-center gap-2">
              <AmountField value={value} onChange={setValue} align="center" className="text-[72px] leading-[76px]" />
              <span className="font-heading text-[24px] font-extrabold text-muted">USDCX</span>
            </div>
            <button type="button" className="mt-1 inline-flex items-center gap-1.5 font-heading text-[17px] font-bold text-accent-tint-ink">
              {usd(value)}
              <Icon name={IconName.ArrowUpDown} size="xs" fill="currentColor" />
            </button>
            <div className={`mt-6 font-heading text-[13px] font-semibold ${over ? 'text-negative-ink' : 'text-muted'}`}>
              {over ? 'More than you have available' : `${BALANCE} USDCX available`}
            </div>
            {shortcuts('mt-3 justify-center text-accent-send-ink')}
          </div>
          <div className="flex w-full items-center justify-between border-t border-hairline pt-3 font-heading">
            <span className="text-[15px] font-semibold text-muted">Sending</span>
            <TokenChip />
          </div>
        </div>
      </Shell>
    );
  }

  if (variant === 'card') {
    // One card holds the amount and its token; the recipient joins underneath.
    return (
      <Shell valid={valid}>
        <div className="mt-3 flex flex-col">
          <div className="rounded-3xl border border-hairline px-4 pb-5 pt-4">
            <div className="font-heading text-[13px] font-semibold text-muted">You send</div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1">
                <AmountField value={value} onChange={setValue} className="text-[48px] leading-[56px]" />
              </span>
              <TokenChip />
            </div>
            <div className="mt-1 flex items-center justify-between font-heading text-[13px] font-semibold">
              <span className="text-muted">{usd(value)}</span>
              <span className={over ? 'text-negative-ink' : 'text-muted'}>{over ? 'More than available' : `Available ${BALANCE}`}</span>
            </div>
          </div>
          <div className="relative z-10 -my-4 flex justify-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-page shadow-[0_0_0_1px_var(--ds-hairline)]">
              <Icon name={IconName.ArrowDown} size="xs" className="[&_*]:fill-[var(--ds-ink)]" />
            </span>
          </div>
          <div className="flex items-center gap-3 rounded-3xl bg-fill px-4 pb-4 pt-6">
            <Avatar size={40} initials="M" color="var(--accent-send)" />
            <div className="min-w-0 flex-1 font-heading">
              <div className="text-[17px] font-extrabold text-ink">{NAME}</div>
              <div className="text-[13px] font-semibold text-muted">{SHORT}</div>
            </div>
            <NetworkChip kind="miden" label="Miden" />
          </div>
          {shortcuts('mt-4 text-accent-send-ink')}
        </div>
      </Shell>
    );
  }

  // tidy: today's arrangement with its loose parts pulled together.
  return (
    <Shell valid={valid}>
      <div className="mt-2 flex flex-col">
        <Recipient className="self-start" />
        <div className="mt-6 flex items-baseline gap-2">
          <AmountField value={value} onChange={setValue} className="text-[64px] leading-[68px]" />
          <span className="font-heading text-[22px] font-extrabold text-muted">USDCX</span>
        </div>
        <button type="button" className="mt-1 inline-flex items-center gap-1.5 self-start font-heading text-[15px] font-bold text-accent-tint-ink">
          {usd(value)}
          <Icon name={IconName.ArrowUpDown} size="xs" fill="currentColor" />
        </button>
        {shortcuts('mt-5 text-accent-send-ink')}
        <div className="mt-8 flex items-center gap-3 border-t border-hairline pt-4 font-heading">
          <TokenLogo faucetId={USDCX} size="md" />
          <div className="flex-1">
            <div className="flex items-center gap-1 text-[17px] font-extrabold text-ink">
              USDCX
              <Icon name={IconName.ChevronDown} size="xs" className="text-accent-send" fill="currentColor" />
            </div>
            <div className={`text-[13px] font-semibold ${over ? 'text-negative-ink' : 'text-muted'}`}>
              {over ? 'More than you have available' : `Available ${BALANCE}`}
            </div>
          </div>
          <NetworkChip kind="miden" label="Miden" />
        </div>
      </div>
    </Shell>
  );
};

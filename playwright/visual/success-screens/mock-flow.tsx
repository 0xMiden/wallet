// The review and success screens of the user's 24 Nov mock (Screenshot 2026-11-24 at 9.05.21 AM),
// built as drawn. Review: the two parties with "You're sending" between their labels, the amount,
// a rule, then plain fact rows with the recipient as the first row. Success: the same rows under
// "You sent". The mock's rows sit on uneven pitches (47 to 65px); here they share one 56px pitch.
// Nothing here ships.
import React, { FC, useState } from 'react';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { Button, ButtonVariant } from '../../../src/components/Button';
import { avatarLabel, ContactAvatar, tintForAddress } from '../../../src/components/contacts/ContactAvatar';
import { FlowLayout } from '../../../src/components/flow/FlowLayout';
import { NetworkLogo } from '../../../src/components/NetworkChip';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { HeaderRule } from '../../../src/components/ui/HeaderRule';
import { SuccessHero } from '../../../src/screens/generating-transaction/success/TransactionSuccessLayout';
import { truncateAddress } from '../../../src/utils/string';
import { SlideToSend } from './flow';
import { BridgeSend, netOf } from './bridge';
import { EXPIRIES, OptionSheet, TRANSFER_TYPES } from './option-sheet';
import { PROTO_TOKENS, ProtoToken } from './tokens';

const figureSize = (text: string) => (text.length <= 4 ? 96 : text.length <= 6 ? 80 : text.length <= 8 ? 62 : 46);

const Chevron: FC = () => (
  <span className="-mr-1 flex -rotate-90 text-muted">
    <Icon name={IconName.ChevronDown} size="xs" className="[&_*]:fill-current [&_*]:stroke-current" />
  </span>
);

/** The fact rows both screens share. With `onEdit` the two option rows open their sheets. */
const Facts: FC<{
  address: string;
  name?: string;
  transferType: string;
  expiry: string;
  onEdit?: (which: 'type' | 'expiry') => void;
  bridge?: BridgeSend;
}> = ({ address, name, transferType, expiry, onEdit, bridge }) => {
  const chain = bridge?.chain;
  const row = 'flex h-14 w-full items-center justify-between border-b border-hairline text-[15px]';
  const label = 'font-extrabold text-muted';
  const option = (title: string, value: string, which: 'type' | 'expiry', last?: boolean) => (
    <button type="button" disabled={!onEdit} onClick={() => onEdit?.(which)} className={`${row} ${last ? 'border-b-0' : ''}`}>
      <span className={label}>{title}</span>
      <span className="flex items-center gap-1 font-black text-ink">
        {value}
        <Chevron />
      </span>
    </button>
  );
  return (
    <div className="w-full font-heading">
      <div className={row}>
        <span className={label}>To</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-col items-end">
            <span className="text-[15px] font-black leading-5 text-ink">{name ?? truncateAddress(address, false, 7, 5)}</span>
            {name ? (
              <span className="text-[11px] font-bold italic leading-[14px] text-muted">{truncateAddress(address, false, 7, 5)}</span>
            ) : (
              <span className="text-[11px] font-extrabold leading-[14px] text-accent-tint-ink">New recipient</span>
            )}
          </span>
          {/* The row avatar at 28px: the 40px one scaled, so its network badge keeps its proportion. */}
          <span className="flex size-7 shrink-0 items-center justify-center">
            <span className="flex scale-[0.7]">
              <ContactAvatar address={address} name={name} network={netOf(address).kind} />
            </span>
          </span>
        </span>
      </div>
      <div className={row}>
        <span className={label}>Network</span>
        <span className="flex items-center gap-1.5 font-black text-ink">
          <NetworkLogo kind={netOf(address, chain).kind} network={netOf(address, chain).slug} />
          {netOf(address, chain).label}
        </span>
      </div>
      <div className={row}>
        <span className={label}>Max network fee</span>
        <span className="font-black text-ink">0.01 USDCX</span>
      </div>
      {/* A cross-chain send says how it crosses, what that costs and what lands; a same-chain one its type and expiry. */}
      {bridge ? (
        <>
          <div className={row}>
            <span className={label}>Route</span>
            <span className="font-black text-ink">
              {bridge.route.label.replace(/ \(.*/, '')} <span className="font-extrabold text-muted">{bridge.route.id === 'usdcx' ? '' : bridge.route.eta}</span>
            </span>
          </div>
          <div className={row}>
            <span className={label}>Bridge fee</span>
            <span className="font-black text-ink">{bridge.route.fee.replace(' Circle fee', '')}</span>
          </div>
          <div className={`${row} border-b-0`}>
            <span className={label}>You receive</span>
            <span className="font-black text-ink">
              {bridge.route.receive} {bridge.route.receiveSymbol}
            </span>
          </div>
        </>
      ) : (
        <>
          {option('Transfer type', transferType, 'type')}
          {option('Expires', expiry, 'expiry', true)}
        </>
      )}
    </div>
  );
};

export interface SendChoices {
  transferType: string;
  expiry: string;
}

export const ReviewMock: FC<{
  amount: string;
  address: string;
  name?: string;
  token?: ProtoToken;
  /** Set for a send to another chain. */
  bridge?: BridgeSend;
  onBack: () => void;
  onClose: () => void;
  onConfirm: (choices: SendChoices) => void;
}> = ({ amount, address, name, token = PROTO_TOKENS[0]!, bridge, onBack, onClose, onConfirm }) => {
  const [transferType, setTransferType] = useState<string>('Private');
  const [expiry, setExpiry] = useState<string>('Never');
  const [sheet, setSheet] = useState<'type' | 'expiry' | null>(null);
  const circle = 'flex size-14 items-center justify-center rounded-full text-[22px] font-black text-white';

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-page px-6 pb-5 pt-4 font-heading text-ink">
      <div className="flex h-12 shrink-0 items-center justify-between">
        <button type="button" aria-label="Back" onClick={onBack} className="-ml-2 flex size-11 items-center justify-center rounded-full">
          <Icon name={IconName.ArrowLeft} size="md" />
        </button>
        <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 flex size-11 items-center justify-center rounded-full">
          <Icon name={IconName.Close} size="md" fill="currentColor" className="text-ink" />
        </button>
      </div>

      {/* You and them, the coin on the arc between, and "You're sending" on the line of their labels. */}
      <div className="relative mx-auto mt-1 flex w-[300px] items-start justify-between">
        <div className="flex w-16 flex-col items-center gap-1.5">
          <span className={circle} style={{ background: 'var(--ds-ink)' }}>
            A
          </span>
          <span className="text-[13px] font-extrabold text-muted">You</span>
        </div>
        <svg className="absolute left-[58px] top-0" width="184" height="56" viewBox="0 0 184 56" fill="none" aria-hidden="true">
          <path d="M4 34 Q92 -22 180 34" stroke="var(--accent-primary)" strokeWidth="2.5" strokeDasharray="1 9" strokeLinecap="round" />
        </svg>
        <span className="review-coin absolute left-[58px] top-0 flex size-9 items-center justify-center rounded-full bg-white shadow-md">
          <TokenLogo faucetId={token.id} size="sm" />
        </span>
        <span className="absolute inset-x-0 bottom-0 text-center text-[17px] font-extrabold leading-5 text-muted">You&apos;re sending</span>
        <div className="flex w-16 flex-col items-center gap-1.5">
          {/* The same colour and initial as this recipient's avatar in the "To" row and on every other screen. */}
          <span className={circle} style={{ background: tintForAddress(address) }}>
            {avatarLabel(address, name)}
          </span>
          <span className="max-w-full truncate text-[13px] font-extrabold text-muted">{name ?? 'New'}</span>
        </div>
      </div>

      <div className="mt-1 flex flex-col items-center">
        <div className="font-black leading-none tracking-[-0.04em]" style={{ fontSize: figureSize(amount) }}>
          {amount}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[24px] font-black tracking-[-0.01em] text-muted">
          <TokenLogo faucetId={token.id} size="sm" />
          {token.symbol}
        </div>
      </div>

      <HeaderRule className="mt-6 w-full shrink-0" />
      <Facts address={address} name={name} transferType={transferType} expiry={expiry} onEdit={setSheet} bridge={bridge} />

      <div className="mt-auto pt-3">
        <SlideToSend
          key={transferType}
          label={transferType === 'Public' ? 'Slide to send publicly' : 'Slide to send'}
          accent="brand"
          onConfirm={() => onConfirm({ transferType, expiry })}
        />
      </div>

      <OptionSheet open={sheet === 'type'} title="Transfer type" options={TRANSFER_TYPES} value={transferType} onChange={setTransferType} onClose={() => setSheet(null)} />
      <OptionSheet open={sheet === 'expiry'} title="Expires" options={EXPIRIES} value={expiry} onChange={setExpiry} onClose={() => setSheet(null)} />
    </div>
  );
};

export const SuccessMock: FC<{
  amount: string;
  address: string;
  name?: string;
  token?: ProtoToken;
  choices?: SendChoices;
  bridge?: BridgeSend;
  onDone: () => void;
}> = ({ amount, address, name, token = PROTO_TOKENS[0]!, choices, bridge, onDone }) => (
  <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
    <FlowLayout
      title="Success"
      onClose={onDone}
      footer={
        <div className="flex w-full flex-col items-center gap-3">
          <Button type="button" variant={ButtonVariant.Primary} accent="send" title="Done" onClick={onDone} className="w-full max-w-none" />
          <Button type="button" variant={ButtonVariant.Secondary} accent="send" title="View in Activities" onClick={onDone} className="w-full max-w-none" />
        </div>
      }
    >
      <section className="tx-stage-rise flex w-full flex-col items-center pt-8 font-heading">
        <SuccessHero />
        <div className="mt-3.5 text-[20px] font-extrabold leading-7 text-ink">You sent</div>
        <div className="flex items-center gap-1 font-extrabold text-ink">
          <span className="text-[32px] leading-10">
            {amount} {token.symbol}
          </span>
          <TokenLogo faucetId={token.id} size="sm" />
        </div>
        <HeaderRule className="mt-6 w-full" />
        <Facts address={address} name={name} transferType={choices?.transferType ?? 'Private'} expiry={choices?.expiry ?? 'Never'} bridge={bridge} />
      </section>
    </FlowLayout>
  </div>
);

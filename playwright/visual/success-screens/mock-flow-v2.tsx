// Version 2 of the 24 Nov flow's last three screens, built from the user's second mock
// (Screenshot 2026-11-24 at 1.04.18 PM): no title bars at all. The review opens straight on the two
// parties; processing keeps those parties in place and puts its title, summary and steps beneath;
// success leads with the tick and the amount at the review's size, and its Done is Bread orange.
// The mock's rows sit on uneven pitches; here they share one 56px pitch. Nothing here ships.
import React, { FC, useEffect, useState } from 'react';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { avatarLabel, ContactAvatar, tintForAddress } from '../../../src/components/contacts/ContactAvatar';
import { NetworkLogo } from '../../../src/components/NetworkChip';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { HeaderRule } from '../../../src/components/ui/HeaderRule';
import { TransactionStepRow } from '../../../src/screens/generating-transaction/components';
import { PRIVATE_SEND_GUARDIAN_STEPS } from '../../../src/screens/generating-transaction/constants';
import { truncateAddress } from '../../../src/utils/string';
import { SlideToSend } from './flow';
import { ArrivalHero, ArrivalStyle } from './arrival';
import type { SendChoices } from './mock-flow';
import { BridgeSend, netOf } from './bridge';
import { EXPIRIES, OptionSheet, TRANSFER_TYPES } from './option-sheet';
import { PROTO_TOKENS, ProtoToken } from './tokens';

const figureSize = (text: string) => (text.length <= 5 ? 88 : text.length <= 7 ? 72 : text.length <= 9 ? 56 : 44);
const STEP_MS = [900, 1300, 1100, 800, 900];

/** The phone's status bar, drawn so the frames read as a device. The operating system draws the real one. */
export const StatusBar: FC<{ background?: string }> = ({ background = '#fff' }) => (
  <div
    aria-hidden="true"
    className="flex h-[54px] shrink-0 items-end justify-between px-[42px] pb-[10px] transition-colors duration-200"
    style={{ background, fontFamily: '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif' }}
  >
    <span className="text-[17px] font-semibold leading-[22px] text-black">9:41</span>
    <span className="flex items-center gap-[6px] pb-[4px]">
      <svg width="18" height="12" viewBox="0 0 18 12" fill="#000">
        <rect x="0" y="8" width="3" height="4" rx="0.8" />
        <rect x="5" y="5.5" width="3" height="6.5" rx="0.8" />
        <rect x="10" y="3" width="3" height="9" rx="0.8" />
        <rect x="15" y="0" width="3" height="12" rx="0.8" />
      </svg>
      <svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="#000" strokeWidth="1.9" strokeLinecap="round">
        <path d="M1.2 4.3a10.3 10.3 0 0 1 14.6 0" />
        <path d="M3.9 7a6.5 6.5 0 0 1 9.2 0" />
        <circle cx="8.5" cy="10.1" r="1.1" fill="#000" stroke="none" />
      </svg>
      <svg width="27" height="13" viewBox="0 0 27 13" fill="none">
        <rect x="0.5" y="0.5" width="23" height="12" rx="3.8" stroke="#000" strokeOpacity="0.4" />
        <rect x="2" y="2" width="20" height="9" rx="2.4" fill="#000" />
        <path d="M25 4.5v4c.8-.3 1.5-1.1 1.5-2s-.7-1.700-1.500-2Z" fill="#000" fillOpacity="0.45" />
      </svg>
    </span>
  </div>
);

/** You and the recipient with the dotted arc between. The coin rests beside you until `moving`, then crosses on a loop. */
const Parties: FC<{ address: string; name?: string; token: ProtoToken; moving?: boolean; arrived?: boolean }> = ({
  address,
  name,
  token,
  moving,
  arrived
}) => {
  const circle = 'flex size-14 items-center justify-center rounded-full text-[22px] font-black text-white';
  return (
    <div className="relative mx-auto flex w-[290px] shrink-0 items-start justify-between">
      <div className="flex w-16 flex-col items-center gap-1.5">
        <span className={circle} style={{ background: 'var(--ds-ink)' }}>
          A
        </span>
        <span className="text-[13px] font-extrabold text-muted">You</span>
      </div>
      <svg className="absolute left-[53px] top-0" width="184" height="56" viewBox="0 0 184 56" fill="none" aria-hidden="true">
        <path d="M4 34 Q92 -22 180 34" stroke="var(--accent-primary)" strokeWidth="2.5" strokeDasharray="1 9" strokeLinecap="round" />
      </svg>
      <span
        className={`absolute left-[53px] top-0 flex size-9 items-center justify-center rounded-full bg-white shadow-md ${moving ? 'review-coin' : ''}`}
        // At rest the coin sits at the start of the arc, against your circle; once delivered, against theirs.
        style={moving ? undefined : { offsetPath: 'path("M4 34 Q92 -22 180 34")', offsetDistance: arrived ? '100%' : '0%', offsetRotate: '0deg' }}
      >
        <TokenLogo faucetId={token.id} size="sm" />
      </span>
      <div className="flex w-16 flex-col items-center gap-1.5">
        {/* As in the mock: a saved contact's circle is the slate blue; an unsaved address keeps its own tint. */}
        <span className={circle} style={{ background: name ? 'var(--accent-send)' : tintForAddress(address) }}>
          {avatarLabel(address, name)}
        </span>
        <span className="max-w-full truncate text-[13px] font-extrabold text-muted">{name ?? 'New'}</span>
      </div>
    </div>
  );
};

const Figure: FC<{ label: string; amount: string; token: ProtoToken }> = ({ label, amount, token }) => (
  <div className="flex shrink-0 flex-col items-center">
    <div className="text-[17px] font-extrabold leading-6 text-muted">{label}</div>
    <div className="font-black leading-[1.02] tracking-[-0.04em]" style={{ fontSize: figureSize(amount) }}>
      {amount}
    </div>
    <div className="mt-1 flex items-center gap-2 text-[24px] font-black leading-7 tracking-[-0.01em] text-muted">
      <TokenLogo faucetId={token.id} size="sm" />
      {token.symbol}
    </div>
  </div>
);

const Chevron: FC = () => (
  <span className="-mr-1 flex -rotate-90 text-muted">
    <Icon name={IconName.ChevronDown} size="xs" className="[&_*]:fill-current [&_*]:stroke-current" />
  </span>
);

const Facts: FC<{
  address: string;
  name?: string;
  transferType: string;
  expiry: string;
  onEdit?: (which: 'type' | 'expiry') => void;
  /** Set for a send to another chain. */
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
    <div className="w-full shrink-0 font-heading">
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
      {/* placeholder says how it crosses, what that costs and what lands; a same-chain one its type and expiry. */}
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

const page = 'relative flex h-full w-full flex-col overflow-hidden bg-page px-[21px] pb-6 font-heading text-ink';

export const ReviewV2: FC<{
  amount: string;
  address: string;
  name?: string;
  token?: ProtoToken;
  bridge?: BridgeSend;
  onConfirm: (choices: SendChoices) => void;
}> = ({ amount, address, name, token = PROTO_TOKENS[0]!, bridge, onConfirm }) => {
  const [transferType, setTransferType] = useState<string>('Private');
  const [expiry, setExpiry] = useState<string>('Never');
  const [sheet, setSheet] = useState<'type' | 'expiry' | null>(null);
  return (
    <div className={`${page} pt-[46px]`}>
      <Parties address={address} name={name} token={token} />
      <div className="mt-6">
        <Figure label="You're sending" amount={amount} token={token} />
      </div>
      <HeaderRule className="mt-7 w-full shrink-0" />
      <Facts address={address} name={name} transferType={transferType} expiry={expiry} onEdit={setSheet} bridge={bridge} />
      <div className="mt-auto pt-3">
        <SlideToSend
          key={transferType}
          label={transferType === 'Public' ? 'Slide to send publicly' : 'Slide to send'}
          accent="plain"
          onConfirm={() => onConfirm({ transferType, expiry })}
        />
      </div>
      <OptionSheet open={sheet === 'type'} title="Transfer type" options={TRANSFER_TYPES} value={transferType} onChange={setTransferType} onClose={() => setSheet(null)} />
      <OptionSheet open={sheet === 'expiry'} title="Expires" options={EXPIRIES} value={expiry} onChange={setExpiry} onClose={() => setSheet(null)} />
    </div>
  );
};

// A send to another chain runs the first three steps on Miden, then crosses and lands. The last two
// labels are the prototype's own: the app does not have bridge step labels yet.
const bridgeSteps = (bridge: BridgeSend) => [
  ...PRIVATE_SEND_GUARDIAN_STEPS.slice(0, 3),
  { ...PRIVATE_SEND_GUARDIAN_STEPS[3]!, id: 'proto-bridging', labelKey: 'protoBridging', defaultLabel: `Bridging via ${bridge.route.id === 'agglayer' ? 'Agglayer' : bridge.route.id === 'usdcx' ? 'Circle' : 'Epoch'}` },
  { ...PRIVATE_SEND_GUARDIAN_STEPS[4]!, id: 'proto-arriving', labelKey: 'protoArriving', defaultLabel: `Arriving on ${bridge.chain.name}` }
];

export const ProcessingV2: FC<{
  amount: string;
  address: string;
  name?: string;
  token?: ProtoToken;
  bridge?: BridgeSend;
  onDone: () => void;
}> = ({ amount, address, name, token = PROTO_TOKENS[0]!, bridge, onDone }) => {
  const steps = bridge ? bridgeSteps(bridge) : PRIVATE_SEND_GUARDIAN_STEPS;
  const [active, setActive] = useState(0);
  const complete = active >= steps.length;
  // The steps advance on a timer here, where the app advances them from the transaction's stages.
  useEffect(() => {
    const id = window.setTimeout(complete ? onDone : () => setActive(value => value + 1), complete ? 1500 : (STEP_MS[active] ?? 900));
    return () => window.clearTimeout(id);
  }, [active, complete, onDone]);

  return (
    <div className={`${page} pt-[46px]`}>
      {/* The same two parties, in the same place as on the review. Only now, once it is sending, does the coin cross. */}
      <Parties address={address} name={name} token={token} moving={!complete} arrived={complete} />
      <h2 className="mt-5 text-center text-[28px] font-extrabold leading-9 tracking-[-0.01em]">Sending Payment</h2>
      {bridge && (
        // A cross-chain send has no summary pill either, but does say what lands and where.
        <div className="mt-1 text-center text-[13px] font-bold leading-[18px] text-muted">
          Arrives as {bridge.route.receive} {bridge.route.receiveSymbol} on {bridge.chain.name} · {bridge.route.label.replace(/ \(.*/, '')}
        </div>
      )}
      <div className="tx-stage-list mt-4 w-full shrink-0 overflow-hidden rounded-[20px] border border-hairline bg-page">
        {steps.map((step, index) => (
          <TransactionStepRow
            key={step.id}
            step={step}
            state={index < active ? 'complete' : index === active ? 'active' : 'pending'}
            accent="send"
            isLast={index === steps.length - 1}
            meta={index < active ? `${Math.max(1, Math.round((STEP_MS[index] ?? 900) / 1000))} sec` : undefined}
          />
        ))}
      </div>
    </div>
  );
};

export const SuccessV2: FC<{
  amount: string;
  address: string;
  name?: string;
  token?: ProtoToken;
  choices?: SendChoices;
  bridge?: BridgeSend;
  /** Which arrival animation the tick plays. */
  arrival?: ArrivalStyle;
  onDone: () => void;
}> = ({ amount, address, name, token = PROTO_TOKENS[0]!, choices, bridge, arrival, onDone }) => (
  <div className={`${page} tx-stage-rise pt-[34px]`}>
    <ArrivalHero token={token} variant={arrival} />
    <div className="mt-5">
      <Figure label="You sent" amount={amount} token={token} />
    </div>
    <HeaderRule className="mt-7 w-full shrink-0" />
    <Facts address={address} name={name} transferType={choices?.transferType ?? 'Private'} expiry={choices?.expiry ?? 'Never'} bridge={bridge} />
    <div className="mt-auto flex flex-col gap-3 pt-3">
      <button type="button" onClick={onDone} className="h-12 w-full rounded-full text-[19px] font-extrabold text-white" style={{ background: 'var(--accent-primary)' }}>
        Done
      </button>
      <button type="button" onClick={onDone} className="h-12 w-full rounded-full bg-fill text-[19px] font-extrabold text-ink active:bg-fill-pressed">
        View in Activities
      </button>
    </div>
  </div>
);

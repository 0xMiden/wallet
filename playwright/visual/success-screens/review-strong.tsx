// Send's review step, one composition in three moods. The moment before money moves is treated as
// a moment: the whole screen commits to it, and a coin travels from you to them while you decide.
//
// With `onSent`, sending happens in place: the review does not hand over to a separate processing
// page. The amount, the two parties and the arc stay where they are; the facts give way to the
// steps, the arc fills as they complete, and the coin makes the crossing once, for real.
//
// Bread's font, colours, token logo and icons, and the app's own step rows; nothing from the app's
// layout components. Everything the real review shows is here. Nothing here ships.
import React, { FC, useEffect, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { ContactAvatar } from '../../../src/components/contacts/ContactAvatar';
import { NetworkLogo } from '../../../src/components/NetworkChip';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { springs } from '../../../src/lib/animation';
import { TransactionStepRow } from '../../../src/screens/generating-transaction/components';
import { PRIVATE_SEND_GUARDIAN_STEPS } from '../../../src/screens/generating-transaction/constants';
import { truncateAddress } from '../../../src/utils/string';
import { PROTO_TOKENS, ProtoToken } from './tokens';
import { SlideToSend } from './flow';
import { EXPIRIES, OptionSheet, TRANSFER_TYPES } from './option-sheet';

export type ReviewTone = 'orange' | 'ink' | 'paper';

const TONES = {
  orange: {
    page: 'var(--accent-primary)',
    strong: '#ffffff',
    soft: '#5a2408',
    rule: 'rgba(90, 36, 8, 0.22)',
    arc: 'rgba(255, 255, 255, 0.7)',
    chip: 'rgba(255, 255, 255, 0.22)',
    you: '#5a2408',
    slider: 'onBrand'
  },
  ink: {
    page: '#1c1917',
    strong: '#ffffff',
    soft: '#a8a199',
    rule: 'rgba(255, 255, 255, 0.12)',
    arc: 'var(--accent-primary)',
    chip: 'rgba(255, 255, 255, 0.1)',
    you: '#3a3531',
    slider: 'onInk'
  },
  paper: {
    page: '#ffffff',
    strong: 'var(--ds-ink)',
    soft: 'var(--ds-muted)',
    rule: 'var(--ds-hairline)',
    arc: 'var(--accent-primary)',
    chip: 'var(--ds-fill)',
    you: 'var(--ds-ink)',
    slider: 'brand'
  }
} as const;

const ARC = 'M4 34 Q92 -22 180 34';
const STEPS = PRIVATE_SEND_GUARDIAN_STEPS;
const STEP_MS = [900, 1300, 1100, 800, 900];

const figureSize = (text: string) => (text.length <= 4 ? 104 : text.length <= 6 ? 84 : text.length <= 8 ? 64 : 48);

const Party: FC<{ initial: string; label: string; color: string; text: string; arrived?: boolean }> = ({ initial, label, color, text, arrived }) => (
  <div className="flex w-16 flex-col items-center gap-1.5">
    <motion.span
      // The recipient takes the coin: one small bounce as it lands.
      animate={arrived ? { scale: [1, 1.14, 1] } : { scale: 1 }}
      transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
      className="relative flex size-14 items-center justify-center rounded-full text-[22px] font-black text-white"
      style={{ background: color }}
    >
      {initial}
      <AnimatePresence>
        {arrived && (
          <motion.span
            key="arrived"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={springs.snappy}
            className="absolute -bottom-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full"
            style={{ background: 'var(--status-positive)', boxShadow: '0 0 0 2.5px #fff' }}
          >
            <svg width="14" height="14" viewBox="0 0 44 44" fill="none">
              <path d="M11 23L18.5 30.5L33 15" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.span>
    <span className="text-[13px] font-extrabold" style={{ color: text }}>
      {label}
    </span>
  </div>
);

export const ReviewStrong: FC<{
  tone: ReviewTone;
  amount?: string;
  address?: string;
  name?: string;
  /** The token being sent. The network fee stays in USDCX, the network's fee token. */
  token?: ProtoToken;
  onBack?: () => void;
  onClose?: () => void;
  /** Called when the slide completes. Ignored when `onSent` is given. */
  onConfirm?: () => void;
  /** Send in place: after the slide the review becomes the progress, then calls this when it is done. */
  onSent?: () => void;
}> = ({ tone, amount = '70.25', address = 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x', name, token = PROTO_TOKENS[0]!, onBack, onClose, onConfirm, onSent }) => {
  const colours = TONES[tone];
  const [transferType, setTransferType] = useState<string>('Private');
  const [expiry, setExpiry] = useState<string>('Never');
  const [sheet, setSheet] = useState<'type' | 'expiry' | null>(null);
  const [phase, setPhase] = useState<'review' | 'sending' | 'sent'>('review');
  const [step, setStep] = useState(0);
  const isPublic = transferType === 'Public';
  const who = name ?? truncateAddress(address, false, 7, 5);
  const row = 'flex h-11 items-center justify-between text-[15px]';
  const reviewing = phase === 'review';
  const progress = reviewing ? 0 : step / STEPS.length;

  // The steps advance on a timer here, where the app advances them from the transaction's stages.
  useEffect(() => {
    if (phase === 'sending') {
      if (step >= STEPS.length) {
        setPhase('sent');
        return;
      }
      const id = window.setTimeout(() => setStep(value => value + 1), STEP_MS[step] ?? 900);
      return () => window.clearTimeout(id);
    }
    if (phase === 'sent') {
      const id = window.setTimeout(() => onSent?.(), 1500);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [phase, step, onSent]);

  const confirm = () => {
    if (onSent) setPhase('sending');
    else onConfirm?.();
  };
  const heading = phase === 'review' ? "You're sending" : phase === 'sending' ? 'Sending' : 'Sent';

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden px-6 pb-5 pt-4 font-heading" style={{ background: colours.page, color: colours.strong }}>
      <div className="flex h-12 shrink-0 items-center justify-between">
        {/* Once it is sending there is nothing to go back to. */}
        <motion.button
          type="button"
          aria-label="Back"
          onClick={onBack}
          animate={{ opacity: reviewing ? 1 : 0 }}
          style={{ pointerEvents: reviewing ? 'auto' : 'none' }}
          className="-ml-2 flex size-11 items-center justify-center rounded-full"
        >
          <Icon name={IconName.ArrowLeft} size="md" style={{ color: colours.strong }} className="[&_*]:fill-current [&_*]:stroke-current" />
        </motion.button>
        <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 flex size-11 items-center justify-center rounded-full">
          <Icon name={IconName.Close} size="md" style={{ color: colours.strong }} className="[&_*]:fill-current" />
        </button>
      </div>

      {/* The transfer, drawn: you, them, and the coin crossing between. */}
      <div className="relative mx-auto mt-2 flex w-[300px] items-start justify-between">
        <Party initial="A" label="You" color={colours.you} text={colours.soft} />
        <svg className="absolute left-[58px] top-0" width="184" height="56" viewBox="0 0 184 56" fill="none" aria-hidden="true">
          <path d={ARC} stroke={colours.arc} strokeWidth="2.5" strokeDasharray="1 9" strokeLinecap="round" />
          {/* The path already travelled, drawn solid as the steps complete. */}
          <motion.path
            d={ARC}
            stroke={colours.arc}
            strokeWidth="3.5"
            strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: progress, opacity: reviewing ? 0 : 1 }}
            transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
          />
        </svg>
        <span
          // Reviewing, the coin loops as a preview. Sending, it sits exactly as far along as the work is.
          className={`absolute left-[58px] top-0 flex size-9 items-center justify-center rounded-full bg-white shadow-md ${reviewing ? 'review-coin' : 'review-coin-travel'}`}
          style={reviewing ? undefined : { offsetDistance: `${progress * 100}%`, opacity: phase === 'sent' ? 0 : 1, transform: phase === 'sent' ? 'scale(0.4)' : 'scale(1)' }}
        >
          <TokenLogo faucetId={token.id} size="sm" />
        </span>
        <Party
          initial={who.charAt(0).toUpperCase()}
          label={name ? name : 'New'}
          color={name ? 'var(--accent-send)' : '#7f9a79'}
          text={colours.soft}
          arrived={phase === 'sent'}
        />
      </div>

      <div className="mt-6 flex flex-col items-center">
        {/* The line above the amount rolls from "You're sending" to "Sending" to "Sent". */}
        <div className="relative h-6 w-full overflow-hidden text-center text-[17px] font-extrabold" style={{ color: colours.soft }}>
          <AnimatePresence initial={false}>
            <motion.span
              key={heading}
              className="absolute inset-0"
              initial={{ y: 16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -16, opacity: 0 }}
              transition={springs.snappy}
            >
              {heading}
            </motion.span>
          </AnimatePresence>
        </div>
        <motion.div
          animate={phase === 'sent' ? { scale: [1, 1.07, 1] } : { scale: 1 }}
          transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
          className="font-black leading-none tracking-[-0.04em]"
          style={{ fontSize: figureSize(amount) }}
        >
          {amount}
        </motion.div>
        <div className="mt-1 flex items-center gap-2 text-[24px] font-black tracking-[-0.01em]" style={{ color: colours.soft }}>
          <TokenLogo faucetId={token.id} size="sm" />
          {token.symbol}
        </div>

        {/* From the mock: "to" in its own chip, then the recipient as a contact: avatar, name, address. */}
        <span className="mt-2 flex size-10 items-center justify-center rounded-full text-[17px] font-black" style={{ background: colours.chip, color: tone === 'paper' ? 'var(--accent-primary)' : colours.strong }}>
          to
        </span>
        <div className="mt-2 flex max-w-full items-center gap-3">
          <ContactAvatar address={address} name={name} network="miden" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[24px] font-black leading-7 tracking-[-0.02em]">{who}</span>
              {!name && (
                <span className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-extrabold" style={{ background: colours.chip }}>
                  New recipient
                </span>
              )}
            </div>
            {/* The address in full on one line; a longer (0x) address steps down a size to stay on it. */}
            <div className={`whitespace-nowrap font-bold italic leading-5 ${address.length > 38 ? 'text-[11px]' : 'text-[13px]'}`} style={{ color: colours.soft }}>
              {address}
            </div>
          </div>
        </div>
      </div>

      {/* Below the address: the facts and the slider while reviewing, the steps once it is sending. */}
      <div className="relative mt-7 flex min-h-0 flex-1 flex-col">
        <AnimatePresence mode="wait" initial={false}>
          {reviewing ? (
            <motion.div
              key="facts"
              className="flex min-h-0 flex-1 flex-col"
              exit={{ opacity: 0, y: 14 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            >
              <div className={row} style={{ borderTop: `1px solid ${colours.rule}` }}>
                <span className="font-extrabold" style={{ color: colours.soft }}>
                  Network
                </span>
                <span className="flex items-center gap-1.5 font-black">
                  <span className="flex rounded-full bg-white p-0.5">
                    <NetworkLogo kind="miden" />
                  </span>
                  Miden
                </span>
              </div>
              <div className={row} style={{ borderTop: `1px solid ${colours.rule}` }}>
                <span className="font-extrabold" style={{ color: colours.soft }}>
                  Max network fee
                </span>
                <span className="font-black">0.01 USDCX</span>
              </div>
              {/* The two options are plain rows of their own: each says what it is, shows its choice, and opens its sheet. */}
              {(
                [
                  ['Transfer type', transferType, 'type'],
                  ['Expires', expiry, 'expiry']
                ] as const
              ).map(([label, current, id]) => (
                <button key={id} type="button" onClick={() => setSheet(id)} className={`${row} w-full`} style={{ borderTop: `1px solid ${colours.rule}` }}>
                  <span className="font-extrabold" style={{ color: colours.soft }}>
                    {label}
                  </span>
                  <span className="flex items-center gap-1 font-black">
                    {current}
                    <span className="-mr-1 flex -rotate-90">
                      <Icon name={IconName.ChevronDown} size="xs" style={{ color: colours.soft }} className="[&_*]:fill-current [&_*]:stroke-current" />
                    </span>
                  </span>
                </button>
              ))}
              <div className="mt-auto pt-3">
                <SlideToSend key={transferType} label={isPublic ? 'Slide to send publicly' : 'Slide to send'} accent={colours.slider} tall onConfirm={confirm} />
              </div>
            </motion.div>
          ) : (
            <motion.div key="steps" className="flex min-h-0 flex-1 flex-col">
              <div className="overflow-hidden rounded-2xl" style={{ boxShadow: `inset 0 0 0 1px ${colours.rule}` }}>
                {STEPS.map((item, index) => (
                  // Each step rises in a beat after the one above it.
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...springs.standard, delay: index * 0.06 }}
                  >
                    <TransactionStepRow
                      step={item}
                      state={index < step ? 'complete' : index === step && phase === 'sending' ? 'active' : phase === 'sent' ? 'complete' : 'pending'}
                      accent="brand"
                      isLast={index === STEPS.length - 1}
                      meta={index < step ? `${Math.max(1, Math.round((STEP_MS[index] ?? 900) / 1000))} sec` : undefined}
                    />
                  </motion.div>
                ))}
              </div>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="mt-auto pt-3 text-center text-[13px] font-bold leading-5"
                style={{ color: colours.soft }}
              >
                {phase === 'sent' ? 'Done.' : "You can close this. We'll notify you when it's done."}
              </motion.p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <OptionSheet
        open={sheet === 'type'}
        title="Transfer type"
        options={TRANSFER_TYPES}
        value={transferType}
        onChange={setTransferType}
        onClose={() => setSheet(null)}
      />
      <OptionSheet open={sheet === 'expiry'} title="Expires" options={EXPIRIES} value={expiry} onChange={setExpiry} onClose={() => setSheet(null)} />
    </div>
  );
};

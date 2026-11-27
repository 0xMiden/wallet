// The Send flow as a clickable prototype: recipient -> amount -> review -> processing -> success.
//
// What is the app's own code: the recipient step (SelectRecipient), the amount step (SendAmount),
// the processing screen's hero, summary pill and step rows, and every card, row, logo, icon and
// button on the review. What is new here: the review is composed from those pieces (the real one
// owns the transaction pipeline and cannot run without a wallet), the slide-to-send control, and
// the success screen, which is the design from the user's Background.svg.
//
// Nothing here can sign or send. It exists to be looked at and clicked through.
import React, { ChangeEvent, FC, useEffect, useRef, useState } from 'react';

import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { Button, ButtonVariant } from '../../../src/components/Button';
import { NetworkLogo } from '../../../src/components/NetworkChip';
import { FlowLayout } from '../../../src/components/flow/FlowLayout';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { DetailCard, DetailDisclosure, DetailRow } from '../../../src/components/ui/DetailCard';
import { Hero } from '../../../src/components/ui/Hero';
import { Pill } from '../../../src/components/ui/Pill';
import { TokenAmount } from '../../../src/components/ui/TokenAmount';
import { durations, easings, springs } from '../../../src/lib/animation';
import { TransactionHeroIcon, TransactionStepRow } from '../../../src/screens/generating-transaction/components';
import { PRIVATE_SEND_GUARDIAN_STEPS } from '../../../src/screens/generating-transaction/constants';
import { TransactionSummaryBadge } from '../../../src/screens/generating-transaction/TransactionSummaryBadge';
import { SelectRecipient } from '../../../src/screens/send-flow/SelectRecipient';
import { SendStepLayout } from '../../../src/screens/send-flow/SendStepLayout';
import type { RecentRecipient } from '../../../src/screens/send-flow/types';
import { truncateAddress } from '../../../src/utils/string';
import { AmountBold } from './amount-bold';
import { BRIDGE_CHAINS, BridgeChain, BridgeRoute, BridgeSend, routesFor } from './bridge';
import { ReviewMock, SendChoices, SuccessMock } from './mock-flow';
import { ProcessingV2, ReviewV2, StatusBar, SuccessV2 } from './mock-flow-v2';
import { EXPIRIES, OptionSheet, TRANSFER_TYPES } from './option-sheet';
import { RecipientIdea } from './recipient-ideas';
import { RecipientPicker } from './recipient-picker';
import { RouteStep } from './route-step';
import { ReviewStrong } from './review-strong';
import { USDCX } from './fixture';
import { SendInStyle } from './styles';
import { PROTO_TOKENS, ProtoToken } from './tokens';

type Step = 'recipient' | 'amount' | 'route' | 'review' | 'processing' | 'success';
const ORDER: Step[] = ['recipient', 'amount', 'route', 'review', 'processing', 'success'];

export const RECENTS: RecentRecipient[] = [
  { address: 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x', name: 'Maya', chain: 'miden' },
  { address: 'mtst1arvdwvzllvg3s5fzjle7nkljeuhkcufr', chain: 'miden' }
];
const FEE = '0.01 USDCX';

/** An address that is in nobody's contacts: what the prototype's Paste puts in, and one to type by hand. */
export const SAMPLE_ADDRESS = 'mtst1aqd8xk3v9p2hn7c5t0wz4ys6ej8ruf2lgm0k';
/** An Ethereum address to try the flow with (a widely used documentation example, not a real recipient). */
export const SAMPLE_ETH_ADDRESS = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
// Named for its first use; it also accepts a 0x Ethereum address, as the app's recipient field does.
const isMidenAddress = (value: string) => /^mtst1[0-9a-z]{28,}$/.test(value.trim()) || /^0x[0-9a-fA-F]{40}$/.test(value.trim());

// ---------------------------------------------------------------------------------------------
// Slide to send: the review's confirm. Dragging the thumb to the end of the track confirms; letting
// go short of it springs the thumb home. Enter or Space on the focused thumb confirms too.
// ---------------------------------------------------------------------------------------------
const THUMB = 44;
const PAD = 4;

/** `send` is the flow's slate blue; `brand` is Bread orange, for the freely designed screens. */
const SLIDE_COLOURS = {
  send: { track: 'var(--accent-send-tint)', fill: 'var(--accent-send)', label: 'var(--accent-send-ink)', glyph: '#fff' },
  brand: { track: 'var(--ds-accent-tint)', fill: 'var(--accent-primary)', label: 'var(--ds-accent-tint-ink)', glyph: '#fff' },
  // Version 2 mock: a near-white track, so only the thumb and the words are orange.
  plain: { track: '#f6f5f3', fill: 'var(--accent-primary)', label: 'var(--accent-primary-hover)', glyph: '#fff' },
  // On a solid Bread-orange screen: a white thumb and fill on a darker well.
  onBrand: { track: 'rgba(74, 31, 8, 0.22)', fill: '#fff', label: '#fff', glyph: 'var(--accent-primary-hover)' },
  // On a dark screen: the orange carries the action.
  onInk: { track: 'rgba(255, 255, 255, 0.1)', fill: 'var(--accent-primary)', label: '#fff', glyph: '#fff' }
};

export const SlideToSend: FC<{ label: string; onConfirm: () => void; accent?: keyof typeof SLIDE_COLOURS; tall?: boolean }> = ({
  label,
  onConfirm,
  accent = 'send',
  tall = false
}) => {
  const colours = SLIDE_COLOURS[accent];
  const reduceMotion = useReducedMotion();
  const trackRef = useRef<HTMLDivElement>(null);
  const [travel, setTravel] = useState(0);
  const [done, setDone] = useState(false);
  const x = useMotionValue(0);
  // The label gives way as the thumb crosses it, and the accent fills in behind the thumb.
  const labelOpacity = useTransform(x, [0, Math.max(travel * 0.6, 1)], [1, 0]);
  const fillWidth = useTransform(x, value => value + THUMB + PAD * 2);

  useEffect(() => {
    const measure = () => setTravel((trackRef.current?.offsetWidth ?? 0) - THUMB - PAD * 2);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // A single nudge on arrival says "this slides".
  useEffect(() => {
    if (reduceMotion || travel === 0) return;
    const controls = animate(x, [0, 18, 0], { delay: 0.7, duration: 0.7, ease: easings.easeInOut });
    return () => controls.stop();
  }, [reduceMotion, travel, x]);

  const finish = () => {
    if (done) return;
    setDone(true);
    void animate(x, travel, springs.snappy);
    window.setTimeout(onConfirm, 420);
  };

  return (
    <div
      ref={trackRef}
      className={`relative w-full select-none overflow-hidden rounded-full ${tall ? 'h-14' : 'h-[52px]'}`}
      style={{ background: colours.track }}
    >
      <motion.div className="absolute inset-y-0 left-0 rounded-full" style={{ width: fillWidth, background: colours.fill }} />
      <motion.span
        // A long label is centred in the space beside the thumb, so it never runs under it.
        className={`pointer-events-none absolute inset-0 flex items-center justify-center font-heading font-extrabold ${
          label.length > 14 ? 'pl-14 pr-3 text-[17px]' : 'text-[19px]'
        }`}
        style={{ opacity: labelOpacity, color: colours.label }}
      >
        <span className="slide-hint">{label}</span>
      </motion.span>
      <motion.button
        type="button"
        aria-label={label}
        data-testid="slide-to-send"
        className={`absolute left-1 flex size-11 cursor-grab items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white active:cursor-grabbing ${tall ? 'top-1.5' : 'top-1'}`}
        style={{ x, background: colours.fill }}
        drag={done ? false : 'x'}
        dragConstraints={{ left: 0, right: travel }}
        dragElastic={0.04}
        dragMomentum={false}
        whileTap={{ scale: 0.94 }}
        onDragEnd={() => {
          if (x.get() >= travel * 0.86) finish();
          else void animate(x, 0, springs.dragRelease);
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            finish();
          }
        }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {done ? (
            <motion.svg
              key="check"
              width="22"
              height="22"
              viewBox="0 0 44 44"
              fill="none"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={springs.snappy}
            >
              <path d="M11 23L18.5 30.5L33 15" stroke={colours.glyph} strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
            </motion.svg>
          ) : (
            <motion.span key="arrow" exit={{ opacity: 0, scale: 0.6 }} transition={springs.snappy} className="flex">
              <Icon name={IconName.ArrowRight} size="sm" style={{ color: colours.glyph }} className="[&_*]:fill-current [&_*]:stroke-current" />
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// Review: the real screen's arrangement, from the real components (ReviewTransaction.tsx).
// ---------------------------------------------------------------------------------------------
export const AppStyleReview: FC<{
  amount: string;
  to: string;
  isNew: boolean;
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => void;
  /** The app's tap button in place of the prototype's slider. */
  current?: boolean;
}> = ({ amount, to, isNew, onBack, onClose, onConfirm, current }) => {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [transferType, setTransferType] = useState<string>('Private');
  const [expiry, setExpiry] = useState<string>('Never');
  const [sheet, setSheet] = useState<'type' | 'expiry' | null>(null);
  const isPublic = transferType === 'Public';
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-app-bg">
      <SendStepLayout
        title={t('reviewDetails')}
        onBack={onBack}
        onClose={onClose}
        footer={
          current ? (
            <Button
              title={isPublic ? t('sendPublicly') : t('sendPayment')}
              variant={ButtonVariant.Primary}
              accent="send"
              onClick={onConfirm}
              className="w-full max-w-none"
            />
          ) : (
            <SlideToSend key={transferType} label={isPublic ? 'Slide to send publicly' : 'Slide to send'} onConfirm={onConfirm} />
          )
        }
      >
        <Hero
          className="mt-3"
          visual={<TokenLogo faucetId={USDCX} size="2xl" />}
          value={<TokenAmount amount={amount} symbol="USDCX" formatting="exact" />}
          subtitle={<span className="font-heading text-base font-bold leading-[22px]">${Number(amount).toFixed(2)}</span>}
        />
        <DetailCard surface="outline" face="heading" className="tx-stage-list mt-6">
          <DetailRow
            label={t('to')}
            className="[&>span:first-child]:min-w-0"
            badge={
              isNew ? (
                <Pill size="tag" tone="muted">
                  {t('newRecipient')}
                </Pill>
              ) : undefined
            }
          >
            <span className="min-w-0 break-all text-[11px]">{to}</span>
          </DetailRow>
          <DetailRow label={t('network')}>
            <span className="flex items-center gap-1.5">
              <NetworkLogo kind="miden" />
              {t('miden')}
            </span>
          </DetailRow>
          <DetailRow label={t('networkFeeMax')} sub="$0.01">
            {FEE}
          </DetailRow>
          <DetailDisclosure
            title={t('advancedOptions')}
            summary={transferType}
            summarySub={expiry}
            summaryEmphasis={isPublic}
            summaryPlacement="end"
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
          >
            {/* As in the app: the transfer type row opens its sheet, the expiry row carries an Edit action. */}
            <DetailRow label={t('transferType')} onClick={() => setSheet('type')} aria-haspopup="dialog">
              {transferType}
            </DetailRow>
            <DetailRow label={t('expires')} action={{ label: t('edit'), onClick: () => setSheet('expiry'), 'aria-haspopup': 'dialog' }}>
              {expiry}
            </DetailRow>
          </DetailDisclosure>
        </DetailCard>
      </SendStepLayout>
      <OptionSheet
        open={sheet === 'type'}
        title={t('transferType')}
        options={TRANSFER_TYPES}
        value={transferType}
        onChange={setTransferType}
        onClose={() => setSheet(null)}
      />
      <OptionSheet open={sheet === 'expiry'} title={t('expires')} options={EXPIRIES} value={expiry} onChange={setExpiry} onClose={() => setSheet(null)} />
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// Processing: the real screen's markup, with the stages advanced on a timer in place of a wallet.
// ---------------------------------------------------------------------------------------------
const STEP_MS = [900, 1300, 1100, 800, 900];

export const Processing: FC<{ amount: string; to: string; name?: string; symbol?: string; outlined?: boolean; onDone: () => void; onHide: () => void }> = ({
  amount,
  to,
  name,
  symbol = 'USDCX',
  outlined,
  onDone,
  onHide
}) => {
  const { t } = useTranslation();
  const steps = PRIVATE_SEND_GUARDIAN_STEPS;
  const [active, setActive] = useState(0);
  const complete = active >= steps.length;

  useEffect(() => {
    if (complete) {
      const id = window.setTimeout(onDone, 1500);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => setActive(value => value + 1), STEP_MS[active] ?? 900);
    return () => window.clearTimeout(id);
  }, [active, complete, onDone]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
      <FlowLayout
        title={t('transactionProcessingHeader')}
        onClose={onHide}
        footer={
          <div className="flex w-full flex-col items-center gap-3">
            <Button type="button" variant={ButtonVariant.Primary} accent="send" onClick={onHide} className="w-full max-w-none">
              {complete ? t('done') : t('hide')}
            </Button>
          </div>
        }
      >
        <section className="flex w-full flex-col items-center pt-6">
          <div className="tx-stage-hero">
            <TransactionHeroIcon state={complete ? 'success' : 'processing'} accent="send" />
          </div>
          <h2 className="mt-5 w-full px-1 text-center font-heading text-[1.75rem] font-bold leading-none text-ink">
            {t('transactionTitleSend')}
          </h2>
          <TransactionSummaryBadge
            lhs={<TokenAmount amount={amount} symbol={symbol} formatting="exact" />}
            // One line always: the contact's name when there is one, else a short form of the address.
            rhs={name ?? truncateAddress(to, false, 7, 5)}
            // Never two lines: nothing inside may wrap, and a long pair steps the type down to fit.
            className={`mt-4 [&_*]:flex-nowrap [&_*]:whitespace-nowrap [&_*]:[overflow-wrap:normal] ${
              amount.length + symbol.length + (name ?? '1234567…12345').length > 24 ? '[&_*]:!text-[17px]' : ''
            }`}
          />
          {/* The prototype (from the mock) outlines the card; the app fills it grey. */}
          <div className={`tx-stage-list mt-6 w-full overflow-hidden ${outlined ? 'rounded-[20px] border border-hairline bg-page' : 'rounded-2xl bg-fill'}`}>
            {steps.map((step, index) => (
              <TransactionStepRow
                key={step.id}
                step={step}
                state={index < active ? 'complete' : index === active ? 'active' : 'pending'}
                accent="send"
                isLast={index === steps.length - 1}
                meta={index < active ? t('transactionStepDurationSec', { seconds: Math.max(1, Math.round((STEP_MS[index] ?? 900) / 1000)) }) : undefined}
              />
            ))}
          </div>
          {!complete && (
            <p className="w-full pt-4 text-center font-heading text-sm font-bold text-ink">{t('generatingTransactionDescription')}</p>
          )}
        </section>
      </FlowLayout>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// The flow. Pages cross like the app's pushed pages: the new one slides in from the right over
// `durations.page` on `easings.standard` while the one beneath moves to -24% and dims.
// ---------------------------------------------------------------------------------------------
export const SendFlowPrototype: FC<{
  /** Open on a given step with the first recent recipient and an amount already in, for the all-screens view. */
  /** `to` opens it on that address instead (a 0x one shows the cross-chain send, with its first route chosen past the route step). */
  start?: { step: Step; recipient?: boolean; amount?: string; to?: string };
  /** Stay on the processing step when it finishes. */
  hold?: boolean;
  /** 'mock' is the user's 24 Nov mock: its review and success screens, segmented shortcuts, a rule on the recipient step. */
  variant?: 'mock' | 'mock2';
}> = ({ start, hold, variant }) => {
  // 'mock2' is version 2 of the same flow: it differs only in its last three screens and the status bar.
  const mock = variant === 'mock' || variant === 'mock2';
  const v2 = variant === 'mock2';
  const [choices, setChoices] = useState<SendChoices>();
  // Where the tapped recent recipient's avatar sat, so the chosen screen's avatar can grow out of it.
  const [origin, setOrigin] = useState<{ x: number; y: number; size: number }>();
  const frameRef = useRef<HTMLDivElement>(null);
  // 24 Nov version: a recipient is taken when one is tapped, pasted, or a typed address is confirmed.
  // Typing by itself never moves on, or the page would change while the address was still being typed.
  const [committed, setCommitted] = useState(Boolean(start?.recipient || start?.to));
  // Version 2, sending to a 0x address: the destination chain, the route chosen for it, and the chain picker.
  const [chain, setChain] = useState<BridgeChain>(BRIDGE_CHAINS[0]!);
  const [route, setRoute] = useState<BridgeRoute | undefined>(() =>
    start?.to?.startsWith('0x') && ORDER.indexOf(start.step) > ORDER.indexOf('route')
      ? routesFor(PROTO_TOKENS[0]!, start.amount ?? '', BRIDGE_CHAINS[0]!)[0]
      : undefined
  );
  const [pickingChain, setPickingChain] = useState(false);
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState<Step>(start?.step ?? 'recipient');
  const [direction, setDirection] = useState(1);
  const [address, setAddress] = useState(start?.to ?? (start?.recipient ? (RECENTS[0]?.address ?? '') : ''));
  const [amount, setAmount] = useState(start?.amount ?? '');
  const [token, setToken] = useState<ProtoToken>(PROTO_TOKENS[0]!);

  const go = (next: Step) => {
    setDirection(ORDER.indexOf(next) >= ORDER.indexOf(step) ? 1 : -1);
    setStep(next);
  };
  const restart = () => {
    setAddress('');
    setCommitted(false);
    setRoute(undefined);
    setChain(BRIDGE_CHAINS[0]!);
    setAmount('');
    setToken(PROTO_TOKENS[0]!);
    go('recipient');
  };

  const trimmed = address.trim();
  const valid = isMidenAddress(trimmed);
  const known = RECENTS.find(recent => recent.address === trimmed);
  // Both 24 Nov versions take the cross-chain path for a 0x address.
  const crossChain = mock && trimmed.startsWith('0x');
  const bridge: BridgeSend | undefined = crossChain && route ? { chain, route } : undefined;

  // Remembers where the tapped recent recipient's avatar sat, then fills them in.
  const pickRecent = (recent: RecentRecipient) => {
    const row = frameRef.current?.querySelectorAll('[data-testid="send-recent-recipient"]')[RECENTS.indexOf(recent)];
    const rect = row?.querySelector('[data-testid="contact-avatar"]')?.getBoundingClientRect();
    setOrigin(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, size: rect.width } : undefined);
    setCommitted(true);
    setAddress(recent.address);
  };

  const page = (() => {
    switch (step) {
      case 'recipient':
        // 24 Nov version: once a recipient is in, the chosen design ("the person is the screen") takes
        // over. The list fades out beneath it while the tapped avatar carries across and grows.
        return (
          <AnimatePresence initial={false}>
            {mock && valid && committed ? (
              <motion.div key="chosen" className="absolute inset-0 z-10 flex flex-col" initial={{ opacity: origin ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                <RecipientIdea
                  variant="centred"
                  address={trimmed}
                  name={known?.name}
                  from={origin}
                  onClear={() => {
                    setOrigin(undefined);
                    setAddress('');
                  }}
                  onBack={() => {
                  setOrigin(undefined);
                  setAddress('');
                }}
                chain={crossChain ? chain : undefined}
                onNetwork={crossChain ? () => setPickingChain(true) : undefined}
                onContinue={() => go('amount')}
                />
                <OptionSheet
                  open={pickingChain}
                  title="Network"
                  options={BRIDGE_CHAINS.map(item => ({ id: item.name, note: `Send to this address on ${item.name}.` }))}
                  value={chain.name}
                  onChange={value => setChain(BRIDGE_CHAINS.find(item => item.name === value) ?? chain)}
                  onClose={() => setPickingChain(false)}
                />
              </motion.div>
            ) : (
              <motion.div key="picker" className="flex min-h-0 flex-1 flex-col" exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
                {mock ? (
                  // 24 Nov version: the first page built to the Background+Border.svg guide.
                  <RecipientPicker
                    address={address}
                    invalid={trimmed !== '' && !valid}
                    recents={RECENTS}
                    onAddressChange={value => {
                      setOrigin(undefined);
                      setCommitted(false);
                      setAddress(value);
                    }}
                    onPaste={() => {
                      setOrigin(undefined);
                      setCommitted(true);
                      setAddress(SAMPLE_ADDRESS);
                    }}
                    onContinue={valid ? () => setCommitted(true) : undefined}
                    onSelectRecent={pickRecent}
                  />
                ) : (
              <SelectRecipient
                address={address}
                isValidAddress={valid}
                error={trimmed !== '' && !valid ? 'invalidMidenAccountId' : undefined}
                chain="miden"
                network="miden"
                recipientName={known?.name}
                recents={RECENTS}
                canAddContact={valid && !known?.name}
                onAddressChange={(event: ChangeEvent<HTMLTextAreaElement>) => setAddress(event.target.value)}
                onAddressBook={() => undefined}
                onAddContact={() => undefined}
                onSelectRecent={pickRecent}
                onSelectNetwork={() => undefined}
                onPaste={() => setAddress(RECENTS[0]!.address)}
                onConfirm={() => go('amount')}
              />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        );
      case 'amount':
        // The freely designed amount step (amount-bold.tsx) in place of the app's SendAmount.
        return (
          <AmountBold
            initial={amount}
            initialToken={token}
            // 24 Nov version: the shortcuts ride on the keyboard, not in a strip above Continue.
            shortcuts={mock ? 'keyboard' : undefined}
            address={trimmed}
            name={known?.name}
            onBack={() => go('recipient')}
            onContinue={(value, chosen) => {
              setAmount(value);
              setToken(chosen);
              go(crossChain ? 'route' : 'review');
            }}
          />
        );
      case 'route':
        // Cross-chain only: how the money crosses, between the amount and the review.
        return (
          <RouteStep
            amount={amount}
            token={token}
            address={trimmed}
            chain={chain}
            initial={route?.id}
            onBack={() => go('amount')}
            onContinue={chosen => {
              setRoute(chosen);
              go('review');
            }}
          />
        );
      case 'review':
        // The freely designed review (review-strong.tsx, the white "paper" mood) in place of the app-style one.
        return (
          v2 ? (
            <ReviewV2
              amount={amount}
              token={token}
              address={trimmed}
              name={known?.name}
              bridge={bridge}
              onConfirm={chosen => {
                setChoices(chosen);
                go('processing');
              }}
            />
          ) : mock ? (
            <ReviewMock
              amount={amount}
              token={token}
              bridge={bridge}
              address={trimmed}
              name={known?.name}
              onBack={() => go('amount')}
              onClose={restart}
              onConfirm={chosen => {
                setChoices(chosen);
                go('processing');
              }}
            />
          ) : (
          <ReviewStrong
            tone="paper"
            amount={amount}
            token={token}
            address={trimmed}
            name={known?.name}
            onBack={() => go('amount')}
            onClose={restart}
            onConfirm={() => go('processing')}
          />
          )
        );
      case 'processing':
        if (v2) {
          return <ProcessingV2 amount={amount} token={token} address={trimmed} name={known?.name} bridge={bridge} onDone={() => (hold ? undefined : go('success'))} />;
        }
        return <Processing amount={amount} to={trimmed} name={mock ? known?.name : undefined} symbol={token.symbol} outlined onDone={() => (hold ? undefined : go('success'))} onHide={restart} />;
      default:
        return v2 ? (
          <SuccessV2 amount={amount} token={token} address={trimmed} name={known?.name} choices={choices} bridge={bridge} onDone={restart} />
        ) : mock ? (
          <SuccessMock amount={amount} token={token} address={trimmed} name={known?.name} choices={choices} bridge={bridge} onDone={restart} />
        ) : (
          <SendInStyle style="guide" amount={`${amount} ${token.symbol}`} to={trimmed} faucetId={token.id} />
        );
    }
  })();

  const slide = reduceMotion ? { duration: 0 } : { duration: durations.page, ease: easings.standard };
  // Processing and success replace the page in place, as they do in the app; the steps before slide.
  const inPlace = step === 'processing' || step === 'success';

  return (
    <>
      {v2 && <StatusBar background={step === 'recipient' ? '#f9f9f9' : '#fff'} />}
    <div ref={frameRef} className={`proto-flow relative flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg ${mock ? 'proto-mock' : ''}`}>
      <AnimatePresence initial={false} custom={direction}>
        <motion.div
          key={step}
          custom={direction}
          className="absolute inset-0 flex flex-col bg-app-bg"
          variants={{
            enter: (dir: number) => (inPlace ? { opacity: 0 } : { x: dir > 0 ? '100%' : '-24%', opacity: dir > 0 ? 1 : 0.6 }),
            center: { x: 0, opacity: 1, zIndex: 1 },
            exit: (dir: number) => (inPlace ? { opacity: 0 } : { x: dir > 0 ? '-24%' : '100%', opacity: dir > 0 ? 0.6 : 1, zIndex: 0 })
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={slide}
        >
          {page}
        </motion.div>
      </AnimatePresence>
    </div>
    </>
  );
};

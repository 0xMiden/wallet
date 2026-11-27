// Three free designs for Send's review step, in the language of the freely designed amount step:
// no title bar, one strong element, Bread orange for the action. Bread's font, colours, token logo,
// contact avatar, network logo and icons; none of the app's layout components. Each shows everything
// the real review shows: amount, recipient with the full address, the new-recipient tag, network,
// maximum network fee, and the advanced options (transfer type, expiry). Nothing here ships.
import React, { FC, ReactNode, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { ContactAvatar } from '../../../src/components/contacts/ContactAvatar';
import { NetworkLogo } from '../../../src/components/NetworkChip';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { springs } from '../../../src/lib/animation';
import { truncateAddress } from '../../../src/utils/string';
import { USDCX } from './fixture';
import { SlideToSend } from './flow';

export type ReviewVariant = 'statement' | 'ticket' | 'sentence';

export interface ReviewBoldProps {
  variant: ReviewVariant;
  amount?: string;
  address?: string;
  /** The saved contact's name; without one the recipient is new and shown by address. */
  name?: string;
  onBack?: () => void;
  onClose?: () => void;
  onConfirm?: () => void;
}

const FEE = '0.01 USDCX';

const figureSize = (text: string) => (text.length <= 4 ? 88 : text.length <= 6 ? 72 : text.length <= 8 ? 56 : 44);

const TopBar: FC<{ onBack?: () => void; onClose?: () => void; children?: ReactNode }> = ({ onBack, onClose, children }) => (
  <div className="relative flex h-12 shrink-0 items-center justify-center">
    <button type="button" aria-label="Back" onClick={onBack} className="absolute left-0 flex size-11 items-center justify-center rounded-full active:bg-fill">
      <Icon name={IconName.ArrowLeft} size="md" />
    </button>
    {children}
    <button type="button" aria-label="Close" onClick={onClose} className="absolute right-0 flex size-11 items-center justify-center rounded-full active:bg-fill">
      <Icon name={IconName.Close} size="md" fill="currentColor" className="text-ink" />
    </button>
  </div>
);

/** The address in full, as two even lines: the review is where the user checks where it is going. */
const FullAddress: FC<{ address: string; className?: string }> = ({ address, className }) => {
  const half = Math.ceil(address.length / 2);
  return (
    <div className={className}>
      <div>{address.slice(0, half)}</div>
      <div>{address.slice(half)}</div>
    </div>
  );
};

const NewTag: FC = () => (
  <span className="rounded-full px-2 py-0.5 text-[12px] font-extrabold" style={{ background: 'var(--ds-accent-tint)', color: 'var(--ds-accent-tint-ink)' }}>
    New recipient
  </span>
);

/** Network, fee and the advanced options: the same three facts in each design, expandable in place. */
const useAdvanced = () => {
  const [open, setOpen] = useState(false);
  return { open, toggle: () => setOpen(value => !value) };
};

const AdvancedRows: FC<{ open: boolean }> = ({ open }) => (
  <AnimatePresence initial={false}>
    {open && (
      <motion.div
        key="advanced"
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={springs.standard}
        className="overflow-hidden"
      >
        <div className="flex h-11 items-center justify-between border-t border-hairline text-[15px]">
          <span className="font-bold text-muted">Transfer type</span>
          <span className="font-extrabold">Private</span>
        </div>
        <div className="flex h-11 items-center justify-between border-t border-hairline text-[15px]">
          <span className="font-bold text-muted">Expires</span>
          <span className="font-extrabold">Never</span>
        </div>
      </motion.div>
    )}
  </AnimatePresence>
);

const Facts: FC<{ className?: string; plain?: boolean }> = ({ className, plain }) => {
  const advanced = useAdvanced();
  return (
    <div className={`${plain ? '' : 'rounded-3xl bg-fill px-4'} ${className ?? ''}`}>
      <div className="flex h-11 items-center justify-between text-[15px]">
        <span className="font-bold text-muted">Network</span>
        <span className="flex items-center gap-1.5 font-extrabold">
          <NetworkLogo kind="miden" />
          Miden
        </span>
      </div>
      <div className="flex h-11 items-center justify-between border-t border-hairline text-[15px]">
        <span className="font-bold text-muted">Max network fee</span>
        <span className="font-extrabold">{FEE}</span>
      </div>
      <button type="button" onClick={advanced.toggle} className="flex h-11 w-full items-center justify-between border-t border-hairline text-[15px]">
        <span className="font-bold text-muted">Advanced options</span>
        <span className="flex items-center gap-1 font-extrabold">
          Private · Never
          <motion.span animate={{ rotate: advanced.open ? 180 : 0 }} transition={springs.snappy} className="flex">
            <Icon name={IconName.ChevronDown} size="xs" fill="currentColor" className="text-muted" />
          </motion.span>
        </span>
      </button>
      <AdvancedRows open={advanced.open} />
    </div>
  );
};

export const ReviewBold: FC<ReviewBoldProps> = ({
  variant,
  amount = '70.25',
  address = 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x',
  name,
  onBack,
  onClose,
  onConfirm
}) => {
  const slide = <SlideToSend label="Slide to send" accent="brand" tall onConfirm={() => onConfirm?.()} />;
  const who = name ?? truncateAddress(address, false, 7, 5);

  if (variant === 'statement') {
    // The amount screen's own shape, now a statement: this much, to this person.
    return (
      <div className="flex h-full w-full flex-col bg-page px-5 pb-5 pt-4 font-heading text-ink">
        <TopBar onBack={onBack} onClose={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center">
          <div className="text-[17px] font-bold text-muted">You&apos;re sending</div>
          <div className="mt-1 font-black leading-none tracking-[-0.03em]" style={{ fontSize: figureSize(amount) }}>
            {amount}
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-full border border-hairline py-1.5 pl-1.5 pr-3.5">
            <TokenLogo faucetId={USDCX} size="sm" />
            <span className="text-[17px] font-extrabold">USDCX</span>
          </div>

          <div className="mt-8 text-[17px] font-bold text-muted">to</div>
          <div className="mt-1 flex items-center gap-2.5">
            <ContactAvatar address={address} name={name} size="sm" />
            <span className="text-[26px] font-black leading-8 tracking-[-0.02em]">{who}</span>
            {!name && <NewTag />}
          </div>
          <FullAddress address={address} className="mt-2 text-center text-[14px] font-bold leading-5 text-muted" />
        </div>
        <Facts />
        <div className="mt-3">{slide}</div>
      </div>
    );
  }

  if (variant === 'ticket') {
    // One object to check: a ticket, what leaves on top and who gets it underneath.
    return (
      <div className="flex h-full w-full flex-col bg-page px-5 pb-5 pt-4 font-heading text-ink">
        <TopBar onBack={onBack} onClose={onClose}>
          <span className="text-[17px] font-extrabold">Review</span>
        </TopBar>
        <div className="relative mt-4 overflow-hidden rounded-[28px] shadow-[0_0_0_1px_var(--ds-hairline)]">
          <div className="px-5 pb-6 pt-5">
            <div className="text-[15px] font-bold text-muted">You send</div>
            <div className="mt-2 flex items-center gap-3">
              <TokenLogo faucetId={USDCX} size="lg" />
              <span className="text-[48px] font-black leading-[52px] tracking-[-0.03em]">{amount}</span>
              <span className="self-end pb-1.5 text-[20px] font-extrabold text-muted">USDCX</span>
            </div>
          </div>
          {/* The tear line, with a notch at each edge. */}
          <div className="relative border-t-2 border-dashed border-hairline">
            <span className="absolute -left-3 -top-3 size-6 rounded-full bg-page shadow-[inset_0_0_0_1px_var(--ds-hairline)]" />
            <span className="absolute -right-3 -top-3 size-6 rounded-full bg-page shadow-[inset_0_0_0_1px_var(--ds-hairline)]" />
          </div>
          <div className="bg-fill px-5 pb-5 pt-6">
            <div className="flex items-center gap-2 text-[15px] font-bold text-muted">
              To
              {!name && <NewTag />}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <ContactAvatar address={address} name={name} size="md" />
              <span className="text-[24px] font-black leading-8 tracking-[-0.02em]">{who}</span>
            </div>
            <FullAddress address={address} className="mt-3 text-[14px] font-bold leading-5 text-muted" />
          </div>
        </div>
        <Facts className="mt-4" />
        <div className="mt-auto pt-3">{slide}</div>
      </div>
    );
  }

  // sentence: say what is about to happen, in full, at the size of a headline.
  return (
    <div className="flex h-full w-full flex-col bg-page px-5 pb-5 pt-4 font-heading text-ink">
      <TopBar onBack={onBack} onClose={onClose} />
      <div className="mt-6 text-[40px] font-black leading-[46px] tracking-[-0.03em]">
        <div className="text-muted">Send</div>
        <div className="flex items-center gap-2.5">
          {amount} USDCX
          <TokenLogo faucetId={USDCX} size="md" />
        </div>
        <div>
          <span className="text-muted">to</span> {who}
        </div>
      </div>
      <div className="mt-6 rounded-3xl bg-fill px-4 py-4">
        <div className="flex items-center gap-2 text-[15px] font-bold text-muted">
          <ContactAvatar address={address} name={name} size="sm" />
          Their address
          {!name && <NewTag />}
        </div>
        <FullAddress address={address} className="mt-2 text-[17px] font-extrabold leading-6" />
      </div>
      <Facts plain className="mt-3 px-1" />
      <div className="mt-auto pt-3">{slide}</div>
    </div>
  );
};

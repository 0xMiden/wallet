// Three arrangements of Send's recipient step once a recipient is chosen. Same content in each as
// the app's screen: the title, who it is, the full address, a way to clear it, the network (which
// can be changed), the Address Book shortcut (or "Add to contacts?" for an unsaved address) and
// Continue. Styled in the language of the 24 Nov mock: outlined cards, the header rule, plain rows.
// Each borrows its arrangement from a shipped app (named on the tab). Nothing here ships.
import React, { FC, ReactNode, useLayoutEffect, useRef } from 'react';

import { animate, motion, useMotionValue } from 'framer-motion';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { Button, ButtonVariant } from '../../../src/components/Button';
import { ContactAvatar } from '../../../src/components/contacts/ContactAvatar';
import { NetworkLogo } from '../../../src/components/NetworkChip';
import { HeaderRule } from '../../../src/components/ui/HeaderRule';
import { Pill } from '../../../src/components/ui/Pill';
import { springs } from '../../../src/lib/animation';
import { BridgeChain, netOf } from './bridge';
import { SendTopBar } from './recipient-picker';

export type RecipientVariant = 'cards' | 'centred' | 'token';

const Person: FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="5" r="2.75" stroke="currentColor" strokeWidth="1.6" />
    <path d="M2.75 13.5c.6-2.3 2.7-3.75 5.25-3.75s4.65 1.45 5.25 3.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const Clear: FC = () => (
  <button type="button" aria-label="Clear recipient" className="flex size-11 shrink-0 items-center justify-center">
    <span className="flex size-6 items-center justify-center rounded-full bg-fill-pressed">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M1.5 1.5l7 7m0-7l-7 7" stroke="var(--ds-ink)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  </button>
);

const Chevron: FC<{ down?: boolean }> = ({ down }) => (
  <span className={`flex text-muted ${down ? '' : '-rotate-90'}`}>
    <Icon name={IconName.ChevronDown} size="xs" className="[&_*]:fill-current [&_*]:stroke-current" />
  </span>
);

const Shell: FC<{ children: ReactNode; onContinue?: () => void; bare?: boolean; onBack?: () => void }> = ({ children, onContinue, bare, onBack }) =>
  onBack ? (
    // In the flow: the first page's top bar stays, so only the content beneath it changes.
    // `bare` leaves the background off, so the page underneath shows through while it fades away.
    <div className={`flex h-full w-full flex-col font-heading text-ink ${bare ? '' : 'bg-page'}`}>
      <SendTopBar onBack={onBack} />
      <div className="flex min-h-0 flex-1 flex-col px-[17px] pb-4">
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        <motion.div
          className="flex shrink-0"
          initial={bare ? { opacity: 0, y: 12 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...springs.standard, delay: 0.3 }}
        >
          <Button
            title="Continue"
            variant={ButtonVariant.Primary}
            accent="send"
            onClick={() => onContinue?.()}
            className="w-full max-w-none"
            data-testid="send-recipient-confirm"
          />
        </motion.div>
      </div>
    </div>
  ) : (
  <div className={`flex h-full w-full flex-col px-4 pb-4 pt-9 font-heading text-ink ${bare ? '' : 'bg-page'}`}>
    <h1 className="text-[28px] font-extrabold leading-9">Send to</h1>
    <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    <Button title="Continue" variant={ButtonVariant.Primary} accent="send" onClick={() => onContinue?.()} className="w-full max-w-none shrink-0" data-testid="send-recipient-confirm" />
  </div>
  );

/** The address in full as two even lines. */
const Address: FC<{ address: string; className?: string }> = ({ address, className }) => {
  const half = Math.ceil(address.length / 2);
  return (
    <div className={className}>
      <div>{address.slice(0, half)}</div>
      <div>{address.slice(half)}</div>
    </div>
  );
};

const Shortcut: FC<{ known: boolean }> = ({ known }) => (
  <Pill icon={<Person />} onClick={() => undefined}>
    {known ? 'Address Book' : 'Add to contacts?'}
  </Pill>
);

export const RecipientIdea: FC<{
  variant: RecipientVariant;
  address: string;
  name?: string;
  /** Clears the recipient (the centred version's "Change"). */
  onClear?: () => void;
  onContinue?: () => void;
  /** In the flow: draws the first page's top bar in place of the "Send to" title; its arrow goes back to that page. */
  onBack?: () => void;
  /** The destination chain of a 0x recipient, and the handler that opens its picker. */
  chain?: BridgeChain;
  onNetwork?: () => void;
  /** Where the tapped avatar sat in the list (viewport centre and size): the big avatar grows out of it. */
  from?: { x: number; y: number; size: number };
}> = ({ variant, address, name, onClear, onContinue, onBack, from, chain, onNetwork }) => {
  const label = 'text-[13px] font-extrabold text-muted';

  // The centred version's arrival: the avatar travels from the row that was tapped to its place and
  // grows as it goes, and the rest of the screen follows it in, top to bottom.
  const hero = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  useLayoutEffect(() => {
    const node = hero.current;
    if (!node || !from) return undefined;
    const rect = node.getBoundingClientRect();
    x.set(from.x - (rect.left + rect.width / 2));
    y.set(from.y - (rect.top + rect.height / 2));
    scale.set(from.size / rect.width);
    const controls = [animate(x, 0, springs.standard), animate(y, 0, springs.standard), animate(scale, 1, springs.standard)];
    return () => controls.forEach(control => control.stop());
    // Runs once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rise = (order: number) =>
    from
      ? { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { ...springs.standard, delay: 0.1 + order * 0.045 } }
      : {};

  if (variant === 'cards') {
    // Two labelled outlined cards, like the recents they came from: who, then where.
    return (
      <Shell>
        <HeaderRule className="mt-4 w-full shrink-0" />
        <div className={`mt-5 ${label}`}>To</div>
        <div className="mt-2 flex items-center gap-3 rounded-[20px] border border-hairline py-3 pl-4 pr-1">
          <ContactAvatar address={address} name={name} network={netOf(address).kind} />
          <div className="min-w-0 flex-1">
            {name && <div className="text-[17px] font-black leading-6">{name}</div>}
            <Address address={address} className={name ? 'text-[13px] font-bold leading-[18px] text-muted' : 'text-[15px] font-extrabold leading-5'} />
          </div>
          <Clear />
        </div>
        <div className={`mt-5 ${label}`}>Network</div>
        <button type="button" className="mt-2 flex h-16 items-center gap-3 rounded-[20px] border border-hairline px-4 text-left">
          <span className="flex size-10 items-center justify-center rounded-full bg-fill">
            <NetworkLogo kind={netOf(address, chain).kind} network={netOf(address, chain).slug} />
          </span>
          <span className="flex-1 text-[17px] font-extrabold">{netOf(address, chain).label}</span>
          <Chevron />
        </button>
        <div className="mt-4 flex">
          <Shortcut known={Boolean(name)} />
        </div>
      </Shell>
    );
  }

  if (variant === 'centred') {
    // The person is the screen, the way the amount is on the next one; the rest are plain rows.
    return (
      <Shell onContinue={onContinue} bare={Boolean(from)} onBack={onBack}>
        <div className="mt-8 flex flex-col items-center">
          <motion.div ref={hero} style={{ x, y, scale }} className="relative z-10">
            <ContactAvatar address={address} name={name} network={netOf(address).kind} size="xl" />
          </motion.div>
          {name && (
            <motion.div {...rise(0)} className="mt-3 text-[32px] font-black leading-10 tracking-[-0.02em]">
              {name}
            </motion.div>
          )}
          <motion.div {...rise(1)}>
            {/* The full address on one line; a longer (0x) address steps down a size to stay on it. */}
            <div
              className={`max-w-full whitespace-nowrap text-center ${
                name
                  ? `mt-1 font-bold leading-5 text-muted ${address.length > 38 ? 'text-[12px]' : 'text-[14px]'}`
                  : `mt-4 font-black leading-6 ${address.length > 38 ? 'text-[13px]' : 'text-[15px]'}`
              }`}
            >
              {address}
            </div>
          </motion.div>
          <motion.button
            {...rise(2)}
            type="button"
            onClick={onClear}
            className="mt-3 flex h-9 items-center gap-1.5 rounded-full border border-hairline px-3.5 text-[14px] font-extrabold active:bg-fill"
          >
            Change
          </motion.button>
        </div>
        <motion.div {...rise(3)} className="mt-7 w-full shrink-0">
          <HeaderRule className="w-full" />
        </motion.div>
        <motion.button {...rise(4)} type="button" onClick={onNetwork} className="flex h-14 w-full items-center justify-between border-b border-hairline text-[15px]">
          <span className="font-extrabold text-muted">Network</span>
          <span className="flex items-center gap-1.5 font-black">
            <NetworkLogo kind={netOf(address, chain).kind} network={netOf(address, chain).slug} />
            {netOf(address, chain).label}
            <Chevron />
          </span>
        </motion.button>
        <motion.button {...rise(5)} type="button" className="flex h-14 w-full items-center justify-between text-[15px]">
          <span className="flex items-center gap-2 font-black">
            <Person />
            {name ? 'Address Book' : 'Add to contacts?'}
          </span>
          <Chevron />
        </motion.button>
      </Shell>
    );
  }

  // token: the field stays a field. The recipient sits in it as a removable token, as in a mail app.
  return (
    <Shell>
      <div className="mt-4 rounded-[20px] border border-hairline p-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 rounded-full bg-fill py-1.5 pl-1.5 pr-1 text-[17px] font-extrabold">
            <ContactAvatar address={address} name={name} size="sm" />
            {name ?? `${address.slice(0, 7)}…${address.slice(-5)}`}
            <span className="-my-2.5 -mr-1">
              <Clear />
            </span>
          </span>
          <button type="button" className="flex h-9 items-center gap-1.5 rounded-full border border-hairline pl-2 pr-2.5 text-[14px] font-extrabold">
            <NetworkLogo kind={netOf(address, chain).kind} network={netOf(address, chain).slug} />
            {netOf(address, chain).label}
            <Chevron down />
          </button>
        </div>
        <Address address={address} className="mt-3 px-1 text-[15px] font-bold leading-[22px] text-muted" />
      </div>
      <div className="mt-3 flex">
        <Shortcut known={Boolean(name)} />
      </div>
    </Shell>
  );
};

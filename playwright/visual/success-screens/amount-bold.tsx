// Send's "Enter amount" step, designed freely. Bread's font (Nunito), colours, token logo, icons and
// contact avatar; none of the app's layout components. One idea: the number is the screen.
//
// The amount is a real text field, so the phone's own number keyboard opens for it. A desktop
// browser shows no such keyboard, so the space it takes is drawn as a labelled placeholder: the
// layout has to work in what is left above it. Nothing here ships.
import React, { FC, ReactNode, useEffect, useRef, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { ContactAvatar } from '../../../src/components/contacts/ContactAvatar';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { springs } from '../../../src/lib/animation';
import { truncateAddress } from '../../../src/utils/string';
import { PROTO_TOKENS, ProtoToken } from './tokens';

/** Roughly what the iOS decimal keyboard and the home indicator take from the bottom of the screen. */
const KEYBOARD_HEIGHT = 300;

// A drawing of the phone's decimal keyboard, so the prototype feels like the device. The real one
// is the operating system's: iOS and Android each draw their own, and the app does not style it.
const KEYBOARD_ROWS: [string, string][][] = [
  [
    ['1', ''],
    ['2', 'ABC'],
    ['3', 'DEF']
  ],
  [
    ['4', 'GHI'],
    ['5', 'JKL'],
    ['6', 'MNO']
  ],
  [
    ['7', 'PQRS'],
    ['8', 'TUV'],
    ['9', 'WXYZ']
  ],
  [
    ['.', ''],
    ['0', ''],
    ['del', '']
  ]
];

// Drawn after the current iOS keyboard (iOS 26): one light panel with large rounded top corners that
// sits over the page, and softly rounded white keys with barely any edge. `accessory` is a bar of our
// own inside the top of the panel, which is where the amount shortcuts ride.
const PhoneKeyboard: FC<{ onKey: (key: string) => void; accessory?: ReactNode }> = ({ onKey, accessory }) => (
  <motion.div
    initial={{ y: '100%' }}
    animate={{ y: 0 }}
    transition={springs.sheetPresent}
    className="shrink-0 select-none rounded-t-[28px] px-[7px] pt-[9px]"
    style={{
      height: KEYBOARD_HEIGHT + (accessory ? 46 : 0),
      background: '#e3e4e8',
      boxShadow: '0 -1px 0 rgba(0, 0, 0, 0.05)',
      fontFamily: '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif'
    }}
  >
    {accessory}
    <div aria-hidden="true" className="flex flex-col gap-[7px]">
      {KEYBOARD_ROWS.map((row, index) => (
        <div key={index} className="flex gap-[7px]">
          {row.map(([key, letters]) => {
            const bare = key === '.' || key === 'del';
            return (
              <button
                key={key}
                type="button"
                tabIndex={-1}
                // Keep the caret in the amount field while a key is pressed.
                onMouseDown={event => event.preventDefault()}
                onClick={() => onKey(key)}
                className="flex h-[47px] flex-1 flex-col items-center justify-center rounded-[11px] text-black active:brightness-90"
                style={bare ? { background: 'transparent' } : { background: '#fff', boxShadow: '0 0.5px 1.5px rgba(0, 0, 0, 0.16)' }}
              >
                {key === 'del' ? (
                  <svg width="25" height="19" viewBox="0 0 24 18" fill="none">
                    <path d="M8.2 1H20a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H8.2a2 2 0 0 1-1.5-.7L1 9l5.7-7.3A2 2 0 0 1 8.2 1Z" stroke="#000" strokeWidth="1.5" strokeLinejoin="round" />
                    <path d="m11.5 6 6 6m0-6-6 6" stroke="#000" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                ) : (
                  <>
                    <span className="text-[25px] leading-[27px]">{key}</span>
                    {letters && <span className="text-[10px] font-bold leading-[11px] tracking-[0.2em]">{letters}</span>}
                  </>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
    <div className="mx-auto mt-[50px] h-[5px] w-[139px] rounded-full bg-black" />
  </motion.div>
);

// The figure steps down as it gets longer, so it always fits and always dominates.
const figureSize = (text: string) => (text.length <= 4 ? 96 : text.length <= 6 ? 76 : text.length <= 8 ? 58 : 44);

export const AmountBold: FC<{
  initial?: string;
  /** Who it goes to. */
  address?: string;
  /** Their saved contact name. Without one the pill shows the shortened address. */
  name?: string;
  /** Reserve the space the phone's keyboard covers. Off shows the screen with the keyboard dismissed. */
  keyboard?: boolean;
  onBack?: () => void;
  /** From the 24 Nov mock: once an amount is in, the shortcuts become an outlined strip with dividers. */
  segmented?: boolean;
  /** Trial designs for the shortcuts: separate chips, a sliding selection, or small chips under the balance. */
  shortcuts?: 'chips' | 'slider' | 'inline' | 'keyboard';
  /** The token selected on arrival. */
  initialToken?: ProtoToken;
  /** Receives the entered amount and the chosen token when Continue is pressed. */
  onContinue?: (amount: string, token: ProtoToken) => void;
}> = ({ initial = '', address = 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x', name, keyboard = true, segmented, shortcuts, initialToken, onBack, onContinue }) => {
  // Which shortcut made the current amount, so the trial designs can show it as chosen.
  const [picked, setPicked] = useState<number | null>(null);
  const [amount, setAmount] = useState(initial);
  const [token, setToken] = useState<ProtoToken>(initialToken ?? PROTO_TOKENS[0]!);
  const [picking, setPicking] = useState(false);
  const BALANCE = token.balance;
  const inputRef = useRef<HTMLInputElement>(null);
  const numeric = Number(amount);
  const over = numeric > BALANCE;
  const valid = amount !== '' && numeric > 0 && !over;
  const shown = amount === '' ? '0' : amount;
  const size = figureSize(shown);

  // The field takes focus on arrival, which is what raises the phone's keyboard.
  useEffect(() => {
    if (keyboard) inputRef.current?.focus({ preventScroll: true });
  }, [keyboard]);

  const type = (raw: string) => {
    setPicked(null);
    const clean = raw.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    const [whole = '', fraction] = clean.split('.');
    setAmount(fraction === undefined ? whole.slice(0, 12) : `${whole || '0'}.${fraction.slice(0, 6)}`);
  };
  const part = (share: number) => setAmount(String(Math.floor(BALANCE * share * 1e6) / 1e6));
  const SHARES: [string, number][] = [
    ['25%', 0.25],
    ['50%', 0.5],
    ['75%', 0.75],
    ['Max', 1]
  ];
  const pick = (index: number) => {
    part(SHARES[index]![1]);
    setPicked(index);
  };
  const trialShortcuts =
    shortcuts === 'chips' ? (
      // Four separate outlined chips; the chosen one fills with Bread orange.
      <div className="flex h-11 shrink-0 gap-2 text-[15px] font-extrabold">
        {SHARES.map(([label], index) => (
          <button
            key={label}
            type="button"
            aria-pressed={picked === index}
            onClick={() => pick(index)}
            className="h-full flex-1 rounded-full transition-colors duration-150"
            style={
              picked === index
                ? { background: 'var(--accent-primary)', color: '#fff' }
                : { boxShadow: 'inset 0 0 0 1px #d9d4cd', color: 'var(--ds-ink)' }
            }
          >
            {label}
          </button>
        ))}
      </div>
    ) : shortcuts === 'slider' ? (
      // One grey track; a white thumb slides to the chosen share, like the phone's own segmented control.
      <div className="relative flex h-11 shrink-0 rounded-full bg-fill p-1 text-[15px] font-extrabold">
        {SHARES.map(([label], index) => (
          <button key={label} type="button" aria-pressed={picked === index} onClick={() => pick(index)} className="relative h-full flex-1 rounded-full">
            {picked === index && (
              <motion.span layoutId="share-thumb" transition={springs.snappy} className="absolute inset-0 rounded-full bg-page shadow-[0_1px_3px_rgba(0,0,0,0.14)]" />
            )}
            <span className="relative" style={{ color: picked === index ? 'var(--ds-accent-tint-ink)' : 'var(--ds-ink)' }}>
              {label}
            </span>
          </button>
        ))}
      </div>
    ) : null;
  const inlineShortcuts =
    shortcuts === 'inline' ? (
      // Small chips sitting with the balance they act on; nothing above Continue.
      <div className="mt-3 flex gap-1.5 text-[14px] font-extrabold">
        {SHARES.map(([label], index) => (
          <button
            key={label}
            type="button"
            aria-pressed={picked === index}
            onClick={event => {
              event.stopPropagation();
              pick(index);
            }}
            className="h-8 rounded-full px-3.5 transition-colors duration-150"
            style={picked === index ? { background: 'var(--ds-accent-tint)', color: 'var(--ds-accent-tint-ink)' } : { background: 'var(--ds-fill)', color: 'var(--ds-ink)' }}
          >
            {label}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-page font-heading text-ink">
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-3 pt-4">
        {/* Who it goes to, where a title would be: the screen needs no other heading. */}
        <div className="relative flex h-12 shrink-0 items-center justify-center">
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            className="absolute left-0 flex size-11 items-center justify-center rounded-full active:bg-fill"
          >
            <Icon name={IconName.ArrowLeft} size="md" />
          </button>
          <div className="flex max-w-[260px] items-center gap-2 rounded-full bg-fill py-1.5 pl-1.5 pr-4">
            <ContactAvatar address={address} name={name} size="sm" />
            <span className="text-[15px] font-bold text-muted">To</span>
            <span className="truncate text-[17px] font-extrabold">{name ?? truncateAddress(address, false, 7, 5)}</span>
          </div>
        </div>

        {/* The number: a real field, sized to what is typed. */}
        <div className="flex min-h-0 flex-1 cursor-text flex-col items-center justify-center" onClick={() => inputRef.current?.focus()}>
          {/* The size animates on the same element: a keyed remount here would drop the field's focus mid-typing. */}
          <motion.span
            initial={false}
            animate={{ fontSize: size }}
            transition={springs.snappy}
            className="inline-grid font-black leading-none tracking-[-0.03em]"
          >
            <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre">
              {shown}
            </span>
            <input
              ref={inputRef}
              size={1}
              inputMode="decimal"
              enterKeyHint="next"
              aria-label={`Amount in ${token.symbol}`}
              placeholder="0"
              value={amount}
              onChange={event => type(event.target.value)}
              className="col-start-1 row-start-1 w-full min-w-0 bg-transparent text-center outline-none placeholder:text-[#cfc9c1]"
              style={{ color: over ? 'var(--ds-negative-ink)' : 'var(--ds-ink)', caretColor: 'var(--accent-primary)' }}
            />
          </motion.span>

          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`Token: ${token.symbol}. Change token`}
            onClick={event => {
              event.stopPropagation();
              setPicking(true);
            }}
            className="mt-3 flex items-center gap-2 rounded-full border border-hairline py-1.5 pl-1.5 pr-3 active:bg-fill"
          >
            {/* The logo and symbol swap with a small pop when the token changes. */}
            <motion.span key={token.id} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={springs.snappy} className="flex">
              <TokenLogo faucetId={token.id} size="sm" />
            </motion.span>
            <span className="text-[17px] font-extrabold">{token.symbol}</span>
            <Icon name={IconName.ChevronDown} size="xs" fill="currentColor" className="text-muted" />
          </button>

          <div className="mt-3 h-5 text-[15px] font-bold" style={{ color: over ? 'var(--ds-negative-ink)' : 'var(--ds-muted)' }}>
            {over ? `You only have ${BALANCE} ${token.symbol}` : `${BALANCE} ${token.symbol} available`}
          </div>
          {inlineShortcuts}
        </div>

        {/* Shortcuts: one quiet strip, not four buttons. */}
        {trialShortcuts}
        <div
          hidden={Boolean(shortcuts)}
          className={`flex h-11 shrink-0 items-center overflow-hidden rounded-full text-[15px] font-extrabold transition-colors duration-150 ${
            segmented && valid ? 'border border-[#c9c4bd] bg-page' : 'bg-fill'
          }`}
        >
          {[
            ['25%', 0.25],
            ['50%', 0.5],
            ['75%', 0.75],
            ['Max', 1]
          ].map(([label, share], index) => (
            <button
              key={label}
              type="button"
              onClick={() => part(Number(share))}
              className={`h-full flex-1 active:bg-fill-pressed ${segmented && valid ? (index > 0 ? 'border-l border-[#c9c4bd]' : '') : 'rounded-full'} ${
                index === 3 ? 'text-accent-tint-ink' : 'text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={!valid}
          onClick={() => onContinue?.(amount, token)}
          className="mt-3 h-14 w-full shrink-0 rounded-full text-[19px] font-extrabold transition-colors duration-150"
          style={valid ? { background: 'var(--accent-primary)', color: '#fff' } : { background: 'var(--ds-fill)', color: '#a8a29a' }}
        >
          Continue
        </button>
      </div>

      {keyboard && (
        <PhoneKeyboard
          onKey={key => type(key === 'del' ? amount.slice(0, -1) : amount + key)}
          accessory={
            shortcuts === 'keyboard' ? (
              // On the keyboard: the four shortcuts as white outlined pills inside the top of its panel,
              // Max in Bread orange (the user's style). The chosen one fills dark.
              <div className="mb-[9px] flex h-[37px] gap-[7px] font-heading text-[15px] font-extrabold">
                {SHARES.map(([label], index) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={picked === index}
                    // Keep the caret in the amount field, as the keys do.
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => pick(index)}
                    className="h-full flex-1 rounded-full transition-colors duration-150"
                    style={
                      picked === index
                        ? { background: 'var(--ds-ink)', color: '#fff' }
                        : { background: '#fff', boxShadow: 'inset 0 0 0 1.5px #ebebeb', color: index === 3 ? 'var(--accent-primary-hover)' : '#595959' }
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        />
      )}

      {/* Token picker: a sheet over the screen and the keyboard, listing what the wallet holds. */}
      <AnimatePresence>
        {picking && (
          <>
            <motion.div
              key="scrim"
              className="absolute inset-0 z-20 bg-black/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setPicking(false)}
            />
            <motion.div
              key="sheet"
              role="dialog"
              aria-label="Choose token"
              className="absolute inset-x-0 bottom-0 z-30 rounded-t-[28px] bg-page px-5 pb-8 pt-3"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={springs.sheetPresent}
            >
              <div className="mx-auto h-[5px] w-9 rounded-full bg-fill-pressed" />
              <div className="mt-4 text-[24px] font-black tracking-[-0.02em]">Choose token</div>
              <div className="mt-3 flex flex-col gap-2">
                {PROTO_TOKENS.map(item => {
                  const selected = item.id === token.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        // The typed amount belongs to the old token, so it is cleared with the switch.
                        if (!selected) setAmount('');
                        setToken(item);
                        setPicking(false);
                        inputRef.current?.focus({ preventScroll: true });
                      }}
                      className="flex items-center gap-3 rounded-2xl px-4 py-3 text-left"
                      style={{ background: selected ? 'var(--ds-accent-tint)' : 'var(--ds-fill)' }}
                    >
                      <TokenLogo faucetId={item.id} size="md" />
                      <span className="flex-1">
                        <span className="block text-[17px] font-extrabold">{item.symbol}</span>
                        <span className="block text-[13px] font-bold text-muted">{item.name}</span>
                      </span>
                      <span className="text-right">
                        <span className="block text-[17px] font-extrabold">{item.balance}</span>
                        <span className="block text-[13px] font-bold text-muted">available</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

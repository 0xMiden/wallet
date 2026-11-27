// A bottom sheet that stays inside the prototype's phone frame, for the review step's two editable
// options. The app's real sheets (TransferTypeDrawer, RecallCalendarDrawer) cover the whole browser
// window from a preview, so this stands in for them. The transfer-type wording is the app's own; the
// expiry choices are a simplification of the app's date-and-time picker.
import React, { FC, ReactNode } from 'react';

import { AnimatePresence, motion } from 'framer-motion';

import { springs } from '../../../src/lib/animation';

export const TRANSFER_TYPES = [
  { id: 'Private', note: 'Default' },
  { id: 'Public', note: "Anyone can see this transfer's token, amount, and recipient address on Miden." }
] as const;
export const EXPIRIES = [
  { id: 'Never', note: 'The recipient can claim it at any time.' },
  { id: '1 hour', note: 'Unclaimed funds come back to you after an hour.' },
  { id: '24 hours', note: 'Unclaimed funds come back to you after a day.' },
  { id: '7 days', note: 'Unclaimed funds come back to you after a week.' }
] as const;

export const OptionSheet: FC<{
  open: boolean;
  title: string;
  options: readonly { id: string; note: string }[];
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  footer?: ReactNode;
}> = ({ open, title, options, value, onChange, onClose, footer }) => (
  <AnimatePresence>
    {open && (
      <>
        <motion.div
          key="scrim"
          className="absolute inset-0 z-20 bg-black/40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        />
        <motion.div
          key="sheet"
          role="dialog"
          aria-label={title}
          className="absolute inset-x-0 bottom-0 z-30 rounded-t-[28px] bg-page px-5 pb-6 pt-3 font-heading text-ink"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={springs.sheetPresent}
        >
          <div className="mx-auto h-[5px] w-9 rounded-full bg-fill-pressed" />
          <div className="mt-4 text-[24px] font-black tracking-[-0.02em]">{title}</div>
          <div role="radiogroup" aria-label={title} className="mt-3 flex flex-col gap-2">
            {options.map(option => {
              const selected = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange(option.id)}
                  className="flex items-center gap-3 rounded-2xl px-4 py-3 text-left"
                  style={{ background: selected ? 'var(--ds-accent-tint)' : 'var(--ds-fill)' }}
                >
                  <span className="flex-1">
                    <span className="block text-[17px] font-extrabold">{option.id}</span>
                    <span className="block text-[13px] font-bold leading-[18px] text-muted">{option.note}</span>
                  </span>
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-full"
                    style={selected ? { background: 'var(--accent-primary)' } : { boxShadow: 'inset 0 0 0 2px var(--ds-fill-pressed)' }}
                  >
                    {selected && (
                      <svg width="14" height="14" viewBox="0 0 44 44" fill="none">
                        <path d="M11 23L18.5 30.5L33 15" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {footer}
          <button type="button" onClick={onClose} className="mt-4 h-14 w-full rounded-full text-[19px] font-extrabold text-white" style={{ background: 'var(--accent-primary)' }}>
            Done
          </button>
        </motion.div>
      </>
    )}
  </AnimatePresence>
);

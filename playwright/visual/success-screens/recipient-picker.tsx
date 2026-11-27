// The Send flow's first page, built to the user's guide (Desktop/Background+Border.svg, 393x852):
// a 60px grey top bar with the back arrow and "Send money"; the address field as a centred 28px
// prompt; two small outlined chips under it; the 4px rule at y217; "Recent"; then each recent
// recipient as its own 68px outlined card. There is no Continue here: choosing or entering a
// recipient moves on to the recipient screen, which carries it. Nothing here ships.
import React, { FC, ReactNode } from 'react';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { Button, ButtonVariant } from '../../../src/components/Button';
import { ContactAvatar } from '../../../src/components/contacts/ContactAvatar';
import type { RecentRecipient } from '../../../src/screens/send-flow/types';
import { truncateAddress } from '../../../src/utils/string';

/** The guide's top bar, shared with the recipient screen so the bar does not change between them. */
export const SendTopBar: FC<{ onBack?: () => void }> = ({ onBack }) => (
  <div className="relative flex h-[60px] shrink-0 items-center justify-center font-heading" style={{ background: '#f9f9f9' }}>
    <button type="button" aria-label="Back" onClick={onBack} className="absolute left-[7px] flex size-11 items-center justify-center rounded-full">
      <Icon name={IconName.ArrowLeft} size="md" />
    </button>
    <span className="text-[19px] font-extrabold leading-6 text-ink">Send money</span>
  </div>
);

const Chip: FC<{ icon: ReactNode; onClick?: () => void; testId?: string; children: ReactNode }> = ({ icon, onClick, testId, children }) => (
  <button
    type="button"
    onClick={onClick}
    data-testid={testId}
    className="flex h-[26px] items-center gap-1.5 rounded-full bg-page pl-2.5 pr-3 text-[12px] font-extrabold text-ink active:bg-fill"
    style={{ boxShadow: 'inset 0 0 0 0.8px rgba(0, 0, 0, 0.2)' }}
  >
    {icon}
    {children}
  </button>
);

export const RecipientPicker: FC<{
  address: string;
  /** Shown when what is typed is not a valid address. */
  invalid?: boolean;
  recents: RecentRecipient[];
  onAddressChange: (value: string) => void;
  onPaste: () => void;
  onAddressBook?: () => void;
  onSelectRecent: (recent: RecentRecipient) => void;
  onBack?: () => void;
  /** Given once a typed address is valid: typing never moves on by itself, so Continue (or Return) does. */
  onContinue?: () => void;
}> = ({ address, invalid, recents, onAddressChange, onPaste, onAddressBook, onSelectRecent, onBack, onContinue }) => (
  <div className="flex h-full w-full flex-col bg-page font-heading text-ink">
    <SendTopBar onBack={onBack} />
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[17px] pb-6 pt-[30px]">
      <textarea
        rows={2}
        aria-label="Recipient address"
        placeholder="Enter Miden or Ethereum Address"
        value={address}
        onChange={event => onAddressChange(event.target.value.replace(/\s/g, ''))}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onContinue?.();
          }
        }}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        // A typed address is long, so it is set smaller than the prompt and always fits the two lines.
        className={`w-full shrink-0 resize-none overflow-hidden break-all bg-transparent px-3 text-center font-bold leading-[34px] tracking-[-0.01em] text-ink outline-none placeholder:text-muted ${
          address ? 'text-[21px]' : 'text-[28px]'
        }`}
        style={{ caretColor: 'var(--accent-primary)' }}
      />
      {/* The error takes its own line only when there is one, so the guide's spacing holds otherwise. */}
      {invalid && <div className="mt-1 shrink-0 text-center text-[13px] font-bold leading-[18px] text-negative-ink">That is not a Miden or Ethereum address</div>}
      <div className="mt-[9px] flex shrink-0 justify-center gap-1.5">
        <Chip
          testId="send-paste"
          onClick={onPaste}
          icon={
            <span className="flex scale-[0.8]">
              <Icon name={IconName.FileCopy} size="xs" />
            </span>
          }
        >
          Paste
        </Chip>
        <Chip
          testId="send-address-book"
          onClick={onAddressBook}
          icon={
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="5" r="2.75" stroke="currentColor" strokeWidth="1.9" />
              <path d="M2.75 13.5c.6-2.3 2.7-3.75 5.25-3.75s4.65 1.45 5.25 3.75" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          }
        >
          Address Book
        </Chip>
      </div>

      {recents.length > 0 && (
        <section data-testid="send-recent-recipients" className="shrink-0">
          <div className="mt-6 h-1 rounded-full" style={{ background: '#f3f0ec' }} />
          <h2 className="mt-[18px] text-[18px] font-extrabold leading-6">Recent</h2>
          <ul className="mt-2.5 flex flex-col gap-3">
            {recents.map(recent => (
              <li key={recent.address}>
                <button
                  type="button"
                  data-testid="send-recent-recipient"
                  onClick={() => onSelectRecent(recent)}
                  className="flex h-[68px] w-full items-center gap-3 rounded-2xl bg-page px-4 text-left active:bg-fill"
                  style={{ boxShadow: 'inset 0 0 0 1px #f3f0ec' }}
                >
                  <ContactAvatar address={recent.address} name={recent.name} network={recent.chain === 'miden' ? 'miden' : 'ethereum'} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[16px] font-extrabold leading-5">{recent.name ?? truncateAddress(recent.address)}</span>
                    <span className="truncate text-[13px] font-semibold leading-[17px] text-muted">
                      {recent.name ? truncateAddress(recent.address) : recent.chain === 'miden' ? 'Miden' : 'Ethereum'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
    {onContinue && (
      <div className="flex shrink-0 px-[17px] pb-4">
        <Button title="Continue" variant={ButtonVariant.Primary} accent="send" onClick={onContinue} className="w-full max-w-none" data-testid="send-typed-continue" />
      </div>
    )}
  </div>
);

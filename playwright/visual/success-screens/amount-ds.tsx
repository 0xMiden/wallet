// Send's "Enter amount" step, rebuilt on the design system and nothing else.
//
// design-system.md, "Entry": "Centered 48px amount with a 22px unit, 15px muted fiat line, token and
// Max pills". Every piece here is the app's own component in the mode the system names:
//   - PageHeader via SendStepLayout, pinned Button CTA
//   - ListGroup + ListRow for who it goes to (64px row, 40px avatar)
//   - TokenAmountInput with align="center" (the real field, its real unit switch and fiat line)
//   - AmountShortcuts (32px pills)
//   - Numpad (76px keys, the passcode keypad)
// The one thing that is not in the app: a decimal key on the keypad. Numpad has no "." today, so it
// is drawn into the pad's empty bottom-left slot here in the digit keys' own style. Shipping this
// means adding that key to Numpad.
import type { TokenPriceInfo } from '../../../src/lib/prices/binance';
import React, { FC, useState } from 'react';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { Button, ButtonVariant } from '../../../src/components/Button';
import { NetworkChip } from '../../../src/components/NetworkChip';
import { Numpad } from '../../../src/components/Numpad';
import { TokenAmountInput } from '../../../src/components/TokenAmountInput';
import { TokenLogo } from '../../../src/components/TokenLogo';
import { Avatar } from '../../../src/components/ui/Avatar';
import { ListGroup } from '../../../src/components/ui/ListGroup';
import { ListRow } from '../../../src/components/ui/ListRow';
import { AmountShortcuts } from '../../../src/screens/send-flow/AmountShortcuts';
import { SendStepLayout } from '../../../src/screens/send-flow/SendStepLayout';
import { USDCX } from './fixture';

const BALANCE = 140.5;
// A price observed just now, so the real field shows its dollar line and its unit switch works.
const QUOTE: TokenPriceInfo = { price: 1, change24h: 0, percentageChange24h: 0, kind: 'market', observedAt: Date.now() };

export const AmountOnSystem: FC<{ initial?: string }> = ({ initial = '' }) => {
  const [amount, setAmount] = useState(initial);
  const numeric = Number(amount);
  const over = numeric > BALANCE;
  const valid = amount !== '' && numeric > 0 && !over;

  const press = (key: string) =>
    setAmount(current => {
      if (key === '.') return current.includes('.') ? current : current === '' ? '0.' : `${current}.`;
      if (current === '0') return key;
      const [, fraction] = current.split('.');
      return fraction !== undefined && fraction.length >= 6 ? current : current + key;
    });

  return (
    <SendStepLayout
      title="Enter amount"
      onBack={() => undefined}
      footer={
        <Button title="Continue" variant={ButtonVariant.Primary} accent="send" onClick={() => undefined} disabled={!valid} className="w-full max-w-none" />
      }
    >
      <div className="flex min-h-full flex-col gap-5">
        <ListGroup surface="fill">
          <ListRow
            avatar={<Avatar size={40} initials="M" color="var(--accent-send)" />}
            title="Maya"
            subtitle="mtst1apq…wk6x"
            trailing={<NetworkChip kind="miden" label="Miden" />}
          />
        </ListGroup>

        <div className="ds-entry -mt-2 flex w-full flex-col">
          <TokenAmountInput
            align="center"
            accent="send"
            assetId={USDCX}
            symbol="USDCX"
            decimals={6}
            decimalsLimit={6}
            scaleIsKnown
            externalAsset
            quote={QUOTE}
            value={amount}
            invalid={over}
            error={over ? 'More than you have available' : undefined}
            showDivider={false}
            onValueChange={value => setAmount(value || '')}
            // The token pill is the field's own slot, drawn as the swap and deposit steps draw it.
            tokenSelector={
              <div className="flex items-center justify-center gap-2">
                <button type="button" className="flex cursor-pointer items-center gap-1.5 rounded-full bg-input-bg py-1.5 pr-2.5 pl-1.5">
                  <TokenLogo faucetId={USDCX} size="sm" />
                  <span className="font-heading text-xl font-bold text-ink">USDCX</span>
                  <Icon name={IconName.ChevronDown} size="xs" className="text-accent-send" fill="currentColor" />
                </button>
                <span className="text-caption text-muted">Available {BALANCE}</span>
              </div>
            }
          />
          <AmountShortcuts balance={BALANCE} decimals={6} scaleIsKnown onAmountChange={setAmount} compact className="mt-3 justify-center text-accent-send-ink" />
        </div>

        <div className="ds-pad relative mx-auto mt-auto w-fit">
          <Numpad onDigit={press} onDelete={() => setAmount(current => current.slice(0, -1))} />
          {/* The decimal key Numpad does not have yet, in the digit keys' own classes. */}
          <button
            type="button"
            aria-label="Decimal point"
            onClick={() => press('.')}
            className="absolute bottom-0 left-0 flex size-19 items-center justify-center rounded-full bg-fill font-heading text-[32px] leading-none font-extrabold text-ink outline-none select-none active:bg-fill-pressed [@media(max-height:720px)]:size-16"
          >
            .
          </button>
        </div>
      </div>
    </SendStepLayout>
  );
};

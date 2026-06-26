import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { CircleButton } from 'components/CircleButton';
import { TokenLogo } from 'components/TokenLogo';
import { SWAP_TOKENS, SwapToken } from 'lib/miden/swap/tokens';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';

export interface SelectSwapTokenProps {
  /** Faucet id currently chosen for this side, rendered as selected. */
  currentFaucetId?: string;
  onSelect: (token: SwapToken) => void;
  onBack: () => void;
}

/**
 * Token picker for a swap side. The DEX exposes a fixed set of test tokens
 * (`SWAP_TOKENS`), so this is a simple list rather than the balance-driven
 * picker used by the send flow.
 */
export const SelectSwapToken: React.FC<SelectSwapTokenProps> = ({ currentFaucetId, onSelect, onBack }) => {
  const { t } = useTranslation();

  return (
    <div className={clsx('flex h-full min-h-0 flex-col bg-app-bg', isMobile() ? 'px-8' : 'px-6')}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto no-scrollbar pt-4 pb-32">
        <CircleButton
          icon={IconName.BackArrow}
          color="currentColor"
          size="sm"
          onClick={onBack}
          className="mb-4 self-start border border-border-card text-primary-500"
        />
        <h1 className="mb-4 font-heading text-2xl font-bold text-[#808080]">{t('selectAToken')}</h1>

        <div className="flex flex-col">
          {SWAP_TOKENS.map(token => (
            <button
              key={token.faucetId}
              type="button"
              onClick={() => {
                hapticLight();
                onSelect(token);
              }}
              className="flex items-center gap-3 py-3.5 text-left"
            >
              <TokenLogo symbol={token.logoSymbol} size="md" />
              <span className="flex-1 font-heading text-base font-bold text-heading-gray">{token.symbol}</span>
              {token.faucetId === currentFaucetId && <span className="h-2.5 w-2.5 rounded-full bg-primary-500" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

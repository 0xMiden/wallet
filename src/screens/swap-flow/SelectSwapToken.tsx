import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { SWAP_TOKENS, SwapToken } from 'lib/miden/swap/tokens';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface SelectSwapTokenDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Faucet id currently chosen for this side, rendered as selected. */
  currentFaucetId?: string;
  onSelect: (token: SwapToken) => void;
}

/**
 * Token picker for a swap side, presented as a bottom sheet (vaul) over the
 * amounts step like the send flow's SelectTokenDrawer. The DEX exposes a fixed
 * set of test tokens (`SWAP_TOKENS`), so this is a simple list rather than the
 * balance-driven picker used by the send flow.
 */
export const SelectSwapTokenDrawer: React.FC<SelectSwapTokenDrawerProps> = ({
  open,
  onOpenChange,
  currentFaucetId,
  onSelect
}) => {
  const { t } = useTranslation();

  const onSelectToken = (token: SwapToken) => {
    hapticLight();
    onSelect(token);
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col min-h-0 px-4 pb-4 h-120">
          <div className="flex flex-col min-h-0 overflow-y-auto no-scrollbar divide-y divide-rule-default">
            {SWAP_TOKENS.map(token => (
              <button
                key={token.faucetId}
                type="button"
                onClick={() => onSelectToken(token)}
                className="flex items-center gap-3 py-3.5 text-left"
                data-testid={`swap-token-${token.symbol}`}
              >
                <TokenLogo symbol={token.logoSymbol} size="md" />
                <span className="flex-1 font-heading text-base font-bold text-heading-gray">{token.symbol}</span>
                {token.faucetId === currentFaucetId && <span className="h-2.5 w-2.5 rounded-full bg-primary-500" />}
              </button>
            ))}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

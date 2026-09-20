import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { getSwapTokens, SwapToken } from 'lib/miden/swap/tokens';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface SelectSwapTokenDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Faucet id currently chosen for this side, rendered as selected. */
  currentFaucetId?: string;
  onSelect: (token: SwapToken) => void;
}

/**
 * Token picker for a swap side, presented as a bottom sheet (vaul) over the amounts step like the
 * send flow's SelectTokenDrawer. The DEX exposes a fixed set of test tokens (`SWAP_TOKENS`), so
 * this is a simple list rather than the balance-driven picker used by the send flow.
 *
 * One `ListGroup` of `ListRow`s, the way the address book and Settings draw a list: rows on the
 * shared `fill` with hairlines inset past the logo, and the chosen side marked with the design
 * system's round check rather than a loose dot. `ListRow` fires the tap haptic itself.
 *
 * The rows carry the swap accent, so the check on the chosen side and the hairlines between the
 * rows are the flow's purple like every other page of the swap (design-system.md, "Action
 * colours"); the symbols stay `ink`.
 */
export const SelectSwapTokenDrawer: React.FC<SelectSwapTokenDrawerProps> = ({
  open,
  onOpenChange,
  currentFaucetId,
  onSelect
}) => {
  const { t } = useTranslation();

  const onSelectToken = (token: SwapToken) => {
    onSelect(token);
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="swap-token">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex h-120 min-h-0 flex-col px-4 pb-4">
          <div className="no-scrollbar min-h-0 overflow-y-auto">
            <ListGroup>
              {getSwapTokens().map(token => (
                <ListRow
                  key={token.faucetId}
                  title={token.symbol}
                  avatar={<TokenLogo symbol={token.logoSymbol} size="lg" />}
                  checked={token.faucetId === currentFaucetId}
                  accent="swap"
                  onClick={() => onSelectToken(token)}
                  data-testid={`swap-token-${token.symbol}`}
                />
              ))}
            </ListGroup>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

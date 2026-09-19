import React, { FC, useCallback, useState } from 'react';

import { cva } from 'class-variance-authority';
import { useTranslation } from 'react-i18next';

import { NetworkModeSheet } from 'components/NetworkModeSheet';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { hapticLight } from 'lib/mobile/haptics';

export interface NetworkModeRibbonProps {
  /** The docked mobile bar (screen corner, home indicator) rather than the floating pill. */
  docked: boolean;
}

/*
 * Geometry. The band is 200 x 12px, rotated -45deg about its centre, so its centre is the word's
 * centre. Measured from the bar's bottom-right corner (x leftwards, y up), "TESTNET" (10px, 0.06em:
 * 48.6px long, 7.1px caps) reaches (48.6 + 7.1) / (2 * sqrt(2)) = 19.7px either side of that centre
 * on each axis.
 *
 * - Docked: centre at x = 25, y = safe + 22.5, where `safe` is the body's --app-safe-bottom
 *   (max(16px, the bottom inset)): the top of the home indicator's gesture zone on an iPhone. The
 *   word's lowest point is 2.8px above that zone, its right end 5.3px inside the screen edge, and it
 *   stays inside a 55pt screen corner. The band's outer edge clears the popped Settings gear.
 * - Floating: centre at (22, 22), inside the pill's 24px corner radius, clear of the popped gear.
 */
const band = cva('pointer-events-none absolute flex h-3 w-[200px] -rotate-45 items-center justify-center', {
  variants: {
    docked: {
      // right: 25 - 100; bottom: safe + 22.5 - 6.
      true: '-right-[75px] bottom-[calc(var(--app-safe-bottom,max(16px,env(safe-area-inset-bottom)))+16.5px)]',
      // right: 22 - 100; bottom: 22 - 6.
      false: '-right-[78px] bottom-4'
    },
    // A devnet build is slate throughout (the brand ramp in tailwind.config.ts), and the ribbon
    // follows it; every other build is the accent tint. Both inks clear 4.5:1 on their fill (white
    // on the accent itself is only 3.0:1). `primary-orange-*` is a fixed palette, so its dark values
    // are spelled out.
    devnet: {
      true: 'bg-primary-orange-lighter text-primary-orange-dark dark:bg-primary-orange-darker dark:text-primary-orange-light',
      false: 'bg-accent-tint text-accent-tint-ink'
    }
  }
});

/**
 * The test network's name on a sash across the bottom nav's lower-right corner, drawn over the bar
 * and taking no space from the tabs. Tapping the word opens the test-network explanation sheet. It
 * follows the effective network, so a Developer Settings override shows here too, and renders
 * nothing on mainnet.
 *
 * Only the word's stretch of the band takes taps (the button); the rest of the band and the corner
 * box let taps through to the tabs underneath, so the Settings tab keeps its hit area except a
 * sliver at its lower right, away from its icon. A name longer than the corner holds ends in an
 * ellipsis; the full name is in the accessible name and the sheet's title.
 */
export const NetworkModeRibbon: FC<NetworkModeRibbonProps> = ({ docked }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const onOpen = useCallback(() => {
    hapticLight();
    setOpen(true);
  }, []);

  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;
  const network = t(networkKey);

  return (
    <>
      <div
        data-testid="network-mode-ribbon-band"
        className={band({ docked, devnet: DEFAULT_NETWORK === MIDEN_NETWORK_NAME.DEVNET })}
      >
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('networkModeStripLabel', { network })}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="pointer-events-auto h-full max-w-[58px] truncate px-[3px] font-heading text-[10px] font-extrabold uppercase leading-3 tracking-[0.06em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/40"
          data-testid="network-mode-ribbon"
        >
          {network}
        </button>
      </div>

      <NetworkModeSheet open={open} onOpenChange={setOpen} />
    </>
  );
};

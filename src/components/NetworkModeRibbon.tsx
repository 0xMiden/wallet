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
 * centre. Measured from the bar's bottom-right corner (x leftwards, y up), a word of length L and cap
 * height h reaches (L + h) / (2 * sqrt(2)) either side of that centre on each axis.
 *
 * - Docked: "TESTNET" at 10px, 0.06em is 48.6 x 7.1px (19.7px each way). Centre at x = 25,
 *   y = pb + 22.5, where pb = max(8px, bottom inset) is the bar's own bottom padding, so the word
 *   rides on the tabs' 56px row: on an iPhone its lowest point is 2.8px above the 34px home
 *   indicator zone, it stays inside the 55pt screen corner, and the band clears the popped Settings
 *   gear by 13px.
 * - Floating: the pill is only 56px tall with a 24px radius and Settings sits 8px from its end, so
 *   the word drops to 9px (43.7 x 6.4px, 17.7px each way), centred at (20, 20): inside both corner
 *   arcs, 1.2px clear of the popped gear.
 */
const band = cva('pointer-events-none absolute flex h-3 w-[200px] -rotate-45 items-center justify-center', {
  variants: {
    docked: {
      // right: 25 - 100; bottom: pb + 22.5 - 6.
      true: '-right-[75px] bottom-[calc(max(8px,env(safe-area-inset-bottom))+16.5px)]',
      // right: 20 - 100; bottom: 20 - 6.
      false: '-right-[80px] bottom-3.5'
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

// The word and 3px either side take taps; the cap keeps a long name inside the corner (ellipsis).
const word = cva(
  'pointer-events-auto h-full truncate px-[3px] font-heading font-extrabold uppercase leading-3 tracking-[0.06em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/40',
  {
    variants: {
      docked: {
        true: 'max-w-[58px] text-[10px]',
        false: 'max-w-[53px] text-[9px]'
      }
    }
  }
);

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
          className={word({ docked })}
          data-testid="network-mode-ribbon"
        >
          {network}
        </button>
      </div>

      <NetworkModeSheet open={open} onOpenChange={setOpen} />
    </>
  );
};

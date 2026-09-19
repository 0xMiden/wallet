import React, { FC, useCallback, useState } from 'react';

import { cva } from 'class-variance-authority';
import { useTranslation } from 'react-i18next';

import { NetworkModeSheet } from 'components/NetworkModeSheet';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { hapticLight } from 'lib/mobile/haptics';

export interface NetworkModeRibbonProps {
  /** The docked mobile bar (screen corner, home indicator) rather than the floating pill. */
  docked: boolean;
}

/*
 * Geometry. The ribbon adapts to the bar, never the reverse. The band is 200 x 14px, rotated -45deg
 * about its centre, so its centre is the word's centre. Measured from the bar's bottom-right corner
 * (x leftwards, y up), "TESTNET" (10px, 0.06em: 48.6 x 7.1px) reaches (48.6 + 7.1) / (2 * sqrt(2)) =
 * 19.7px either side of that centre on each axis.
 *
 * - Docked: centre at x = 21.5, y = pb + 36, where pb is the bar's bottom padding
 *   (max(8px, --app-safe-bottom - 16px); 18px on an iPhone, whose bar is 83px). On an iPhone 17 Pro
 *   the band's inner edge (x + y = 65.6) stays outside the 55pt screen corner's cut, so the whole
 *   sash is visible; the word runs x 1.8..41.2, y 34.3..73.7, level with the top of the home
 *   indicator's zone; the band's outer edge clears the popped Settings gear by 2.8pt (0.1pt on a
 *   375pt iPhone, where the tabs sit 4pt further right).
 * - Floating: the 72px pill (24px radius), centre at (24, 24): the band's inner edge (38.1) is
 *   outside the corner arc's cut (14.1), and it clears the popped gear by 12.9pt.
 */
const band = cva(
  // `primary-orange-dark` is the build's brand ramp: #9F4518 (white on it 6.3:1), slate #4E5F73 on
  // a devnet build (6.5:1). A fixed palette, so the same pairing holds in dark mode.
  'pointer-events-none absolute flex h-3.5 w-[200px] -rotate-45 items-center justify-center bg-primary-orange-dark text-pure-white shadow-ribbon',
  {
    variants: {
      docked: {
        // right: 21.5 - 100; bottom: pb + 36 - 7.
        true: '-right-[78.5px] bottom-[calc(max(0.5rem,calc(var(--app-safe-bottom,max(16px,env(safe-area-inset-bottom)))-16px))+29px)]',
        // right: 24 - 100; bottom: 24 - 7.
        false: '-right-[76px] bottom-[17px]'
      }
    }
  }
);

// The word and 3px either side take taps; the cap keeps a long name inside the corner (ellipsis).
const word =
  'pointer-events-auto h-full max-w-[56px] truncate px-[3px] font-heading text-[10px] font-extrabold uppercase leading-[14px] tracking-[0.06em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pure-white/70';

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
      <div data-testid="network-mode-ribbon-band" className={band({ docked })}>
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('networkModeStripLabel', { network })}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={word}
          data-testid="network-mode-ribbon"
        >
          {network}
        </button>
      </div>

      <NetworkModeSheet open={open} onOpenChange={setOpen} />
    </>
  );
};

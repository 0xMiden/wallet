import React, { FC, useCallback, useState } from 'react';

import { cva } from 'class-variance-authority';
import { useTranslation } from 'react-i18next';

import { NetworkModeSheet } from 'components/NetworkModeSheet';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { hapticLight } from 'lib/mobile/haptics';

export interface NetworkModeRibbonProps {
  /** The docked mobile bar (its corner is the screen's on iOS, the system navigation bar's top on Android) rather than the floating pill. */
  docked: boolean;
}

/*
 * Geometry: a classic corner sash that only just clips the corner. The band is 200 x 14px, rotated
 * -45deg about its centre, and its centreline is x + y = c, measured from the corner (x leftwards,
 * y up). The corner box clips it where it meets the right and bottom edges, (0, c) and (c, 0), and a
 * rounded screen corner or pill radius trims both ends by the same amount (both are symmetric about
 * the diagonal), so the visible stretch is centred on (c/2, c/2). The band's own centre, and so the
 * word, sits exactly there.
 *
 * "TESTNET" (10px, 0.06em: 48.6 x 7.1px) is fully inside a 55pt screen corner (iPhone 17 Pro) from
 * c = 47.5, inside a 44pt corner (375pt iPhones) from 44, and inside the floating pill's 24px radius
 * from 42.5.
 * - Docked: c = 50, word centre (25, 25) from the corner box's bottom-right corner, which is the
 *   screen's on iOS and the top of the system navigation bar on Android (BottomNav's `clearInset`).
 *   The word spans x and y 5.3..44.7; the band clears the popped Settings gear by 22pt (iPhone 17
 *   Pro) and 21pt (375pt).
 * - Floating: c = 44, word centre (22, 22); inside the pill's corner, 17pt clear of the gear.
 */
const band = cva(
  // `primary-orange-dark` is the build's brand ramp: #9F4518 (white on it 6.3:1), slate #4E5F73 on
  // a devnet build (6.5:1). A fixed palette, so the same pairing holds in dark mode.
  'pointer-events-none absolute flex h-3.5 w-[200px] -rotate-45 items-center justify-center bg-primary-orange-dark text-pure-white shadow-ribbon',
  {
    variants: {
      docked: {
        // right: 25 - 100; bottom: 25 - 7.
        true: '-right-[75px] bottom-[18px]',
        // right: 22 - 100; bottom: 22 - 7.
        false: '-right-[78px] bottom-[15px]'
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

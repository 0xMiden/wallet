import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { NetworkModeSheet } from 'components/NetworkModeSheet';
import { Pill } from 'components/ui/Pill';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { hapticLight } from 'lib/mobile/haptics';

/**
 * The test network's name as a small pill in the bottom nav's right corner, in place of the
 * full-width banner the wallet used to top every page with. Tapping it opens the test-network
 * explanation sheet. It follows the effective network, so a Developer Settings override shows here
 * too, and renders nothing on mainnet.
 *
 * The button is a 44px target; the pill (24px) sits at its bottom, which puts the pill's center on
 * the bar's center line while the target stays out of the bar's bottom 16px (see `BottomNav`'s
 * accessory slot). The pill truncates when the tabs leave it less room than the name needs; the full
 * name stays in the accessible name and the sheet's title.
 */
// A devnet build is slate throughout (the brand ramp in tailwind.config.ts), and the strip follows
// it as the banner does; every other build uses the accent tint. `primary-orange-*` is a fixed
// palette, so its dark values are spelled out.
const TONE_CLASSES = {
  brand: 'bg-accent-tint text-accent-tint-ink',
  devnet:
    'bg-primary-orange-lighter text-primary-orange-dark dark:bg-primary-orange-darker dark:text-primary-orange-light'
};

export const NetworkModeStrip: FC = () => {
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
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('networkModeStripLabel', { network })}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-11 min-w-0 max-w-full items-end rounded-full pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/30"
        data-testid="network-mode-strip"
      >
        <Pill
          size="sm"
          tone="plain"
          className={DEFAULT_NETWORK === MIDEN_NETWORK_NAME.DEVNET ? TONE_CLASSES.devnet : TONE_CLASSES.brand}
        >
          {network}
        </Pill>
      </button>

      <NetworkModeSheet open={open} onOpenChange={setOpen} />
    </>
  );
};

import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { NetworkModeSheet } from 'components/NetworkModeSheet';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { hapticLight } from 'lib/mobile/haptics';

/**
 * Full-width banner that tops the dApp confirm window with the Miden network the wallet is on,
 * where the network matters for what is about to be signed. The wallet itself says it in the bottom
 * nav's corner ribbon instead (`NetworkModeRibbon`). The name follows the effective network, so a
 * Developer Settings override shows here too, and the banner renders nothing on mainnet. The colors
 * come from the build-time brand ramp, so a devnet build shows the slate palette.
 *
 * Tapping the banner opens the test-network explanation sheet (#875).
 */
export const NetworkModeBanner: FC = () => {
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
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-11 w-full shrink-0 items-center justify-center gap-2 border-b border-dashed border-primary-orange-light bg-primary-orange-lighter px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/30 dark:border-primary-orange-dark dark:bg-primary-orange-darker"
        data-testid="network-mode-banner"
      >
        <BreadLogo aria-hidden="true" className="size-[18px] shrink-0" />
        <span className="font-heading text-sm font-bold text-primary-orange-dark dark:text-primary-orange-light">
          {t('networkModeBanner', { network })}
        </span>
      </button>

      <NetworkModeSheet open={open} onOpenChange={setOpen} />
    </>
  );
};

import React, { createContext, FC, useCallback, useContext, useState } from 'react';

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
/**
 * Set by a shell that already renders a banner over its whole subtree. A nested banner then stands
 * down, so a screen rendered inside such a shell cannot show two.
 *
 * This exists because the first attempt suppressed the nested one with a step condition on the
 * shell instead. That desynchronises during a route transition: `activeRoute` is live state read
 * outside `AnimatePresence`, so on the way back the shell's banner mounts while the exiting card
 * still renders its own, and on the way forward neither is up. A condition on ancestry cannot
 * desynchronise, because the ancestor either wraps the subtree or it does not.
 */
const NetworkAlreadyNamed = createContext(false);

/** Wrap a subtree whose shell already names the network, so nested banners stand down. */
export const NetworkNamedByShell: FC<{ children: React.ReactNode }> = ({ children }) => (
  <NetworkAlreadyNamed.Provider value={true}>{children}</NetworkAlreadyNamed.Provider>
);

export const NetworkModeBanner: FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const onOpen = useCallback(() => {
    hapticLight();
    setOpen(true);
  }, []);

  const alreadyNamed = useContext(NetworkAlreadyNamed);

  const networkKey = getTestNetworkNameKey();
  if (!networkKey || alreadyNamed) return null;
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

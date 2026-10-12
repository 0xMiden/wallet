import React, { createContext, FC, useContext } from 'react';

import { NetworkModePill } from 'components/NetworkModePill';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

/**
 * Names the Miden network the wallet is on at the top of every screen that commits value, where the
 * network matters for what is about to be signed. It draws `NetworkModePill` (the network, "Tokens
 * have no real value", the info glyph); Home itself carries the mainnet countdown banner instead. The name follows
 * the effective network, so a Developer Settings override shows here too, and it renders nothing on
 * mainnet. Tapping it opens the test-network explanation sheet (#875).
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
  const alreadyNamed = useContext(NetworkAlreadyNamed);

  if (!getTestNetworkNameKey() || alreadyNamed) return null;

  // The network pill, inset at the page margin over the screen's header, so every screen that
  // commits value names the network in the same words and shape.
  return (
    <div className="shrink-0 px-4 pt-2">
      <NetworkModePill data-testid="network-mode-banner" />
    </div>
  );
};

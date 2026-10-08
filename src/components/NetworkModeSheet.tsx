import React, { FC, useEffect, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { usePageActive } from 'app/layouts/page-active';
import { AcknowledgeSheet } from 'components/AcknowledgeSheet';
import { NetworkNoticeRows } from 'components/NetworkNoticeRows';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { useLocation } from 'lib/woozie';

export interface NetworkModeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The test-network explanation (#875): no value, no real funds, and resets that never carry over to
 * Mainnet. Opened from Home's network pill and from the dApp confirm window's banner; the caller
 * owns `open`. Renders nothing on mainnet.
 */
export const NetworkModeSheet: FC<NetworkModeSheetProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const { pathname, hash } = useLocation();
  const pageActive = usePageActive();
  // The latest callback, so closing on a navigation does not also run whenever the caller hands in
  // a new function (which would close the sheet the render after it opened).
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // The sheet lives outside the routed page's own tree, so a navigation does not unmount it: close
  // it on any route or onboarding-step change, and when the page it opened from goes off screen (a
  // page slid over the tabs), since the drawer itself is portaled above everything. Only a change
  // closes it, so a sheet that mounts open stays open.
  const where = { pathname, hash, pageActive };
  const lastWhere = useRef(where);
  useEffect(() => {
    const last = lastWhere.current;
    lastWhere.current = { pathname, hash, pageActive };
    if (last.pathname !== pathname || last.hash !== hash || last.pageActive !== pageActive) {
      onOpenChangeRef.current(false);
    }
  }, [pathname, hash, pageActive]);

  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;
  const network = t(networkKey);

  return (
    <AcknowledgeSheet
      open={open}
      onOpenChange={onOpenChange}
      screenKey="network-mode"
      testId="network-mode-sheet"
      title={t('networkModeSheetTitle', { network })}
      description={t('networkNoticeBody')}
    >
      <div className="px-4">
        <NetworkNoticeRows />
      </div>
    </AcknowledgeSheet>
  );
};

import React, { useEffect, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { FlowLayout } from 'components/flow/FlowLayout';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { Button } from 'components/ui/Button';
import { Notice } from 'components/ui/Notice';

/**
 * Why the Deposit flow cannot run:
 * - `off`: the relay and NEAR Intents are both off for this network.
 * - `no-address`: the relay is on, but the account has no deposit address (no stored EVM key), and NEAR Intents is off.
 * - `deduct`: the relay answers `deduct` gas mode, which the flow does not support yet, and NEAR Intents does not serve
 *   the pair.
 */
export type DepositUnavailableCause = 'off' | 'no-address' | 'deduct';

/** The i18n key of the text of each cause. */
function bodyKeyOf(cause: DepositUnavailableCause): string {
  switch (cause) {
    case 'off':
      return 'depositFlowUnavailableOff';
    case 'no-address':
      return 'depositFlowUnavailableNoAddress';
    case 'deduct':
      return 'depositFlowUnavailableDeduct';
  }
}

export interface DepositUnavailableProps {
  cause: DepositUnavailableCause;
  /** Back, and the Done button: leaves the flow. */
  onBack: () => void;
  /** Close: leaves the flow for Home. */
  onClose: () => void;
}

/**
 * The Deposit flow's one "not available" page, in the flow's own frame, with a text for each cause. It logs the cause
 * one time (with no address and no key material).
 */
export const DepositUnavailable: React.FC<DepositUnavailableProps> = ({ cause, onBack, onClose }) => {
  const { t } = useTranslation();
  const logged = useRef<DepositUnavailableCause | null>(null);
  useEffect(() => {
    if (logged.current === cause) return;
    logged.current = cause;
    console.warn('[deposit] the Deposit flow is not available:', cause);
  }, [cause]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg text-ink">
      <NetworkModeBanner />
      <FlowLayout
        title={t('depositFlowTitle')}
        onBack={onBack}
        onClose={onClose}
        footer={<Button title={t('done')} onClick={onBack} className="w-full max-w-none" />}
      >
        <div data-testid="deposit-unavailable" data-cause={cause}>
          <Notice
            tone="warning"
            icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
            title={t('depositFlowUnavailableTitle')}
          >
            {t(bodyKeyOf(cause))}
          </Notice>
        </div>
      </FlowLayout>
    </div>
  );
};

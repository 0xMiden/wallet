import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { NetworkChip } from 'components/NetworkChip';
import { NETWORK_NOTICE_ROWS } from 'components/NetworkNoticeRows';
import { CheckboxRow } from 'components/ui/Checkbox';
import { ListGroup } from 'components/ui/ListGroup';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface NetworkNoticeScreenProps {
  onSubmit?: () => void;
}

/**
 * Onboarding notice shown after the first tap on Welcome, before the user
 * creates or restores a wallet. It names the effective network and asks the
 * user to tick each of the three test-network facts; "I understand" opens only
 * once all three are ticked. On mainnet, which has no test tokens, it renders
 * nothing.
 */
export const NetworkNoticeScreen: React.FC<NetworkNoticeScreenProps> = ({ onSubmit }) => {
  const { t } = useTranslation();
  const [checked, setChecked] = useState<Readonly<Record<string, boolean>>>({});
  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;
  const network = t(networkKey);
  const allChecked = NETWORK_NOTICE_ROWS.every(row => checked[row.id]);

  return (
    <OnboardingStepLayout
      data-testid="onboarding-network-notice"
      eyebrow={<NetworkChip kind="miden" label={t('networkNoticeChip', { network })} />}
      title={t('networkModeBanner', { network })}
      description={t('networkNoticeBody')}
      footer={
        <Button
          title={t('iUnderstand')}
          data-testid="onboarding-network-notice-acknowledge"
          disabled={!allChecked}
          onClick={onSubmit}
        />
      }
    >
      {/* A checklist in one grey group, like every other list of rows: the facts are one set the
          user confirms together, and the group's inset hairlines keep them one unit. */}
      <ListGroup>
        {NETWORK_NOTICE_ROWS.map(row => (
          <CheckboxRow
            key={row.id}
            data-testid={`onboarding-network-notice-check-${row.id}`}
            checked={Boolean(checked[row.id])}
            onCheckedChange={value => setChecked(prev => ({ ...prev, [row.id]: value }))}
            title={t(row.titleKey)}
            description={t(row.bodyKey)}
          />
        ))}
      </ListGroup>
    </OnboardingStepLayout>
  );
};

export default NetworkNoticeScreen;

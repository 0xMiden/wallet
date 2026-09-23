import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ListRow } from 'components/ui/ListRow';
import { isMidenNameSupported } from 'lib/miden/name/config';
import { formatMidenName, MIDEN_NAME_SUFFIX } from 'lib/miden/name/encoding';
import {
  ownedLabelOf,
  phaseOf,
  registerNameInputsOf,
  uiStateOf,
  useMidenNameRegistrations
} from 'lib/miden/name/registrations';
import { navigate } from 'lib/woozie';

interface MidenNameReceiveRowProps {
  address: string;
}

/**
 * The Miden Name row of the Receive actions. It shows the owned name, the
 * claim in progress, or the offer to claim a name. Nothing shows on a network
 * with no Miden Name deployment.
 */
export const MidenNameReceiveRow: FC<MidenNameReceiveRowProps> = ({ address }) => {
  const supported = isMidenNameSupported();
  const { t } = useTranslation();
  const { rows } = useMidenNameRegistrations(supported ? address : undefined);

  if (!supported) return null;

  const ownedLabel = ownedLabelOf(rows);
  // The rows are newest first, so this is the newest claim in progress.
  const liveClaim = rows.find(row => uiStateOf(phaseOf(row)) === 'claiming');
  const liveLabel = liveClaim ? registerNameInputsOf(liveClaim)?.label : undefined;
  const icon = <Icon name={IconName.User} size="xs" />;

  if (ownedLabel !== undefined) {
    return (
      <ListRow
        icon={icon}
        title={t('midenName')}
        subtitle={formatMidenName(ownedLabel)}
        chevron
        onClick={() => navigate('/settings/miden-name')}
        data-testid="receive-miden-name"
      />
    );
  }

  if (liveClaim !== undefined && liveLabel !== undefined) {
    return (
      <ListRow
        icon={icon}
        title={t('midenName')}
        subtitle={t('midenNameClaiming', { name: formatMidenName(liveLabel) })}
        chevron
        onClick={() => navigate(`/miden-name/status/${encodeURIComponent(liveClaim.id)}`)}
        data-testid="receive-miden-name"
      />
    );
  }

  return (
    <ListRow
      icon={icon}
      title={t('midenNameClaimCta')}
      subtitle={t('midenNameClaimCtaSubtitle', { suffix: MIDEN_NAME_SUFFIX })}
      chevron
      onClick={() => navigate('/miden-name')}
      data-testid="receive-miden-name"
    />
  );
};

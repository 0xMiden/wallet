import React from 'react';

import { useTranslation } from 'react-i18next';

import { guardianEndpointHost } from 'app/hooks/useCurrentGuardianEndpoint';
import { AcknowledgeSheet } from 'components/AcknowledgeSheet';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';

import { guardianOperatorCopy } from './GuardianProviderSheet';

export interface GuardianProviderDetailsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  option: ResolvedGuardianOption;
}

/**
 * The guardian step's Learn more: the shown operator's details, kept off the page. Its name, who it is,
 * and the rows Guardian Settings shows for the account's own operator (who runs it, where, and its
 * endpoint).
 */
export const GuardianProviderDetailsSheet: React.FC<GuardianProviderDetailsSheetProps> = ({
  open,
  onOpenChange,
  option
}) => {
  const { t } = useTranslation();
  const copy = guardianOperatorCopy(option.id);

  return (
    <AcknowledgeSheet
      open={open}
      onOpenChange={onOpenChange}
      screenKey="guardian-provider-details"
      testId="meet-guardian-provider-details"
      title={option.name}
      description={copy ? t(copy.aboutKey) : option.operatedBy}
    >
      <DetailCard surface="outline" className="mx-4 mt-2">
        <DetailRow label={t('guardianProvider')}>{option.operatedBy}</DetailRow>
        <DetailRow label={t('guardianRegion')}>{option.location}</DetailRow>
        <DetailRow label={t('guardianEndpointLabel')} stacked>
          {guardianEndpointHost(option.endpoint)}
        </DetailRow>
      </DetailCard>
    </AcknowledgeSheet>
  );
};

export default GuardianProviderDetailsSheet;

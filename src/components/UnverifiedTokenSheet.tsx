import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { AcknowledgeSheet } from 'components/AcknowledgeSheet';

interface UnverifiedTokenSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Why a token is marked Unverified, opened from the "Unverified token · Why?" pill on its token page:
 * the token is not on Miden's verified list, and anyone can mint a token under any name, so the
 * faucet ID is what to check before trusting it.
 */
export const UnverifiedTokenSheet: FC<UnverifiedTokenSheetProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();

  return (
    <AcknowledgeSheet
      open={open}
      onOpenChange={onOpenChange}
      screenKey="unverified-token"
      testId="unverified-token-sheet"
      title={t('unverifiedTokenTitle')}
      description={t('unverifiedTokenDescription')}
      descriptionVariant="message"
    />
  );
};

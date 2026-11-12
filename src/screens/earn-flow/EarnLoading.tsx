import React from 'react';

import { useTranslation } from 'react-i18next';

import { Spinner } from 'components/ui/Spinner';

export function EarnLoading() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t('loading')} className="flex justify-center py-4">
      <Spinner />
    </div>
  );
}

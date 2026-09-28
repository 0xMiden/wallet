import React from 'react';

import { useTranslation } from 'react-i18next';

import { Notice } from 'components/ui/Notice';

/**
 * The one rendering of `useHardwareProtector`'s failure state (#1056): the hook probes once per
 * mount and none of its screens offer Retry, so reopening the page is the only remedy, and every
 * screen that gates on the probe says exactly that.
 */
export const ProtectorProbeErrorNotice: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();

  return (
    <Notice tone="negative" role="alert" title={t('error')} className={className} data-testid="protector-probe-error">
      {t('couldNotCheckUnlockMethodReopen')}
    </Notice>
  );
};

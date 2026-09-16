import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { cn } from 'lib/ui/util';

export interface TestNetworkWarningProps {
  /** Locale key for the bold first line. */
  titleKey: string;
  /** Locale key for the body text. */
  bodyKey: string;
  /** Placeholder values for both locale keys. */
  values?: Record<string, string>;
  className?: string;
  'data-testid'?: string;
}

/**
 * Dashed, brand-tinted callout used at every funding decision point (#875):
 * Receive, the EVM wallet connect step and the bridge form. Same look as the
 * onboarding notice's network pill so all test-network notices read as one
 * family.
 */
export const TestNetworkWarning: FC<TestNetworkWarningProps> = ({
  titleKey,
  bodyKey,
  values,
  className,
  'data-testid': testId
}) => {
  const { t } = useTranslation();

  return (
    <div
      role="note"
      data-testid={testId}
      className={cn(
        'w-full flex items-start gap-3 rounded-xl border border-dashed border-primary-orange-light bg-primary-orange-lighter px-4 py-3.5 text-left dark:border-primary-orange-dark dark:bg-primary-orange-darker',
        className
      )}
    >
      <Icon
        name={IconName.WarningFill}
        size="sm"
        className="mt-0.5 shrink-0 text-primary-orange-dark dark:text-primary-orange-light"
        fill="currentColor"
      />
      <div className="flex flex-col gap-0.5 text-primary-orange-dark dark:text-primary-orange-light">
        <span className="text-sm font-semibold leading-[18px]">{t(titleKey, values)}</span>
        <span className="text-[13px] leading-[18px]">{t(bodyKey, values)}</span>
      </div>
    </div>
  );
};

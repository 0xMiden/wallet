import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { TransactionStepRow } from 'screens/generating-transaction/components';

import { usdcxDepositSteps, UsdcxDepositStepsInput } from './usdcx-deposit-steps';

export interface UsdcxDepositStepsProps extends UsdcxDepositStepsInput {
  className?: string;
}

/**
 * The steps between Pending and Confirmed of a USDCx deposit, drawn with the generating-transaction step
 * rows: done, in progress, or still to come. Same rows on the deposit status screen and in Activity.
 */
export const UsdcxDepositSteps: React.FC<UsdcxDepositStepsProps> = ({ className, ...input }) => {
  const { t } = useTranslation();
  const steps = usdcxDepositSteps(input);

  return (
    <div
      className={clsx('overflow-hidden rounded-2xl border border-rule-default bg-fill', className)}
      data-testid="usdcx-deposit-steps"
    >
      {steps.map((step, index) => (
        <TransactionStepRow
          key={step.id}
          step={{ id: step.id, labelKey: step.labelKey, defaultLabel: step.labelKey }}
          state={step.state}
          label={t(step.labelKey, step.network === undefined ? undefined : { network: step.network })}
          isLast={index === steps.length - 1}
          accent="brand"
        />
      ))}
    </div>
  );
};

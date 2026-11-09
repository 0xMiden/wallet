import React from 'react';

import { TokenAmount } from 'components/ui/TokenAmount';

export interface AmountLabelProps extends React.HTMLAttributes<HTMLDivElement> {
  currency?: string;
  amount: string;
}

/** Use TokenAmount for new amount displays. */
export const AmountLabel: React.FC<AmountLabelProps> = ({ className, amount, currency, ...props }) => (
  <div {...props} className={className}>
    <TokenAmount
      amount={amount}
      prefix={currency}
      trimTrailingZeros={false}
      className="text-4xl font-bold leading-10"
    />
  </div>
);

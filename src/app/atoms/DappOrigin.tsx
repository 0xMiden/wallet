import React, { FC } from 'react';

import classNames from 'clsx';

import { splitDappOrigin } from 'utils/dapp-origin';

type DappOriginProps = {
  origin: string;
  className?: string;
  'data-testid'?: string;
};

/**
 * A dApp origin as an approval surface shows it (#1072). The origin is whatever the dApp presents,
 * so a long subdomain-heavy one must not push out the registrable domain that says who is asking:
 * the scheme and leading labels give way with an ellipsis, and the domain never shrinks (it wraps
 * instead when it alone is wider than the surface).
 */
export const DappOrigin: FC<DappOriginProps> = ({ origin, className, 'data-testid': testId }) => {
  const { lead, domain } = splitDappOrigin(origin);

  return (
    <span className={classNames('flex min-w-0 max-w-full', className)} title={origin} data-testid={testId}>
      {lead && (
        <span className="min-w-0 truncate" data-testid="dapp-origin-lead">
          {lead}
        </span>
      )}
      {domain && (
        <span className="max-w-full shrink-0 break-all" data-testid="dapp-origin-domain">
          {domain}
        </span>
      )}
    </span>
  );
};

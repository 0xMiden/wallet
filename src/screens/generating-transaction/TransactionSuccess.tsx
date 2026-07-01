import React, { FC } from 'react';

import { IBridgedSendExtraInputs } from 'lib/miden/db/types';

import { BridgeSuccess } from './success/BridgeSuccess';
import { SendSuccess } from './success/SendSuccess';
import { TransactionSuccessProps } from './success/TransactionSuccessLayout';

export type { TransactionSuccessProps } from './success/TransactionSuccessLayout';

const isBridgedSendExtraInputs = (value: unknown): value is IBridgedSendExtraInputs => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<IBridgedSendExtraInputs>;
  return (
    typeof candidate.destinationAddress === 'string' &&
    typeof candidate.destinationNetwork === 'number' &&
    (candidate.provider === 'epoch' || candidate.provider === 'agglayer')
  );
};

/**
 * Picks the success receipt for a completed transaction by type. Each variant
 * lives in `./success` and composes the shared `TransactionSuccessLayout`.
 *
 * Only the bridged-send discriminator routes away from the default today.
 * `SwapSuccess` / `EarnSuccess` exist as stubs but have no discriminator yet
 * (no `swap` / `earn` tx type or producer — see those files), so they're
 * unreachable; `SendSuccess` covers send plus every other type.
 */
export const TransactionSuccess: FC<TransactionSuccessProps> = props => {
  const extraInputs = props.transaction?.extraInputs;

  if (isBridgedSendExtraInputs(extraInputs)) {
    return <BridgeSuccess {...props} bridgedInputs={extraInputs} />;
  }

  return <SendSuccess {...props} />;
};

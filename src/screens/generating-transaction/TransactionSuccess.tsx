import React, { FC } from 'react';

import { IBridgedSendExtraInputs } from 'lib/miden/db/types';

import { BridgeSuccess } from './success/BridgeSuccess';
import { GuardianSwitchSuccess } from './success/GuardianSwitchSuccess';
import { SendSuccess } from './success/SendSuccess';
import { SwapSuccess } from './success/SwapSuccess';
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
 * `swap` and `switch-guardian` route by the tx type; bridged sends route by
 * their extraInputs discriminator. `EarnSuccess` exists as a stub but has no discriminator yet
 * (no `earn` tx type or producer — see that file), so it's unreachable;
 * `SendSuccess` covers send plus every other type.
 */
export const TransactionSuccess: FC<TransactionSuccessProps> = props => {
  const extraInputs = props.transaction?.extraInputs;

  if (props.transaction?.type === 'swap') {
    return <SwapSuccess {...props} />;
  }

  if (props.transaction?.type === 'switch-guardian') {
    return <GuardianSwitchSuccess {...props} />;
  }

  if (isBridgedSendExtraInputs(extraInputs)) {
    return <BridgeSuccess {...props} bridgedInputs={extraInputs} />;
  }

  return <SendSuccess {...props} />;
};

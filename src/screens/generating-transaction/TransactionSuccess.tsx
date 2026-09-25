import React, { FC } from 'react';

import { IBridgedSendExtraInputs } from 'lib/miden/db/types';

import { BridgeSuccess } from './success/BridgeSuccess';
import { EarnSuccess } from './success/EarnSuccess';
import { GuardianSwitchSuccess } from './success/GuardianSwitchSuccess';
import { MidenNameSuccess } from './success/MidenNameSuccess';
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
 * `swap`, `switch-guardian`, `earn-deposit` and `register-name` route by the tx type; bridged
 * sends route by their extraInputs discriminator. `SendSuccess` covers send
 * plus every other type.
 */
export const TransactionSuccess: FC<TransactionSuccessProps> = props => {
  const extraInputs = props.transaction?.extraInputs;

  switch (props.transaction?.type) {
    case 'swap':
      return <SwapSuccess {...props} />;
    case 'earn-deposit':
      return <EarnSuccess {...props} />;
    case 'switch-guardian':
      return <GuardianSwitchSuccess {...props} />;
    case 'register-name':
      return <MidenNameSuccess {...props} />;
    default:
      break;
  }

  if (isBridgedSendExtraInputs(extraInputs)) {
    return <BridgeSuccess {...props} bridgedInputs={extraInputs} />;
  }

  return <SendSuccess {...props} />;
};

import React, { ReactNode, useId } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { useCommandWorkbenchSlots } from 'screens/command/CommandWorkbench';

import { SelectRecipient, SelectRecipientProps } from './SelectRecipient';
import { sendNetworkKind } from './send-network-kind';
import { SendAmount, SendAmountProps } from './SendAmount';

export interface CommandSendComposerProps {
  recipient: Omit<SelectRecipientProps, 'onAddressChange' | 'onConfirm'>;
  onRecipientChange: (value: string) => void;
  amount: SendAmountProps;
  onReview: () => void;
  routeBlocked?: boolean;
  route: ReactNode;
}

export function CommandSendComposer({
  recipient,
  onRecipientChange,
  amount,
  onReview,
  routeBlocked,
  route
}: CommandSendComposerProps): React.ReactElement {
  const { t } = useTranslation();
  const formId = useId();
  const canReview =
    !routeBlocked &&
    recipient.isValidAddress &&
    (sendNetworkKind(recipient.chain) === undefined ||
      (recipient.network !== undefined && recipient.network !== 'miden')) &&
    !!amount.token &&
    amount.token.scaleIsKnown &&
    !amount.tokenHeld &&
    amount.isValidAmount;
  const outlets = useCommandWorkbenchSlots(
    <Button
      type="submit"
      form={formId}
      title={t('reviewDetails')}
      variant={ButtonVariant.Primary}
      data-testid="command-send-review"
      disabled={!canReview}
      className="w-full max-w-none sm:w-auto sm:min-w-40"
    />,
    route
  );

  return (
    <div data-testid="command-send-composer">
      <form
        id={formId}
        className="grid items-start gap-4 md:grid-cols-2 md:gap-6"
        onSubmit={event => {
          event.preventDefault();
          if (canReview) onReview();
        }}
      >
        <div className="min-w-0">
          <SelectRecipient
            {...recipient}
            embedded
            onAddressChange={event => onRecipientChange(event.target.value)}
            onConfirm={onReview}
          />
        </div>
        <div className="min-w-0 rounded-2xl border border-hairline bg-page p-4 sm:p-5">
          <p className="mb-2 text-body-sm text-muted">{t('youSend')}</p>
          <SendAmount {...amount} embedded onConfirm={onReview} />
        </div>
      </form>
      {outlets}
    </div>
  );
}

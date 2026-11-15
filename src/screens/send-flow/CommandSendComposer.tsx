import React, { ReactNode, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { DetailCard, DetailDisclosure } from 'components/ui/DetailCard';

import { SelectRecipient, SelectRecipientProps } from './SelectRecipient';
import { SendAmount, SendAmountProps } from './SendAmount';

export interface CommandSendComposerProps {
  recipient: Omit<SelectRecipientProps, 'onAddressChange' | 'onConfirm'>;
  onRecipientChange: (value: string) => void;
  amount: SendAmountProps;
  onReview: () => void;
  route: ReactNode;
}

export function CommandSendComposer({
  recipient,
  onRecipientChange,
  amount,
  onReview,
  route
}: CommandSendComposerProps): React.ReactElement {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const canReview =
    recipient.isValidAddress &&
    (recipient.chain !== 'ethereum' || (recipient.network !== undefined && recipient.network !== 'miden')) &&
    !!amount.token &&
    amount.token.scaleIsKnown &&
    !amount.tokenHeld &&
    amount.isValidAmount;

  return (
    <div data-testid="command-send-composer" className="flex flex-col gap-4">
      <SelectRecipient
        {...recipient}
        embedded
        onAddressChange={event => onRecipientChange(event.target.value)}
        onConfirm={onReview}
      />
      <SendAmount {...amount} embedded onConfirm={onReview} />
      {route && (
        <DetailCard surface="outline">
          <DetailDisclosure
            title={t('commandDetails')}
            summary={t('route')}
            open={detailsOpen}
            onOpenChange={setDetailsOpen}
          >
            {route}
          </DetailDisclosure>
        </DetailCard>
      )}
      <Button
        type="button"
        title={t('reviewDetails')}
        variant={ButtonVariant.Primary}
        accent="send"
        data-testid="command-send-review"
        disabled={!canReview}
        onClick={onReview}
        className="w-full max-w-none"
      />
    </div>
  );
}

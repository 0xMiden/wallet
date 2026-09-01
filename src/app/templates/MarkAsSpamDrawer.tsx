import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { formatBigInt } from 'lib/i18n/numbers';
import { AssetMetadata } from 'lib/miden/metadata';
import { SpamAction } from 'lib/miden/note-spam';
import { DetailCard, DetailRow } from 'lib/ui/DetailCard';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { truncateAddress } from 'utils/string';

/** The slice of a pending note the sheet needs; `NoteWithMetadata` satisfies it. */
export interface MarkAsSpamNote {
  id: string;
  faucetId: string;
  senderAddress: string;
  amount: string;
  metadata: AssetMetadata;
}

export interface MarkAsSpamDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kept mounted with `null` so the sheet can animate out after the note is gone. */
  note: MarkAsSpamNote | null;
  /**
   * The native MIDEN faucet can never be blocked — that would hide every MIDEN
   * note and fight auto-consume — so a native note offers "Block sender" only.
   */
  isNativeFaucet: boolean;
  onConfirm: (action: SpamAction) => void;
}

/**
 * "Mark as spam?" confirmation. Blocking the ASSET hides every note of that
 * faucet (the asset is what spam is made of); blocking the sender too covers a
 * spammer who rotates faucets. Both are reversible from the spam bin.
 */
export const MarkAsSpamDrawer: FC<MarkAsSpamDrawerProps> = ({
  open,
  onOpenChange,
  note,
  isNativeFaucet,
  onConfirm
}) => {
  const { t } = useTranslation();

  const decimals = note?.metadata.decimals ?? 6;
  const symbol = note?.metadata.symbol || 'UNKNOWN';
  const amountLabel = note ? `${formatBigInt(BigInt(note.amount), decimals)} ${symbol}` : '';
  const senderLabel = note?.senderAddress ? truncateAddress(note.senderAddress, false, 8, 4) : t('unknown');

  const confirm = (action: SpamAction) => {
    onConfirm(action);
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="mark-as-spam">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="text-2xl">{t('markAsSpamTitle')}</DrawerTitle>
          <DrawerDescription>{t(isNativeFaucet ? 'markAsSpamBodyNative' : 'markAsSpamBody')}</DrawerDescription>
        </DrawerHeader>

        <div className="px-4">
          <DetailCard>
            <DetailRow label={t('sender')} value={senderLabel} />
            <DetailRow label={t('amount')} value={amountLabel} isLast />
          </DetailCard>
        </div>

        {note && (
          <DrawerFooter>
            {isNativeFaucet ? (
              <Button
                data-testid="spam-block-sender"
                variant={ButtonVariant.Danger}
                className="max-w-none"
                title={t('blockSender')}
                onClick={() => confirm({ kind: 'block-sender', senderAddress: note.senderAddress })}
              />
            ) : (
              <>
                <Button
                  data-testid="spam-block-asset"
                  variant={ButtonVariant.Danger}
                  className="max-w-none"
                  title={t('blockThisAsset')}
                  onClick={() => confirm({ kind: 'block-faucet', faucetId: note.faucetId })}
                />
                <Button
                  data-testid="spam-block-sender-and-asset"
                  variant={ButtonVariant.Danger}
                  className="max-w-none"
                  title={t('blockSenderAndAsset')}
                  onClick={() =>
                    confirm({
                      kind: 'block-sender-and-faucet',
                      senderAddress: note.senderAddress,
                      faucetId: note.faucetId
                    })
                  }
                />
              </>
            )}
            <Button
              data-testid="spam-cancel"
              variant={ButtonVariant.Secondary}
              className="max-w-none"
              title={t('cancel')}
              onClick={() => onOpenChange(false)}
            />
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  );
};

export default MarkAsSpamDrawer;

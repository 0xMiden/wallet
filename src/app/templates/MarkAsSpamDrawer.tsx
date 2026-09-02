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
  /**
   * `note` (default): one pending note — sender + amount, block asset / sender.
   * `asset`: a whole asset group from the Pending summary — `note.amount` is the
   * group total and the sender is not meaningful, so only "Block this asset" is
   * offered. Never used for the native faucet, which cannot be blocked.
   */
  scope?: 'note' | 'asset';
  /** Number of notes in the group; only read in `asset` scope. */
  noteCount?: number;
  onConfirm: (action: SpamAction) => void;
}

interface BlockActionsArgs {
  note: MarkAsSpamNote;
  scope: 'note' | 'asset';
  isNativeFaucet: boolean;
  confirm: (action: SpamAction) => void;
  t: (key: string) => string;
}

/** The destructive choices, by what is being marked. Cancel is appended by the caller. */
function renderBlockActions({ note, scope, isNativeFaucet, confirm, t }: BlockActionsArgs): React.ReactNode {
  const blockAsset = (
    <Button
      data-testid="spam-block-asset"
      variant={ButtonVariant.Danger}
      className="max-w-none"
      title={t('blockThisAsset')}
      onClick={() => confirm({ kind: 'block-faucet', faucetId: note.faucetId })}
    />
  );

  switch (true) {
    case scope === 'asset':
      return blockAsset;
    case isNativeFaucet:
      return (
        <Button
          data-testid="spam-block-sender"
          variant={ButtonVariant.Danger}
          className="max-w-none"
          title={t('blockSender')}
          onClick={() => confirm({ kind: 'block-sender', senderAddress: note.senderAddress })}
        />
      );
    default:
      return (
        <>
          {blockAsset}
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
      );
  }
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
  scope = 'note',
  noteCount = 1,
  onConfirm
}) => {
  const { t } = useTranslation();

  const decimals = note?.metadata.decimals ?? 6;
  const symbol = note?.metadata.symbol || 'UNKNOWN';
  const amountLabel = note ? `${formatBigInt(BigInt(note.amount), decimals)} ${symbol}` : '';
  const senderLabel = note?.senderAddress ? truncateAddress(note.senderAddress, false, 8, 4) : t('unknown');
  const assetLabel = note?.metadata.name || symbol;
  const isAssetScope = scope === 'asset';

  const confirm = (action: SpamAction) => {
    onConfirm(action);
    onOpenChange(false);
  };

  const description = (() => {
    switch (true) {
      case isAssetScope:
        return t('markAsSpamAssetBody', { count: noteCount });
      case isNativeFaucet:
        return t('markAsSpamBodyNative');
      default:
        return t('markAsSpamBody');
    }
  })();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="mark-as-spam">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="text-2xl">{t('markAsSpamTitle')}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>

        <div className="px-4">
          <DetailCard>
            {isAssetScope ? (
              <DetailRow label={t('asset')} value={assetLabel} />
            ) : (
              <DetailRow label={t('sender')} value={senderLabel} />
            )}
            <DetailRow label={t('amount')} value={amountLabel} isLast />
          </DetailCard>
        </div>

        {note && (
          <DrawerFooter>
            {renderBlockActions({ note, scope, isNativeFaucet, confirm, t })}
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

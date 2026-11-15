import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { AddressTab, ReceiveBridgeTile } from 'app/pages/Receive/AddressTab';
import { useActivityClaimList } from 'app/templates/history/useActivityClaimList';
import { FeatureUnavailableNotice } from 'components/FeatureUnavailable';
import { useRegisterCommandFlowBack } from 'components/flow/FlowPresentation';
import { EmptyState } from 'components/ui/EmptyState';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { SectionHeader } from 'components/ui/SectionHeader';
import { StatusBadge } from 'components/ui/StatusBadge';
import { formatBigInt } from 'lib/i18n/numbers';
import { useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { useCommandDrafts } from 'screens/command/command-drafts';
import { truncateAddress } from 'utils/string';

export function CommandReceive({
  address,
  onBridgeDeposit,
  bridgeAvailability,
  bridgeOffered
}: {
  address: string;
  onBridgeDeposit: () => void;
  bridgeAvailability: FeatureAvailability;
  bridgeOffered: boolean;
}) {
  const { t } = useTranslation();
  const drafts = useCommandDrafts();
  const selectedFaucetId = drafts.readDraft('receive')?.faucetId;
  const metadata = useAllTokensBaseMetadata();
  const { data: balances = [] } = useAllBalances(address, metadata);
  const selectedAsset = balances.find(balance => balance.tokenId === selectedFaucetId);
  const { listItems, renderPendingItem, isLoadingNotes, hidden } = useActivityClaimList('', 'pending');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const privacyReady = hidden.loaded && !hidden.failed;
  const selectedNote = privacyReady ? listItems.find(item => item.note.id === selectedNoteId) : undefined;

  const closePicker = useCallback(() => setPickerOpen(false), []);
  useEffect(() => {
    if (!pickerOpen && document.activeElement?.closest('[data-receive-asset-picker="true"][data-state="closed"]')) {
      pickerTrigger.current?.focus();
    }
  }, [pickerOpen]);
  const back = useCallback(() => {
    if (pickerOpen) closePicker();
    else setSelectedNoteId(null);
  }, [pickerOpen, closePicker]);
  useRegisterCommandFlowBack(pickerOpen || selectedNote ? back : undefined);

  return (
    <div data-testid="command-receive" className="grid gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <SectionHeader size="lg">{t('receiveAt')}</SectionHeader>
        <AddressTab
          address={address}
          onBridgeDeposit={onBridgeDeposit}
          bridgeAvailability={bridgeAvailability}
          bridgeOffered={bridgeOffered}
          presentation="command"
        />
      </div>
      <div className="min-w-0 space-y-4">
        <SectionHeader size="lg">{selectedNote ? t('activityAcceptTransfer') : t('transfersSection')}</SectionHeader>
        {hidden.failed && (
          <Notice role="alert" tone="negative" variant="inline" errorId="activityHiddenNotesError">
            {t('activityHiddenNotesError')}
          </Notice>
        )}
        {selectedNote ? (
          <div data-testid="receive-note-review">{renderPendingItem(selectedNote, true)}</div>
        ) : (
          <>
            {isLoadingNotes && (
              <p role="status" className="text-caption text-muted">
                {t('activityFetchingHistoryAndNotes')}
              </p>
            )}
            {privacyReady && listItems.length === 0 && !isLoadingNotes && (
              <EmptyState icon={IconName.Receive} size="compact" title={t('receiveNoPendingTransfers')} />
            )}
            {privacyReady && listItems.length > 0 && (
              <ListGroup surface="fill">
                {listItems.map(item => {
                  const symbol = item.note.metadata.symbol;
                  const sender = item.note.senderAddress
                    ? truncateAddress(item.note.senderAddress, false, 8, 4)
                    : t('unknown');
                  const amount = hasKnownScale(item.note.metadata)
                    ? formatBigInt(BigInt(item.note.amount), item.note.metadata.decimals)
                    : undefined;
                  return (
                    <ListRow
                      key={item.note.id}
                      title={amount === undefined ? symbol : `${amount} ${symbol}`}
                      subtitle={`${t('from')}: ${sender}`}
                      trailing={
                        <StatusBadge
                          size="sm"
                          status={
                            item.note.fromCache
                              ? 'checking'
                              : item.status === 'claiming' && item.held
                                ? 'unconfirmed'
                                : item.status === 'claiming'
                                  ? 'inProgress'
                                  : item.status === 'failed'
                                    ? 'failed'
                                    : 'pending'
                          }
                        />
                      }
                      data-testid={`receive-note-${item.note.id}`}
                      onClick={() => setSelectedNoteId(item.note.id)}
                    />
                  );
                })}
              </ListGroup>
            )}
          </>
        )}
        <SectionHeader size="lg">{t('assets')}</SectionHeader>
        <ListGroup>
          <ListRow
            ref={pickerTrigger}
            title={
              <span data-testid="receive-selected-asset">{selectedAsset?.metadata.symbol ?? t('selectAToken')}</span>
            }
            data-testid="receive-asset-picker"
            accent="receive"
            onClick={() => setPickerOpen(true)}
          />
        </ListGroup>
        {bridgeOffered && (
          <div data-testid="receive-bridge-utility" className="space-y-2">
            <ReceiveBridgeTile onBridgeDeposit={onBridgeDeposit} availability={bridgeAvailability} />
            <FeatureUnavailableNotice availability={bridgeAvailability} variant="inline" />
          </div>
        )}
      </div>
      <Drawer
        open={pickerOpen}
        onOpenChange={open => (open ? setPickerOpen(true) : closePicker())}
        screenKey="receive-asset"
        closeOnBack={false}
      >
        <DrawerContent data-receive-asset-picker="true">
          <DrawerHeader>
            <DrawerTitle>{t('selectAToken')}</DrawerTitle>
          </DrawerHeader>
          <ListGroup className="mx-4 mb-4">
            {balances.map(balance => (
              <ListRow
                key={balance.tokenId}
                title={balance.metadata.symbol}
                checked={balance.tokenId === selectedFaucetId}
                accent="receive"
                data-testid={`receive-asset-${balance.tokenId}`}
                onClick={() => {
                  drafts.writeDraft('receive', { faucetId: balance.tokenId });
                  closePicker();
                }}
              />
            ))}
          </ListGroup>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

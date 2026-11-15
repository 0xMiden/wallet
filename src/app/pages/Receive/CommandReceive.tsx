import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { AddressTab } from 'app/pages/Receive/AddressTab';
import { useActivityClaimList } from 'app/templates/history/useActivityClaimList';
import { useRegisterCommandFlowBack } from 'components/flow/FlowPresentation';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SectionHeader } from 'components/ui/SectionHeader';
import { useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { useCommandDrafts } from 'screens/command/command-drafts';

export function CommandReceive({ address, onBridgeDeposit }: { address: string; onBridgeDeposit: () => void }) {
  const { t } = useTranslation();
  const drafts = useCommandDrafts();
  const selectedFaucetId = drafts.readDraft('receive')?.faucetId;
  const metadata = useAllTokensBaseMetadata();
  const { data: balances = [] } = useAllBalances(address, metadata);
  const selectedAsset = balances.find(balance => balance.tokenId === selectedFaucetId);
  const { listItems, renderPendingItem, isLoadingNotes } = useActivityClaimList('', 'pending');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const selectedNote = listItems.find(item => item.note.id === selectedNoteId);

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
        <button
          ref={pickerTrigger}
          type="button"
          data-testid="receive-asset-picker"
          className="min-h-12 w-full rounded-2xl bg-fill px-4 text-left text-row-title text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-receive"
          onClick={() => setPickerOpen(true)}
        >
          <span data-testid="receive-selected-asset">{selectedAsset?.metadata.symbol ?? t('selectAToken')}</span>
        </button>
        <AddressTab address={address} onBridgeDeposit={onBridgeDeposit} presentation="command" />
      </div>
      <div className="min-w-0 space-y-4">
        <SectionHeader size="lg">{selectedNote ? t('activityAcceptTransfer') : t('transfersSection')}</SectionHeader>
        {selectedNote ? (
          <div data-testid="receive-note-review">{renderPendingItem(selectedNote, true)}</div>
        ) : (
          <>
            {isLoadingNotes && (
              <p role="status" className="text-caption text-muted">
                {t('activityFetchingHistoryAndNotes')}
              </p>
            )}
            <ListGroup surface="fill">
              {listItems.map(item => (
                <ListRow
                  key={item.note.id}
                  title={item.note.metadata.symbol}
                  subtitle={item.note.senderAddress || t('unknown')}
                  value={item.status === 'claiming' ? t('activityAcceptingTransfer') : undefined}
                  data-testid={`receive-note-${item.note.id}`}
                  onClick={() => setSelectedNoteId(item.note.id)}
                />
              ))}
            </ListGroup>
          </>
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

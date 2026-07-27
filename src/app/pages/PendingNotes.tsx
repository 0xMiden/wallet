import React, { FC, useCallback, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { useClaimNotes } from 'app/hooks/useClaimNotes';
import { PendingTab } from 'app/pages/Receive/PendingTab';
import { ScreenHeader } from 'components/ScreenHeader';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { goBack } from 'lib/woozie';

/**
 * Standalone pending-notes (claimable notes) screen, routed at `/pending-notes`
 * (and the legacy `/pending` alias). Reached from the Activity header and from
 * the "note received" native notification. Claim orchestration lives in
 * `useClaimNotes`; `PendingTab` renders the summary / per-asset detail views.
 *
 * The selected asset lives here so the header's back affordance can step out of
 * the detail view before leaving the page.
 */
const PendingNotes: FC = () => {
  const { t } = useTranslation();
  const { fullPage, sidePanel } = useAppEnv();
  const claim = useClaimNotes();
  const [selectedFaucetId, setSelectedFaucetId] = useState<string | null>(null);

  const handleBack = useCallback(() => {
    if (selectedFaucetId) {
      hapticLight();
      setSelectedFaucetId(null);
      return;
    }
    goBack();
  }, [selectedFaucetId]);

  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg px-4')}>
      <ScreenHeader
        title={t('pendingNotes')}
        backLabel={t('back')}
        backTestId={selectedFaucetId ? 'pending-detail-back' : undefined}
        onBack={handleBack}
      />
      <PendingTab
        safeClaimableNotes={claim.safeClaimableNotes}
        unclaimedNotesCount={claim.unclaimedNotes.length}
        account={claim.account}
        mutateClaimableNotes={claim.mutateClaimableNotes}
        isDelegatedProvingEnabled={claim.isDelegatedProvingEnabled}
        claimingNoteIds={claim.claimingNoteIds}
        failedNoteIds={claim.failedNoteIds}
        checkingNoteIds={claim.checkingNoteIds}
        selectedFaucetId={selectedFaucetId}
        onSelectFaucetId={setSelectedFaucetId}
        onClaimingStateChange={claim.handleClaimingStateChange}
        onClaimAll={claim.handleClaimAll}
        onClaimGroup={claim.handleClaimGroup}
      />
    </div>
  );
};

export default PendingNotes;

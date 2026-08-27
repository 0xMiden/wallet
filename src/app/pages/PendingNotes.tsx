import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useClaimNotes } from 'app/hooks/useClaimNotes';
import { useReportNoteClaim } from 'app/hooks/useReportNoteClaim';
import { PendingTab } from 'app/pages/Receive/PendingTab';
import { NavigationHeader } from 'components/NavigationHeader';
import { isMobile } from 'lib/platform';

const PendingNotes: FC = () => {
  const { t } = useTranslation();
  const { fullPage, sidePanel } = useAppEnv();
  // This screen owns the `note_handle` flow. The reporter is handed to both
  // claim paths — the batch queue inside the hook and the per-note buttons in
  // PendingTab — so a claim is reported wherever the user starts it.
  const reportClaim = useReportNoteClaim();
  const claim = useClaimNotes(reportClaim);

  // Reached in-app there's a screen to return to, so pop history. But this page
  // can also be opened cold in a fresh tab (a received-note notification deep-
  // links here — #467), where history.go(-1) is a no-op and would leave a dead
  // back button; fall back to the wallet home in that case.
  const handleBack = useBackWithFallback();

  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg')}>
      <NavigationHeader title={t('pendingNotes')} onBack={handleBack} variant="prominent" titleAlign="left" />
      <PendingTab
        safeClaimableNotes={claim.safeClaimableNotes}
        unclaimedNotesCount={claim.unclaimedNotes.length}
        account={claim.account}
        isDelegatedProvingEnabled={claim.isDelegatedProvingEnabled}
        claimingNoteIds={claim.claimingNoteIds}
        retriableNoteIds={claim.retriableNoteIds}
        invalidNoteIds={claim.invalidNoteIds}
        checkingNoteIds={claim.checkingNoteIds}
        onClaimingStateChange={claim.handleClaimingStateChange}
        onClaimAll={claim.handleClaimAll}
        onClaimGroup={claim.handleClaimGroup}
        reportClaim={reportClaim}
      />
    </div>
  );
};

export default PendingNotes;

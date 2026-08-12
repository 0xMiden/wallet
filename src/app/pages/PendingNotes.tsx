import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { useClaimNotes } from 'app/hooks/useClaimNotes';
import { PendingTab } from 'app/pages/Receive/PendingTab';
import { ScreenHeader } from 'components/ScreenHeader';
import { isMobile } from 'lib/platform';
import { goBack, navigate } from 'lib/woozie';

const PendingNotes: FC = () => {
  const { t } = useTranslation();
  const { fullPage, sidePanel } = useAppEnv();
  const claim = useClaimNotes();

  // Reached in-app there's a screen to return to, so pop history. But this page
  // can also be opened cold in a fresh tab (a received-note notification deep-
  // links here — #467), where history.go(-1) is a no-op and would leave a dead
  // back button; fall back to the wallet home in that case.
  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      goBack();
    } else {
      navigate('/');
    }
  };

  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg')}>
      {/* #503 — match every other screen's ScreenHeader inset (ScreenHeader has
          no horizontal padding of its own) so the back icon + title aren't flush
          against the left edge. */}
      <ScreenHeader title={t('pendingNotes')} backLabel={t('back')} onBack={handleBack} className="mx-4 shrink-0" />
      <PendingTab
        safeClaimableNotes={claim.safeClaimableNotes}
        unclaimedNotesCount={claim.unclaimedNotes.length}
        account={claim.account}
        isDelegatedProvingEnabled={claim.isDelegatedProvingEnabled}
        claimingNoteIds={claim.claimingNoteIds}
        failedNoteIds={claim.failedNoteIds}
        checkingNoteIds={claim.checkingNoteIds}
        onClaimingStateChange={claim.handleClaimingStateChange}
        onClaimAll={claim.handleClaimAll}
        onClaimGroup={claim.handleClaimGroup}
      />
    </div>
  );
};

export default PendingNotes;

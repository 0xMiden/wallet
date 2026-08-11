import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { useClaimNotes } from 'app/hooks/useClaimNotes';
import { PendingTab } from 'app/pages/Receive/PendingTab';
import { ScreenHeader } from 'components/ScreenHeader';
import { isMobile } from 'lib/platform';
import { goBack } from 'lib/woozie';

const PendingNotes: FC = () => {
  const { t } = useTranslation();
  const { fullPage, sidePanel } = useAppEnv();
  const claim = useClaimNotes();

  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg')}>
      <ScreenHeader
        title={t('pendingNotes')}
        backLabel={t('back')}
        onBack={() => goBack()}
        className="mx-4 shrink-0"
      />
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

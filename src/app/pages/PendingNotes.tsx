import React, { FC, useCallback, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useClaimNotes } from 'app/hooks/useClaimNotes';
import { IconName } from 'app/icons/v2';
import { PendingTab } from 'app/pages/Receive/PendingTab';
import { CircleButton } from 'components/CircleButton';
import { NavigationHeader } from 'components/NavigationHeader';
import { useClaimableNotesWithSpam } from 'lib/miden/front/claimable-notes';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

const PendingNotes: FC = () => {
  const { t } = useTranslation();
  const { fullPage, sidePanel } = useAppEnv();
  const claim = useClaimNotes();
  // Notes the spam list is currently hiding — the count on the bin button.
  const { spam } = useClaimableNotesWithSpam(claim.account.publicKey);

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

  const spamCount = spam.length;

  // The bin belongs to the asset list, not to one asset's detail view: there it
  // would sit next to a specific token while acting on everything.
  const [inAssetDetail, setInAssetDetail] = useState(false);
  const handleSelectedGroupChange = useCallback((faucetId: string | null) => setInAssetDetail(faucetId !== null), []);

  // On the list it is always shown, even at zero: blocked assets and senders
  // live behind it and can only be un-blocked from the bin.
  const spamBin = (
    <span className="relative inline-flex">
      <CircleButton
        data-testid="spam-bin-button"
        aria-label={t('spamBinAriaLabel', { count: spamCount })}
        icon={IconName.Bin}
        onClick={() => navigate('/pending-notes/spam')}
        className="w-11 h-11 bg-gray-25 text-black"
        size="sm"
        color="currentColor"
      />
      {spamCount > 0 && (
        <span
          aria-hidden
          data-testid="spam-bin-count"
          className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-negative px-1 font-heading text-[10px] font-bold leading-none text-pure-white"
        >
          {spamCount}
        </span>
      )}
    </span>
  );

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg')}>
      <NavigationHeader
        title={t('pendingNotes')}
        onBack={handleBack}
        variant="prominent"
        titleAlign="left"
        rightAction={inAssetDetail ? undefined : spamBin}
      />
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
        onSelectedGroupChange={handleSelectedGroupChange}
      />
    </div>
  );
};

export default PendingNotes;

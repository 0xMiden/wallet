import React, { useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { useClaimNotes } from 'app/hooks/useClaimNotes';
import { AddressTab } from 'app/pages/Receive/AddressTab';
import { PendingTab } from 'app/pages/Receive/PendingTab';
import { TabPicker } from 'components/TabPicker';
import { useAccount } from 'lib/miden/front';
import { isMobile } from 'lib/platform';

export interface ReceiveProps {}

type ReceiveTab = 'address' | 'pending';

/**
 * Pending-notes tab body. Split into its own component so `useClaimNotes`
 * (which polls for stuck txs / claimable notes) only runs while the Pending
 * tab is open — Receive is always mounted inside the home swipe carousel.
 */
const PendingTabContent: React.FC = () => {
  const claim = useClaimNotes();

  return (
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
  );
};

export const Receive: React.FC<ReceiveProps> = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const address = account.publicKey;
  const [tab, setTab] = useState<ReceiveTab>('address');

  const { fullPage, sidePanel } = useAppEnv();

  // Match SendManager's container sizing - use h-full to inherit from parent (body has safe area padding).
  const containerClass =
    isMobile() || sidePanel
      ? 'h-full w-full'
      : fullPage
        ? 'h-[640px] max-h-[640px] w-[600px] max-w-[600px]'
        : 'h-[600px] max-h-[600px] w-[360px] max-w-[360px]';

  return (
    <div className={classNames(containerClass, 'mx-auto overflow-hidden flex flex-col bg-app-bg relative')}>
      <div className="px-4 pt-3 pb-2">
        <TabPicker
          tabs={[
            { id: 'address', title: t('address'), active: tab === 'address' },
            { id: 'pending', title: t('pending'), active: tab === 'pending' }
          ]}
          onTabChange={index => setTab(index === 0 ? 'address' : 'pending')}
        />
      </div>

      {tab === 'address' ? <AddressTab address={address} /> : <PendingTabContent />}
    </div>
  );
};

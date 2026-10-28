import React from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import { useTranslation } from 'react-i18next';

import { AdvancedDetails, FoldableField } from '../../../src/app/confirm/AdvancedDetails';
import { TransactionAssetView } from '../../../src/app/confirm/TransactionAssetView';
import type { TxAssetView } from '../../../src/app/confirm/decode';
import type { NoteFlow } from '../../../src/app/confirm/note-flow';
import { DappConfirmationModal } from '../../../src/app/pages/Browser/DappConfirmationModal';
import type { DAppConfirmationRequest } from '../../../src/lib/dapp-browser/confirmation-store';

const account = 'mtst1apsnkg6x57mhxyrq09aavyq08yu5dy4p_qr7qqq9wr6w';
const eth = 'miden1ethfixture';
const usdcx = 'miden1usdcxfixture';

const flow: NoteFlow = {
  inputCount: 0,
  inputs: [],
  outputs: [
    {
      id: `0x${'11'.repeat(32)}`,
      kind: 'P2ID',
      visibility: 'public',
      sender: account,
      assets: [{ faucetId: eth, amount: 1_000_000_000_000_000n }],
      nfts: []
    },
    {
      id: `0x${'22'.repeat(32)}`,
      kind: 'PSWAP',
      visibility: 'private',
      assets: [{ faucetId: usdcx, amount: 252n }],
      nfts: []
    },
    {
      id: `0x${'33'.repeat(32)}`,
      kind: 'fee',
      visibility: 'public',
      assets: [{ faucetId: usdcx, amount: 133n }],
      nfts: []
    }
  ],
  storageChanges: []
};

const partial: NoteFlow = {
  inputCount: 2,
  inputs: [
    {
      id: `0x${'44'.repeat(32)}`,
      kind: 'unknown',
      visibility: 'unknown'
    }
  ],
  outputs: [
    {
      id: `0x${'55'.repeat(32)}`,
      kind: 'custom',
      visibility: 'private',
      scriptRoot: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      assets: [{ faucetId: usdcx, amount: 42_000n }],
      nfts: []
    }
  ],
  storageChanges: [
    { slotName: 'account-state', kind: 'value', operation: 'update' },
    { slotName: 'orders', kind: 'map', operation: 'create', entryCount: 2 }
  ]
};

const assetView: TxAssetView = {
  account,
  outgoing: [
    { faucetId: eth, amount: 1_000_000_000_000_000n },
    { faucetId: usdcx, amount: 252n }
  ],
  incoming: [],
  outgoingNfts: [],
  incomingNfts: [],
  unlistedAssets: 0,
  inputNotesConsumed: 0,
  outputNotesCreated: 2,
  fee: { faucetId: usdcx, amount: 133n },
  storageChanged: false
};

export function TransactionFixture({ surface, variant }: { surface: 'modal' | 'asset'; variant: 'main' | 'partial' }) {
  const { t } = useTranslation();
  const noteFlow = variant === 'partial' ? partial : flow;
  if (surface === 'modal') {
    const request: DAppConfirmationRequest = {
      id: `visual-${variant}`,
      type: 'transaction',
      origin: 'https://swap.example',
      appMeta: { name: 'Swap example' },
      network: 'testnet',
      networkRpc: 'https://rpc.testnet.miden.io',
      privateDataPermission: PrivateDataPermission.UponRequest,
      allowedPrivateData: AllowedPrivateData.None,
      existingPermission: false,
      sourcePublicKey: account,
      transactionMessages: ['Verified transaction effects'],
      noteFlow
    };
    return <DappConfirmationModal request={request} accountId={account} onResolve={() => undefined} />;
  }
  return (
    <main className="mx-auto flex h-full w-full max-w-[440px] flex-col bg-surface-solid text-ink" data-testid="tx-asset-fixture">
      <header className="shrink-0 border-b border-border-light px-5 py-4 text-lg font-semibold">Transaction review</header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="tx-asset-scroll">
        <TransactionAssetView
          view={
            variant === 'main'
              ? assetView
              : { ...assetView, inputNotesConsumed: 2, outputNotesCreated: 1, storageChanged: true }
          }
          mode="verified"
          noteFlow={noteFlow}
          onDownload={() => undefined}
        />
        <AdvancedDetails label={t('rawTransactionData')}>
          <FoldableField label="recipient" value="(none)" />
          <FoldableField label="importNotes" value={0} />
          <FoldableField label="requestBytes" value={'AQID'.repeat(60)} />
        </AdvancedDetails>
      </div>
    </main>
  );
}

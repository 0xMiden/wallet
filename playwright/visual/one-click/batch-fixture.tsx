import React, { useEffect, useState, useSyncExternalStore } from 'react';

import MyBadges from '../../../src/app/pages/MyBadges';
import DeviceSettings from '../../../src/app/templates/DeviceSettings';
import { EvmBridgeTokenDrawer, type DepositErc20Row } from '../../../src/app/templates/EvmConnectModal/EvmBridgeTokenDrawer';
import { depositTokenKey, type DepositToken } from '../../../src/app/templates/EvmConnectModal/deposit-token';
import { PendingActivityCard, type PendingActivityItem } from '../../../src/app/templates/history/PendingActivityCard';
import {
  RecoveryPhraseKeepPrompt,
  RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY
} from '../../../src/app/templates/RecoveryPhraseKeepPrompt';
import { SubPageHeaderProvider } from '../../../src/components/ui/SubPageLayout';
import { BADGE_STORAGE_KEY, readEarnedBadges } from '../../../src/lib/badges/types';
import { ITransactionStatus, type ITransaction } from '../../../src/lib/miden/db/types';
import { getStorageProvider as getActualStorageProvider } from '../../../src/lib/platform/storage-adapter';
import { DialogsProvider } from '../../../src/lib/ui/dialog';
import { useDeadlineNow } from '../../../src/lib/ui/deadline-ticker';
import { Provider as LocationProvider } from '../../../src/lib/woozie';
import { ChooseDeviceRole } from '../../../src/screens/onboarding/import-wallet-flow/ChooseDeviceRole';

// These boundaries hold display data only. No signer, credential or network operation exists here.
const account = { publicKey: 'visual-account', hotPublicKey: 'visual-device', name: 'Example account' };
const plain = new Map<string, unknown>();
const listeners = new Set<() => void>();
let revision = 0;
let removals = 0;
let history: ITransaction[] = [];
const publish = () => {
  revision++;
  listeners.forEach(listener => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => revision;
const wallet = {
  currentAccount: account,
  seedPhraseStatus: 'stored',
  tokenPrices: {},
  removeSeedPhrase: async () => {
    removals++;
    publish();
  }
};

export function useWalletStore<T>(select: (state: typeof wallet) => T): T {
  useSyncExternalStore(subscribe, snapshot);
  return select(wallet);
}
export const useNetwork = () => ({ id: 'mainnet' });
export const useMidenContext = () => ({
  accounts: [account],
  signTransaction: async () => {
    throw new Error('Rendering fixture cannot sign');
  }
});
export const useDeviceSigners = () => ({
  devices: [
    { commitment: `0x${'11'.repeat(32)}`, current: true },
    { commitment: `0x${'22'.repeat(32)}`, current: false }
  ],
  failed: false
});

// Keep the production hashed vault-presence check, including its absent-value behavior.
const fixtureStorage = {
  get: async (keys: string[]) => Object.fromEntries(keys.filter(key => plain.has(key)).map(key => [key, plain.get(key)])),
  set: async (entries: Record<string, unknown>) => {
    Object.entries(entries).forEach(([key, value]) => plain.set(key, value));
    publish();
  },
  remove: async (keys: string[]) => {
    keys.forEach(key => plain.delete(key));
    publish();
  }
};
export const getStorageProvider = () =>
  new URLSearchParams(location.search).has('batch') ? fixtureStorage : getActualStorageProvider();

export const transactions = {
  where: (index: string) => ({
    between: (lower: readonly unknown[]) => {
      const rows = history.filter(
        row =>
          (index.startsWith('[recovered') ? row.recoveredBadgeNetwork : row.badgeNetwork) === lower[0] &&
          row.status === lower[1] && row.type === lower[2]
      );
      return {
        primaryKeys: async () => rows.map(row => row.id),
        keys: async () => rows.map(row => [lower[0], row.status, row.type, row.badgeEvidenceRevision]),
        toArray: async () => rows
      };
    }
  })
};

async function prepare(state: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vault_check'));
  const vaultKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  plain.set(vaultKey, 'fixture-vault-present');
  plain.set(BADGE_STORAGE_KEY, state === 'badges-saved' ? ['first-send'] : []);
  plain.set(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, state === 'phrase' ? account.publicKey : '');
  if (state === 'badges-history') {
    history = [
      {
        id: 'eligible-send', accountId: account.publicKey, secondaryAccountId: 'visual-recipient',
        type: 'send', amount: 1n, status: ITransactionStatus.Completed,
        initiatedAt: 1, displayIcon: 'SEND', badgeNetwork: 'mainnet'
      },
      {
        id: 'ineligible-deposit', accountId: account.publicKey, type: 'bridged-receive', amount: 1n,
        status: ITransactionStatus.Completed, initiatedAt: 1, displayIcon: 'SEND',
        badgeNetwork: 'testnet', extraInputs: { phase: 'received' }
      }
    ];
  }
}

function TokenDrawer({ select }: { select: (token: string) => void }) {
  const [selected, setSelected] = useState<DepositToken>('ETH');
  const rows = Array.from({ length: 19 }, (_, index): DepositErc20Row => ({
    token: {
      symbol: index === 1 ? 'TINY' : `ASSET${index}`,
      contractAddress: `0x${index.toString(16).padStart(40, '0')}`,
      decimals: 18
    },
    name: index === 1 ? 'TINY' : `ASSET${index}`,
    balance: index === 1 ? '0' : String(index),
    value: BigInt(index)
  }));
  return (
    <EvmBridgeTokenDrawer
      open
      onOpenChange={() => undefined}
      selected={selected}
      ethBalance="0.5"
      ethBalanceValue={500000000000000000n}
      circleUsdcBalance="0"
      circleUsdcBalanceValue={null}
      circleUsdcLabel="USDC"
      epochRows={[
        {
          key: 'POL',
          address: '0x0000000000000000000000000000000000000000',
          midenFaucetId: 'visual-pol',
          name: 'POL',
          balance: '',
          value: null,
          loading: true
        }
      ]}
      erc20Rows={rows}
      onSelect={token => {
        setSelected(token);
        select(depositTokenKey(token));
      }}
    />
  );
}

function HeldActivity() {
  const [deadline] = useState(() => Math.floor(Date.now() / 1000) + 60);
  const now = useDeadlineNow(deadline * 1000);
  const item: PendingActivityItem = {
    note: {
      id: 'visual-note',
      faucetId: 'visual-token',
      amount: '1000000',
      senderAddress: 'visual-sender',
      receivedAt: Date.parse('2026-11-12T11:58:00Z') / 1000,
      isBeingClaimed: false,
      type: 'unknown',
      metadata: { name: 'Example token', symbol: 'TOK', decimals: 6 }
    },
    status: 'claiming',
    held: true,
    txId: 'visual-claim',
    ...(now < deadline * 1000 ? { holdUntil: deadline } : {})
  };
  return <PendingActivityCard item={item} onAccept={() => undefined} onRetryHeld={() => undefined} />;
}

export function BatchFixture({ state }: { state: string }) {
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState('');
  useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    void prepare(state).then(() => setReady(true));
  }, [state]);
  if (!ready) return null;
  const views: Record<string, React.ReactNode> = {
    tokens: <TokenDrawer select={setSelection} />,
    hold: <div className="p-4"><HeldActivity /></div>,
    role: <ChooseDeviceRole deviceCount={2} onSubmit={setSelection} />,
    devices: (
      <SubPageHeaderProvider value={{ title: 'Devices' }}>
        <DeviceSettings />
      </SubPageHeaderProvider>
    ),
    phrase: <RecoveryPhraseKeepPrompt />
  };
  return (
    <LocationProvider>
      <DialogsProvider>
        <main
          className="mx-auto flex h-full w-full max-w-[600px] flex-col bg-app-bg text-ink"
          data-testid="batch-ready"
          data-awards={readEarnedBadges(plain.get(BADGE_STORAGE_KEY)).join(',')}
          data-removals={removals}
          data-selection={selection}
        >
          {state.startsWith('badges-') ? <MyBadges /> : views[state]}
        </main>
      </DialogsProvider>
    </LocationProvider>
  );
}

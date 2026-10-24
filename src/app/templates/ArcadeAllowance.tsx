import React, { useSyncExternalStore } from 'react';

import { useTranslation } from 'react-i18next';

import { hasBalanceSnapshotForNetwork } from 'lib/miden/balance-snapshot';
import { useTokensMetadata } from 'lib/miden/front/assets';
import { useAllBalances } from 'lib/miden/front/balance';
import { useAccount, useAllNetworks } from 'lib/miden/front/ready';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { subscribeBridgeConfig } from 'lib/remote-config/runtime';

import { ArcadeCoinsCard } from './ArcadeCoinsCard';

/** Existing export retained for the Coins route; weekly controls and service are no longer mounted. */
export const ArcadeAllowance: React.FC = () => {
  const { i18n } = useTranslation();
  const account = useAccount();
  const networks = useAllNetworks();
  const networkId = useSyncExternalStore(subscribeBridgeConfig, getEffectiveNetworkName);
  const networkName = networks.find(network => network.id === networkId)?.name ?? networkId;
  const { allTokensBaseMetadataRef } = useTokensMetadata();
  const { data, isLoading } = useAllBalances(account.publicKey, allTokensBaseMetadataRef.current);
  // Pinned hex + BasicWallet addresses of public token issuers, derived with the real SDK.
  // Extension balance rows arrive before this UI realm necessarily initializes WASM.
  const issuers =
    networkId === 'mainnet'
      ? ['0x34a3510213533f512ec4abe36baf84', 'mm1aq62x5gzzdfn75fwcj47x6a0ssyu9cxz_qr7qqq9wr6w']
      : networkId === 'testnet'
        ? ['0x97924b9a77ed54917ff6d6364ae661', 'mtst1azteyju6wlk4fytl7mtrvjhxvy08nme2_qr7qqq9wr6w']
        : [];
  const rows = data.filter(row => issuers.includes(row.tokenId));
  const coin = rows[0];
  const amount = coin?.balance ?? 0;
  const known =
    issuers.length > 0 &&
    !isLoading &&
    hasBalanceSnapshotForNetwork(data, networkId) &&
    rows.length <= 1 &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    (coin === undefined || (coin.metadata.decimals === 6 && !coin.metadata.scaleIsUnknown));
  const balance = known
    ? new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { maximumFractionDigits: 6 }).format(amount)
    : null;

  return <ArcadeCoinsCard balance={balance} networkName={networkName} busy={isLoading} />;
};

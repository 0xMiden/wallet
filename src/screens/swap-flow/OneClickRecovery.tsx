import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button, ButtonVariant } from 'components/Button';
import { Notice } from 'components/ui/Notice';
import type { IOneClickTrackingData } from 'lib/miden/db/types';
import { useAccount } from 'lib/miden/front';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { createMidenAssetMetadataResolver, fetchOneClickAssets } from 'lib/one-click/client';
import { useOneClickConfig as useOneClickConfigState } from 'lib/one-click/config';
import type { OneClickAsset } from 'lib/one-click/types';
import { readMidenFaucetMetadata } from 'lib/remote-config/derive';

import { OneClickFlow } from './OneClickFlow';
import { OneClickNetworkOption } from './OneClickPickers';

interface OneClickRecoveryProps {
  tracking: IOneClickTrackingData;
  transactionAccountId: string;
  onBack: () => void;
}

function assetMatches(current: OneClickAsset | undefined, pinned: OneClickAsset): boolean {
  return (
    current !== undefined &&
    current.assetId === pinned.assetId &&
    current.blockchain === pinned.blockchain &&
    current.decimals === pinned.decimals &&
    current.faucetId === pinned.faucetId &&
    current.chainId === pinned.chainId &&
    current.contractAddress === pinned.contractAddress
  );
}

export const OneClickRecovery: React.FC<OneClickRecoveryProps> = ({ tracking, transactionAccountId, onBack }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const config = useOneClickConfigState();
  const effectiveNetwork = getEffectiveNetworkName();
  const [assets, setAssets] = useState<OneClickAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
    setAssets([]);
    setLoading(true);
    setLoadError(false);
    if (!config) {
      setLoading(false);
      setLoadError(true);
      return () => {
        active = false;
      };
    }
    let rpcUrl: string;
    try {
      rpcUrl = getEffectiveRpcUrl();
    } catch {
      setLoading(false);
      setLoadError(true);
      return () => {
        active = false;
      };
    }
    const resolver = createMidenAssetMetadataResolver(faucetId => readMidenFaucetMetadata(faucetId, rpcUrl));
    void fetchOneClickAssets(config, resolver).then(
      nextAssets => {
        if (!active) return;
        setAssets(nextAssets);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setLoading(false);
        setLoadError(true);
      }
    );
    return () => {
      active = false;
    };
  }, [config, effectiveNetwork]);

  const networks = useMemo<OneClickNetworkOption[]>(() => {
    const labels: Record<string, string> = {
      miden: 'oneClickNetworkMiden',
      eth: 'oneClickNetworkEthereum',
      base: 'oneClickNetworkBase',
      arb: 'oneClickNetworkArbitrum',
      op: 'oneClickNetworkOptimism',
      arc: 'oneClickNetworkArc'
    };
    return Array.from(new Set(assets.map(asset => asset.blockchain))).map(id => ({
      id,
      name: labels[id]
        ? t(labels[id])
        : id
            .split(/[-_]/)
            .map(part => part[0]?.toUpperCase() + part.slice(1))
            .join(' '),
      kind: id === 'miden' ? 'miden' : 'ethereum',
      logoNetwork: id === 'eth' ? 'ethereum' : id === 'arb' ? 'arbitrum' : id === 'op' ? 'optimism' : undefined
    }));
  }, [assets, t]);

  const originAsset = assets.find(asset => asset.assetId === tracking.originAsset.assetId);
  const destinationAsset = assets.find(asset => asset.assetId === tracking.destinationAsset.assetId);
  const accountMatches =
    transactionAccountId === tracking.accountId &&
    account.publicKey === tracking.accountId &&
    tracking.accountAddress === tracking.accountId &&
    tracking.network === effectiveNetwork;
  const configMatches = config?.serviceUrl === tracking.config.serviceUrl;
  const outboundRouteMatches =
    tracking.direction === 'miden-to-evm' &&
    tracking.request.originAsset.blockchain === 'miden' &&
    tracking.request.originAsset.assetId === tracking.originAsset.assetId &&
    tracking.request.destinationAsset.assetId === tracking.destinationAsset.assetId &&
    tracking.request.refundTo === tracking.accountAddress &&
    tracking.originAsset.blockchain === 'miden' &&
    tracking.destinationAsset.blockchain !== 'miden' &&
    assetMatches(originAsset, tracking.originAsset) &&
    assetMatches(destinationAsset, tracking.destinationAsset);
  const inboundAttempt =
    tracking.direction === 'evm-to-miden' &&
    (tracking.evmSubmission === 'attempted' || tracking.evmSubmission === 'known') &&
    tracking.request.originAsset.blockchain !== 'miden' &&
    tracking.request.originAsset.assetId === tracking.originAsset.assetId &&
    tracking.request.destinationAsset.blockchain === 'miden' &&
    tracking.request.destinationAsset.assetId === tracking.destinationAsset.assetId &&
    tracking.request.recipient === tracking.accountAddress &&
    tracking.destinationAsset.blockchain === 'miden' &&
    tracking.originAsset.blockchain !== 'miden' &&
    assetMatches(originAsset, tracking.originAsset) &&
    assetMatches(destinationAsset, tracking.destinationAsset);
  const routeMatches = outboundRouteMatches || inboundAttempt;

  if (loading) {
    return (
      <HomeGroupPaneBody title={t('oneClickRefreshingExpiredQuote')}>
        <p className="text-body-sm text-muted" aria-live="polite">
          {t('calculatingQuote')}
        </p>
      </HomeGroupPaneBody>
    );
  }

  if (loadError || !accountMatches || !configMatches || !routeMatches || config === null) {
    return (
      <HomeGroupPaneBody title={t('oneClickRecoveryUnavailable')}>
        <Notice tone="warning" title={t('oneClickRecoveryUnavailable')}>
          {t('oneClickRecoveryUnavailableBody')}
        </Notice>
        <Button
          title={t('backToSwap')}
          variant={ButtonVariant.Secondary}
          onClick={onBack}
          className="mt-5 w-full max-w-none"
        />
      </HomeGroupPaneBody>
    );
  }

  const offerNetwork = networks.find(network => network.id === tracking.originAsset.blockchain);
  const requestNetwork = networks.find(network => network.id === tracking.destinationAsset.blockchain);
  if (!offerNetwork || !requestNetwork) {
    return (
      <HomeGroupPaneBody title={t('oneClickRecoveryUnavailable')}>
        <Notice tone="warning" title={t('oneClickRecoveryUnavailable')}>
          {t('oneClickRecoveryUnavailableBody')}
        </Notice>
        <Button
          title={t('backToSwap')}
          variant={ButtonVariant.Secondary}
          onClick={onBack}
          className="mt-5 w-full max-w-none"
        />
      </HomeGroupPaneBody>
    );
  }

  return (
    <OneClickFlow
      config={config}
      assets={assets}
      networks={networks}
      offerNetwork={offerNetwork}
      requestNetwork={requestNetwork}
      midenAddress={account.publicKey}
      initialRecovery={tracking}
      onBackToSwap={onBack}
    />
  );
};

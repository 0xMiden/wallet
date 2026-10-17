import React from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button } from 'components/Button';
import { Notice } from 'components/ui/Notice';
import { SectionHeader } from 'components/ui/SectionHeader';
import { usdcxArrivalKey } from 'lib/usdcx/constant';
import { RouteCard } from 'screens/send-flow/Route';

export interface EvmBridgeUsdcxRouteProps {
  confirmDisabled?: boolean;
  footerClassName?: string;
  notice?: string;
  fee?: string;
  sourceChainId: number;
  onConfirm: () => void;
}

export const EvmBridgeUsdcxRoute: React.FC<EvmBridgeUsdcxRouteProps> = ({
  confirmDisabled = false,
  notice,
  fee,
  sourceChainId,
  onConfirm
}) => {
  const { t } = useTranslation();
  return (
    <HomeGroupPaneBody
      top="header"
      footer={
        <Button
          title={t('continue')}
          accent="receive"
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="bridge-route-confirm"
          className="w-full max-w-none"
        />
      }
    >
      <SectionHeader size="lg">{t('bridgeChooseRoute')}</SectionHeader>
      <p className="mb-4 text-body-sm text-muted">{t('bridgeRouteDescription')}</p>
      <RouteCard
        emoji=""
        label={t('usdcxRouteName')}
        selected
        onSelect={() => undefined}
        fee={fee ?? t('noFee')}
        eta={t(usdcxArrivalKey(sourceChainId))}
        testId="bridge-route-usdcx"
        accent="receive"
      />
      <Notice variant="inline" className="mt-4">
        {notice ?? t('usdcxRouteNotice')}
      </Notice>
    </HomeGroupPaneBody>
  );
};

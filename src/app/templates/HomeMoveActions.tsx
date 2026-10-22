import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { isFeatureBlocked } from 'components/FeatureUnavailable';
import { CardButton } from 'components/ui/Card';
import { IconCircle } from 'components/ui/FactRow';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { isBridgeInOfferedOnNetwork, useBridgeInAvailability } from 'lib/usdcx/use-bridge-in-availability';
import { navigate } from 'lib/woozie';

interface MoveTileProps {
  icon: IconName;
  title: string;
  hint: string;
  /** The tint behind the glyph and the glyph's ink: Receive's green for money in, Send's blue for money out. */
  tone: string;
  onClick: () => void;
  disabled?: boolean;
  'data-testid': string;
}

const MoveTile: React.FC<MoveTileProps> = ({ icon, title, hint, tone, onClick, disabled, ...rest }) => (
  <CardButton
    surface="outline"
    padding="row"
    onClick={onClick}
    disabled={disabled}
    className="flex min-w-0 flex-1 items-center gap-3"
    data-testid={rest['data-testid']}
  >
    <IconCircle size="lg" className={tone}>
      <Icon name={icon} />
    </IconCircle>
    <span className="min-w-0 text-left">
      <span className="block truncate text-row-title font-extrabold text-ink">{title}</span>
      <span className="block truncate text-caption-heading text-muted">{hint}</span>
    </span>
  </CardButton>
);

/**
 * Money in and out of Miden, under the balance card: Deposit opens Bridge in, Withdraw opens Send, where a
 * recipient on another network takes the bridge-out route. Deposit follows the Receive page's Cross-chain tile: hidden
 * where the network configures no bridge-in route, greyed while the route is unavailable.
 */
export const HomeMoveActions: React.FC = () => {
  const { t } = useTranslation();
  const hasDocument = useBridgeConfigSnapshot().config !== null;
  const bridgeIn = useBridgeInAvailability({
    hold: availability => isBridgeInOfferedOnNetwork(hasDocument, availability)
  });
  const bridgeInOnNetwork = isBridgeInOfferedOnNetwork(hasDocument, bridgeIn);

  return (
    <div className="flex gap-2" data-testid="home-move-actions">
      {bridgeInOnNetwork && (
        <MoveTile
          icon={IconName.BridgeIn}
          title={t('homeDeposit')}
          hint={t('homeDepositHint')}
          tone="bg-accent-receive-tint text-accent-receive"
          onClick={() => navigate('/bridge/deposit')}
          disabled={isFeatureBlocked(bridgeIn)}
          data-testid="home-deposit"
        />
      )}
      <MoveTile
        icon={IconName.BridgeOut}
        title={t('withdraw')}
        hint={t('homeWithdrawHint')}
        tone="bg-accent-send-tint text-accent-send"
        onClick={() => navigate('/send')}
        data-testid="home-withdraw"
      />
    </div>
  );
};

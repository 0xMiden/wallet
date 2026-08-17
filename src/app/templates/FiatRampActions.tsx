import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { isFiatRampEnabled } from 'lib/feature-flags';
import { useAccount } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

/**
 * Buy (fiat on-ramp) button rendered under the home balance card. Hidden
 * entirely unless the build carries a MoonPay key AND the current account
 * has a derived EVM address (imported accounts don't).
 */
export const FiatRampActions: FC = () => {
  const { t } = useTranslation();
  const account = useAccount();

  if (!isFiatRampEnabled() || !account.evmAddress) return null;

  return (
    <div className="flex gap-2">
      <Button
        variant={ButtonVariant.Secondary}
        title={t('buy')}
        className="max-w-none flex-1"
        onClick={() => {
          hapticLight();
          navigate('/buy');
        }}
        data-testid="fiat-ramp-buy"
      />
    </div>
  );
};

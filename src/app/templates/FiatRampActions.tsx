import React, { FC, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { BuyInfoDrawer } from 'app/templates/BuyInfoDrawer';
import { Button, ButtonVariant } from 'components/Button';
import { isFiatRampEnabled } from 'lib/feature-flags';
import { useAccount } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

/**
 * Buy (fiat on-ramp) button rendered under the home balance card. Hidden
 * entirely unless the build carries a MoonPay key AND the current account
 * has a derived EVM address (imported accounts don't). Tapping Buy first
 * opens an explainer drawer; Continue navigates to the MoonPay checkout.
 */
export const FiatRampActions: FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const [infoOpen, setInfoOpen] = useState(false);

  if (!isFiatRampEnabled() || !account.evmAddress) return null;

  return (
    <div className="flex gap-2">
      <Button
        variant={ButtonVariant.Secondary}
        title={t('buy')}
        className="max-w-none flex-1"
        onClick={() => {
          hapticLight();
          setInfoOpen(true);
        }}
        data-testid="fiat-ramp-buy"
      />
      <BuyInfoDrawer
        open={infoOpen}
        onOpenChange={setInfoOpen}
        onContinue={() => {
          setInfoOpen(false);
          navigate('/buy');
        }}
      />
    </div>
  );
};

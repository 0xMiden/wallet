import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface BuyInfoDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
}

interface BuyInfoStep {
  icon: IconName;
  titleKey: string;
  bodyKey: string;
}

const STEPS: BuyInfoStep[] = [
  { icon: IconName.Globe, titleKey: 'buyInfoRedirectTitle', bodyKey: 'buyInfoRedirectBody' },
  { icon: IconName.Wallet, titleKey: 'buyInfoEvmTitle', bodyKey: 'buyInfoEvmBody' },
  { icon: IconName.CrossChain, titleKey: 'buyInfoBridgeTitle', bodyKey: 'buyInfoBridgeBody' }
];

/**
 * Pre-checkout explainer shown before opening the MoonPay checkout: the user
 * is redirected to MoonPay with their address pre-filled, funds land on a
 * client-side-derived EVM address first, then bridge to Miden via Agglayer.
 */
export const BuyInfoDrawer: React.FC<BuyInfoDrawerProps> = ({ open, onOpenChange, onContinue }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('buyInfoTitle')}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-col gap-5 px-4 pb-2">
          {STEPS.map(step => (
            <div key={step.titleKey} className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
                <Icon name={step.icon} size="sm" fill="currentColor" />
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-semibold text-text-primary-token">{t(step.titleKey)}</span>
                <span className="text-sm text-text-muted">{t(step.bodyKey)}</span>
              </div>
            </div>
          ))}
        </div>

        <DrawerFooter>
          <Button title={t('continue')} onClick={onContinue} data-testid="buy-info-continue" />
          <Button variant={ButtonVariant.Secondary} title={t('cancel')} onClick={() => onOpenChange(false)} />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};

export default BuyInfoDrawer;

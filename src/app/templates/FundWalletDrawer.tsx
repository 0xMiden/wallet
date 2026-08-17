import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export type FundWalletDrawerState = 'loading' | 'success' | 'error';

export interface FundWalletDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: FundWalletDrawerState;
  errorMessage?: string;
  onRetry: () => void;
  onDone: () => void;
}

/**
 * Presentational funding drawer for the "Fund now" prompt. It is deliberately
 * DUMB — it renders whatever `state` it's handed (loading / success / error)
 * and reports intent back through `onRetry` / `onDone`; the faucet call itself
 * lives in the parent. On error it surfaces the ACTUAL failure message (with a
 * generic fallback) in a copyable, live-announced region plus a Retry action.
 */
export const FundWalletDrawer: React.FC<FundWalletDrawerProps> = ({
  open,
  onOpenChange,
  state,
  errorMessage,
  onRetry,
  onDone
}) => {
  const { t } = useTranslation();

  const title =
    state === 'loading'
      ? t('fundWalletLoadingTitle')
      : state === 'success'
        ? t('fundWalletSuccessTitle')
        : t('fundWalletErrorTitle');

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
        </DrawerHeader>

        <div
          role={state === 'error' ? 'alert' : 'status'}
          aria-live={state === 'error' ? 'assertive' : 'polite'}
          className="flex flex-col items-center gap-4 px-4 pb-2 text-center"
        >
          {state === 'loading' && (
            <span className="text-accent-primary">
              <Icon name={IconName.Loader} size="xl" className="animate-spin" fill="currentColor" />
            </span>
          )}
          {state === 'success' && (
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-status-positive/15 text-status-positive">
              <Icon name={IconName.Checkmark} size="md" fill="currentColor" />
            </span>
          )}
          {state === 'error' && (
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-status-negative/15 text-status-negative">
              <Icon name={IconName.Close} size="md" fill="currentColor" />
            </span>
          )}

          {state === 'loading' && <p className="text-sm text-text-muted">{t('fundWalletLoadingBody')}</p>}
          {state === 'success' && <p className="text-sm text-text-muted">{t('fundWalletSuccessBody')}</p>}
          {state === 'error' && (
            <p className="select-text text-sm text-text-muted">{errorMessage ?? t('fundWalletErrorBody')}</p>
          )}
        </div>

        {state !== 'loading' && (
          <DrawerFooter>
            {state === 'success' ? (
              <Button title={t('done')} onClick={onDone} />
            ) : (
              <>
                <Button title={t('retry')} onClick={onRetry} />
                <Button variant={ButtonVariant.Secondary} title={t('close')} onClick={onDone} />
              </>
            )}
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  );
};

export default FundWalletDrawer;

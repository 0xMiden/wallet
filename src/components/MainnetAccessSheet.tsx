import React, { FC, FormEvent, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useHideForegroundDappWhileOpen } from 'app/providers/DappBrowserProvider';
import { Button } from 'components/Button';
import { CodeInput } from 'components/ui/CodeInput';
import { ErrorLine } from 'components/ui/ErrorLine';
import { MAINNET_ACCESS_CODE_LENGTH, MainnetAccessOutcome } from 'lib/mainnet-access';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface MainnetAccessSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Checks the code. The sheet closes on `granted` and shows a refusal on `rejected`. */
  onSubmit: (code: string) => Promise<MainnetAccessOutcome>;
}

/** Why the last try did not open mainnet: the code was refused, or the check did not complete. */
type Failure = 'rejected' | 'unchecked';

/**
 * The mainnet access sheet: mainnet is invite-only, and the user types the 8-digit access code here.
 * The caller owns `open` and the check of the code. The sheet renders nothing on mainnet.
 */
export const MainnetAccessSheet: FC<MainnetAccessSheetProps> = ({ open, onOpenChange, onSubmit }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A sheet that opens again starts empty.
  useEffect(() => {
    if (open) return;
    setCode('');
    setFailure(null);
  }, [open]);

  // The native window of a foreground dApp is above the host WebView and hides the sheet. The
  // provider hides that window while the sheet is open.
  useHideForegroundDappWhileOpen(open);

  const networkKey = getTestNetworkNameKey();
  if (!networkKey) return null;

  const complete = code.length === MAINNET_ACCESS_CODE_LENGTH;

  // Literal keys, so the key-coverage test can find them.
  const failureMessage = (): string | null => {
    switch (failure) {
      case 'rejected':
        return t('mainnetAccessCodeRejected');
      case 'unchecked':
        return t('mainnetAccessCheckFailed');
      case null:
        return null;
    }
  };

  const changeCode = (next: string) => {
    setCode(next);
    setFailure(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!complete || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const outcome = await onSubmit(code);
      switch (outcome) {
        case 'granted':
          onOpenChange(false);
          break;
        case 'rejected':
          setFailure('rejected');
          break;
      }
    } catch {
      setFailure('unchecked');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="mainnet-access">
      {/* The code field takes no focus when the sheet opens. The user taps the field to type. */}
      <DrawerContent>
        <form onSubmit={submit} className="flex min-h-0 flex-col" data-testid="mainnet-access-sheet">
          <DrawerHeader>
            <DrawerTitle>{t('switchToMainnet')}</DrawerTitle>
          </DrawerHeader>
          <DrawerDescription>{t('mainnetAccessDescription')}</DrawerDescription>
          <div className="flex flex-col gap-2 px-4 pt-2 pb-6">
            <CodeInput
              value={code}
              onChange={changeCode}
              length={MAINNET_ACCESS_CODE_LENGTH}
              label={t('mainnetAccessCodeLabel')}
              invalid={failure !== null}
              disabled={submitting}
              data-testid="mainnet-access-code"
            />
            <ErrorLine data-testid="mainnet-access-error">{failureMessage()}</ErrorLine>
          </div>
          {/* The shared Button fires its own tap haptic. */}
          <DrawerFooter className="shrink-0 items-center gap-3 pt-0">
            <Button
              type="submit"
              title={t('unlockMainnet')}
              disabled={!complete}
              isLoading={submitting}
              className="w-full"
              data-testid="mainnet-access-cta"
            />
            <p className="text-center text-body-sm text-muted">
              {t('mainnetAccessNoCode', { network: t(networkKey) })}
            </p>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
};

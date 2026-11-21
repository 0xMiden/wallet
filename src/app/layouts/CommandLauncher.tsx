import React, { ReactElement, useId, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { openCommandHome, useAppEnv, WindowType } from 'app/env';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/ui/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { isExtension } from 'lib/platform';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

export default function CommandLauncher({ inBalanceCard = false }: { inBalanceCard?: boolean }): ReactElement | null {
  const { t } = useTranslation();
  const { popup, sidePanel, confirmWindow } = useAppEnv();
  const { config } = useBridgeConfigSnapshot({ load: false });
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const descriptionId = useId();

  if (!isExtension() || confirmWindow || (!popup && !sidePanel)) return null;
  if (sidePanel && config?.features.openFullscreen === false) return null;

  const open = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(false);
    try {
      await openCommandHome(sidePanel ? WindowType.SidePanel : WindowType.Popup);
    } catch {
      setError(true);
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };

  return (
    <div className={inBalanceCard ? 'min-w-0' : 'shrink-0 px-4 py-2'}>
      <Button
        variant={ButtonVariant.Launcher}
        className={inBalanceCard ? 'w-12 px-0' : undefined}
        isLoading={opening}
        aria-label={t('commandOpenFullscreen')}
        aria-describedby={descriptionId}
        onClick={open}
      >
        <Icon name={IconName.Fullscreen} className="h-5 w-5 shrink-0" fill="currentColor" aria-hidden="true" />
      </Button>
      <span id={descriptionId} className="sr-only">
        {t('commandFullscreenNewTab')}
      </span>
      <ErrorLine errorId="commandFullscreenOpenFailed">{error && t('commandFullscreenOpenFailed')}</ErrorLine>
    </div>
  );
}

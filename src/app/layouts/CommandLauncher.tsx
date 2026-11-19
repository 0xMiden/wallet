import React, { ReactElement, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { openCommandHome, useAppEnv, WindowType } from 'app/env';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/ui/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { isExtension } from 'lib/platform';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

export default function CommandLauncher(): ReactElement | null {
  const { t } = useTranslation();
  const { popup, sidePanel, confirmWindow } = useAppEnv();
  const { config } = useBridgeConfigSnapshot({ load: false });
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);

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
    <div className="shrink-0 px-4 py-2">
      <Button
        variant={ButtonVariant.Launcher}
        isLoading={opening}
        aria-describedby="command-fullscreen-new-tab-description"
        onClick={open}
      >
        <Icon name={IconName.Fullscreen} className="h-5 w-5" fill="currentColor" aria-hidden="true" />
        <span>{t('commandOpenFullscreen')}</span>
      </Button>
      <span id="command-fullscreen-new-tab-description" className="sr-only">
        {t('commandFullscreenNewTab')}
      </span>
      <ErrorLine errorId="commandFullscreenOpenFailed">{error && t('commandFullscreenOpenFailed')}</ErrorLine>
    </div>
  );
}

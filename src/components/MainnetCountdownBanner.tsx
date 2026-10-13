import React, { FC, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { MAINNET_EARLY_ACCESS_URL } from 'app/constants';
import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { TextAction } from 'components/ui/TextAction';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * The time left until `launchAt` as `DD:HH:MM:SS`, whole seconds, and `null` once it has passed.
 * Days are not capped at two digits, so a far-off date still reads in full.
 */
export function formatCountdown(now: number, launchAt: number): string | null {
  const remaining = launchAt - now;
  if (remaining <= 0) return null;
  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((remaining % MINUTE_MS) / SECOND_MS);
  return [pad2(days), pad2(hours), pad2(minutes), pad2(seconds)].join(':');
}

/**
 * The strip above every page of the open wallet: the Bread mark, a live `DD:HH:MM:SS` countdown
 * to the mainnet launch, and a link to the early-access list. The network's remote config drives
 * it (`mainnetCountdown`, 0xMiden/wallet-config): the banner shows while the switch is on and the
 * launch moment is set and still ahead, and renders nothing otherwise, so flipping the switch or
 * the moment there reaches every wallet within about an hour. The clock ticks once a second while a
 * countdown is set; the banner mounts outside every page-active provider, so it has no on-screen
 * signal to gate on.
 */
export const MainnetCountdownBanner: FC = () => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  const config = useBridgeConfigSnapshot().config?.mainnetCountdown;
  const launchAt = config?.enabled ? config.launchAt : undefined;
  const countdown = launchAt === undefined ? null : formatCountdown(now, launchAt);
  const ticking = countdown !== null;

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const intervalId = setInterval(() => setNow(Date.now()), SECOND_MS);
    return () => clearInterval(intervalId);
  }, [ticking]);

  if (countdown === null) return null;

  const openEarlyAccess = () => {
    openExternalUrl({ url: MAINNET_EARLY_ACCESS_URL, title: t('mainnetCountdownLink') }).catch(() => {});
  };

  return (
    <div
      className="flex w-full shrink-0 items-center justify-center gap-2 border-b border-dashed border-accent-tint-ink/30 bg-accent-tint px-4 py-1"
      data-testid="mainnet-countdown-banner"
    >
      <BreadLogo aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
      <div className="flex items-center gap-2">
        <time
          className="text-value font-extrabold tracking-[0.06em] tabular-nums text-accent-tint-ink"
          aria-label={t('mainnetCountdownLabel', { time: countdown })}
          data-testid="mainnet-countdown"
        >
          {countdown}
        </time>
        <span aria-hidden="true" className="size-[3px] shrink-0 rounded-full bg-accent-tint-ink opacity-50" />
        <TextAction onClick={openEarlyAccess} data-testid="mainnet-countdown-link">
          {t('mainnetCountdownLink')}
        </TextAction>
      </div>
    </div>
  );
};

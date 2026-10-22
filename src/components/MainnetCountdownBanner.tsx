import React, { FC, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { MAINNET_EARLY_ACCESS_URL } from 'app/constants';
import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { MainnetSwitchSheet } from 'components/MainnetSwitchSheet';
import { TextAction } from 'components/ui/TextAction';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useMainnetLaunchNow } from 'lib/remote-config/use-mainnet-launch';
import { selectMainnetLaunchAt } from 'lib/remote-config/values';

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
 * The strip above every page of the open wallet: the Bread mark and, before the mainnet launch, a live
 * `DD:HH:MM:SS` countdown to it with a link to the early-access list; from the launch moment on, the
 * switch to mainnet. The network's remote config drives it (`mainnetCountdown`, 0xMiden/wallet-config):
 * the banner shows on a test network while the switch is on and the launch moment is set, and renders
 * nothing otherwise (so never on mainnet), so flipping the switch or the moment there reaches every
 * wallet within about an hour. The clock ticks once a second while a countdown is set, and the tick
 * that reaches the moment turns the countdown into the switch; the banner mounts outside every
 * page-active provider, so it has no on-screen signal to gate on.
 */
export const MainnetCountdownBanner: FC = () => {
  const { t } = useTranslation();
  const snapshot = useBridgeConfigSnapshot();
  // A wallet on mainnet has nothing to count down to, and nothing to switch to. The effective network
  // decides, so a Developer Settings override to mainnet hides the banner too.
  const onTestNetwork = getTestNetworkNameKey() !== null;
  const launchAt = onTestNetwork ? selectMainnetLaunchAt(snapshot) : null;
  const now = useMainnetLaunchNow(launchAt);
  const countdown = launchAt === null ? null : formatCountdown(now, launchAt);

  if (launchAt === null) return null;
  if (countdown === null) return <MainnetSwitchBanner />;

  const openEarlyAccess = () => {
    openExternalUrl({ url: MAINNET_EARLY_ACCESS_URL, title: t('mainnetCountdownLink') }).catch(() => {});
  };

  return (
    <BannerFrame testId="mainnet-countdown-banner">
      <div className="flex items-center gap-2">
        <time
          className="text-value font-extrabold tracking-[0.06em] tabular-nums text-accent-tint-ink"
          aria-label={t('mainnetCountdownLabel', { time: countdown })}
          data-testid="mainnet-countdown"
        >
          {countdown}
        </time>
        <span aria-hidden="true" className="size-[3px] shrink-0 rounded-full bg-accent-tint-ink opacity-50" />
        <TextAction
          onClick={openEarlyAccess}
          className="underline decoration-1 underline-offset-[3px]"
          data-testid="mainnet-countdown-link"
        >
          {t('mainnetCountdownLink')}
        </TextAction>
      </div>
    </BannerFrame>
  );
};

const BannerFrame: FC<{ testId: string; children: React.ReactNode }> = ({ testId, children }) => (
  <div
    className="flex w-full shrink-0 items-center justify-center gap-2 border-b border-dashed border-accent-tint-ink/30 bg-accent-tint px-4"
    data-testid={testId}
  >
    <BreadLogo aria-hidden="true" className="h-6 w-6 shrink-0" />
    {children}
  </div>
);

// Asks for the code before anything else: the sheet wipes the wallet only for a code mainnet accepted.
const MainnetSwitchBanner: FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <BannerFrame testId="mainnet-switch-banner">
      <TextAction
        onClick={() => setOpen(true)}
        className="text-title-section underline decoration-1 underline-offset-[3px]"
        data-testid="mainnet-switch-link"
      >
        {t('mainnetAccessTitle')}
      </TextAction>
      <MainnetSwitchSheet open={open} onOpenChange={setOpen} />
    </BannerFrame>
  );
};

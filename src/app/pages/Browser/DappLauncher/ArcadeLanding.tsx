import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/ui/Button';
import { Card } from 'components/ui/Card';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { EmptyState } from 'components/ui/EmptyState';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { PromptCarousel } from 'components/ui/PromptCarousel';
import { SectionHeader } from 'components/ui/SectionHeader';
import { ARCADE_ACTIVITY_PATH, ARCADE_COINS_PATH, arcadeDiscovery } from 'lib/arcade';
import type { ExploreItem, ExploreView } from 'lib/dapp-browser';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { navigate } from 'lib/woozie';

import { AppIcon, appTint } from './AppIcon';
import { AppList } from './AppRow';

const GameCard: React.FC<{ item: ExploreItem; onOpen: (url: string) => void; onDetails: () => void }> = ({
  item,
  onOpen,
  onDetails
}) => {
  const { t } = useTranslation();
  return (
    <Card padding="none" className="overflow-hidden" data-testid="arcade-featured-game">
      <div
        className="flex h-40 items-center justify-center"
        style={{ backgroundColor: item.brandColor ?? appTint(item.url) }}
      >
        <AppIcon url={item.url} name={item.name} icon={item.icon} size="hero" surface="fill" />
      </div>
      <div className="p-4">
        <h3 className="text-title-section text-ink">{item.name}</h3>
        <p className="line-clamp-2 text-body-sm text-muted">{item.tagline}</p>
        <p className="mt-2 text-caption text-muted">{t('arcadePostingPolicy')}</p>
      </div>
      {/* Same foot as Activity's pending card: edge-to-edge actions under a hairline, square-cornered,
        the card's rounded clip shaping the outer corners. */}
      <div className="flex border-t border-hairline">
        <Button
          size="sm"
          variant={ButtonVariant.Ghost}
          onClick={onDetails}
          className="h-12 w-2/5 whitespace-nowrap rounded-none border-0"
        >
          {t('arcadeDetails')}
        </Button>
        <Button
          size="sm"
          onClick={() => onOpen(item.url)}
          className="h-12 min-w-0 flex-1 rounded-none"
          data-testid="arcade-open-game"
        >
          {t('arcadeOpenGame')}
        </Button>
      </div>
    </Card>
  );
};

export const ArcadeLanding: React.FC<{ catalog: ExploreView; pending: boolean; onOpen: (url: string) => void }> = ({
  catalog,
  pending,
  onOpen
}) => {
  const { t } = useTranslation();
  const { games, featured } = arcadeDiscovery(catalog);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  // Resolve against current data: a network change or delisting cannot leave an old game launchable.
  const details = games.find(game => game.id === detailsId);
  const openGame = (url: string) => {
    setDetailsId(null);
    onOpen(url);
  };
  return (
    <div className="flex flex-col gap-5 px-4" data-testid="arcade-landing">
      {featured.length > 0 && (
        <section aria-label={t('arcadeFeatured')} data-testid="arcade-featured">
          <SectionHeader size="xl" className="px-0 pb-3">
            {t('arcadeFeatured')}
          </SectionHeader>
          <PromptCarousel>
            {featured.map(item => (
              <GameCard key={item.id} item={item} onOpen={openGame} onDetails={() => setDetailsId(item.id)} />
            ))}
          </PromptCarousel>
        </section>
      )}
      <nav aria-label={t('arcadeQuickActions')} className="flex gap-2" data-testid="arcade-quick-actions">
        {[
          { icon: IconName.Coins, label: t('arcadeCoinsShort'), path: ARCADE_COINS_PATH },
          { icon: IconName.Activity, label: t('arcadeActivityShort'), path: ARCADE_ACTIVITY_PATH }
        ].map(action => (
          <Pill
            key={action.path}
            icon={<Icon name={action.icon} size="sm" className="text-accent-tint-ink" />}
            size="lg"
            onClick={() => navigate(action.path)}
            className="min-w-0 flex-1 justify-center"
          >
            {action.label}
          </Pill>
        ))}
      </nav>
      <section aria-label={t('arcadeGamesToTry')} data-testid="arcade-game-list">
        <SectionHeader size="xl" className="px-0 pb-3">
          {t('arcadeGamesToTry')}
        </SectionHeader>
        {pending ? (
          <p role="status" className="text-body-sm text-muted">
            {t('loading')}
          </p>
        ) : games.length > 0 ? (
          <AppList items={games} onOpen={url => setDetailsId(games.find(game => game.url === url)?.id ?? null)} />
        ) : (
          <EmptyState icon={IconName.Rocket} title={t('arcadeNoGames')} description={t('arcadeNoGamesDescription')} />
        )}
      </section>
      <Drawer
        open={Boolean(details)}
        onOpenChange={open => {
          if (!open) setDetailsId(null);
        }}
        screenKey="arcade-game"
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{details?.name}</DrawerTitle>
          </DrawerHeader>
          <DrawerDescription>{details?.tagline}</DrawerDescription>
          {details && (
            <div className="flex flex-col gap-3 px-4 pb-4">
              <Notice variant="inline">{t('arcadePostingPolicy')}</Notice>
              <DetailCard>
                <DetailRow label={t('website')}>{new URL(details.url).hostname}</DetailRow>
              </DetailCard>
              <Notice variant="inline" icon={<Icon name={IconName.ShieldCheck} size="sm" fill="currentColor" />}>
                {t('arcadeOpeningNotice')}
              </Notice>
            </div>
          )}
          <DrawerFooter>
            <Button
              className="mx-auto"
              onClick={() => {
                if (details) openGame(details.url);
              }}
            >
              {t('arcadeOpenGame')}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
};

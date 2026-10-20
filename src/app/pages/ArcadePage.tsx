import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Icon, IconName } from 'app/icons/v2';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { Avatar } from 'components/ui/Avatar';
import { Button, ButtonVariant } from 'components/ui/Button';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { EmptyState } from 'components/ui/EmptyState';
import { Hero } from 'components/ui/Hero';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextAction } from 'components/ui/TextAction';
import { ARCADE_ACTIVITY_PATH, ARCADE_COINS_PATH, ARCADE_PATH, ARCADE_RANKINGS_PATH } from 'lib/arcade';
import { useAccount } from 'lib/miden/front';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { HistoryAction, navigate, useLocation } from 'lib/woozie';

// Design fixtures only. Never passed to wallet storage, asset readers, signing or a service.
const SAMPLE_BALANCE = 7850;
const SAMPLE_SUBMITTED_BALANCE = 7250;
const SAMPLE_PLAYERS = [
  { id: 'juniper', name: 'Juniper', balance: 12400 },
  { id: 'orbit', name: 'Orbit', balance: 9600 },
  { id: 'mochi', name: 'Mochi', balance: 7500 },
  { id: 'you', name: '', balance: SAMPLE_SUBMITTED_BALANCE },
  { id: 'nori', name: 'Nori', balance: 4800 }
];

/** Native destinations with an opt-in development-only design preview, never simulated wallet funds. */
export const ArcadePage: React.FC<{ page: 'rankings' | 'coins' }> = ({ page }) => {
  const { t, i18n } = useTranslation();
  const account = useAccount();
  const network = getEffectiveNetworkName();
  const { search } = useLocation();
  const previewAvailable = process.env.MODE_ENV === 'development';
  const preview = previewAvailable && new URLSearchParams(search).get('preview') === 'sample';
  const back = useBackWithFallback(ARCADE_PATH);
  const [review, setReview] = useState(false);
  const [sampleUpdated, setSampleUpdated] = useState(false);
  const onBack = () => (review ? setReview(false) : back());
  useMobileBackHandler(() => {
    if (!review) return false;
    setReview(false);
    return true;
  }, [review]);
  const rankings = page === 'rankings';
  const format = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { maximumFractionDigits: 0 });
  const formatGC = (value: number) => format.format(value) + ' GC';
  const formatRank = (value: number) => '#' + format.format(value);
  const submittedBalance = sampleUpdated ? SAMPLE_BALANCE : SAMPLE_SUBMITTED_BALANCE;
  const players = preview
    ? SAMPLE_PLAYERS.map(player => (player.id === 'you' ? { ...player, balance: submittedBalance } : player)).sort(
        (a, b) => b.balance - a.balance
      )
    : [];
  const rank = players.findIndex(player => player.id === 'you') + 1;
  const rankingsPath = ARCADE_RANKINGS_PATH + (preview ? '?preview=sample' : '');
  const togglePreview = () => {
    setReview(false);
    setSampleUpdated(false);
    navigate(
      { pathname: rankings ? ARCADE_RANKINGS_PATH : ARCADE_COINS_PATH, search: preview ? '' : '?preview=sample' },
      HistoryAction.Replace
    );
  };
  const applySample = () => {
    // This handler has no async work, wallet calls, persistence, or network transport.
    setSampleUpdated(true);
    setReview(false);
  };

  return (
    <SubPageLayout
      title={t(review ? 'arcadeReviewBalance' : rankings ? 'arcadeRankings' : 'arcadeCoins')}
      onBack={onBack}
      focusTitleOnMount
      data-testid={`arcade-${page}-page`}
      headerActions={
        previewAvailable ? (
          <TextAction onClick={togglePreview}>{t(preview ? 'arcadeExitPreview' : 'arcadePreview')}</TextAction>
        ) : undefined
      }
      footerLayout="stack"
      footer={
        review ? (
          <Button disabled={!preview} onClick={preview ? applySample : undefined}>
            {t(preview ? 'arcadeApplySample' : 'arcadeSubmitBalance')}
          </Button>
        ) : !preview ? (
          // Nothing to act on until GC is live: the privacy line, then the one useful next step.
          <>
            <Notice
              variant="inline"
              icon={<Icon name={IconName.ShieldCheck} size="sm" fill="currentColor" />}
              className="justify-center"
            >
              {t(rankings ? 'arcadeRankingsPrivate' : 'arcadeBalancePrivate')}
            </Notice>
            <Button onClick={() => navigate(ARCADE_PATH)} data-testid="arcade-browse-games">
              {t('arcadeBrowseGames')}
            </Button>
          </>
        ) : (
          <>
            {rankings ? (
              <Button onClick={() => setReview(true)} data-testid="arcade-update-balance">
                {t('arcadeUpdateBalance')}
              </Button>
            ) : (
              <Button onClick={() => navigate(rankingsPath)}>{t('arcadeGCRankings')}</Button>
            )}
            <Button variant={ButtonVariant.Secondary} onClick={() => navigate(ARCADE_ACTIVITY_PATH)}>
              {t('arcadeMyActivity')}
            </Button>
          </>
        )
      }
    >
      {preview && (
        <Notice tone="warning" data-testid="arcade-sample-notice">
          {t('arcadeSampleNotice')}
        </Notice>
      )}
      {review ? (
        <>
          <Notice tone="warning">{t('arcadeBalanceDisclosure')}</Notice>
          <DetailCard>
            <DetailRow label={t('account')} stacked>
              {preview ? t('arcadeSamplePlayer') : account.publicKey}
            </DetailRow>
            <DetailRow label={t('network')}>{preview ? t('arcadePreviewOnly') : network}</DetailRow>
            <DetailRow label={t('arcadeGCBalance')}>
              {preview ? formatGC(SAMPLE_BALANCE) : t('arcadeNotRead')}
            </DetailRow>
          </DetailCard>
          {!preview && <Notice role="status">{t('arcadeConnectionRequired')}</Notice>}
        </>
      ) : preview ? (
        <>
          <Hero
            visual={
              rankings ? null : (
                <Avatar
                  size={88}
                  color="var(--ds-fill)"
                  icon={<Icon name={IconName.Coins} size="lg" className="text-accent-tint-ink" />}
                />
              )
            }
            value={
              <AnimatedNumber value={rankings ? rank : SAMPLE_BALANCE} format={rankings ? formatRank : formatGC} />
            }
            subtitle={t(rankings ? 'arcadeYourRank' : 'arcadeGCBalance')}
            data-testid="arcade-sample-hero"
          />
          <DetailCard>
            <DetailRow label={t('arcadeSubmittedBalance')}>
              <AnimatedNumber value={submittedBalance} format={formatGC} />
            </DetailRow>
            {!rankings && <DetailRow label={t('arcadeYourRank')}>{formatRank(rank)}</DetailRow>}
          </DetailCard>
          {rankings && (
            <SubPageSection title={t('arcadeLeaderboard')}>
              <ListGroup surface="outline" data-testid="arcade-sample-leaderboard">
                {players.map((player, index) => (
                  <ListRow
                    key={player.id}
                    title={player.id === 'you' ? t('you') : player.name}
                    avatar={
                      <Pill size="sm" tone={player.id === 'you' ? 'selected' : 'neutral'}>
                        {formatRank(index + 1)}
                      </Pill>
                    }
                    value={<AnimatedNumber className="text-value text-ink" value={player.balance} format={formatGC} />}
                    data-testid={`arcade-sample-player-${player.id}`}
                  />
                ))}
              </ListGroup>
            </SubPageSection>
          )}
          {sampleUpdated && <Notice role="status">{t('arcadeSampleUpdated')}</Notice>}
        </>
      ) : (
        // The slot the leaderboard or the balance will fill once GC is live: dashed, not a filled card.
        <EmptyState
          surface="dashed"
          icon={rankings ? IconName.Users : IconName.Coins}
          title={t(rankings ? 'arcadeRankingsUnavailable' : 'arcadeCoinsUnavailable')}
          description={t(rankings ? 'arcadeRankingsDescription' : 'arcadeCoinsDescription')}
        />
      )}
    </SubPageLayout>
  );
};

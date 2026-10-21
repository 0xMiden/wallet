import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ArcadeAllowanceCard, ArcadeGameCatalog } from '../../src/app/pages/Browser/DappLauncher/ArcadeView';
import { TabRootHeader } from '../../src/components/ui/TabRootHeader';
import en from '../../public/_locales/en/en.json';
import '../../src/main.css';

const params = new URLSearchParams(location.search);
const state = params.get('state');
const dark = params.get('theme') === 'dark';
document.documentElement.classList.toggle('dark', dark);
await i18next
  .use(initReactI18next)
  .init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { prefix: '$', suffix: '$', escapeValue: false }
  });
const snapshot =
  state === 'claimed'
    ? { status: { kind: 'claimed' as const, nextEligibleAt: '2026-10-26T00:00:00Z' }, balance: '18' }
    : state === 'eligible'
      ? { status: { kind: 'eligible' as const }, balance: '8' }
      : { status: { kind: 'unavailable' as const }, balance: null };
createRoot(document.getElementById('root')!).render(
  <div className="bg-page text-ink min-h-screen pb-6">
    <div className="bg-accent-tint text-accent-tint-ink text-caption px-4 py-2">
      Review fixture · fictional balance, eligibility and game
    </div>
    <TabRootHeader
      title="Explore"
      filter={{
        items: [
          { id: 'all', label: 'All' },
          { id: 'finance', label: 'Finance' },
          { id: 'arcade', label: 'Arcade' },
          { id: 'others', label: 'Others' }
        ],
        value: 'arcade',
        onChange: () => {},
        'aria-label': 'Categories'
      }}
    />
    <main className="flex flex-col gap-6 px-4 pt-4">
      <ArcadeAllowanceCard
        snapshot={snapshot}
        busy={false}
        networkName="Partner Mainnet"
        onClaim={() => {}}
        onRefresh={() => {}}
      />
      <ArcadeGameCatalog
        pending={false}
        onOpen={() => {}}
        games={[
          {
            id: 'fixture-game',
            name: 'Bread Quest',
            tagline: 'Find your path through a new puzzle. Your results and rankings live in the game.',
            category: 'games',
            url: 'https://fixture.example/',
            isExchange: false
          }
        ]}
      />
    </main>
  </div>
);

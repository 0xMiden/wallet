import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ArcadePage } from '../../src/app/pages/ArcadePage';
import { ArcadeLanding } from '../../src/app/pages/Browser/DappLauncher/ArcadeLanding';
import { TabRootHeader } from '../../src/components/ui/TabRootHeader';
import en from '../../public/_locales/en/en.json';
import '../../src/main.css';

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
await i18next.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { prefix: '$', suffix: '$', escapeValue: false }
});
createRoot(document.getElementById('root')!).render(
  <div className="bg-page text-ink h-screen flex flex-col">
    <div className="bg-accent-tint text-accent-tint-ink text-caption px-4 py-2">
      Review fixture · fictional balance, eligibility and game
    </div>
    {params.get('page') === 'coins' ? (
      <ArcadePage />
    ) : (
      <>
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
        <main className="pt-2">
          <ArcadeLanding
            pending={false}
            onOpen={url => {
              document.body.dataset.openedGame = url;
            }}
            catalog={{
              items: [
                {
                  id: 'fixture-game',
                  name: 'Bread Quest',
                  tagline: 'Find your path through a new puzzle.',
                  category: 'arcade',
                  url: 'https://fixture.example/',
                  isExchange: false
                }
              ],
              sections: [{ id: 'featured', kind: 'featured', title: 'Featured', itemIds: ['fixture-game'] }]
            }}
          />
        </main>
      </>
    )}
  </div>
);

import React from 'react';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { MotionConfig } from 'framer-motion';
import Me from '../../src/app/pages/Me';
import MyBadges from '../../src/app/pages/MyBadges';
import { BottomNav } from '../../src/components/ui/BottomNav';
import { Icon, IconName } from '../../src/app/icons/v2';
import english from '../../public/_locales/en/en.json';
import '../../src/main.css';
import { navigate, useLocation } from './router';
import { initializeBadgeFixture } from './issuance-fixture';
await initializeBadgeFixture();

await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: english } },
  interpolation: { escapeValue: false, prefix: '$', suffix: '$' }
});
document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).get('theme') === 'dark');
const items = [
  { id: 'home', label: 'Home', icon: IconName.Home },
  { id: 'explore', label: 'Explore', icon: IconName.Explore },
  { id: 'activity', label: 'Activity', icon: IconName.Activity },
  { id: 'profile', label: 'Profile', icon: IconName.User }
].map(item => ({ ...item, icon: <Icon name={item.icon} fill="currentColor" /> }));
function Preview() {
  const { pathname } = useLocation();
  return (
    <MotionConfig reducedMotion="user">
      <div className="qa-shell">
        {pathname === '/me' ? (
          <Me />
        ) : pathname === '/me/badges' ? (
          <MyBadges />
        ) : (
          <div data-testid="route-destination">{pathname}</div>
        )}
        {pathname === '/me' && (
          <div className="qa-nav">
            <BottomNav items={items} activeId="profile" onChange={id => navigate(id === 'profile' ? '/me' : '/')} />
          </div>
        )}
      </div>
    </MotionConfig>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);

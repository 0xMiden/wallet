import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';

import '../../../src/i18n';
import '../../../src/main.css';
import { useActivityClaims } from '../../../src/app/hooks/useActivityClaims';
import { PendingActivityCard } from '../../../src/app/templates/history/PendingActivityCard';

if (new URLSearchParams(location.search).has('dark')) document.documentElement.classList.add('dark');

function Fixture() {
  const { items, accept, retryHeld } = useActivityClaims();
  return (
    <main className="flex min-h-screen flex-col gap-3 bg-app-bg p-4 text-ink">
      <h1 className="font-heading text-xl font-bold">Activity</h1>
      {items.map(item => (
        <PendingActivityCard key={item.note.id} item={item} onAccept={accept} onRetryHeld={retryHeld} initiallyExpanded />
      ))}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <Fixture />
  </MotionConfig>
);

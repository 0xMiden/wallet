import { useSyncExternalStore } from 'react';

/**
 * The Home page nearest the pager's scroll position while the user swipes, before the swipe settles
 * and navigates. The action bar shows it, so its pill moves with the swipe instead of after the
 * page lands (the settle waits for `scrollend`, or for an idle check on iOS). Null when no swipe is in
 * progress: the route then names the page.
 */
let previewId: string | null = null;
const listeners = new Set<() => void>();

export function setHomePagerPreview(id: string | null): void {
  if (previewId === id) return;
  previewId = id;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string | null {
  return previewId;
}

export function useHomePagerPreview(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

import { useEffect, useRef } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { usePromptSlideActive } from 'components/ui/prompt-slide-active';

import { reportUserVisibleError, UserErrorId, UserErrorSurface } from './user-visible-error';

export function useUserVisibleError(
  id: UserErrorId | null | undefined,
  surface: UserErrorSurface,
  occurrence?: object
): void {
  const pageActive = usePageActive();
  const slideActive = usePromptSlideActive();
  const active = pageActive && slideActive;
  const episode = useRef({ id, surface, occurrence, reported: false });

  useEffect(() => {
    if (episode.current.id !== id || episode.current.surface !== surface || episode.current.occurrence !== occurrence) {
      episode.current = { id, surface, occurrence, reported: false };
    }
    const current = episode.current;
    if (!id || !active || current.reported) return undefined;
    const timer = setTimeout(() => {
      current.reported = true;
      reportUserVisibleError(id, surface);
    }, 1000);
    return () => clearTimeout(timer);
  }, [id, surface, occurrence, active]);
}

import { useEffect, useRef } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { usePromptSlideActive } from 'components/ui/prompt-slide-active';

import { reportUserVisibleError, UserErrorDiagnostics, UserErrorId, UserErrorSurface } from './user-visible-error';

export function useUserVisibleError(
  id: UserErrorId | null | undefined,
  surface: UserErrorSurface,
  occurrence?: object,
  diagnostics?: UserErrorDiagnostics
): void {
  const pageActive = usePageActive();
  const slideActive = usePromptSlideActive();
  const active = pageActive && slideActive;
  const episode = useRef({ id, surface, occurrence, reported: false });
  // Outside the effect's dependencies: a new diagnostics object on each render must not restart the dwell.
  const latestDiagnostics = useRef(diagnostics);
  latestDiagnostics.current = diagnostics;

  useEffect(() => {
    if (episode.current.id !== id || episode.current.surface !== surface || episode.current.occurrence !== occurrence) {
      episode.current = { id, surface, occurrence, reported: false };
    }
    const current = episode.current;
    if (!id || !active || current.reported) return undefined;
    const timer = setTimeout(() => {
      current.reported = true;
      const reported = latestDiagnostics.current;
      if (reported === undefined) reportUserVisibleError(id, surface);
      else reportUserVisibleError(id, surface, reported);
    }, 1000);
    return () => clearTimeout(timer);
  }, [id, surface, occurrence, active]);
}

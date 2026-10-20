import { useEffect } from 'react';

import { reportUserVisibleError, UserErrorId, UserErrorSurface } from './user-visible-error';

export function useUserVisibleError(
  id: UserErrorId | null | undefined,
  surface: UserErrorSurface,
  occurrence?: object
): void {
  useEffect(() => {
    if (!id) return undefined;
    const timer = setTimeout(() => reportUserVisibleError(id, surface), 1000);
    return () => clearTimeout(timer);
  }, [id, surface, occurrence]);
}

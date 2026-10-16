import React, { useSyncExternalStore } from 'react';
export const navigate = (to: string) => {
  location.hash = to;
};
export const goBack = () => history.back();
export const HistoryAction = { Replace: 'replace', Push: 'push' };
export const createLocationState = () => ({ href: location.href, historyPosition: 1 });
export const listen = (listener: () => void) => {
  addEventListener('hashchange', listener);
  return () => removeEventListener('hashchange', listener);
};
export const useLocation = () => ({ pathname: useSyncExternalStore(listen, () => location.hash.slice(1) || '/me') });
export const Link = ({
  to,
  children,
  testID,
  testIDProperties,
  ...props
}: React.PropsWithChildren<Record<string, unknown> & { to: string }>) => (
  <a href={`#${to}`} {...props}>
    {children}
  </a>
);

import React from 'react';

// Only native navigation and haptics are replaced; all layout components are real.
export const navigate = () => undefined;
export const useCloseOnBack = () => undefined;
export const useHideNavbarWhileOpen = () => undefined;
export const hapticLight = () => undefined;
export const hapticSelection = () => undefined;

export const useUserVisibleError = () => undefined;

export const Link = (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />;

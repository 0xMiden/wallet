import { createContext, useContext } from 'react';

/**
 * Whether the page a component renders in is the one on screen. TabLayout keeps a visited tab
 * mounted under the active one and MobilePageLayers keeps a page mounted under a slide page, so work
 * a page does only for display, such as a poll, pauses while this is false.
 */
export const PageActiveContext = createContext(true);

export function usePageActive(): boolean {
  return useContext(PageActiveContext);
}

/**
 * Whether the page's layer is fully on screen: false while a slide page covers it or is still
 * sliding off it after a pop. PageActiveContext turns true as the pop starts, so work resumes at
 * once; this one waits for the reveal to finish, for paint that must match what is visible.
 */
export const PageOnScreenContext = createContext(true);

export function usePageOnScreen(): boolean {
  return useContext(PageOnScreenContext);
}

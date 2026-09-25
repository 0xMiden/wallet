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
 * Whether the page's layer is fully on screen: false while a slide page covers it, and after any
 * pop that returns to it (to a plain page or a slide page alike) until its own way back has finished
 * and the popped page has slid off. A page nothing covered is on screen at once, as is every page
 * under reduced motion. PageActiveContext turns true as the pop starts, so work resumes at
 * once; this one waits for the reveal to finish, for paint that must match what is visible.
 */
export const PageOnScreenContext = createContext(true);

export function usePageOnScreen(): boolean {
  return useContext(PageOnScreenContext);
}

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

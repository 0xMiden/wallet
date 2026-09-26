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

/**
 * True when a router Pop reached the page while its current layer was not mounted (it never had one, after a reload
 * or a remount beneath history; its layer went; or its layer was retired), so the Pop mounted it fresh. It is read
 * once, when the content mounts; a close only returns to a mounted layer, so it never sets it. Such a page never
 * slides in from the right, which would read as a push; it fades in instead, unless its layer reveals it.
 */
export const PageMountedByReturnContext = createContext(false);

export function usePageMountedByReturn(): boolean {
  return useContext(PageMountedByReturnContext);
}

/**
 * True when that return mount is a reveal: the page's layer brings it back from under the page that left, so the page
 * plays no mount entrance of its own at all.
 */
export const PageRevealedByLayerContext = createContext(false);

export function usePageRevealedByLayer(): boolean {
  return useContext(PageRevealedByLayerContext);
}

import { isExtension } from 'lib/platform';

/** Buy and Sell run through the Transak widget. The extension has no widget, so it does not offer them. */
export const isCashAvailable = (): boolean => !isExtension();

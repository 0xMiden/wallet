import { NATIVE_PAGE_COLOR } from 'lib/mobile/status-bar';
import { getThemeSetting } from 'lib/settings/helpers';
import { resolveTheme } from 'lib/settings/theme';

export interface WebviewToolbarColors {
  toolbarColor: string;
}

/**
 * The native header colour for a WebView the wallet opens, from the app's own resolved theme.
 * Without it the plugin follows the phone's appearance on iOS and is always white on Android.
 * The text colour is left to the plugins, which pick white or black from the toolbar colour.
 * Call it at every open: the theme can change between two.
 */
export function webviewToolbarColors(): WebviewToolbarColors {
  const theme = resolveTheme(getThemeSetting());
  return { toolbarColor: NATIVE_PAGE_COLOR[theme] };
}

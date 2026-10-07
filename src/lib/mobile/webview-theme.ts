import { NATIVE_PAGE_COLOR } from 'lib/mobile/status-bar';
import { ResolvedTheme } from 'lib/settings/constants';
import { getThemeSetting } from 'lib/settings/helpers';
import { resolveTheme } from 'lib/settings/theme';

const TOOLBAR_TEXT_COLOR: Record<ResolvedTheme, string> = { dark: '#ffffff', light: '#000000' };

export interface WebviewToolbarColors {
  toolbarColor: string;
  toolbarTextColor: string;
}

/**
 * The native header colours for a WebView the wallet opens, from the app's own resolved theme.
 * Without them the plugin follows the phone's appearance on iOS and is always white on Android.
 * Call it at every open: the theme can change between two.
 */
export function webviewToolbarColors(): WebviewToolbarColors {
  const theme = resolveTheme(getThemeSetting());
  return { toolbarColor: NATIVE_PAGE_COLOR[theme], toolbarTextColor: TOOLBAR_TEXT_COLOR[theme] };
}

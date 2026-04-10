import { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } from '../lib/miden-chain/constants';

export const isDevnet = DEFAULT_NETWORK === MIDEN_NETWORK_NAME.DEVNET;

/* c8 ignore start -- build-time constants; devnet branch only executes in MIDEN_NETWORK=devnet builds */

// Primary palette
export const PRIMARY_50 = isDevnet ? '#EEF1F4' : '#FFF0E5';
export const PRIMARY_500 = isDevnet ? '#7286A0' : '#FF5500';
export const PRIMARY_600 = isDevnet ? '#5A6B80' : '#CC4400';

// Brand variants
export const PRIMARY_ORANGE = isDevnet ? '#8A9DB5' : '#FF8844';
export const PRIMARY_ORANGE_DISABLED = isDevnet ? '#7F95AD' : '#FF7722';
export const PRIMARY_ORANGE_LIGHT = isDevnet ? '#C5D0DC' : '#FFD4B8';
export const PRIMARY_ORANGE_DARK = isDevnet ? '#4E5F73' : '#AA3700';
export const PRIMARY_ORANGE_LIGHTER = isDevnet ? '#EEF1F4' : '#FFF0E5';
export const PRIMARY_ORANGE_DARKER = isDevnet ? '#3A4857' : '#882200';

// Accent colors
export const PILL_ACTIVE = isDevnet ? '#6878A0' : '#E87040';
export const ACCENT_ORANGE = isDevnet ? '#5E7090' : '#EE622F';

// For inline style / SVG usage
export const PRIMARY_HEX = PRIMARY_500;
export const PRIMARY_HEX_ALPHA = isDevnet ? '#7286A099' : '#FF550099';
export const PRIMARY_HEX_LIGHT_ALPHA = isDevnet ? 'rgba(114,134,160,0.10)' : 'rgba(255,85,0,0.10)';
export const ACCENT_HEX = ACCENT_ORANGE;

// Focus ring shadow
export const OUTLINE_SHADOW = isDevnet ? '0 0 0 3px rgba(114, 134, 160, 0.5)' : '0 0 0 3px rgba(237, 137, 54, 0.5)';

// Orange sub-palette (for tailwind config)
export const ORANGE_PALETTE = isDevnet
  ? {
      50: '#EEF1F4',
      100: '#DDE4EB',
      200: '#C5D0DC',
      300: '#ADBCCD',
      400: '#96A8BE',
      500: '#7F95AD',
      600: '#6B809A',
      700: '#576B82',
      800: '#44566A',
      900: '#3A4857',
      950: '#7286A0'
    }
  : {
      50: '#FFF0E5',
      100: '#FFE0CC',
      200: '#FFCC99',
      300: '#FFB366',
      400: '#FF9933',
      500: '#FF7700',
      600: '#DD5500',
      700: '#BB4400',
      800: '#993300',
      900: '#882200',
      950: '#FF5500'
    };

export const LOGO_ORANGE_PALETTE = isDevnet
  ? {
      200: '#8A9DB5',
      300: '#C5D0DC',
      400: '#7F95AD',
      500: '#7286A0',
      700: '#4E5F73'
    }
  : {
      200: '#FF8844',
      300: '#FFD4B8',
      400: '#FF7722',
      500: '#FF5500',
      700: '#AA3700'
    };

/* c8 ignore stop */

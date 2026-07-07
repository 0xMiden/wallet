import { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } from '../lib/miden-chain/constants';

export const isDevnet = DEFAULT_NETWORK === MIDEN_NETWORK_NAME.DEVNET;

/* c8 ignore start -- build-time constants; devnet branch only executes in MIDEN_NETWORK=devnet builds */

// Primary palette. Testnet brand orange = app brand #E77537.
export const PRIMARY_50 = isDevnet ? '#EEF1F4' : '#FFF3EC';
export const PRIMARY_500 = isDevnet ? '#7286A0' : '#E77537';
export const PRIMARY_600 = isDevnet ? '#5A6B80' : '#C95A21';

// Brand variants
export const PRIMARY_ORANGE = isDevnet ? '#8A9DB5' : '#E77537';
export const PRIMARY_ORANGE_DISABLED = isDevnet ? '#7F95AD' : '#DCD4C8';
export const PRIMARY_ORANGE_LIGHT = isDevnet ? '#C5D0DC' : '#F7C8B1';
export const PRIMARY_ORANGE_DARK = isDevnet ? '#4E5F73' : '#9F4518';
export const PRIMARY_ORANGE_LIGHTER = isDevnet ? '#EEF1F4' : '#FFF3EC';
export const PRIMARY_ORANGE_DARKER = isDevnet ? '#3A4857' : '#652D15';

// Accent colors
export const PILL_ACTIVE = isDevnet ? '#6878A0' : '#E77537';
export const ACCENT_ORANGE = isDevnet ? '#5E7090' : '#E77537';

// For inline style / SVG usage
export const PRIMARY_HEX = PRIMARY_500;
export const PRIMARY_HEX_ALPHA = isDevnet ? '#7286A099' : '#E7753799';
export const PRIMARY_HEX_LIGHT_ALPHA = isDevnet ? 'rgba(114,134,160,0.10)' : 'rgba(231,117,55,0.10)';
export const ACCENT_HEX = ACCENT_ORANGE;

// Focus ring shadow
export const OUTLINE_SHADOW = isDevnet ? '0 0 0 3px rgba(114, 134, 160, 0.5)' : '0 0 0 3px rgba(231, 117, 55, 0.5)';

// Orange sub-palette (for tailwind config). Testnet ramp regenerated around #E77537.
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
      50: '#FFF3EC',
      100: '#FCE3D6',
      200: '#F7C8B1',
      300: '#F1A47E',
      400: '#EC8754',
      500: '#E77537',
      600: '#C95A21',
      700: '#9F4518',
      800: '#7D3616',
      900: '#652D15',
      950: '#381508'
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
      200: '#F1A47E',
      300: '#F7C8B1',
      400: '#E77537',
      500: '#E77537',
      700: '#9F4518'
    };

/* c8 ignore stop */

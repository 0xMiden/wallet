import { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } from '../lib/miden-chain/constants';

export const isDevnet = DEFAULT_NETWORK === MIDEN_NETWORK_NAME.DEVNET;

/* c8 ignore start -- build-time constants; devnet branch only executes in MIDEN_NETWORK=devnet builds */

// Primary palette. Testnet brand orange = Foundations accent/primary #D44B00.
export const PRIMARY_50 = isDevnet ? '#EEF1F4' : '#FFF0E5';
export const PRIMARY_500 = isDevnet ? '#7286A0' : '#D44B00';
export const PRIMARY_600 = isDevnet ? '#5A6B80' : '#B33E00';

// Brand variants
export const PRIMARY_ORANGE = isDevnet ? '#8A9DB5' : '#D44B00';
export const PRIMARY_ORANGE_DISABLED = isDevnet ? '#7F95AD' : '#DCD4C8';
export const PRIMARY_ORANGE_LIGHT = isDevnet ? '#C5D0DC' : '#F9D4BF';
export const PRIMARY_ORANGE_DARK = isDevnet ? '#4E5F73' : '#8C3200';
export const PRIMARY_ORANGE_LIGHTER = isDevnet ? '#EEF1F4' : '#FFEDDC';
export const PRIMARY_ORANGE_DARKER = isDevnet ? '#3A4857' : '#5C2200';

// Accent colors
export const PILL_ACTIVE = isDevnet ? '#6878A0' : '#C24400';
export const ACCENT_ORANGE = isDevnet ? '#5E7090' : '#B33E00';

// For inline style / SVG usage
export const PRIMARY_HEX = PRIMARY_500;
export const PRIMARY_HEX_ALPHA = isDevnet ? '#7286A099' : '#D44B0099';
export const PRIMARY_HEX_LIGHT_ALPHA = isDevnet ? 'rgba(114,134,160,0.10)' : 'rgba(212,75,0,0.10)';
export const ACCENT_HEX = ACCENT_ORANGE;

// Focus ring shadow
export const OUTLINE_SHADOW = isDevnet ? '0 0 0 3px rgba(114, 134, 160, 0.5)' : '0 0 0 3px rgba(212, 75, 0, 0.5)';

// Orange sub-palette (for tailwind config). Testnet ramp regenerated around #D44B00.
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
      50: '#FFEDDC',
      100: '#FBD9BB',
      200: '#F5BB87',
      300: '#EE9956',
      400: '#E47B2C',
      500: '#D44B00',
      600: '#B33E00',
      700: '#8C3200',
      800: '#6E2700',
      900: '#5C2200',
      950: '#3F1700'
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
      200: '#E47B2C',
      300: '#F9D4BF',
      400: '#D44B00',
      500: '#D44B00',
      700: '#8C3200'
    };

/* c8 ignore stop */

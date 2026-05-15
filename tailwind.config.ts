import { Config } from 'tailwindcss';

import customColors from './src/utils/colors';

// Network-conditional branding: driven by MIDEN_NETWORK env variable (default: testnet)
const isDevnet = process.env.MIDEN_NETWORK === 'devnet';

const primaryPalette = {
  50: isDevnet ? '#EEF1F4' : '#FFEDDC',
  500: isDevnet ? '#7286A0' : '#D44B00',
  600: isDevnet ? '#5A6B80' : '#B33E00'
};

export default {
  darkMode: 'class',
  content: ['./public/**/*.{html,js,mjs}', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    // Custom colors (overrides Tailwind defaults)
    colors: (() => {
      const baseColors = {
        transparent: 'transparent',
        current: 'currentColor',
        black: 'var(--color-text-primary)',
        white: 'var(--color-surface)',
        'pure-black': '#000000',
        'pure-white': '#FFFFFF',
        'surface-solid': 'var(--color-surface-solid)',
        'input-bg': 'var(--color-input-bg)',
        'border-light': 'var(--color-border-light)',
        'text-muted': 'var(--color-text-muted)',
        'border-subtle': 'var(--color-border-subtle)',
        'heading-gray': 'var(--color-text-secondary)',
        gray: {
          25: 'var(--color-surface-secondary)',
          50: 'var(--color-surface-tertiary)',
          100: 'var(--color-hover-bg)',
          200: '#59657C',
          250: '#484848',
          300: '#E0D9D6',
          400: '#737373',
          500: '#818181',
          600: '#CBCBCB',
          700: '#E9EBEF',
          800: '#818898',
          900: '#F8F9FA'
        },
        yellow: {
          100: '#fffff0',
          200: '#fefcbf',
          300: '#faf089',
          400: '#f6e05e',
          500: '#FFEFD2',
          600: '#d69e2e',
          700: '#b7791f',
          800: '#975a16',
          900: '#744210'
        },
        blue: {
          100: '#E2E7FD',
          200: '#BFCBFF',
          300: '#ECF5FF',
          400: primaryPalette[500],
          500: '#4299e1',
          600: '#3182ce',
          700: primaryPalette[600],
          800: '#2c5282',
          900: '#2a4365'
        },
        orange: isDevnet
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
              // Testnet ramp regenerated around Foundations accent/primary #D44B00.
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
            },
        logoOrange: isDevnet
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
            },
        // Brand colors
        'primary-white': '#fcfaf7',
        'primary-orange': isDevnet ? '#8A9DB5' : '#D44B00',
        'primary-orange-disabled': isDevnet ? '#7F95AD' : '#DCD4C8',
        'primary-orange-light': isDevnet ? '#C5D0DC' : '#F9D4BF',
        'primary-orange-dark': isDevnet ? '#4E5F73' : '#8C3200',
        'primary-orange-lighter': isDevnet ? '#EEF1F4' : '#FFEDDC',
        'primary-orange-darker': isDevnet ? '#3A4857' : '#5C2200',
        'primary-gray': '#656565',
        'border-card': 'var(--color-border)',
        'chip-bg': 'var(--color-chip-bg)',
        'pill-active': isDevnet ? '#6878A0' : '#C24400',
        'accent-orange': isDevnet ? '#5E7090' : '#B33E00',
        'app-bg': 'var(--color-app-bg)',
        'send-blue': '#024073',
        'receive-green': '#38824A',
        // Design system tokens (Foundations + Typography) — semantic namespace.
        // Light/dark values resolve from CSS vars in src/main.css.
        'accent-primary': 'var(--accent-primary)',
        'accent-primary-hover': 'var(--accent-primary-hover)',
        'text-primary-token': 'var(--text-primary)',
        'text-secondary-token': 'var(--text-secondary)',
        'text-tertiary-token': 'var(--text-tertiary)',
        'text-on-accent': 'var(--text-on-accent)',
        'surface-page': 'var(--surface-page)',
        'surface-input': 'var(--surface-input)',
        'surface-interactive': 'var(--surface-interactive)',
        'surface-inactive': 'var(--surface-inactive)',
        'status-positive': 'var(--status-positive)',
        'status-pending': 'var(--status-pending)',
        'status-negative': 'var(--status-negative)',
        'tx-received': 'var(--tx-received)',
        'tx-sent': 'var(--tx-sent)',
        'tx-swap': 'var(--tx-swap)',
        'tx-earn': 'var(--tx-earn)',
        'rule-default': 'var(--rule-default)',
        'rule-strong': 'var(--rule-strong)',
        ...customColors,
        // Override primary from customColors with network-conditional values
        primary: primaryPalette
      };
      return baseColors;
    })(),

    // Custom font families with Geist
    fontFamily: {
      sans: ['Inter'],
      serif: ['Inter'],
      mono: ['Inter'],
      inter: ['Inter']
    },

    extend: {
      // Custom spacing values not in Tailwind defaults
      spacing: {
        15: '3.75rem',
        35: '8.75rem'
      },
      // Custom shadows
      boxShadow: {
        'xs-white': '0 0 0 1px rgba(255, 255, 255, 0.05)',
        'top-light': '0 -1px 2px 0 rgba(0, 0, 0, 0.1)',
        outline: isDevnet ? '0 0 0 3px rgba(114, 134, 160, 0.5)' : '0 0 0 3px rgba(212, 75, 0, 0.5)'
      },
      // Custom border radius
      borderRadius: {
        '4xl': '2rem',
        5: '5px',
        10: '10px',
        // Design system semantic radii (Foundations · Radius)
        'sm-token': 'var(--radius-sm)',
        'md-token': 'var(--radius-md-token)',
        'lg-token': 'var(--radius-lg-token)'
      },
      // Custom stroke color
      stroke: {
        orange: '#ED8936'
      },
      // Custom animation
      animation: {
        'gradient-wave': 'gradient-wave 2s ease-in-out infinite'
      },
      keyframes: {
        'gradient-wave': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        }
      }
    }
  },
  plugins: []
} satisfies Config;

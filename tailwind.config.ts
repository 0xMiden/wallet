import { Config } from 'tailwindcss';

import customColors from './src/utils/colors';

export default {
  content: ['./public/**/*.{html,js,mjs}', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    // Custom colors (overrides Tailwind defaults)
    colors: (() => {
      const baseColors = {
        transparent: 'transparent',
        current: 'currentColor',
        black: '#000',
        white: '#fff',
        'heading-gray': '#484848',
        gray: {
          25: '#F9F9F9',
          50: '#F3F3F3',
          100: '#E1DBDB',
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
        red: {
          100: '#fff5f5',
          200: '#fed7d7',
          300: '#feb2b2',
          400: '#fc8181',
          500: '#f56565',
          600: '#e53e3e',
          700: '#c53030',
          800: '#9b2c2c',
          900: '#742a2a'
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
        green: {
          100: '#00802680',
          200: '#c6f6d5',
          300: '#9ae6b4',
          400: '#68d391',
          500: '#48bb78',
          600: '#38a169',
          700: '#2f855a',
          800: '#276749',
          900: '#22543d'
        },
        blue: {
          100: '#E2E7FD',
          200: '#BFCBFF',
          300: '#ECF5FF',
          400: '#FF5500',
          500: '#4299e1',
          600: '#3182ce',
          700: '#CC4400',
          800: '#2c5282',
          900: '#2a4365'
        },
        orange: {
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
        },
        logoOrange: {
          200: '#FF8844',
          300: '#FFD4B8',
          400: '#FF7722',
          500: '#FF5500',
          700: '#AA3700'
        },
        // Brand colors
        'primary-white': '#fcfaf7',
        'primary-orange': '#FF8844',
        'primary-orange-disabled': '#FF7722',
        'primary-orange-light': '#FFD4B8',
        'primary-orange-dark': '#AA3700',
        'primary-orange-lighter': '#FFF0E5',
        'primary-orange-darker': '#882200',
        'primary-gray': '#656565',
        'border-card': '#D6DAE0',
        'chip-bg': '#EEEFF2',
        'accent-orange': '#EE622F',
        'app-bg': '#F6F4F2',
        ...customColors
      };
      return baseColors;
    })(),

    // Custom font families with Geist
    fontFamily: {
      sans: [
        "'Geist'",
        'system-ui',
        '-apple-system',
        'BlinkMacSystemFont',
        '"Segoe UI"',
        'Roboto',
        '"Helvetica Neue"',
        'Arial',
        '"Noto Sans"',
        'sans-serif',
        '"Apple Color Emoji"',
        '"Segoe UI Emoji"',
        '"Segoe UI Symbol"',
        '"Noto Color Emoji"'
      ],
      serif: ['Georgia', 'Cambria', '"Times New Roman"', 'Times', 'serif'],
      mono: ["'Geist Mono'", 'Menlo', 'Monaco', 'Consolas', '"Liberation Mono"', '"Courier New"', 'monospace'],
      geist: ["'Geist'", 'system-ui', 'sans-serif'],
      'geist-mono': ["'Geist Mono'", 'monospace']
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
        outline: '0 0 0 3px rgba(237, 137, 54, 0.5)'
      },
      // Custom border radius
      borderRadius: {
        '4xl': '2rem',
        5: '5px',
        10: '10px'
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

// DO NOT USE THIS FILE DIRECTLY FOR DEVELOPMENT
// use `import colors from '@src/utils/colors'` instead
// which is based on this, has type information and is easier to use.

// This one is used for tailwind.config.js.

const colors = {
  primary: {
    50: '#FFF3EC',
    500: '#E77537',
    600: '#C95A21'
  },
  grey: {
    25: '#F9F9F9',
    50: '#F3F3F3',
    100: '#EBEBEB',
    200: '#D7D7D7',
    300: '#BABABA',
    400: '#9E9E9E',
    500: '#818181',
    600: '#656565',
    700: '#484848',
    800: '#2F2F2F',
    900: '#1C1C1C'
  },
  blue: {
    50: '#ECF5FF',
    100: '#E2E7FD',
    200: '#BFCBFF',
    300: '#ECF5FF',
    500: '#56A1F9'
  },
  yellow: {
    50: '#FFEFD2',
    100: '#fffff0',
    300: '#FFEFD2',
    500: '#FEA644',
    600: '#DA8231',
    700: '#b7791f'
  },
  green: {
    50: '#E7FAF2',
    100: '#E6F5EA',
    300: '#90BA89',
    500: '#2BA84A',
    600: '#1A9C52',
    700: '#38824A',
    // Added for green text on a green-50 fill: the darkest existing shade is 700
    // (#38824A), and at 4.34:1 on green-50 that is short of AA for normal-size
    // text. 800 is 7.34:1 on the same fill. Additive — nothing used `green-800`.
    800: '#1F5C33'
  },
  red: {
    50: '#FEF2F2',
    100: '#FEE2E2',
    500: '#EF4444',
    600: '#DC2626',
    700: '#B91C1C'
  }
};

module.exports = colors;

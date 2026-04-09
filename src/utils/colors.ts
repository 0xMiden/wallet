import { includes } from 'lodash';

import { ColorCode, Colors } from '../types/colors';
import colors from './tailwind-colors';

const _colors = colors as Colors;

export const getColorHex = (colorCode: ColorCode): string => {
  /*
    Receives: A color string like 'primary-500'.
    Returns: The hex value for the colorCode if it exists.
  */

  if (!includes(colorCode, '-')) {
    throw new Error(`Color ${colorCode} does not exist`);
  }

  const parts = colorCode.split('-');
  const name = parts[0];
  const shade = parts[1];
  if (!name || !shade) {
    throw new Error(`Color ${colorCode} does not exist`);
  }

  const nameColors = _colors[name];
  if (!nameColors) {
    throw new Error(`Color ${name} does not exist`);
  }
  const hex = nameColors[shade];
  if (!hex) {
    throw new Error(`Shade ${shade} does not exist for color ${name}`);
  }

  return hex;
};

export const getRandomColor = (): ColorCode => {
  /*
    Returns: A random vibrant color with shade 500 (gray colors are excluded).
  */

  delete _colors.gray;
  const colorNames = Object.keys(_colors);
  const randomColorName = colorNames[Math.floor(Math.random() * colorNames.length)] ?? 'primary';
  const colorShade = '500';

  return `${randomColorName}-${colorShade}`;
};

export const isColorCode = (colorCode: string): boolean => {
  /*
    Receives: A color string like 'primary-500'.
    Returns: True if the colorCode exists.
  */

  if (!includes(colorCode, '-')) {
    return false;
  }

  const parts = colorCode.split('-');
  const name = parts[0];
  const shade = parts[1];
  if (!name || !shade) return false;

  const nameColors = _colors[name];
  if (!nameColors) {
    return false;
  }
  if (!nameColors[shade]) {
    return false;
  }

  return true;
};

export default _colors;

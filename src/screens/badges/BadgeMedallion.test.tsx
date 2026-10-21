import React from 'react';

import { render, screen } from '@testing-library/react';

import { IconName } from 'app/icons/v2';

import { BadgeMedallion } from './BadgeMedallion';
import type { BadgeDefinition } from './catalog';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const badge: BadgeDefinition = {
  id: 'first-deposit',
  available: true,
  titleI18nKey: 'badgeFirstDeposit',
  descriptionI18nKey: 'badgeFirstDepositDescription',
  icon: IconName.BadgeDeposit
};

it('draws the illustrated art in place of the glyph when a badge has it, keeping the lock', () => {
  render(<BadgeMedallion badge={{ ...badge, art: 'first-deposit.png' }} />);
  const medallion = screen.getByTestId('badge-medallion-first-deposit');
  expect(medallion.querySelector('img')).toHaveAttribute('src', 'first-deposit.png');
  expect(medallion.querySelector('img')).toHaveAttribute('alt', '');
  expect(medallion).toHaveAttribute('data-earned', 'false');
  expect(medallion.querySelectorAll('svg').length).toBe(1);
});

it('keeps the glyph for a badge without art', () => {
  render(<BadgeMedallion badge={badge} earned />);
  const medallion = screen.getByTestId('badge-medallion-first-deposit');
  expect(medallion.querySelector('img')).toBeNull();
  expect(medallion.querySelectorAll('svg').length).toBe(1);
});

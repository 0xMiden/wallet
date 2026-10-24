import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ARCADE_PATH } from 'lib/arcade';
import { navigate } from 'lib/woozie';

import { ArcadeBanner } from './ArcadeBanner';

jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

it('links Home directly to Arcade without opening a game or requesting wallet access', () => {
  render(<ArcadeBanner />);
  fireEvent.click(screen.getByTestId('home-arcade-banner'));
  expect(navigate).toHaveBeenCalledWith(ARCADE_PATH);
  expect(screen.getByText('arcadeHomeDescription')).toBeInTheDocument();
});

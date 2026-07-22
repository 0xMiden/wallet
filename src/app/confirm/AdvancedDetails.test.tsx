import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AdvancedDetails } from './AdvancedDetails';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

it('hides children until toggled, then reveals them', () => {
  render(
    <AdvancedDetails>
      <div>secret-json</div>
    </AdvancedDetails>
  );
  expect(screen.queryByText('secret-json')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'advancedDetails' }));
  expect(screen.getByText('secret-json')).toBeInTheDocument();
});

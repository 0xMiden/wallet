import React from 'react';

import { render, screen, within } from '@testing-library/react';

import { OriginatorChip } from './OriginatorChip';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

describe('OriginatorChip', () => {
  it('names a non-ASCII host with its ASCII form', () => {
    const origin = `https://${String.fromCharCode(0x430)}pple.example`;
    render(<OriginatorChip origin={origin} testId="originator" />);

    expect(within(screen.getByTestId('originator')).getByTestId('dapp-origin-ascii')).toHaveTextContent(
      'xn--pple-43d.example'
    );
  });
});

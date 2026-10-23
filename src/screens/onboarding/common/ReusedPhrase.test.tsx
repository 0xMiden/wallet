import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ReusedPhraseNotice, ReusedPhraseScreen } from './ReusedPhrase';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled, 'data-testid': testId }: any) => (
    <button data-testid={testId} onClick={onClick} disabled={disabled}>
      {title}
    </button>
  )
}));

describe('ReusedPhraseScreen', () => {
  it('says this is a new account, not a recovery, and that the phrase stays on the device', () => {
    render(<ReusedPhraseScreen />);

    expect(screen.getByText('reusedPhraseTitle')).toBeInTheDocument();
    expect(screen.getByText('reusedPhraseNotRecovery')).toBeInTheDocument();
    expect(screen.getByText('reusedPhraseWarning')).toBeInTheDocument();
    expect(screen.getByText('reusedPhraseStaysOnDevice')).toBeInTheDocument();
  });

  it('holds Continue back until the warning is acknowledged, and takes the tick back', () => {
    const onSubmit = jest.fn();
    render(<ReusedPhraseScreen onSubmit={onSubmit} />);
    const continueButton = screen.getByTestId('reused-phrase-continue') as HTMLButtonElement;

    expect(continueButton).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(continueButton).toBeDisabled();
  });
});

describe('ReusedPhraseNotice', () => {
  it('reports the tick and shows an optional lead above the warning', () => {
    const onAcknowledgedChange = jest.fn();
    render(<ReusedPhraseNotice acknowledged={false} onAcknowledgedChange={onAcknowledgedChange} lead="lead line" />);

    expect(screen.getByText('lead line')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onAcknowledgedChange).toHaveBeenCalledWith(true);
  });
});

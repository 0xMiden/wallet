import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import ErrorBoundary from './ErrorBoundary';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('components/Button', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Button: ({ title, onClick }: any) => <button onClick={onClick}>{title}</button>,
  ButtonVariant: { Primary: 'primary' }
}));
jest.mock('./icons/v2', () => ({ Icon: () => null, IconName: { Frown: 'frown' } }));

// GAP 11 (resilience): the "Try Again" control was dead (no onClick). Clicking it
// must reset the boundary and re-render the (now-recovered) children.
describe('ErrorBoundary — Try Again', () => {
  it('resets the boundary and re-renders recovered children when Try Again is clicked', () => {
    let shouldThrow = true;
    const Boom = () => {
      if (shouldThrow) throw new Error('boom');
      return <div>recovered</div>;
    };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    // Error UI is shown (t returns the key in this mock).
    expect(screen.getByText('tryAgain')).toBeInTheDocument();

    // The next render will succeed; clicking Try Again must recover.
    shouldThrow = false;
    act(() => {
      fireEvent.click(screen.getByText('tryAgain'));
    });

    expect(screen.getByText('recovered')).toBeInTheDocument();
    errSpy.mockRestore();
  });
});

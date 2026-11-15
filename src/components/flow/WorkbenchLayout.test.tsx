import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { WorkbenchLayout } from './WorkbenchLayout';

it('keeps one composition with a disclosure below it and optional footer', () => {
  const onBack = jest.fn();
  const onMinimize = jest.fn();
  render(
    <WorkbenchLayout
      title="Send"
      composition={<div>Recipient</div>}
      summary={<div>Fee details</div>}
      footer={<button>Review</button>}
      onBack={onBack}
      onMinimize={onMinimize}
    >
      <div>Transfer amount</div>
    </WorkbenchLayout>
  );
  expect(screen.getByRole('heading', { name: 'Send' })).toBeInTheDocument();
  expect(screen.getByText('Transfer amount')).toBeInTheDocument();
  expect(screen.getByText('Recipient')).toBeInTheDocument();
  expect(screen.getByText('Fee details')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review' }).closest('footer')).toHaveAttribute(
    'data-testid',
    'command-footer'
  );
  expect(screen.getByText('Fee details').closest('details')).toHaveAttribute('data-testid', 'command-details');
  expect(
    screen.getByText('Transfer amount').compareDocumentPosition(screen.getByTestId('command-details')) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /back/i }));
  fireEvent.click(screen.getByRole('button', { name: /minimize/i }));
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(onMinimize).toHaveBeenCalledTimes(1);
});

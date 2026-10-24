import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { captureCrash } from 'lib/telemetry/crash';

import { ActivityGroupsBoundary } from './ActivityGroupsBoundary';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/telemetry/crash', () => ({ captureCrash: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

it('contains a Groups render failure, reports it, retries, and offers List without removing navigation', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const onReturnToList = jest.fn();
  let broken = true;
  const Content = () => {
    if (broken) throw new Error('synthetic Groups render failure');
    return <p>Recovered groups</p>;
  };
  const view = render(
    <>
      <nav>Wallet navigation</nav>
      <ActivityGroupsBoundary onReturnToList={onReturnToList}>
        <Content />
      </ActivityGroupsBoundary>
    </>
  );
  expect(screen.getByRole('navigation')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('activityGroupsUnavailable');
  expect(captureCrash).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'tryAgain' }));
  expect(screen.getByRole('alert')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'activityReturnToList' }));
  expect(onReturnToList).toHaveBeenCalledTimes(1);
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: 'tryAgain' }));
  expect(screen.getByText('Recovered groups')).toBeInTheDocument();
  view.unmount();
  consoleError.mockRestore();
});

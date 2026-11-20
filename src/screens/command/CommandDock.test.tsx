import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { navigate } from 'lib/woozie';

import { CommandDock } from './CommandDock';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));

test('moves a single decorative selection pill without replacing dock buttons', () => {
  const { rerender } = render(<CommandDock activeAction="receive" />);
  const receive = screen.getByRole('button', { name: 'receive' });
  const send = screen.getByRole('button', { name: 'send' });
  expect(within(receive).getByTestId('command-dock-highlight')).toHaveAttribute('aria-hidden', 'true');
  rerender(<CommandDock activeAction="send" />);
  expect(screen.getByRole('button', { name: 'send' })).toBe(send);
  expect(screen.getAllByTestId('command-dock-highlight')).toHaveLength(1);
  expect(within(send).getByTestId('command-dock-highlight')).toBeInTheDocument();
  expect(send).toHaveAttribute('aria-current', 'page');
  expect(receive).not.toHaveAttribute('aria-current');
  rerender(<CommandDock />);
  expect(screen.queryByTestId('command-dock-highlight')).not.toBeInTheDocument();
});

test('the five Command shortcuts show decorative icons and retain their original routes', () => {
  render(<CommandDock />);
  const dock = within(screen.getByRole('navigation', { name: 'commandActions' }));
  expect(dock.getAllByRole('button')).toHaveLength(5);
  for (const [name, path] of [
    ['send', '/send'],
    ['receive', '/receive'],
    ['swap', '/swap'],
    ['earn', '/earn'],
    ['commandBridge', '/bridge/deposit']
  ]) {
    const button = dock.getByRole('button', { name });
    expect(button.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    fireEvent.click(button);
    expect(navigate).toHaveBeenLastCalledWith(path);
  }
});

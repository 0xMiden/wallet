import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Options } from 'qr-code-styling';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { PrivateKeyPair } from './PrivateKeyPair';

const mockQrOptions = jest.fn();
jest.mock(
  'qr-code-styling',
  () =>
    class {
      constructor(options: Options) {
        mockQrOptions(options);
      }
      append(container: HTMLElement) {
        container.append(document.createElement('canvas'));
      }
    }
);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (['importHotKeyInvalid'].includes(key) ? `Visible ${key}` : key) })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

it('renders an exact QR payload first, exposes no secret attribute, and switches to two read-only boxes', () => {
  const hot = 'ab'.repeat(32);
  const evm = 'cd'.repeat(32);
  const payload = `${hot}:${evm}`;
  const view = render(<PrivateKeyPair payload={payload} />);
  expect(mockQrOptions).toHaveBeenLastCalledWith(expect.objectContaining({ data: payload }));
  expect(screen.getByRole('img', { name: 'privateKeyPairQr' })).toBeInTheDocument();
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  expect(view.container.innerHTML).not.toContain(hot);
  expect(view.container.querySelector('[data-qr-payload]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'showPrivateKeyText' }));
  expect(screen.getByLabelText('midenHotPrivateKey')).toHaveValue(hot);
  expect(screen.getByLabelText('evmPrivateKey')).toHaveValue(evm);
  screen.getAllByRole('textbox').forEach(field => expect(field).toHaveAttribute('readonly'));
  fireEvent.click(screen.getByRole('button', { name: 'showQrCode' }));
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
  view.unmount();
  expect(view.container.innerHTML).toBe('');
});

jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

const mockReport = jest.mocked(reportUserVisibleError);

describe('user-visible private-key errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReport.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports importHotKeyInvalid only after its invalid payload is visible for 1000 ms', () => {
    const view = render(<PrivateKeyPair payload="not-a-key-pair" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Visible importHotKeyInvalid');
    act(() => jest.advanceTimersByTime(999));
    expect(mockReport.mock.calls).toEqual([]);
    act(() => jest.advanceTimersByTime(1));
    expect(mockReport.mock.calls).toEqual([['importHotKeyInvalid', 'inline']]);
    view.rerender(<PrivateKeyPair payload="still-invalid" />);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([['importHotKeyInvalid', 'inline']]);
  });

  it('does not report valid QR/text views or their private-key warning', () => {
    render(<PrivateKeyPair payload={`${'ab'.repeat(32)}:${'cd'.repeat(32)}`} />);
    expect(screen.getByText('privateKeyPairWarning')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    fireEvent.click(screen.getByRole('button', { name: 'showPrivateKeyText' }));
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });

  it.each(['valid', 'unmount'])('cancels an invalid-payload episode at 999 ms on %s', ending => {
    const view = render(<PrivateKeyPair payload="invalid" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(999));
    if (ending === 'unmount') view.unmount();
    else view.rerender(<PrivateKeyPair payload={`${'ab'.repeat(32)}:${'cd'.repeat(32)}`} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });
});

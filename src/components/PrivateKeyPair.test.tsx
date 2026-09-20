import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { Options } from 'qr-code-styling';

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
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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

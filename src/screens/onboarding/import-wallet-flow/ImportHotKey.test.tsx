import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { ScanQrDrawerProps } from 'screens/send-flow/ScanQrDrawer';

import { ImportHotKeyScreen } from './ImportHotKey';

const HOT = 'ab'.repeat(32);
const EVM = 'cd'.repeat(32);
const PAYLOAD = `${HOT}:${EVM}`;
const mockScan = jest.fn();
const mockDecode = jest.fn();
let mockMobile = false;
let mockAvailable = true;
let mockProtected = true;

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/platform', () => ({ isMobile: () => mockMobile }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('lib/mobile/screenshot-guard', () => ({ useScreenshotGuard: () => mockProtected }));
jest.mock('lib/qr/scanner', () => ({ isScanAvailable: () => mockAvailable, scanQRCode: () => mockScan() }));
jest.mock('lib/qr/image-decoder', () => ({ decodeQrImage: (file: File) => mockDecode(file) }));
jest.mock('screens/send-flow/ScanQrDrawer', () => ({
  ScanQrDrawer: ({ open, rawPayload, onDetected, onOpenChange }: ScanQrDrawerProps) =>
    open ? (
      <button
        onClick={() => {
          if (rawPayload) onDetected(`${'ab'.repeat(32)}:${'cd'.repeat(32)}`);
          onOpenChange(false);
        }}
      >
        camera-result
      </button>
    ) : null
}));

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const upload = () =>
  fireEvent.change(screen.getByLabelText('uploadQrImage'), {
    target: { files: [new File(['fixture'], 'keys.png', { type: 'image/png' })] }
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockMobile = false;
  mockAvailable = true;
  mockProtected = true;
});

it('starts with camera and upload, then accepts two manual keys through the same validator', () => {
  const onSubmit = jest.fn();
  render(<ImportHotKeyScreen onSubmit={onSubmit} />);
  expect(screen.queryByLabelText('midenHotPrivateKey')).toBeNull();
  expect(screen.getByRole('button', { name: 'scanQrTitle' })).toBeEnabled();
  expect(screen.getByTestId('import-hot-key-submit')).toBeDisabled();
  click('enterKeysManually');
  fireEvent.change(screen.getByLabelText('midenHotPrivateKey'), { target: { value: `0x${HOT.toUpperCase()}` } });
  expect(screen.getByTestId('import-hot-key-submit')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('evmPrivateKey'), { target: { value: EVM } });
  click('continue');
  expect(onSubmit).toHaveBeenCalledWith(PAYLOAD);
  expect(screen.getByLabelText('midenHotPrivateKey')).toHaveValue('');
});

it('imports the exact raw extension camera payload', () => {
  const onSubmit = jest.fn();
  render(<ImportHotKeyScreen onSubmit={onSubmit} />);
  click('scanQrTitle');
  click('camera-result');
  click('continue');
  expect(onSubmit).toHaveBeenCalledWith(PAYLOAD);
});

it('accepts native camera and local image results', async () => {
  mockMobile = true;
  mockScan.mockResolvedValue({ success: true, address: PAYLOAD });
  mockDecode.mockResolvedValue(PAYLOAD);
  const onSubmit = jest.fn();
  render(<ImportHotKeyScreen onSubmit={onSubmit} />);
  await act(async () => {
    click('scanQrTitle');
  });
  click('continue');
  expect(onSubmit).toHaveBeenLastCalledWith(PAYLOAD);
  await act(async () => {
    upload();
  });
  click('continue');
  expect(onSubmit).toHaveBeenCalledTimes(2);
});

it.each([HOT, `${HOT}:${'0'.repeat(64)}`, `${PAYLOAD}:extra`])('rejects invalid decoded payloads', async payload => {
  mockDecode.mockResolvedValue(payload);
  render(<ImportHotKeyScreen />);
  await act(async () => {
    upload();
  });
  expect(screen.getByRole('alert')).toHaveTextContent('importHotKeyInvalid');
  expect(screen.getByTestId('import-hot-key-submit')).toBeDisabled();
});

it('keeps upload and manual entry available without a camera and handles bad images', async () => {
  mockAvailable = false;
  mockDecode.mockRejectedValue(new Error('decode failed'));
  render(<ImportHotKeyScreen />);
  expect(screen.getByRole('button', { name: 'scanQrTitle' })).toBeDisabled();
  await act(async () => {
    upload();
  });
  expect(screen.getByRole('alert')).toHaveTextContent('invalidQrImage');
  click('enterKeysManually');
  expect(screen.getByLabelText('evmPrivateKey')).toBeEnabled();
});

it.each(['scanCancelled', 'cameraPermissionDenied'])('handles native %s', async errorKey => {
  mockMobile = true;
  mockScan.mockResolvedValue({ success: false, errorKey });
  render(<ImportHotKeyScreen />);
  await act(async () => {
    click('scanQrTitle');
  });
  expect(screen.getByTestId('import-hot-key-submit')).toBeDisabled();
  expect(screen.queryByRole('alert')?.textContent ?? null).toBe(errorKey === 'scanCancelled' ? null : errorKey);
});

it('ignores a late upload after switching to manual entry', async () => {
  let finish = (value: string) => {
    expect(value).toBe(PAYLOAD);
  };
  mockDecode.mockReturnValue(
    new Promise<string>(resolve => {
      finish = resolve;
    })
  );
  render(<ImportHotKeyScreen />);
  upload();
  click('enterKeysManually');
  await act(async () => {
    finish(PAYLOAD);
  });
  expect(screen.getByLabelText('midenHotPrivateKey')).toHaveValue('');
  expect(screen.getByTestId('import-hot-key-submit')).toBeDisabled();
});

it('discards native results after unmount and withholds input until screenshot protection is ready', async () => {
  mockMobile = true;
  let finish = () => {};
  mockScan.mockReturnValue(
    new Promise(resolve => {
      finish = () => resolve({ success: true, address: PAYLOAD });
    })
  );
  const view = render(<ImportHotKeyScreen />);
  click('scanQrTitle');
  view.unmount();
  await act(async () => {
    finish();
  });
  mockProtected = false;
  render(<ImportHotKeyScreen />);
  expect(screen.queryByRole('button', { name: 'scanQrTitle' })).toBeNull();
  expect(screen.getByTestId('import-hot-key-submit')).toBeDisabled();
});

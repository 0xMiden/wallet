import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
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

it('lays out on the step layout: one primary Continue pinned, the key sources secondary, manual entry a text action', () => {
  render(<ImportHotKeyScreen />);
  expect(screen.getByRole('heading', { level: 1, name: 'importHotKeyTitle' })).toBeInTheDocument();
  expect(screen.getByTestId('import-hot-key-submit').closest('[data-slot="footer"]')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'scanQrTitle' })).toHaveClass('bg-fill');
  expect(screen.getByRole('button', { name: 'uploadQrImage' })).toHaveClass('bg-fill');
  const manual = screen.getByRole('button', { name: 'enterKeysManually' });
  expect(manual).toHaveClass('text-accent-tint-ink');
  fireEvent.click(manual);
  expect(screen.getByLabelText('midenHotPrivateKey')).toHaveAttribute('id', 'hot-key-input');
  expect(screen.getByLabelText('evmPrivateKey')).toHaveAttribute('id', 'evm-key-input');
});

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
const privateErrorFixture =
  'failure 0x1234abcd amount 42 abandon ability able about above absent absorb abstract absurd abuse access accident';
const dwellForError = () => {
  act(() => {
    jest.advanceTimersByTime(999);
  });
  expect(reportUserVisibleError).not.toHaveBeenCalled();
  act(() => {
    jest.advanceTimersByTime(1);
  });
};
const expectDisplayReport = (id: string, surface: string) => {
  expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  expect(reportUserVisibleError).toHaveBeenCalledWith(id, surface);
  expect(JSON.stringify(jest.mocked(reportUserVisibleError).mock.calls)).not.toContain(privateErrorFixture);
};

describe('user-visible error reporting', () => {
  it('does not report the positive key-pair-ready notice', () => {
    render(<ImportHotKeyScreen />);
    click('enterKeysManually');
    fireEvent.change(screen.getByLabelText('midenHotPrivateKey'), { target: { value: HOT } });
    fireEvent.change(screen.getByLabelText('evmPrivateKey'), { target: { value: EVM } });
    expect(screen.getByText('privateKeyPairReady')).toBeVisible();
    dwellForError();
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reports manual invalid keys without sending key material', () => {
    render(<ImportHotKeyScreen />);
    click('enterKeysManually');
    fireEvent.change(screen.getByLabelText('midenHotPrivateKey'), { target: { value: privateErrorFixture } });
    expect(screen.getByRole('alert')).toHaveTextContent('importHotKeyInvalid');
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    dwellForError();
    expectDisplayReport('importHotKeyInvalid', 'notice');
  });
  it('reports the restore failure', () => {
    render(<ImportHotKeyScreen isError />);
    expect(screen.getByRole('alert')).toHaveTextContent('importHotKeyError');
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    dwellForError();
    expectDisplayReport('importHotKeyError', 'notice');
  });
  it.each(['cameraPermissionDenied', 'noQrCodeFound', 'smthWentWrong'])('reports native scan failure %s', async id => {
    mockMobile = true;
    mockScan.mockResolvedValue({ success: false, errorKey: id });
    render(<ImportHotKeyScreen />);
    await act(async () => {
      click('scanQrTitle');
    });
    expect(screen.getByRole('alert')).toHaveTextContent(id);
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    dwellForError();
    expectDisplayReport(id, 'notice');
  });
  it('reports an unreadable QR upload', async () => {
    mockDecode.mockRejectedValue(new Error(privateErrorFixture));
    render(<ImportHotKeyScreen />);
    await act(async () => {
      upload();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('invalidQrImage');
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    dwellForError();
    expectDisplayReport('invalidQrImage', 'notice');
  });
  it('does not report scan cancellation or camera unavailable helper text', async () => {
    mockAvailable = false;
    const view = render(<ImportHotKeyScreen />);
    expect(screen.getByText('keyCameraUnavailable')).toBeVisible();
    dwellForError();
    view.unmount();
    mockAvailable = true;
    mockMobile = true;
    mockScan.mockResolvedValue({ success: false, errorKey: 'scanCancelled' });
    render(<ImportHotKeyScreen />);
    await act(async () => {
      click('scanQrTitle');
    });
    dwellForError();
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
});

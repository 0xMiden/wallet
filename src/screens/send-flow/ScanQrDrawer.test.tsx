import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { ScanQrDrawer } from './ScanQrDrawer';

/**
 * ScanQrDrawer is the extension-only webcam QR scanner. It opens the camera via
 * `getUserMedia`, decodes frames with the native `BarcodeDetector`, and must
 * tear the camera down completely on close/success/unmount. jsdom ships neither
 * `mediaDevices` nor `BarcodeDetector`, so we install controllable stand-ins and
 * drive the async request -> decode -> teardown pipeline deterministically.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// i18n: identity translator so copy renders as raw keys (matches sibling tests).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Drawer — passthrough stub so children (video + state copy) sit directly in the
// DOM without vaul portals. Mirrors RecallCalendarDrawer.test.tsx.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer">{children}</div>,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

// Loader — trivial stub so we don't drag in the icon barrel.
jest.mock('components/Loader', () => ({
  Loader: () => <span data-testid="loader" />
}));

// A syntactically valid Miden testnet address (real ./format validates it).
const VALID_ADDRESS = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';

type WindowWithDetector = { BarcodeDetector?: unknown };

const getUserMediaMock = jest.fn();
const detectMock = jest.fn();

/** Build a MediaStream stand-in with jest-spied tracks. */
const makeStream = (trackCount = 2) => {
  const tracks = Array.from({ length: trackCount }, () => ({ stop: jest.fn() }));
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
};

const domError = (name: string): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

/** Flush the getUserMedia -> decode -> teardown microtask chain. */
const flushAsync = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const noopProps = () => ({
  onOpenChange: jest.fn(),
  onDetected: jest.fn(),
  onError: jest.fn()
});

let origRaf: typeof window.requestAnimationFrame;
let origCancelRaf: typeof window.cancelAnimationFrame;

beforeEach(() => {
  getUserMediaMock.mockReset();
  detectMock.mockReset();

  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: getUserMediaMock },
    configurable: true
  });

  (window as unknown as WindowWithDetector).BarcodeDetector = class {
    detect = detectMock;
  };

  // Neutralize the rAF re-scan loop: the FIRST decode runs immediately after the
  // stream attaches, so a no-op rAF keeps each test to a single deterministic
  // decode without a runaway animation loop.
  origRaf = window.requestAnimationFrame;
  origCancelRaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = jest.fn().mockReturnValue(1) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = jest.fn() as unknown as typeof window.cancelAnimationFrame;
});

afterEach(() => {
  window.requestAnimationFrame = origRaf;
  window.cancelAnimationFrame = origCancelRaf;
  delete (window as unknown as WindowWithDetector).BarcodeDetector;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ScanQrDrawer', () => {
  it('requests the environment-facing camera and shows the video when open', async () => {
    const { stream } = makeStream();
    getUserMediaMock.mockResolvedValue(stream);
    detectMock.mockResolvedValue([]); // no code yet -> keep scanning

    render(<ScanQrDrawer open {...noopProps()} />);
    await flushAsync();

    expect(getUserMediaMock).toHaveBeenCalledWith({ video: { facingMode: 'environment' } });
    expect(screen.getByTestId('scan-qr-video')).toBeInTheDocument();
  });

  it('does not request the camera while closed', async () => {
    render(<ScanQrDrawer open={false} {...noopProps()} />);
    await flushAsync();
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it('shows the permission-denied state and reports the error on NotAllowedError', async () => {
    getUserMediaMock.mockRejectedValue(domError('NotAllowedError'));
    const props = noopProps();

    render(<ScanQrDrawer open {...props} />);
    await flushAsync();

    expect(screen.getByTestId('scan-qr-permission-denied')).toBeInTheDocument();
    expect(props.onError).toHaveBeenCalledWith('cameraPermissionDenied');
  });

  it('shows the no-camera state on NotFoundError', async () => {
    getUserMediaMock.mockRejectedValue(domError('NotFoundError'));
    const props = noopProps();

    render(<ScanQrDrawer open {...props} />);
    await flushAsync();

    expect(screen.getByTestId('scan-qr-no-camera')).toBeInTheDocument();
  });

  it('falls back to the no-camera state for a non-Error / unknown getUserMedia rejection', async () => {
    getUserMediaMock.mockRejectedValue('camera exploded'); // non-Error rejection
    const props = noopProps();

    render(<ScanQrDrawer open {...props} />);
    await flushAsync();

    expect(screen.getByTestId('scan-qr-no-camera')).toBeInTheDocument();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('reports a detected address once, closes the drawer, and stops every camera track', async () => {
    const { stream, tracks } = makeStream(2);
    getUserMediaMock.mockResolvedValue(stream);
    detectMock.mockResolvedValue([{ rawValue: VALID_ADDRESS }]);
    const props = noopProps();

    render(<ScanQrDrawer open {...props} />);
    await flushAsync();

    expect(props.onDetected).toHaveBeenCalledTimes(1);
    expect(props.onDetected).toHaveBeenCalledWith(VALID_ADDRESS);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    tracks.forEach(track => expect(track.stop).toHaveBeenCalledTimes(1));
  });

  it('keeps scanning (no close) when a QR decodes to a non-Miden value', async () => {
    const { stream } = makeStream();
    getUserMediaMock.mockResolvedValue(stream);
    detectMock.mockResolvedValue([{ rawValue: 'not-an-address' }]);
    const props = noopProps();

    render(<ScanQrDrawer open {...props} />);
    await flushAsync();

    expect(props.onDetected).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    // Still scanning -> the video stays mounted.
    expect(screen.getByTestId('scan-qr-video')).toBeInTheDocument();
  });

  it('tears down a camera stream that resolves after the drawer has closed', async () => {
    const { stream, tracks } = makeStream(2);
    let resolveGum: (value: MediaStream) => void = () => {};
    getUserMediaMock.mockReturnValue(new Promise(resolve => (resolveGum = resolve)));
    const props = noopProps();

    const { rerender } = render(<ScanQrDrawer open {...props} />);
    // Close before the camera grant arrives.
    rerender(<ScanQrDrawer open={false} {...props} />);

    await act(async () => {
      resolveGum(stream);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // The late stream is stopped immediately; scanning never starts.
    tracks.forEach(track => expect(track.stop).toHaveBeenCalledTimes(1));
    expect(props.onDetected).not.toHaveBeenCalled();
  });

  it('drives the loop via requestVideoFrameCallback when available and cancels it on teardown', async () => {
    // rVFC invokes its callback (advancing one frame) then hands back a handle.
    const rvfc = jest.fn((cb: () => void) => {
      cb();
      return 7;
    });
    const cancelRvfc = jest.fn();
    (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback = rvfc;
    (HTMLVideoElement.prototype as unknown as Record<string, unknown>).cancelVideoFrameCallback = cancelRvfc;
    try {
      const { stream } = makeStream();
      getUserMediaMock.mockResolvedValue(stream);
      detectMock
        .mockResolvedValueOnce([{ rawValue: 'not-an-address' }]) // frame 1 -> schedules via rVFC
        .mockResolvedValueOnce([{ rawValue: VALID_ADDRESS }]); // frame 2 -> success
      const props = noopProps();

      render(<ScanQrDrawer open {...props} />);
      await flushAsync();

      // The video-frame scheduler was used in preference to rAF, and the pending
      // frame handle is cancelled when the camera tears down on success.
      expect(rvfc).toHaveBeenCalled();
      expect(cancelRvfc).toHaveBeenCalledWith(7);
      expect(props.onDetected).toHaveBeenCalledWith(VALID_ADDRESS);
    } finally {
      delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback;
      delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).cancelVideoFrameCallback;
    }
  });

  it('keeps scanning when the environment cannot attach the stream to the video element', async () => {
    // Simulate a browser without a settable `srcObject` (the attach is guarded).
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() {
        return null;
      },
      set() {
        throw new Error('srcObject unsupported');
      }
    });
    try {
      const { stream } = makeStream();
      getUserMediaMock.mockResolvedValue(stream);
      detectMock.mockResolvedValue([]); // no code yet
      const props = noopProps();

      render(<ScanQrDrawer open {...props} />);
      await flushAsync();

      // The failed attach is swallowed; scanning still starts.
      expect(screen.getByTestId('scan-qr-video')).toBeInTheDocument();
      expect(props.onError).not.toHaveBeenCalled();
    } finally {
      delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).srcObject;
    }
  });

  it('rescans subsequent frames until a valid address appears', async () => {
    const { stream } = makeStream();
    getUserMediaMock.mockResolvedValue(stream);
    detectMock
      .mockResolvedValueOnce([{ rawValue: 'not-an-address' }]) // frame 1: keep scanning
      .mockResolvedValueOnce([{ rawValue: VALID_ADDRESS }]); // frame 2: success
    // Let rAF actually advance one frame so the loop reaches frame 2.
    (window.requestAnimationFrame as jest.Mock).mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const props = noopProps();

    render(<ScanQrDrawer open {...props} />);
    await flushAsync();

    expect(detectMock).toHaveBeenCalledTimes(2);
    expect(props.onDetected).toHaveBeenCalledWith(VALID_ADDRESS);
  });

  it('stops all tracks on close and never sets state after unmount', async () => {
    const { stream, tracks } = makeStream(2);
    getUserMediaMock.mockResolvedValue(stream);
    // A deferred decode still in flight when the drawer closes.
    let resolveDetect: (value: Array<{ rawValue: string }>) => void = () => {};
    detectMock.mockReturnValue(new Promise(resolve => (resolveDetect = resolve)));
    const props = noopProps();

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(<ScanQrDrawer open {...props} />);
    await flushAsync();

    // Close: teardown must cancel the loop and stop the camera.
    rerender(<ScanQrDrawer open={false} {...props} />);
    tracks.forEach(track => expect(track.stop).toHaveBeenCalledTimes(1));

    // The in-flight decode resolves AFTER teardown: the cancelled guard must
    // swallow it without a stray onDetected or a setState-after-unmount warning.
    await act(async () => {
      resolveDetect([{ rawValue: VALID_ADDRESS }]);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(props.onDetected).not.toHaveBeenCalled();
    const reactWarnings = consoleError.mock.calls.filter(([msg]) =>
      typeof msg === 'string' ? /not wrapped in act|unmounted component|memory leak/.test(msg) : false
    );
    expect(reactWarnings).toHaveLength(0);

    consoleError.mockRestore();
  });
});

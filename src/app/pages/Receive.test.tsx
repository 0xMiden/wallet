import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { Receive } from './Receive';

// Pending (claimable) notes moved to their own `/pending-notes` page — see
// Pending.test.tsx for the claim-flow coverage. Receive is now address-only.

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('@capacitor/share', () => ({
  Share: { share: jest.fn() }
}));

jest.mock('app/atoms/FormField', () => React.forwardRef(() => null));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: false, sidePanel: false })
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { Add: 'Add', CrossChain: 'CrossChain', Share: 'Share' }
}));

jest.mock('app/templates/EvmConnectModal', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('app/pages/BridgeDeposit', () => ({
  __esModule: true,
  default: () => <div data-testid="bridge-deposit" />
}));

jest.mock('components/Button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    title
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    title?: string;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children ?? title}
    </button>
  ),
  ButtonVariant: { Ghost: 'ghost', Primary: 'primary', Secondary: 'secondary' }
}));

jest.mock('components/QRCode', () => ({
  QRCode: () => null
}));

let mockPublicKey = 'test-account-123';

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: mockPublicKey })
}));

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };
const telemetryHandles: TelemetryHandle[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
  telemetryHandles.push(handle);
  return handle;
});

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: () => 'unknown'
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isExtension: () => false
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: () => ({ fieldRef: { current: null }, copy: jest.fn(), copied: false })
}));

jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({ address: undefined, connected: false })
}));

let mockPathname = '/receive';

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  // The receive flow only reports while its route is showing: the home carousel
  // keeps this page mounted for the whole session, so a mount-triggered flow
  // fired on every app open.
  useLocation: () => ({ pathname: mockPathname })
}));

jest.mock('utils/string', () => ({
  truncateAddress: (addr: string) => addr?.slice(0, 8) || ''
}));

// Both suites render this page as if its route were showing; the one test that
// checks the carousel case sets this to another page for itself.
beforeEach(() => {
  mockPathname = '/receive';
});

describe('Receive - Address', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  afterEach(async () => {
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('renders the account address', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    await act(async () => {
      testRoot!.render(<Receive />);
    });

    const full = testContainer.querySelector('[data-testid="receive-address-full"]');
    expect(full?.textContent).toBe('test-account-123');
  });

  it('does not render a pending tab switcher', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    await act(async () => {
      testRoot!.render(<Receive />);
    });

    expect(testContainer.querySelector('[data-testid="receive-tab-pending"]')).toBeNull();
  });
});

// The receive surface is a view: its job is to put a usable address in front of
// the user (QR, copy, share), so that is what "completed" means here.
describe('Receive - receive_share telemetry', () => {
  /** Throwing accessor so a missing handle names how many flows were begun. */
  const handleAt = (index: number): TelemetryHandle => {
    const handle = telemetryHandles[index];
    if (!handle) throw new Error(`no flow was begun at index ${index} (begun: ${telemetryHandles.length})`);
    return handle;
  };

  /** Everything this suite handed to telemetry, for the privacy assertions. */
  const telemetryPayload = () =>
    JSON.stringify({
      begun: beginFlowMock.mock.calls,
      settled: telemetryHandles.map(handle => [
        handle.complete.mock.calls,
        handle.cancel.mock.calls,
        handle.fail.mock.calls
      ])
    });

  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  const renderReceive = async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    await act(async () => {
      testRoot!.render(<Receive />);
    });
  };

  const unmountReceive = async () => {
    await act(async () => {
      testRoot!.unmount();
    });
    testRoot = null;
  };

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    telemetryHandles.length = 0;
    mockPublicKey = 'test-account-123';
  });

  afterEach(async () => {
    if (testRoot) await unmountReceive();
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('reports nothing while another home page is showing, since the carousel keeps this one mounted', async () => {
    // TabLayout renders Overview / Send / Receive / Earn / Swap as one carousel
    // and mounts every page at once for the whole session. The address renders
    // unconditionally, so a mount-triggered flow both began AND completed a
    // receive-address share on every single app open — making this the wallet's
    // most numerous event and none of it evidence that anyone shared anything.
    mockPathname = '/';

    await renderReceive();

    expect(beginFlowMock).not.toHaveBeenCalled();
  });

  it('begins one receive_share flow on entry', async () => {
    await renderReceive();

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('receive_share');
  });

  it('completes the flow once the address is presented', async () => {
    await renderReceive();

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('does not re-report the presented address on unmount', async () => {
    await renderReceive();

    await unmountReceive();

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('cancels the flow when there is no address to present', async () => {
    mockPublicKey = '';

    await renderReceive();
    expect(handleAt(0).complete).not.toHaveBeenCalled();

    await unmountReceive();

    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
  });

  it('completes a flow that was waiting once the address arrives', async () => {
    mockPublicKey = '';
    await renderReceive();

    mockPublicKey = 'test-account-123';
    await act(async () => {
      testRoot!.render(<Receive />);
    });

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('never passes the address to telemetry', async () => {
    await renderReceive();

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('test-account-123');
  });
});

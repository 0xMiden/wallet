/** @jest-environment node */
import { isCrashReportingEnabledAsync } from 'lib/settings/helpers';

import { captureCrash, initCrashReporting, scrubEvent, stopCrashReporting } from './crash';

jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual<typeof import('lib/settings/helpers')>('lib/settings/helpers'),
  isCrashReportingEnabledAsync: jest.fn()
}));

const captured: unknown[] = [];
jest.mock('@sentry/browser', () => ({
  BrowserClient: jest.fn(() => ({ init: jest.fn(), close: jest.fn() })),
  Scope: jest.fn(() => ({
    setClient: jest.fn(),
    captureException: (error: unknown) => captured.push(error)
  })),
  makeFetchTransport: jest.fn(),
  defaultStackParser: jest.fn(),
  inboundFiltersIntegration: jest.fn(() => ({ name: 'InboundFilters' })),
  linkedErrorsIntegration: jest.fn(() => ({ name: 'LinkedErrors' })),
  dedupeIntegration: jest.fn(() => ({ name: 'Dedupe' }))
}));

beforeEach(() => {
  captured.length = 0;
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(true);
  initCrashReporting({ listenToGlobals: false });
});

afterEach(() => {
  stopCrashReporting();
  jest.clearAllMocks();
});

it.each([
  ['visible', 'visible'],
  ['hidden', 'hidden'],
  ['prerender', 'unknown'],
  ['missing document', 'unknown'],
  ['throwing document', 'unknown'],
  ['throwing visibility', 'unknown']
])('captures visible hidden and unknown in the capture realm: %s', async (state, expected) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let visibilityReads = 0;
  try {
    if (state !== 'missing document') {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        get() {
          if (state === 'throwing document') throw new Error('document unavailable');
          return {
            get visibilityState() {
              visibilityReads++;
              if (state === 'throwing visibility') throw new Error('visibility unavailable');
              return visibilityReads === 1 ? state : 'changed';
            }
          };
        }
      });
    }
    captureCrash(new Error('cursor failed'));
    const expectedReads = state === 'missing document' || state === 'throwing document' ? 0 : 1;
    expect(visibilityReads).toBe(expectedReads);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(captured).toHaveLength(1);
    const event: Record<string, unknown> = {};
    scrubEvent(event, { originalException: captured[0] });
    expect(event.extra).toEqual({ walletDiagnostics: expect.objectContaining({ pageVisibility: expected }) });
    expect(event.tags).toEqual({ network: 'testnet' });
    expect(event.tags).not.toHaveProperty('page_visibility');
    expect(visibilityReads).toBe(expectedReads);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

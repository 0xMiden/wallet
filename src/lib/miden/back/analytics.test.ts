/**
 * Unit tests for `lib/miden/back/analytics.ts` — the Segment analytics client
 * wrapper (`trackEvent` / `pageEvent` / `performanceEvent`) plus the
 * module-load-time write-key guard.
 *
 * The Segment `Analytics` node client is mocked so no network calls happen and
 * we can assert on the exact `client.track` / `client.page` payloads. The
 * module reads `process.env.ALEO_WALLET_SEGMENT_WRITE_KEY` and instantiates the
 * client at import time, so each case (re)loads the module in isolation with
 * the env configured for that scenario.
 */
import { AnalyticsEventCategory } from 'lib/miden/analytics-types';

// `mock`-prefixed names are the only out-of-scope refs `jest.mock` factories
// may close over (the hoist rule). The constructor is a plain fn that, when
// `new`-ed, returns our stub client — `new` uses the returned object.
const mockTrack = jest.fn();
const mockPage = jest.fn();
const mockAnalyticsCtor = jest.fn(() => ({ track: mockTrack, page: mockPage }));

jest.mock('@segment/analytics-node', () => ({
  Analytics: mockAnalyticsCtor
}));

const WRITE_KEY = 'test-segment-write-key';

type AnalyticsModule = typeof import('./analytics');

/** (Re)load the module in a fresh registry so its import-time side effects
 * (env guard + client construction) run against the current `process.env`. */
const loadAnalytics = (): AnalyticsModule => {
  let mod!: AnalyticsModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    mod = require('./analytics');
  });
  return mod;
};

describe('lib/miden/back/analytics', () => {
  const ORIGINAL_WRITE_KEY = process.env.ALEO_WALLET_SEGMENT_WRITE_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALEO_WALLET_SEGMENT_WRITE_KEY = WRITE_KEY;
  });

  afterAll(() => {
    if (ORIGINAL_WRITE_KEY === undefined) {
      delete process.env.ALEO_WALLET_SEGMENT_WRITE_KEY;
    } else {
      process.env.ALEO_WALLET_SEGMENT_WRITE_KEY = ORIGINAL_WRITE_KEY;
    }
  });

  describe('module initialization', () => {
    it('throws when ALEO_WALLET_SEGMENT_WRITE_KEY is not set', () => {
      delete process.env.ALEO_WALLET_SEGMENT_WRITE_KEY;

      expect(() => loadAnalytics()).toThrow("Require a 'ALEO_WALLET_SEGMENT_WRITE_KEY' environment variable to be set");
      expect(mockAnalyticsCtor).not.toHaveBeenCalled();
    });

    it('constructs a single Segment client with the configured write key', () => {
      loadAnalytics();

      expect(mockAnalyticsCtor).toHaveBeenCalledTimes(1);
      expect(mockAnalyticsCtor).toHaveBeenCalledWith({ writeKey: WRITE_KEY });
    });
  });

  describe('trackEvent', () => {
    it('sends a "<category> <event>" track call and folds category/event into properties', async () => {
      const { trackEvent } = loadAnalytics();

      await trackEvent({
        userId: 'user-1',
        rpc: undefined,
        event: 'ClickedSend',
        category: AnalyticsEventCategory.ButtonPress,
        properties: { foo: 'bar' }
      });

      expect(mockTrack).toHaveBeenCalledTimes(1);
      const payload = mockTrack.mock.calls[0]![0];
      expect(payload).toMatchObject({
        userId: 'user-1',
        event: 'ButtonPress ClickedSend',
        properties: {
          foo: 'bar',
          event: 'ClickedSend',
          category: AnalyticsEventCategory.ButtonPress
        }
      });
      expect(payload.timestamp).toBeInstanceOf(Date);
    });

    it('works when no `properties` object is supplied', async () => {
      const { trackEvent } = loadAnalytics();

      await trackEvent({
        userId: 'user-1b',
        rpc: undefined,
        event: 'Opened',
        category: AnalyticsEventCategory.General
      });

      expect(mockTrack).toHaveBeenCalledTimes(1);
      const payload = mockTrack.mock.calls[0]![0];
      expect(payload.event).toBe('General Opened');
      expect(payload.properties).toEqual({
        event: 'Opened',
        category: AnalyticsEventCategory.General
      });
    });

    it('lets caller `properties` be overridden by the derived event/category fields', async () => {
      const { trackEvent } = loadAnalytics();

      await trackEvent({
        userId: 'user-1c',
        rpc: undefined,
        event: 'RealEvent',
        category: AnalyticsEventCategory.Toggle,
        // These collide with the fields the wrapper appends; the appended
        // values must win because they are spread last.
        properties: { event: 'stale', category: 'stale', keep: 1 }
      });

      const payload = mockTrack.mock.calls[0]![0];
      expect(payload.properties).toEqual({
        keep: 1,
        event: 'RealEvent',
        category: AnalyticsEventCategory.Toggle
      });
    });
  });

  describe('pageEvent', () => {
    it('sends a page call with url = path+search and the derived page properties', async () => {
      const { pageEvent } = loadAnalytics();

      await pageEvent({
        userId: 'user-2',
        rpc: undefined,
        path: '/home',
        search: '?tab=1',
        additionalProperties: { extra: true }
      });

      expect(mockPage).toHaveBeenCalledTimes(1);
      expect(mockTrack).not.toHaveBeenCalled();
      const payload = mockPage.mock.calls[0]![0];
      expect(payload).toMatchObject({
        userId: 'user-2',
        name: '/home',
        category: 'AnalyticsEventCategory.PageOpened',
        properties: {
          url: '/home?tab=1',
          path: '?tab=1',
          referrer: '/home',
          category: 'AnalyticsEventCategory.PageOpened',
          extra: true
        }
      });
      expect(payload.timestamp).toBeInstanceOf(Date);
    });

    it('handles an empty search string and empty additionalProperties', async () => {
      const { pageEvent } = loadAnalytics();

      await pageEvent({
        userId: 'user-2b',
        rpc: undefined,
        path: '/settings',
        search: '',
        additionalProperties: {}
      });

      const payload = mockPage.mock.calls[0]![0];
      expect(payload.name).toBe('/settings');
      expect(payload.properties.url).toBe('/settings');
      expect(payload.properties.path).toBe('');
      expect(payload.properties.referrer).toBe('/settings');
    });

    it('lets additionalProperties override the derived category field', async () => {
      const { pageEvent } = loadAnalytics();

      await pageEvent({
        userId: 'user-2c',
        rpc: undefined,
        path: '/p',
        search: '?x=1',
        // Spread last in the source, so this overrides the default category.
        additionalProperties: { category: 'Custom', note: 'z' }
      });

      const payload = mockPage.mock.calls[0]![0];
      expect(payload.properties.category).toBe('Custom');
      expect(payload.properties.note).toBe('z');
    });
  });

  describe('performanceEvent', () => {
    it('sends a "Performance <event>" track call merging timings and additional props', async () => {
      const { performanceEvent } = loadAnalytics();

      await performanceEvent({
        userId: 'user-3',
        rpc: undefined,
        event: 'Sync',
        timings: { total: 1200, prove: 300 },
        additionalProperties: { network: 'testnet' }
      });

      expect(mockTrack).toHaveBeenCalledTimes(1);
      expect(mockPage).not.toHaveBeenCalled();
      const payload = mockTrack.mock.calls[0]![0];
      expect(payload).toMatchObject({
        userId: 'user-3',
        event: 'Performance Sync',
        properties: { total: 1200, prove: 300, network: 'testnet' }
      });
      expect(payload.timestamp).toBeInstanceOf(Date);
    });

    it('handles empty timings and empty additionalProperties', async () => {
      const { performanceEvent } = loadAnalytics();

      await performanceEvent({
        userId: 'user-3b',
        rpc: undefined,
        event: 'Idle',
        timings: {},
        additionalProperties: {}
      });

      const payload = mockTrack.mock.calls[0]![0];
      expect(payload.event).toBe('Performance Idle');
      expect(payload.properties).toEqual({});
    });
  });
});

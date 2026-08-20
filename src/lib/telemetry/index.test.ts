import * as telemetry from './index';
import { clearLegacyAnalyticsStorage } from './legacy-cleanup';
import { beginFlow, classifyError } from './report-flow';

jest.mock('lib/miden/front', () => ({ request: jest.fn() }));

describe('the telemetry barrel', () => {
  it('re-exports the flow reporting primitive', () => {
    expect(telemetry.beginFlow).toBe(beginFlow);
    expect(telemetry.classifyError).toBe(classifyError);
  });

  it('re-exports the legacy storage cleanup', () => {
    expect(telemetry.clearLegacyAnalyticsStorage).toBe(clearLegacyAnalyticsStorage);
  });

  /**
   * The barrel is what screens import, so anything it re-exports becomes
   * reachable from the frontend. `sendEvent` and the sink's test hooks must
   * stay behind the background boundary: a screen that could call the sink
   * directly would bypass the consent gate's single auditable check.
   */
  it('exposes nothing beyond the documented surface', () => {
    expect(Object.keys(telemetry).sort()).toEqual(['beginFlow', 'classifyError', 'clearLegacyAnalyticsStorage']);
  });
});

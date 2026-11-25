import { renderHook } from '@testing-library/react';

import { request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';
import { __resetRunForTest } from 'lib/telemetry/run';
import { HistoryAction } from 'lib/woozie';

import { useScreenVisitTelemetry } from './useScreenVisitTelemetry';

jest.mock('lib/miden/front', () => ({ request: jest.fn().mockResolvedValue({}) }));
jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => false) }));
jest.mock('app/env', () => ({ useAppEnv: () => ({ popup: false, sidePanel: true }) }));

const visits = () =>
  jest
    .mocked(request)
    .mock.calls.map(([req]) => (req as unknown as { event: Record<string, unknown> }).event)
    .filter(e => e.phase === 'visit');

let now = 0;
beforeEach(() => {
  __resetRunForTest();
  jest.mocked(request).mockClear();
  now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

describe('useScreenVisitTelemetry', () => {
  it('reports the first destination and the next visit, tagged with the side panel surface', () => {
    const { rerender } = renderHook(({ usable, path, trigger }) => useScreenVisitTelemetry(usable, path, trigger), {
      initialProps: { usable: true, path: '/', trigger: null as HistoryAction | null }
    });
    now = 2000;
    rerender({ usable: true, path: '/send', trigger: HistoryAction.Push });
    now = 5000;
    rerender({ usable: true, path: '/', trigger: HistoryAction.Pop });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ type: WalletMessageType.ReportTelemetryEventRequest })
    );
    expect(visits().map(v => [v.screen, v.source, v.surface, v.visibleMs, v.order])).toEqual([
      ['overview', 'initial', 'side_panel', 2000, 1],
      ['send', 'push', 'side_panel', 3000, 2]
    ]);
  });

  it('reports nothing while the wallet is not usable and starts over at initial after unlock', () => {
    const { rerender, unmount } = renderHook(({ usable, path }) => useScreenVisitTelemetry(usable, path, null), {
      initialProps: { usable: false, path: '/' }
    });
    now = 9000;
    rerender({ usable: true, path: '/' });
    now = 12000;
    unmount();
    expect(visits().map(v => [v.screen, v.source, v.complete, v.visibleMs])).toEqual([
      ['overview', 'initial', false, 3000]
    ]);
  });

  it('does not count hidden time and reports only the path-free screen name', () => {
    const { rerender } = renderHook(({ path }) => useScreenVisitTelemetry(true, path, null), {
      initialProps: { path: '/token-detail/0xdeadbeef' }
    });
    now = 1000;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    now = 100000;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    now = 101000;
    rerender({ path: '/me' });
    const reported = visits();
    expect(reported.map(v => [v.screen, v.source, v.visibleMs])).toEqual([
      ['other', 'initial', 1000],
      ['other', 'resume', 1000]
    ]);
    expect(JSON.stringify(reported)).not.toContain('deadbeef');
  });
});

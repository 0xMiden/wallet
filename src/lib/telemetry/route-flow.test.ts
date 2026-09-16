import { request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

import {
  __resetRouteFlowsForTest,
  enterRouteFlow,
  hasOpenRouteFlow,
  reportRouteFlowStep,
  settleRouteFlow
} from './route-flow';
import { FlowEndedEvent, TelemetryEvent } from './types';

jest.mock('lib/miden/front', () => ({ request: jest.fn() }));

jest.mock('nanoid', () => {
  let issued = 0;
  return { nanoid: () => `flow-${++issued}` };
});

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

const sentEvents = (): TelemetryEvent[] =>
  jest
    .mocked(request)
    .mock.calls.flatMap(([req]) => (req.type === WalletMessageType.ReportTelemetryEventRequest ? [req.event] : []));

const endedEvents = (): FlowEndedEvent[] => sentEvents().flatMap(event => (event.phase === 'ended' ? [event] : []));

describe('route flows', () => {
  beforeEach(() => {
    jest.mocked(request).mockResolvedValue({ type: WalletMessageType.ReportTelemetryEventResponse });
  });

  afterEach(() => {
    __resetRouteFlowsForTest();
    jest.resetAllMocks();
  });

  it('survives the handoff between two routes, which is the whole reason it exists', async () => {
    // The earn deposit shape: begun on the amount screen, advanced and settled
    // on a separate review route. A component-local handle would have reported
    // this successful deposit as abandoned at the moment of navigation.
    enterRouteFlow('earn');
    reportRouteFlowStep('earn', 'select_amount');

    // ...amount screen unmounts, review route mounts and adopts...
    enterRouteFlow('earn');
    reportRouteFlowStep('earn', 'review');
    settleRouteFlow('earn', flow => flow.complete());
    await flushMicrotasks();

    expect(endedEvents()).toEqual([expect.objectContaining({ flow: 'earn', result: 'completed', step: 'review' })]);
  });

  it('adopts rather than restarts, so one journey is one flow', async () => {
    enterRouteFlow('earn');
    enterRouteFlow('earn');
    await flushMicrotasks();

    expect(sentEvents().filter(event => event.phase === 'started')).toHaveLength(1);
  });

  it('keeps flows apart, so settling one cannot end another', async () => {
    enterRouteFlow('earn');
    enterRouteFlow('guardian_rotate');
    settleRouteFlow('earn', flow => flow.cancel());
    await flushMicrotasks();

    expect(endedEvents()).toEqual([expect.objectContaining({ flow: 'earn', result: 'cancelled' })]);
    expect(hasOpenRouteFlow('guardian_rotate')).toBe(true);
  });

  it('clears the handle before settling, so a terminal call and the unmount it triggers report once', async () => {
    enterRouteFlow('earn');
    settleRouteFlow('earn', flow => {
      // Standing in for the navigation a real caller performs here, which
      // unmounts the screen whose cleanup settles the same flow.
      settleRouteFlow('earn', inner => inner.cancel());
      flow.complete();
    });
    await flushMicrotasks();

    expect(endedEvents()).toEqual([expect.objectContaining({ result: 'completed' })]);
  });

  it('does nothing when asked to settle or advance a flow that is not open', async () => {
    settleRouteFlow('earn', flow => flow.complete());
    reportRouteFlowStep('earn', 'review');
    await flushMicrotasks();

    expect(sentEvents()).toEqual([]);
    expect(hasOpenRouteFlow('earn')).toBe(false);
  });
});

import { serializeEvent, WIRE_KEYS } from './serialize';
import { TelemetryContext, TelemetryEvent } from './types';

const context: TelemetryContext = { appVersion: '1.15.21', platform: 'extension' };

describe('serializeEvent', () => {
  it('serializes a started event with no result or duration', () => {
    const event: TelemetryEvent = { phase: 'started', flow: 'send', flowId: 'f1', runId: 'r1' };
    expect(serializeEvent(event, context)).toEqual({
      phase: 'started',
      flow: 'send',
      flowId: 'f1',
      runId: 'r1',
      appVersion: '1.15.21',
      platform: 'extension'
    });
  });

  it('serializes a completed event with a rounded duration', () => {
    const event: TelemetryEvent = {
      phase: 'ended',
      flow: 'send',
      flowId: 'f1',
      runId: 'r1',
      result: 'completed',
      durationMs: 1234.87
    };
    expect(serializeEvent(event, context)).toEqual({
      phase: 'ended',
      flow: 'send',
      flowId: 'f1',
      runId: 'r1',
      result: 'completed',
      durationMs: 1235,
      appVersion: '1.15.21',
      platform: 'extension'
    });
  });

  it('includes step only when supplied, so a single-screen flow does not invent one', () => {
    const withStep = serializeEvent(
      { phase: 'ended', flow: 'swap', flowId: 'f1', runId: 'r1', result: 'cancelled', durationMs: 10, step: 'review' },
      context
    );
    expect(withStep.step).toBe('review');

    const withoutStep = serializeEvent(
      { phase: 'ended', flow: 'unlock', flowId: 'f1', runId: 'r1', result: 'completed', durationMs: 10 },
      context
    );
    expect('step' in withoutStep).toBe(false);
  });

  it('never puts a step on a started event, which by definition has reached nothing yet', () => {
    const payload = serializeEvent({ phase: 'started', flow: 'swap', flowId: 'f1', runId: 'r1' }, context);

    expect('step' in payload).toBe(false);
  });

  it('includes errorKind only when supplied', () => {
    const withKind = serializeEvent(
      {
        phase: 'ended',
        flow: 'send',
        flowId: 'f1',
        runId: 'r1',
        result: 'errored',
        errorKind: 'network',
        durationMs: 10
      },
      context
    );
    expect(withKind.errorKind).toBe('network');

    const withoutKind = serializeEvent(
      { phase: 'ended', flow: 'send', flowId: 'f1', runId: 'r1', result: 'cancelled', durationMs: 10 },
      context
    );
    expect('errorKind' in withoutKind).toBe(false);
  });

  it('emits only allowlisted keys for every event shape', () => {
    const events: TelemetryEvent[] = [
      { phase: 'started', flow: 'open', flowId: 'a', runId: 'r1' },
      { phase: 'ended', flow: 'unlock', flowId: 'b', runId: 'r1', result: 'completed', durationMs: 1 },
      { phase: 'ended', flow: 'import', flowId: 'c', runId: 'r1', result: 'errored', errorKind: 'rpc', durationMs: 2 }
    ];
    for (const event of events) {
      for (const key of Object.keys(serializeEvent(event, context))) {
        expect(WIRE_KEYS).toContain(key);
      }
    }
  });

  it('carries the run id verbatim on both phases, since it is what groups a visit', () => {
    const start = serializeEvent({ phase: 'started', flow: 'swap', flowId: 'f1', runId: 'run-7' }, context);
    const end = serializeEvent(
      { phase: 'ended', flow: 'swap', flowId: 'f1', runId: 'run-7', result: 'completed', durationMs: 3 },
      context
    );

    expect(start.runId).toBe('run-7');
    expect(end.runId).toBe('run-7');
    // Distinct fields, not two names for one value: conflating them is exactly
    // the mistake that made every Aptabase session hold a single flow.
    expect(start.runId).not.toBe(start.flowId);
  });

  it('derives appVersion and platform from context, ignoring any caller-supplied value', () => {
    const payload = serializeEvent({ phase: 'started', flow: 'open', flowId: 'a', runId: 'r1' }, context);
    expect(payload.appVersion).toBe('1.15.21');
    expect(payload.platform).toBe('extension');
  });

  it('never produces a nested object or array', () => {
    const payload = serializeEvent(
      {
        phase: 'ended',
        flow: 'send',
        flowId: 'f1',
        runId: 'r1',
        result: 'errored',
        errorKind: 'proving',
        durationMs: 5
      },
      context
    );
    for (const value of Object.values(payload)) {
      expect(['string', 'number']).toContain(typeof value);
    }
  });

  describe('a settled operation', () => {
    // The whole second axis, which this file had no cases for at all. Two
    // mutations survived the entire suite because of it: dropping the
    // `durationMs !== undefined` guard, which posts `durationMs: null` for an
    // operation that has no honest interval, and dropping the early `return`,
    // which lets a settled event fall through into the flow branch and pick up a
    // `flow` and `flowId` the design says it can never have.
    const settled: TelemetryEvent = {
      phase: 'settled',
      operation: 'tx_send',
      runId: 'r1',
      result: 'errored',
      durationMs: 1204.6,
      errorKind: 'proving',
      step: 'sending'
    };

    it('carries the operation, the verdict, the kind and the stage', () => {
      expect(serializeEvent(settled, context)).toEqual({
        phase: 'settled',
        operation: 'tx_send',
        runId: 'r1',
        result: 'errored',
        durationMs: 1205,
        errorKind: 'proving',
        step: 'sending',
        appVersion: '1.15.21',
        platform: 'extension'
      });
    });

    it('omits durationMs entirely when there is no honest interval, rather than sending a zero or a null', () => {
      // A reconciled row has been sitting there for however long the user was
      // away, so it sends no duration. An absent key reads as absent; a `null`
      // — which is what `Math.round(undefined)` becomes through `JSON` — reads
      // as a number that is not one, and a zero would be averaged.
      const payload = serializeEvent(
        { phase: 'settled', operation: 'tx_send', runId: 'r1', result: 'completed' },
        context
      );

      expect('durationMs' in payload).toBe(false);
      expect(payload).toEqual({
        phase: 'settled',
        operation: 'tx_send',
        runId: 'r1',
        result: 'completed',
        appVersion: '1.15.21',
        platform: 'extension'
      });
    });

    it('never acquires a flow or a flowId, which is the one thing it must not have', () => {
      // Pairing an operation to the flow that started it would mean writing a
      // telemetry id onto the durable transaction row, so the absence is a
      // design commitment rather than an oversight. Asserted on both shapes,
      // because the two take different branches out of the serializer.
      for (const event of [settled, { ...settled, durationMs: undefined }]) {
        const payload = serializeEvent(event as TelemetryEvent, context);
        expect('flow' in payload).toBe(false);
        expect('flowId' in payload).toBe(false);
      }
    });

    it('emits only allowlisted keys, on both shapes', () => {
      for (const event of [settled, { ...settled, durationMs: undefined }]) {
        const keys = Object.keys(serializeEvent(event as TelemetryEvent, context));
        expect(keys.filter(key => !WIRE_KEYS.includes(key))).toEqual([]);
      }
    });
  });
});

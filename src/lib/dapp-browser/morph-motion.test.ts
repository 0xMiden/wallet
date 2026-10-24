import type { PresentationMorphEvent } from '@miden/dapp-browser';

import { applyMorphEvent, classifyMorphEvent, type DappMotion, isMorphCard } from './morph-motion';

const motion: DappMotion = {
  id: 'a',
  lifetime: 'L',
  morphId: 'm1',
  target: 'collapsed',
  outgoingId: null,
  started: false,
  acknowledging: false,
  progress: 1,
  velocity: 0,
  tracking: false,
  eventSeq: 0
};

function morphEvent(overrides: Partial<PresentationMorphEvent>): PresentationMorphEvent {
  return {
    id: 'a',
    managedHostCloseToken: 'L',
    morphId: 'm1',
    phase: 'started',
    target: 'collapsed',
    progress: 0.98,
    velocity: -3,
    tracking: false,
    visibilitySequence: 4,
    ...overrides
  };
}

it('ignores events of another session, lifetime or morph id', () => {
  for (const overrides of [
    { id: 'b' },
    { managedHostCloseToken: 'other' },
    { managedHostCloseToken: undefined },
    { morphId: 'm0' }
  ]) {
    expect(classifyMorphEvent(motion, morphEvent(overrides))).toEqual({ kind: 'ignore' });
  }
});

it('ignores every event while no motion is held', () => {
  expect(classifyMorphEvent(null, morphEvent({ phase: 'settled' }))).toEqual({ kind: 'ignore' });
});

it('maps phases to actions', () => {
  expect(classifyMorphEvent(motion, morphEvent({ phase: 'started' }))).toEqual({ kind: 'start' });
  expect(classifyMorphEvent(motion, morphEvent({ phase: 'retargeted', target: 'expanded', tracking: true }))).toEqual({
    kind: 'retarget',
    target: 'expanded',
    tracking: true
  });
  expect(classifyMorphEvent(motion, morphEvent({ phase: 'settled', target: 'expanded' }))).toEqual({
    kind: 'settle',
    target: 'expanded'
  });
  expect(classifyMorphEvent(motion, morphEvent({ phase: 'cancelled' }))).toEqual({ kind: 'cancel' });
});

it('ignores a malformed event from the bridge', () => {
  const malformed: PresentationMorphEvent[] = [
    JSON.parse('null'),
    JSON.parse('"morph"'),
    JSON.parse('0'),
    JSON.parse('{"id":"a","managedHostCloseToken":"L","morphId":"m1","phase":"started"}'),
    morphEvent({ phase: JSON.parse('"paused"') }),
    morphEvent({ phase: 'retargeted', target: JSON.parse('null') }),
    morphEvent({ phase: 'settled', target: JSON.parse('"sideways"') }),
    morphEvent({ progress: Number.NaN }),
    morphEvent({ velocity: Number.POSITIVE_INFINITY }),
    morphEvent({ tracking: JSON.parse('"yes"') })
  ];
  for (const event of malformed) {
    expect(classifyMorphEvent(motion, event)).toEqual({ kind: 'ignore' });
    expect(applyMorphEvent(motion, event)).toBe(motion);
  }
});

it('ignores a superseded morph id once the caller holds a newer one', () => {
  const newer: DappMotion = { ...motion, morphId: 'm2', target: 'expanded' };
  expect(classifyMorphEvent(newer, morphEvent({ phase: 'settled', target: 'collapsed' }))).toEqual({ kind: 'ignore' });
  const retarget = morphEvent({
    morphId: 'm2',
    phase: 'retargeted',
    target: 'collapsed',
    progress: 0.6,
    velocity: 1.5
  });
  expect(classifyMorphEvent(newer, retarget)).toEqual({ kind: 'retarget', target: 'collapsed', tracking: false });
  expect(applyMorphEvent(newer, retarget)).toEqual({
    ...newer,
    target: 'collapsed',
    started: true,
    progress: 0.6,
    velocity: 1.5,
    eventSeq: 1
  });
});

it('copies the latest progress, velocity and tracking', () => {
  const started = applyMorphEvent(motion, morphEvent({ phase: 'started' }));
  expect(started).toEqual({ ...motion, started: true, progress: 0.98, velocity: -3, eventSeq: 1 });
  const grabbed = applyMorphEvent(
    started,
    morphEvent({ phase: 'retargeted', progress: 0.5, velocity: 0, tracking: true })
  );
  expect(grabbed).toMatchObject({ target: 'collapsed', progress: 0.5, velocity: 0, tracking: true, eventSeq: 2 });
  const settled = applyMorphEvent(
    grabbed,
    morphEvent({ phase: 'settled', target: 'expanded', progress: 1, velocity: 0 })
  );
  expect(settled).toMatchObject({ target: 'collapsed', started: true, progress: 1, tracking: false, eventSeq: 3 });
});

it('leaves started false until native reports the morph moving', () => {
  expect(applyMorphEvent(motion, morphEvent({ phase: 'cancelled' })).started).toBe(false);
  expect(applyMorphEvent(motion, morphEvent({ phase: 'settled' })).started).toBe(false);
});

it('returns the motion itself for an ignored event', () => {
  expect(applyMorphEvent(motion, morphEvent({ morphId: 'm0' }))).toBe(motion);
});

it('accepts only a finite card with positive size', () => {
  const card = { x: 282, y: 650, width: 104, height: 132, cornerRadius: 16 };
  expect(isMorphCard(card)).toBe(true);
  expect(isMorphCard({ ...card, x: -4, cornerRadius: 0 })).toBe(true);
  for (const value of [
    { ...card, x: Number.NaN },
    { ...card, y: Number.POSITIVE_INFINITY },
    { ...card, width: 0 },
    { ...card, height: -1 },
    { ...card, cornerRadius: -1 },
    { ...card, width: '104' },
    { x: 282, y: 650, width: 104, height: 132 },
    null,
    'card',
    42
  ]) {
    expect(isMorphCard(value)).toBe(false);
  }
});
